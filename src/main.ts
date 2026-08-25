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
import "./hrMonitor.js";
import { registerUiGlobals, updateDisplay } from "./uiControls.js";
import { registerPwaGlobals } from "./pwaInstall.js";
import { getSession, isSessionStale, clearSession } from "./sessionStore.js";
import { applyRuntimeDocumentState } from "./platform/runtime.js";

applyRuntimeDocumentState();

function cleanupStaleWorkoutSessions() {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  days.forEach((day) => {
    const session = getSession(day);
    if (session.sessionStart && isSessionStale(day)) {
      const hours = Math.round((Date.now() - parseInt(session.sessionStart)) / (1000 * 60 * 60));
      console.warn(
        `Cleaning up stale workout session for ${day} (age: ${hours} hours)`
      );
      clearSession(day);
    }
  });
}

function setupModalBackgroundHandlers() {
  const modalBg = document.getElementById("modalBg");
  const cancelModalBg = document.getElementById("cancelModalBg");
  const workoutSummaryModalBg = document.getElementById("workoutSummaryModalBg");
  if (modalBg) {
    modalBg.addEventListener("click", (e) => {
      if (e.target === modalBg && typeof (window as any).closeModal === "function") (window as any).closeModal();
    });
  }
  if (cancelModalBg) {
    cancelModalBg.addEventListener("click", (e) => {
      if (e.target === cancelModalBg && typeof (window as any).closeCancelModal === "function")
        (window as any).closeCancelModal();
    });
  }
  if (workoutSummaryModalBg) {
    workoutSummaryModalBg.addEventListener("click", (e) => {
      if (e.target === workoutSummaryModalBg && typeof (window as any).closeWorkoutSummaryModal === "function")
        (window as any).closeWorkoutSummaryModal();
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
  if (typeof (window as any).loadSisuSettings === "function") {
    await (window as any).loadSisuSettings();
  }
}

bootstrap().catch((err) => console.error("Failed to bootstrap app:", err));

(window as any).APP_VERSION = APP_VERSION;
