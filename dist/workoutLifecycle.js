import { getSession, clearSession, markSummaryEmitted } from "./sessionStore.js";
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
export function handleWorkoutCompletion(day) {
    const session = getSession(day);
    if (session.summaryEmitted !== "false" || typeof window.generateWorkoutSummary !== "function")
        return;
    const sessionId = session.sessionId;
    const sessionStart = session.sessionStart;
    if (!sessionId || !sessionStart)
        return;
    const sessionStartTime = parseInt(sessionStart);
    const sessionAge = Date.now() - sessionStartTime;
    if (sessionAge > MAX_SESSION_AGE_MS) {
        console.warn(`Skipping stale workout session for ${day} on completion (age: ${Math.round(sessionAge / (1000 * 60 * 60))} hours)`);
        clearSession(day);
        return;
    }
    const endedAt = Date.now();
    window
        .generateWorkoutSummary(sessionId, sessionStartTime, endedAt, day)
        .then((summary) => window.emitWorkoutSummary(summary))
        .then(() => {
        markSummaryEmitted(day);
    })
        .catch((error) => {
        console.error("Error emitting workout summary on completion:", error);
        if (error.message && error.message.includes("exceeds maximum")) {
            console.warn("Stale session detected on completion, cleaning up...");
            clearSession(day);
        }
    });
}
export async function handleWorkoutCancellation(day) {
    const session = getSession(day);
    if (!session.startTime ||
        !session.sessionId ||
        !session.sessionStart ||
        session.summaryEmitted !== "false" ||
        typeof window.generateWorkoutSummary !== "function") {
        return;
    }
    const sessionStartTime = parseInt(session.sessionStart);
    const sessionAge = Date.now() - sessionStartTime;
    if (sessionAge > MAX_SESSION_AGE_MS) {
        console.warn(`Skipping stale workout session for ${day} (age: ${Math.round(sessionAge / (1000 * 60 * 60))} hours)`);
        return;
    }
    const endedAt = Date.now();
    try {
        const summary = await window.generateWorkoutSummary(session.sessionId, sessionStartTime, endedAt, day, { cancelled: true });
        await window.emitWorkoutSummary(summary);
    }
    catch (error) {
        console.error("Error emitting workout summary on cancel:", error);
        if (error.message && error.message.includes("exceeds maximum")) {
            console.warn("Stale session detected, cleaning up...");
        }
    }
}
