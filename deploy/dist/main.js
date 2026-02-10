import { APP_VERSION, setVersionOnDom } from "./version.js";
import { registerProfileGlobals, loadProfile } from "./profile.js";
import { registerStorageGlobals } from "./workoutStorage.js";
import { registerZoneGlobals } from "./zoneCalculator.js";
import { registerSummaryGlobals } from "./workoutSummary.js";
import { registerWorkoutDataGlobals, initializeWorkoutPlan } from "./workoutData.js";
import { registerWorkoutLogicGlobals } from "./workoutLogic.js";
import { registerWakeLockGlobals } from "./wakeLock.js";
import { registerVoiceGlobals } from "./voice.js";
import { registerSisuGlobals } from "./sisuSync.js";
import { registerUiGlobals, updateDisplay } from "./uiControls.js";
import { registerPwaGlobals } from "./pwaInstall.js";
function cleanupStaleWorkoutSessions() {
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    days.forEach((day) => {
        const sessionStart = localStorage.getItem(`session_start_${day}`);
        if (sessionStart) {
            const sessionAge = now - parseInt(sessionStart);
            if (sessionAge > MAX_SESSION_AGE_MS) {
                console.warn(`Cleaning up stale workout session for ${day} (age: ${Math.round(sessionAge / (1000 * 60 * 60))} hours)`);
                localStorage.removeItem(`start_${day}`);
                localStorage.removeItem(`session_id_${day}`);
                localStorage.removeItem(`session_start_${day}`);
                localStorage.removeItem(`summary_emitted_${day}`);
                localStorage.removeItem(`paused_${day}`);
                localStorage.removeItem(`paused_elapsed_${day}`);
            }
        }
    });
}
function setupModalBackgroundHandlers() {
    const modalBg = document.getElementById("modalBg");
    const cancelModalBg = document.getElementById("cancelModalBg");
    const workoutSummaryModalBg = document.getElementById("workoutSummaryModalBg");
    if (modalBg) {
        modalBg.addEventListener("click", (e) => {
            if (e.target === modalBg && typeof window.closeModal === "function")
                window.closeModal();
        });
    }
    if (cancelModalBg) {
        cancelModalBg.addEventListener("click", (e) => {
            if (e.target === cancelModalBg && typeof window.closeCancelModal === "function")
                window.closeCancelModal();
        });
    }
    if (workoutSummaryModalBg) {
        workoutSummaryModalBg.addEventListener("click", (e) => {
            if (e.target === workoutSummaryModalBg && typeof window.closeWorkoutSummaryModal === "function")
                window.closeWorkoutSummaryModal();
        });
    }
}
async function bootstrap() {
    registerProfileGlobals();
    registerStorageGlobals();
    registerZoneGlobals();
    registerSummaryGlobals();
    registerWorkoutDataGlobals();
    registerWorkoutLogicGlobals();
    registerWakeLockGlobals();
    registerVoiceGlobals();
    registerSisuGlobals();
    registerPwaGlobals();
    const phaseDisplayEl = document.getElementById("phaseDisplay");
    registerUiGlobals(phaseDisplayEl);
    setVersionOnDom();
    setupModalBackgroundHandlers();
    loadProfile();
    cleanupStaleWorkoutSessions();
    await initializeWorkoutPlan();
    updateDisplay();
    setInterval(updateDisplay, 1000);
    if (typeof window.loadSisuSettings === "function") {
        await window.loadSisuSettings();
    }
}
bootstrap().catch((err) => console.error("Failed to bootstrap app:", err));
window.APP_VERSION = APP_VERSION;
