import { getHrTargets } from "./workoutData.js";
import { todayName } from "./utils/dateTime.js";
import { PlanBlock } from "./types.js";
import { getSession, startSession, pauseSession, resumeSession, clearSession } from "./sessionStore.js";
import { handleWorkoutCancellation } from "./workoutLifecycle.js";

const RING_CIRC = 339.292;
const RING_CIRC_LANDSCAPE = 407.1504;

function getRingCircumference() {
  return window.matchMedia("(orientation: landscape)").matches ? RING_CIRC_LANDSCAPE : RING_CIRC;
}

function getStartTime(day?: string) {
  const dayToUse = day || todayName();
  return getSession(dayToUse).startTime;
}

function isPaused(day?: string) {
  const dayToUse = day || todayName();
  return getSession(dayToUse).paused;
}

function getPausedElapsed(day?: string) {
  const dayToUse = day || todayName();
  return getSession(dayToUse).pausedElapsed;
}

function pauseWorkout(day?: string, elapsedSec?: number) {
  const dayToUse = day || todayName();
  pauseSession(dayToUse, elapsedSec ?? 0);
  if (typeof (window as any).updateDisplay === "function") (window as any).updateDisplay();
}

function resumeWorkout(day?: string) {
  const dayToUse = day || todayName();
  resumeSession(dayToUse);
  if (typeof (window as any).updateDisplay === "function") (window as any).updateDisplay();
}

function startWorkout() {
  const day = typeof (window as any).getSelectedDay === "function" ? (window as any).getSelectedDay() : todayName();
  const startTime = Date.now();
  if (typeof (window as any).generateUUID === "function") {
    const sessionId = (window as any).generateUUID();
    startSession(day, startTime, sessionId);
    if (typeof (window as any).initDB === "function") {
      (window as any).initDB().catch((err: any) => console.error("Failed to init DB:", err));
    }
  } else {
    startSession(day, startTime, null);
  }

  if (typeof (window as any).requestWakeLock === "function") {
    (window as any).requestWakeLock();
  }
  if (typeof (window as any).updateDisplay === "function") (window as any).updateDisplay();
}

async function restartWorkout() {
  const day = typeof (window as any).getSelectedDay === "function" ? (window as any).getSelectedDay() : todayName();
  const session = getSession(day);

  await handleWorkoutCancellation(day);

  if (typeof (window as any).releaseWakeLock === "function") {
    await (window as any).releaseWakeLock();
  }

  clearSession(day);

  if (session.sessionId && typeof (window as any).clearHrSamples === "function") {
    await (window as any).clearHrSamples(session.sessionId).catch((err: any) => console.error("Error clearing HR samples:", err));
  }

  if (typeof (window as any).updateDisplay === "function") (window as any).updateDisplay();
}

function getPhase(elapsedSec: number, blocks: PlanBlock) {
  const w = blocks.warm * 60;
  const s = blocks.sustain * 60;
  const c = blocks.cool * 60;
  if (elapsedSec < w) return { phase: "Warm-Up", timeLeft: w - elapsedSec, done: false };
  if (elapsedSec < w + s) {
    const day = typeof (window as any).getSelectedDay === "function" ? (window as any).getSelectedDay() : todayName();
    const dayHrTargets = getHrTargets()[day];
    if (dayHrTargets && dayHrTargets.intervals && dayHrTargets.intervals.phases) {
      const warmSec = blocks.warm * 60;
      const sustainElapsed = Math.max(0, elapsedSec - warmSec);
      const phases = dayHrTargets.intervals.phases;
      const isSequence = dayHrTargets.intervals.isSequence;
      let elapsedInPhases = sustainElapsed;
      if (isSequence) {
        const totalDuration = phases.reduce((sum, p) => sum + p.duration * 60, 0);
        elapsedInPhases = Math.min(sustainElapsed, totalDuration);
      } else {
        const cycleDuration = phases.reduce((sum, p) => sum + p.duration * 60, 0);
        elapsedInPhases = sustainElapsed % cycleDuration;
      }
      let accumulated = 0;
      for (let i = 0; i < phases.length; i++) {
        const phaseDuration = phases[i].duration * 60;
        if (elapsedInPhases < accumulated + phaseDuration) {
          const timeLeftInPhase = accumulated + phaseDuration - elapsedInPhases;
          return { phase: "Sustain", timeLeft: timeLeftInPhase, done: false };
        }
        accumulated += phaseDuration;
      }
    }
    return { phase: "Sustain", timeLeft: w + s - elapsedSec, done: false };
  }
  if (elapsedSec < w + s + c) return { phase: "Cool-Down", timeLeft: w + s + c - elapsedSec, done: false };
  return { phase: "Completed", timeLeft: 0, done: true };
}

function formatTime(sec: number, options?: { showSeconds?: boolean }) {
  const showSeconds = options && "showSeconds" in options ? !!options.showSeconds : true;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(h + "h");
  parts.push(m + "m");
  if (showSeconds) parts.push(s + "s");
  return parts.join(" ");
}

