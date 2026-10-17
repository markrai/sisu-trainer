// IndexedDB storage for workout sessions and HR samples
const DB_NAME = 'fitbaus_trainer_db';
const DB_VERSION = 2;
const STORE_WORKOUTS = 'workouts';
const STORE_HR_SAMPLES = 'hr_samples';
const STORE_SISU_SETTINGS = 'sisu_settings';

let db = null;

// Initialize IndexedDB
function initDB() {
  return new Promise((resolve, reject) => {
    if (db) {
      resolve(db);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(request.error);
    };

    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const database = event.target.result;

      // Create workouts store
      if (!database.objectStoreNames.contains(STORE_WORKOUTS)) {
        const workoutsStore = database.createObjectStore(STORE_WORKOUTS, {
          keyPath: 'session_id'
        });
        workoutsStore.createIndex('startedAt', 'startedAt', { unique: false });
        workoutsStore.createIndex('day', 'day', { unique: false });
      }

      // Create HR samples store
      if (!database.objectStoreNames.contains(STORE_HR_SAMPLES)) {
        const hrSamplesStore = database.createObjectStore(STORE_HR_SAMPLES, {
          keyPath: ['session_id', 'timestamp_sec']
        });
        hrSamplesStore.createIndex('session_id', 'session_id', { unique: false });
      }

      // Create SISU settings store
      if (!database.objectStoreNames.contains(STORE_SISU_SETTINGS)) {
        database.createObjectStore(STORE_SISU_SETTINGS, {
          keyPath: 'key'
        });
      }
    };
  });
}

// Store HR sample (second-by-second)
async function storeHrSample(sessionId, timestampSec, hr) {
  try {
    const database = await initDB();
    const transaction = database.transaction([STORE_HR_SAMPLES], 'readwrite');
    const store = transaction.objectStore(STORE_HR_SAMPLES);
    
    await store.put({
      session_id: sessionId,
      timestamp_sec: timestampSec,
      hr: hr
    });
  } catch (error) {
    console.error('Error storing HR sample:', error);
  }
}

// Get all HR samples for a session
async function getHrSamples(sessionId) {
  try {
    const database = await initDB();
    const transaction = database.transaction([STORE_HR_SAMPLES], 'readonly');
    const store = transaction.objectStore(STORE_HR_SAMPLES);
    const index = store.index('session_id');
    
    return new Promise((resolve, reject) => {
      const request = index.getAll(sessionId);
      request.onsuccess = () => {
        resolve(request.result || []);
      };
      request.onerror = () => {
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('Error getting HR samples:', error);
    return [];
  }
}

// Store workout summary
async function storeWorkoutSummary(summary) {
  try {
    const database = await initDB();
    const transaction = database.transaction([STORE_WORKOUTS], 'readwrite');
    const store = transaction.objectStore(STORE_WORKOUTS);
    
    await store.put({
      session_id: summary.external_session_id,
      startedAt: summary.startedAt,
      endedAt: summary.endedAt,
      day: summary.day || null,
      summary: summary
    });
  } catch (error) {
    console.error('Error storing workout summary:', error);
  }
}

// Clear HR samples for a session (cleanup)
async function clearHrSamples(sessionId) {
  try {
    const database = await initDB();
    const transaction = database.transaction([STORE_HR_SAMPLES], 'readwrite');
    const store = transaction.objectStore(STORE_HR_SAMPLES);
    const index = store.index('session_id');
    
    return new Promise((resolve, reject) => {
      const range = IDBKeyRange.only(sessionId);
      const request = index.openCursor(range);
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => {
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('Error clearing HR samples:', error);
  }
}

// Get all workout summaries
async function getAllWorkoutSummaries() {
  try {
    const database = await initDB();
    const transaction = database.transaction([STORE_WORKOUTS], 'readonly');
    const store = transaction.objectStore(STORE_WORKOUTS);
    const index = store.index('startedAt');
    
    return new Promise((resolve, reject) => {
      const workouts = [];
      const request = index.openCursor(null, 'prev'); // Sort by newest first
      
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          workouts.push(cursor.value);
          cursor.continue();
        } else {
          resolve(workouts);
        }
      };
      
      request.onerror = () => {
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('Error getting all workout summaries:', error);
    return [];
  }
}

// Delete workout summary and associated HR samples
async function deleteWorkoutSummary(sessionId) {
  try {
    const database = await initDB();
    
    // Delete workout summary
    const workoutTransaction = database.transaction([STORE_WORKOUTS], 'readwrite');
    const workoutStore = workoutTransaction.objectStore(STORE_WORKOUTS);
    await workoutStore.delete(sessionId);
    
    // Delete associated HR samples
    await clearHrSamples(sessionId);
    
    return true;
  } catch (error) {
    console.error('Error deleting workout summary:', error);
    return false;
  }
}

// Store SISU connection settings
async function storeSisuSettings(host, port) {
  try {
    const database = await initDB();
    const transaction = database.transaction([STORE_SISU_SETTINGS], 'readwrite');
    const store = transaction.objectStore(STORE_SISU_SETTINGS);
    
    await store.put({
      key: 'config',
      host: host,
      port: port,
      last_connected: new Date().toISOString(),
      last_sync: null
    });
    return true;
  } catch (error) {
    console.error('Error storing SISU settings:', error);
    return false;
  }
}

// Get SISU connection settings
async function getSisuSettings() {
  try {
    const database = await initDB();
    const transaction = database.transaction([STORE_SISU_SETTINGS], 'readonly');
    const store = transaction.objectStore(STORE_SISU_SETTINGS);
    
    return new Promise((resolve, reject) => {
      const request = store.get('config');
      request.onsuccess = () => {
        resolve(request.result || null);
      };
      request.onerror = () => {
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('Error getting SISU settings:', error);
    return null;
  }
}

// Clear SISU settings
async function clearSisuSettings() {
  try {
    const database = await initDB();
    const transaction = database.transaction([STORE_SISU_SETTINGS], 'readwrite');
    const store = transaction.objectStore(STORE_SISU_SETTINGS);
    
    await store.delete('config');
    return true;
  } catch (error) {
    console.error('Error clearing SISU settings:', error);
    return false;
  }
}

// Expose functions globally
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