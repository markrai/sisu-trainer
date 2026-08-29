import { HrSample, WorkoutSummary, SisuSettings } from "./types.js";

const DB_NAME = "vo2_workout_db";
const DB_VERSION = 2;
const STORE_WORKOUTS = "workouts";
const STORE_HR_SAMPLES = "hr_samples";
const STORE_SISU_SETTINGS = "sisu_settings";

let db: IDBDatabase | null = null;

async function initDB(): Promise<IDBDatabase> {
  if (db) return db;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };
    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;
      if (!database.objectStoreNames.contains(STORE_WORKOUTS)) {
        const workoutsStore = database.createObjectStore(STORE_WORKOUTS, { keyPath: "session_id" });
        workoutsStore.createIndex("startedAt", "startedAt", { unique: false });
        workoutsStore.createIndex("day", "day", { unique: false });
      }
      if (!database.objectStoreNames.contains(STORE_HR_SAMPLES)) {
        const hrSamplesStore = database.createObjectStore(STORE_HR_SAMPLES, {
          keyPath: ["session_id", "timestamp_sec"],
        });
        hrSamplesStore.createIndex("session_id", "session_id", { unique: false });
      }
      if (!database.objectStoreNames.contains(STORE_SISU_SETTINGS)) {
        database.createObjectStore(STORE_SISU_SETTINGS, { keyPath: "key" });
      }
    };
  });
}

async function storeHrSample(sessionId: string, timestampSec: number, hr: number) {
  try {
    const database = await initDB();
    const tx = database.transaction([STORE_HR_SAMPLES], "readwrite");
    const store = tx.objectStore(STORE_HR_SAMPLES);
    const key: [string, number] = [sessionId, timestampSec];
    await new Promise<void>((resolve, reject) => {
      const getRequest = store.get(key);
      getRequest.onerror = () => reject(getRequest.error);
      getRequest.onsuccess = () => {
        if (getRequest.result) {
          resolve();
          return;
        }
        const addRequest = store.add({ session_id: sessionId, timestamp_sec: timestampSec, hr });
        addRequest.onsuccess = () => resolve();
        addRequest.onerror = () => {
          if (addRequest.error?.name === "ConstraintError") resolve();
          else reject(addRequest.error);
        };
      };
    });
  } catch (error) {
    console.error("Error storing HR sample:", error);
  }
}

async function getHrSamples(sessionId: string): Promise<HrSample[]> {
  try {
    const database = await initDB();
    const tx = database.transaction([STORE_HR_SAMPLES], "readonly");
    const store = tx.objectStore(STORE_HR_SAMPLES);
    const index = store.index("session_id");
    return await new Promise((resolve, reject) => {
      const request = index.getAll(sessionId);
      request.onsuccess = () => resolve(request.result as HrSample[] || []);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error("Error getting HR samples:", error);
    return [];
  }
}

async function storeWorkoutSummary(summary: WorkoutSummary) {
  try {
    const database = await initDB();
    const tx = database.transaction([STORE_WORKOUTS], "readwrite");
    const store = tx.objectStore(STORE_WORKOUTS);
    await new Promise<void>((resolve, reject) => {
      const request = store.put({
        session_id: summary.external_session_id,
        startedAt: summary.startedAt,
        endedAt: summary.endedAt,
        day: summary.day || null,
        summary,
      });
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("workout summary write aborted"));
    });
  } catch (error) {
    console.error("Error storing workout summary:", error);
  }
}

async function clearHrSamples(sessionId: string) {
  try {
    const database = await initDB();
    const tx = database.transaction([STORE_HR_SAMPLES], "readwrite");
    const store = tx.objectStore(STORE_HR_SAMPLES);
    const index = store.index("session_id");
    return await new Promise<void>((resolve, reject) => {
      const range = IDBKeyRange.only(sessionId);
      const request = index.openCursor(range);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error("Error clearing HR samples:", error);
  }
}

async function getAllWorkoutSummaries(): Promise<Array<{ summary: WorkoutSummary }>> {
  try {
    const database = await initDB();
    const tx = database.transaction([STORE_WORKOUTS], "readonly");
    const store = tx.objectStore(STORE_WORKOUTS);
    const index = store.index("startedAt");
    return await new Promise((resolve, reject) => {
      const workouts: any[] = [];
      const request = index.openCursor(null, "prev");
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          workouts.push(cursor.value);
          cursor.continue();
        } else {
          resolve(workouts);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error("Error getting all workout summaries:", error);
    return [];
  }
}

async function deleteWorkoutSummary(sessionId: string) {
  try {
    const database = await initDB();
    const tx = database.transaction([STORE_WORKOUTS], "readwrite");
    const store = tx.objectStore(STORE_WORKOUTS);
    await store.delete(sessionId);
    await clearHrSamples(sessionId);
    return true;
  } catch (error) {
    console.error("Error deleting workout summary:", error);
    return false;
  }
}

async function storeSisuSettings(host: string, port: number, protocol?: "https" | "http") {
  try {
    const database = await initDB();
    const tx = database.transaction([STORE_SISU_SETTINGS], "readwrite");
    const store = tx.objectStore(STORE_SISU_SETTINGS);
    await store.put({
      key: "config",
      host,
      port,
      protocol,
      last_connected: new Date().toISOString(),
      last_sync: null,
    } as SisuSettings);
    return true;
  } catch (error) {
    console.error("Error storing SISU settings:", error);
    return false;
  }
}

async function getSisuSettings(): Promise<SisuSettings | null> {
  try {
    const database = await initDB();
    const tx = database.transaction([STORE_SISU_SETTINGS], "readonly");
    const store = tx.objectStore(STORE_SISU_SETTINGS);
    return await new Promise((resolve, reject) => {
      const request = store.get("config");
      request.onsuccess = () => resolve(request.result as SisuSettings || null);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error("Error getting SISU settings:", error);
    return null;
  }
}

async function clearSisuSettings() {
  try {
    const database = await initDB();
    const tx = database.transaction([STORE_SISU_SETTINGS], "readwrite");
    const store = tx.objectStore(STORE_SISU_SETTINGS);
    await store.delete("config");
    return true;
  } catch (error) {
    console.error("Error clearing SISU settings:", error);
    return false;
  }
}

export function registerStorageGlobals() {
  (window as any).initDB = initDB;
  (window as any).storeHrSample = storeHrSample;
  (window as any).getHrSamples = getHrSamples;
  (window as any).storeWorkoutSummary = storeWorkoutSummary;
  (window as any).clearHrSamples = clearHrSamples;
  (window as any).getAllWorkoutSummaries = getAllWorkoutSummaries;
  (window as any).deleteWorkoutSummary = deleteWorkoutSummary;
  (window as any).storeSisuSettings = storeSisuSettings;
  (window as any).getSisuSettings = getSisuSettings;
  (window as any).clearSisuSettings = clearSisuSettings;
}

/** Close the cached IDB handle and delete the app database (tests only). */
export async function resetWorkoutStorageForTests(): Promise<void> {
  if (db) {
    db.close();
    db = null;
  }
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

export {
  initDB,
  storeHrSample,
  getHrSamples,
  storeWorkoutSummary,
  clearHrSamples,
  getAllWorkoutSummaries,
  deleteWorkoutSummary,
  storeSisuSettings,
  getSisuSettings,
  clearSisuSettings,
};
