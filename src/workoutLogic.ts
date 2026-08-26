import { getHrTargets } from "./workoutData.js";
import { todayName } from "./utils/dateTime.js";
import { PlanBlock, WorkoutPhaseState } from "./types.js";
import { getSession, startSession, pauseSession, resumeSession, clearSession } from "./sessionStore.js";
import { handleWorkoutCancellation } from "./workoutLifecycle.js";
import { resetMachineGuidanceRuntime } from "./machines/runtime.js";

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
  let sessionId: string | null = null;
  if (typeof (window as any).generateUUID === "function") {
    sessionId = (window as any).generateUUID();
    startSession(day, startTime, sessionId);
    if (typeof (window as any).initDB === "function") {
      (window as any).initDB().catch((err: any) => console.error("Failed to init DB:", err));
    }
  } else {
    startSession(day, startTime, null);
  }
  resetMachineGuidanceRuntime(sessionId);

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
  resetMachineGuidanceRuntime();

  if (session.sessionId && typeof (window as any).clearHrSamples === "function") {
    await (window as any).clearHrSamples(session.sessionId).catch((err: any) => console.error("Error clearing HR samples:", err));
  }

  if (typeof (window as any).updateDisplay === "function") (window as any).updateDisplay();
}

function getIntervalRuntime(day: string, sustainElapsed: number) {
  const intervals = getHrTargets()[day]?.intervals;
  if (!intervals || intervals.phases.length === 0) return null;
  const phases = intervals.phases;
  const totalDuration = phases.reduce((sum, phase) => sum + phase.duration * 60, 0);
  if (totalDuration <= 0) return null;
  const cycleIndex = intervals.isSequence ? 0 : Math.floor(sustainElapsed / totalDuration);
  const elapsedInCycle = intervals.isSequence
    ? Math.min(sustainElapsed, Math.max(0, totalDuration - 1))
    : sustainElapsed % totalDuration;
  let accumulated = 0;
  for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
    const interval = phases[phaseIndex];
    const durationSeconds = interval.duration * 60;
    if (elapsedInCycle < accumulated + durationSeconds) {
      const workPhasesThroughCurrent = phases
        .slice(0, phaseIndex + 1)
        .filter((phase) => phase.kind === "work").length;
      return {
        interval,
        phaseIndex,
        phaseElapsedSeconds: elapsedInCycle - accumulated,
        phaseDurationSeconds: durationSeconds,
        intervalIndex: intervals.isSequence ? Math.max(1, workPhasesThroughCurrent) : cycleIndex + 1,
        phaseId: intervals.isSequence ? `sequence:${phaseIndex}` : `cycle:${cycleIndex}:${phaseIndex}`,
      };
    }
    accumulated += durationSeconds;
  }
  return null;
}

function getPhase(elapsedSec: number, blocks: PlanBlock): WorkoutPhaseState {
  const w = blocks.warm * 60;
  const s = blocks.sustain * 60;
  const c = blocks.cool * 60;
  if (elapsedSec < w) {
    return {
      phase: "Warm-Up",
      kind: "warmup",
      phaseId: "warmup",
      phaseElapsedSeconds: elapsedSec,
      phaseDurationSeconds: w,
      timeLeft: w - elapsedSec,
      done: false,
    };
  }
  if (elapsedSec < w + s) {
    const day = typeof (window as any).getSelectedDay === "function" ? (window as any).getSelectedDay() : todayName();
    const sustainElapsed = Math.max(0, elapsedSec - w);
    const intervalRuntime = getIntervalRuntime(day, sustainElapsed);
    if (intervalRuntime) {
      return {
        phase: "Sustain",
        kind: intervalRuntime.interval.kind,
        phaseId: intervalRuntime.phaseId,
        phaseElapsedSeconds: intervalRuntime.phaseElapsedSeconds,
        phaseDurationSeconds: intervalRuntime.phaseDurationSeconds,
        timeLeft: intervalRuntime.phaseDurationSeconds - intervalRuntime.phaseElapsedSeconds,
        done: false,
        detailName: intervalRuntime.interval.phase,
        intervalIndex: intervalRuntime.intervalIndex,
      };
    }
    return {
      phase: "Sustain",
      kind: getHrTargets()[day]?.main_set_kind ?? "work",
      phaseId: "sustain",
      phaseElapsedSeconds: sustainElapsed,
      phaseDurationSeconds: s,
      timeLeft: w + s - elapsedSec,
      done: false,
    };
  }
  if (elapsedSec < w + s + c) {
    const cooldownElapsed = elapsedSec - w - s;
    return {
      phase: "Cool-Down",
      kind: "cooldown",
      phaseId: "cooldown",
      phaseElapsedSeconds: cooldownElapsed,
      phaseDurationSeconds: c,
      timeLeft: w + s + c - elapsedSec,
      done: false,
    };
  }
  return {
    phase: "Completed",
    kind: "completed",
    phaseId: "completed",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 0,
    timeLeft: 0,
    done: true,
  };
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

function parseHrTargetRange(value: string | null | undefined) {
  if (!value) return null;
  const greaterThanCapMatch = value.match(/≥(\d+)\s*\(cap\s*(\d+)\)/);
  if (greaterThanCapMatch) return { min: parseInt(greaterThanCapMatch[1]), max: parseInt(greaterThanCapMatch[2]) };
  const greaterThanMatch = value.match(/≥(\d+)/);
  if (greaterThanMatch) {
    const target = parseInt(greaterThanMatch[1]);
    return { min: target, max: 200 };
  }
  const rangeMatch = value.match(/(\d+)[–-](\d+)/);
  if (rangeMatch) return { min: parseInt(rangeMatch[1]), max: parseInt(rangeMatch[2]) };
  const lessThanMatch = value.match(/<(\d+)/);
  if (lessThanMatch) return { min: 0, max: parseInt(lessThanMatch[1]) - 1 };
  const singleMatch = value.match(/(\d+)/);
  if (!singleMatch) return null;
  const target = parseInt(singleMatch[1]);
  return { min: target - 5, max: target + 5 };
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
      const intervalRuntime = getIntervalRuntime(day, sustainElapsed);
      if (intervalRuntime?.interval.target_hr_bpm) return intervalRuntime.interval.target_hr_bpm + " bpm";
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
  (window as any).parseHrTargetRange = parseHrTargetRange;
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
  parseHrTargetRange,
};
