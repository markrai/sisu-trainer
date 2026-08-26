import { isActivity } from "./workoutActivity.js";
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
function storageOrBrowser(storage) {
    return storage !== null && storage !== void 0 ? storage : localStorage;
}
function parseStoredActivity(raw) {
    return isActivity(raw) ? raw : undefined;
}
export function getSession(day, storage) {
    const store = storageOrBrowser(storage);
    return {
        startTime: store.getItem("start_" + day),
        sessionId: store.getItem("session_id_" + day),
        sessionStart: store.getItem("session_start_" + day),
        summaryEmitted: store.getItem("summary_emitted_" + day),
        paused: store.getItem("paused_" + day) === "true",
        pausedElapsed: parseInt(store.getItem("paused_elapsed_" + day) || "0", 10),
        activity: parseStoredActivity(store.getItem("activity_" + day)),
    };
}
export function startSession(day, startTime, sessionId, activity, storage) {
    const store = storageOrBrowser(storage);
    store.setItem("start_" + day, String(startTime));
    if (sessionId != null) {
        store.setItem("session_id_" + day, sessionId);
        store.setItem("session_start_" + day, String(startTime));
        store.setItem("summary_emitted_" + day, "false");
    }
    if (activity)
        store.setItem("activity_" + day, activity);
    else
        store.removeItem("activity_" + day);
}
export function pauseSession(day, elapsedSec) {
    localStorage.setItem("paused_" + day, "true");
    localStorage.setItem("paused_elapsed_" + day, String(elapsedSec));
}
export function resumeSession(day) {
    const pausedElapsed = parseInt(localStorage.getItem("paused_elapsed_" + day) || "0", 10);
    const newStart = Date.now() - pausedElapsed * 1000;
    localStorage.setItem("start_" + day, String(newStart));
    localStorage.removeItem("paused_" + day);
    localStorage.removeItem("paused_elapsed_" + day);
}
export function clearSession(day, storage) {
    const store = storageOrBrowser(storage);
    store.removeItem("start_" + day);
    store.removeItem("session_id_" + day);
    store.removeItem("session_start_" + day);
    store.removeItem("summary_emitted_" + day);
    store.removeItem("paused_" + day);
    store.removeItem("paused_elapsed_" + day);
    store.removeItem("activity_" + day);
}
export function markSummaryEmitted(day) {
    localStorage.setItem("summary_emitted_" + day, "true");
}
export function isSessionStale(day) {
    const sessionStart = localStorage.getItem("session_start_" + day);
    if (!sessionStart)
        return true;
    const sessionAge = Date.now() - parseInt(sessionStart);
    return sessionAge > MAX_SESSION_AGE_MS;
}
