const DB_NAME = "vo2_workout_db";
const DB_VERSION = 2;
const STORE_WORKOUTS = "workouts";
const STORE_HR_SAMPLES = "hr_samples";
const STORE_SISU_SETTINGS = "sisu_settings";
let db = null;
async function initDB() {
    if (db)
        return db;
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
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
async function storeHrSample(sessionId, timestampSec, hr) {
    try {
        const database = await initDB();
        const tx = database.transaction([STORE_HR_SAMPLES], "readwrite");
        const store = tx.objectStore(STORE_HR_SAMPLES);
        await store.put({ session_id: sessionId, timestamp_sec: timestampSec, hr });
    }
    catch (error) {
        console.error("Error storing HR sample:", error);
    }
}
async function getHrSamples(sessionId) {
    try {
        const database = await initDB();
        const tx = database.transaction([STORE_HR_SAMPLES], "readonly");
        const store = tx.objectStore(STORE_HR_SAMPLES);
        const index = store.index("session_id");
        return await new Promise((resolve, reject) => {
            const request = index.getAll(sessionId);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }
    catch (error) {
        console.error("Error getting HR samples:", error);
        return [];
    }
}
async function storeWorkoutSummary(summary) {
    try {
        const database = await initDB();
        const tx = database.transaction([STORE_WORKOUTS], "readwrite");
        const store = tx.objectStore(STORE_WORKOUTS);
        await store.put({
            session_id: summary.external_session_id,
            startedAt: summary.startedAt,
            endedAt: summary.endedAt,
            day: summary.day || null,
            summary,
        });
    }
    catch (error) {
        console.error("Error storing workout summary:", error);
    }
}
async function clearHrSamples(sessionId) {
    try {
        const database = await initDB();
        const tx = database.transaction([STORE_HR_SAMPLES], "readwrite");
        const store = tx.objectStore(STORE_HR_SAMPLES);
        const index = store.index("session_id");
        return await new Promise((resolve, reject) => {
            const range = IDBKeyRange.only(sessionId);
            const request = index.openCursor(range);
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                }
                else {
                    resolve();
                }
            };
            request.onerror = () => reject(request.error);
        });
    }
    catch (error) {
        console.error("Error clearing HR samples:", error);
    }
}
async function getAllWorkoutSummaries() {
    try {
        const database = await initDB();
        const tx = database.transaction([STORE_WORKOUTS], "readonly");
        const store = tx.objectStore(STORE_WORKOUTS);
        const index = store.index("startedAt");
        return await new Promise((resolve, reject) => {
            const workouts = [];
            const request = index.openCursor(null, "prev");
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    workouts.push(cursor.value);
                    cursor.continue();
                }
                else {
                    resolve(workouts);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }
    catch (error) {
        console.error("Error getting all workout summaries:", error);
        return [];
    }
}
async function deleteWorkoutSummary(sessionId) {
    try {
        const database = await initDB();
        const tx = database.transaction([STORE_WORKOUTS], "readwrite");
        const store = tx.objectStore(STORE_WORKOUTS);
        await store.delete(sessionId);
        await clearHrSamples(sessionId);
        return true;
    }
    catch (error) {
        console.error("Error deleting workout summary:", error);
        return false;
    }
}
async function storeSisuSettings(host, port) {
    try {
        const database = await initDB();
        const tx = database.transaction([STORE_SISU_SETTINGS], "readwrite");
        const store = tx.objectStore(STORE_SISU_SETTINGS);
        await store.put({
            key: "config",
            host,
            port,
            last_connected: new Date().toISOString(),
            last_sync: null,
        });
        return true;
    }
    catch (error) {
        console.error("Error storing SISU settings:", error);
        return false;
    }
}
async function getSisuSettings() {
    try {
        const database = await initDB();
        const tx = database.transaction([STORE_SISU_SETTINGS], "readonly");
        const store = tx.objectStore(STORE_SISU_SETTINGS);
        return await new Promise((resolve, reject) => {
            const request = store.get("config");
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }
    catch (error) {
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
    }
    catch (error) {
        console.error("Error clearing SISU settings:", error);
        return false;
    }
}
export function registerStorageGlobals() {
    window.initDB = initDB;
    window.storeHrSample = storeHrSample;
    window.getHrSamples = getHrSamples;
    window.storeWorkoutSummary = storeWorkoutSummary;
    window.clearHrSamples = clearHrSamples;
    window.getAllWorkoutSummaries = getAllWorkoutSummaries;
    window.deleteWorkoutSummary = deleteWorkoutSummary;
    window.storeSisuSettings = storeSisuSettings;
    window.getSisuSettings = getSisuSettings;
    window.clearSisuSettings = clearSisuSettings;
}
export { initDB, storeHrSample, getHrSamples, storeWorkoutSummary, clearHrSamples, getAllWorkoutSummaries, deleteWorkoutSummary, storeSisuSettings, getSisuSettings, clearSisuSettings, };
