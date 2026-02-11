const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
export function getSession(day) {
    return {
        startTime: localStorage.getItem("start_" + day),
        sessionId: localStorage.getItem("session_id_" + day),
        sessionStart: localStorage.getItem("session_start_" + day),
        summaryEmitted: localStorage.getItem("summary_emitted_" + day),
        paused: localStorage.getItem("paused_" + day) === "true",
        pausedElapsed: parseInt(localStorage.getItem("paused_elapsed_" + day) || "0", 10),
    };
}
export function startSession(day, startTime, sessionId) {
    localStorage.setItem("start_" + day, String(startTime));
    if (sessionId != null) {
        localStorage.setItem("session_id_" + day, sessionId);
        localStorage.setItem("session_start_" + day, String(startTime));
        localStorage.setItem("summary_emitted_" + day, "false");
    }
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
export function clearSession(day) {
    localStorage.removeItem("start_" + day);
    localStorage.removeItem("session_id_" + day);
    localStorage.removeItem("session_start_" + day);
    localStorage.removeItem("summary_emitted_" + day);
    localStorage.removeItem("paused_" + day);
    localStorage.removeItem("paused_elapsed_" + day);
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