function getTodayHRV() {
  return null;
}

function adjustedBlockLengths(base: PlanBlock, _hrv: any) {
  return base;
}

function updateRing(elapsedSec: number, blocks: PlanBlock) {
  const ringEl = document.getElementById("ringProgress");
  const center = document.getElementById("ringCenterText");
  if (!(ringEl instanceof SVGCircleElement) || !blocks) return;
  const totalSec = (blocks.warm + blocks.sustain + blocks.cool) * 60;
  if (totalSec <= 0) return;
  const cappedElapsed = Math.max(0, Math.min(elapsedSec, totalSec));
  const remaining = totalSec - cappedElapsed;
  const ringCirc = getRingCircumference();
  const showElapsed = typeof (window as any).getShowElapsed === "function" && (window as any).getShowElapsed();

  if (showElapsed) {
    // Increasing ring: fill as elapsed time grows (phase colors match progress)
    const progress = cappedElapsed / totalSec;
    const offset = ringCirc * (1 - progress);
    ringEl.style.strokeDasharray = String(ringCirc);
    ringEl.style.strokeDashoffset = String(offset);
  } else {
    // Decrementing ring: show remaining portion
    const visibleLength = ringCirc * (remaining / totalSec);
    ringEl.style.strokeDasharray = `${visibleLength} ${ringCirc}`;
    ringEl.style.strokeDashoffset = "0";
  }

  const showSeconds =
    typeof (window as any).getShowSecondsCountdown === "function" && (window as any).getShowSecondsCountdown();
  const labelEl = document.getElementById("ringCenterLabel");
  if (center) center.textContent = formatTime(showElapsed ? cappedElapsed : remaining, { showSeconds });
  if (labelEl) labelEl.textContent = showElapsed ? "total elapsed" : "total remaining";
}

function hrTargetText(phaseName: string, day: string, elapsedSec: number, blocks: PlanBlock) {
  const dayHrTargets = getHrTargets()[day];
  if (!dayHrTargets) return "";
  if (phaseName === "Warm-Up") {
    if (dayHrTargets.warmup_subsections && Array.isArray(dayHrTargets.warmup_subsections)) {
      for (const subsection of dayHrTargets.warmup_subsections) {
        const startSec = subsection.start_min * 60;
        const endSec = subsection.end_min * 60;
        if (elapsedSec >= startSec && elapsedSec < endSec) {
          return subsection.target_hr_bpm + " bpm";
        }
      }
    }
    if (dayHrTargets.warmup) return dayHrTargets.warmup + " bpm";
  } else if (phaseName === "Cool-Down") {
    if (dayHrTargets.cooldown) return dayHrTargets.cooldown + " bpm";
  } else if (phaseName === "Sustain") {
    if (dayHrTargets.intervals && dayHrTargets.intervals.phases) {
      const warmSec = blocks.warm * 60;
      const sustainElapsed = Math.max(0, elapsedSec - warmSec);
      const phases = dayHrTargets.intervals.phases;
      const isSequence = dayHrTargets.intervals.isSequence;
      let elapsedInPhases = sustainElapsed;
      if (isSequence) {
        const totalDuration = phases.reduce((sum, p) => sum + p.duration * 60, 0);
        elapsedInPhases = Math.min(sustainElapsed, totalDuration);
      } else {
        const cycleDuration = phases.reduce((sum, p) => sum + p.duration * 60, 0);
        elapsedInPhases = sustainElapsed % cycleDuration;
      }
      let accumulated = 0;
      for (let i = 0; i < phases.length; i++) {
        const phaseDuration = phases[i].duration * 60;
        if (elapsedInPhases < accumulated + phaseDuration) {
          if (phases[i].target_hr_bpm) return phases[i].target_hr_bpm + " bpm";
          break;
        }
        accumulated += phaseDuration;
      }
    } else if (dayHrTargets.main_set) {
      return dayHrTargets.main_set + " bpm";
    }
  }
  return "";
}

export function registerWorkoutLogicGlobals() {
  (window as any).todayName = todayName;
  (window as any).getStartTime = getStartTime;
  (window as any).isPaused = isPaused;
  (window as any).getPausedElapsed = getPausedElapsed;
  (window as any).pauseWorkout = pauseWorkout;
  (window as any).resumeWorkout = resumeWorkout;
  (window as any).startWorkout = startWorkout;
  (window as any).restartWorkout = restartWorkout;
  (window as any).getPhase = getPhase;
  (window as any).formatTime = formatTime;
  (window as any).getTodayHRV = getTodayHRV;
  (window as any).adjustedBlockLengths = adjustedBlockLengths;
  (window as any).updateRing = updateRing;
  (window as any).hrTargetText = hrTargetText;
}

export {
  todayName,
  getStartTime,
  isPaused,
  getPausedElapsed,
  pauseWorkout,
  resumeWorkout,
  startWorkout,
  restartWorkout,
  getPhase,
  formatTime,
  adjustedBlockLengths,
  updateRing,
  hrTargetText,
};
