import { getHrTargets, getPlan, getWorkoutMetadata } from "./workoutData.js";
import { todayName } from "./utils/dateTime.js";
import { Activity, PlanBlock, WorkoutPhaseState } from "./types.js";
import {
  getSession,
  startSession,
  pauseSession,
  resumeSession,
  clearSession,
  getEarlyCooldownElapsed,
  setEarlyCooldownElapsed,
  type SessionData,
  type SessionStorage,
} from "./sessionStore.js";
import { handleWorkoutCancellation } from "./workoutLifecycle.js";
import { resetMachineGuidanceRuntime } from "./machines/runtime.js";
import { getActiveWorkoutActivity, requireAllowedActivity } from "./workoutActivity.js";

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

export type EarlyCooldownDecision =
  | { type: "unavailable" }
  | { type: "already-in-cooldown"; resume: boolean }
  | { type: "enter-early-cooldown"; elapsedSec: number; resume: boolean };

export interface EarlyCooldownRequestOptions {
  storage?: SessionStorage;
  now?: number;
  blocks?: PlanBlock | null;
}

function completedPhase(): WorkoutPhaseState {
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

function cooldownPhase(elapsedSec: number, startSec: number, durationSec: number): WorkoutPhaseState {
  const phaseElapsedSeconds = elapsedSec - startSec;
  if (phaseElapsedSeconds >= durationSec) return completedPhase();
  return {
    phase: "Cool-Down",
    kind: "cooldown",
    phaseId: "cooldown",
    phaseElapsedSeconds,
    phaseDurationSeconds: durationSec,
    timeLeft: durationSec - phaseElapsedSeconds,
    done: false,
  };
}

function actualElapsedSeconds(
  startTime: string | null,
  paused: boolean,
  pausedElapsed: number,
  now: number
): number {
  if (!startTime) return 0;
  if (paused) return pausedElapsed;
  return Math.floor((now - parseInt(startTime, 10)) / 1000);
}

function lastPersistedElapsedFromHrSamples(
  samples: readonly { timestamp_sec: number }[]
): number | undefined {
  let max: number | undefined;
  for (const sample of samples) {
    if (!Number.isFinite(sample.timestamp_sec)) continue;
    if (max === undefined || sample.timestamp_sec > max) max = sample.timestamp_sec;
  }
  return max;
}

function workoutRelativeHrSample(
  session: Pick<SessionData, "startTime" | "sessionId" | "paused" | "pausedElapsed">,
  now = Date.now(),
  lastPersistedElapsed?: number | null
): { elapsedSec: number } | null {
  if (!session.startTime || !session.sessionId || session.paused) return null;
  const elapsedSec = actualElapsedSeconds(session.startTime, false, session.pausedElapsed, now);
  if (lastPersistedElapsed != null && elapsedSec <= lastPersistedElapsed) return null;
  return { elapsedSec };
}

function planEarlyCooldownTransition(input: {
  blocks: PlanBlock | null | undefined;
  hasSession: boolean;
  elapsedSec: number;
  paused: boolean;
  earlyCooldownElapsed?: number | null;
}): EarlyCooldownDecision {
  if (!input.hasSession || !input.blocks || input.blocks.cool <= 0) {
    return { type: "unavailable" };
  }
  const phase = getPhase(input.elapsedSec, input.blocks, input.earlyCooldownElapsed);
  if (phase.done) return { type: "unavailable" };
  if (phase.kind === "cooldown") {
    return { type: "already-in-cooldown", resume: input.paused };
  }
  return { type: "enter-early-cooldown", elapsedSec: input.elapsedSec, resume: input.paused };
}

function resolveEarlyCooldownBlocks(
  day: string,
  blocksOverride?: PlanBlock | null
): PlanBlock | null {
  if (blocksOverride !== undefined) return blocksOverride;
  const base = getPlan()[day];
  return base ? adjustedBlockLengths(base, null) : null;
}

let earlyCooldownInFlight = false;

function requestEarlyCooldown(day?: string, options?: EarlyCooldownRequestOptions): EarlyCooldownDecision {
  if (earlyCooldownInFlight) return { type: "unavailable" };
  earlyCooldownInFlight = true;
  try {
    const dayToUse = day || (typeof (window as any).getSelectedDay === "function" ? (window as any).getSelectedDay() : todayName());
    const storage = options?.storage;
    const now = options?.now ?? Date.now();
    const session = getSession(dayToUse, storage);
    const blocks = resolveEarlyCooldownBlocks(dayToUse, options?.blocks);
    const elapsedSec = actualElapsedSeconds(session.startTime, session.paused, session.pausedElapsed, now);
    const decision = planEarlyCooldownTransition({
      blocks,
      hasSession: Boolean(session.startTime),
      elapsedSec,
      paused: session.paused,
      earlyCooldownElapsed: getEarlyCooldownElapsed(dayToUse, storage),
    });
    if (decision.type === "unavailable") return decision;
    if (decision.type === "enter-early-cooldown") {
      setEarlyCooldownElapsed(dayToUse, decision.elapsedSec, storage);
    }
    if (session.paused) resumeSession(dayToUse, storage, now);
    if (typeof (window as any).requestWakeLock === "function") (window as any).requestWakeLock();
    if (typeof (window as any).updateDisplay === "function") (window as any).updateDisplay();
    return decision;
  } finally {
    earlyCooldownInFlight = false;
  }
}

function startWorkout() {
  const day = typeof (window as any).getSelectedDay === "function" ? (window as any).getSelectedDay() : todayName();
  const allowed = getWorkoutMetadata()[day]?.activities ?? [];
  const automatic = getActiveWorkoutActivity(allowed);
  if (automatic) {
    beginWorkout(automatic);
    return;
  }
  if (allowed.length > 1) {
    if (typeof (window as any).promptWorkoutActivitySelection === "function") {
      (window as any).promptWorkoutActivitySelection(allowed);
    }
    return;
  }
  beginWorkout();
}

function beginWorkout(activity?: Activity) {
  const day = typeof (window as any).getSelectedDay === "function" ? (window as any).getSelectedDay() : todayName();
  const allowed = getWorkoutMetadata()[day]?.activities ?? [];
  const resolved = activity !== undefined
    ? requireAllowedActivity(allowed, activity)
    : getActiveWorkoutActivity(allowed);
  if (allowed.length > 1 && resolved === undefined) return;
  const startTime = Date.now();
  let sessionId: string | null = null;
  if (typeof (window as any).generateUUID === "function") {
    sessionId = (window as any).generateUUID();
    startSession(day, startTime, sessionId, resolved);
    if (typeof (window as any).initDB === "function") {
      (window as any).initDB().catch((err: any) => console.error("Failed to init DB:", err));
    }
  } else {
    startSession(day, startTime, null, resolved);
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

function getPhase(elapsedSec: number, blocks: PlanBlock, earlyCooldownElapsed?: number | null): WorkoutPhaseState {
  const w = blocks.warm * 60;
  const s = blocks.sustain * 60;
  const c = blocks.cool * 60;
  if (
    earlyCooldownElapsed != null &&
    Number.isFinite(earlyCooldownElapsed) &&
    earlyCooldownElapsed >= 0 &&
    c > 0 &&
    elapsedSec >= earlyCooldownElapsed
  ) {
    return cooldownPhase(elapsedSec, earlyCooldownElapsed, c);
  }
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
    return cooldownPhase(elapsedSec, w + s, c);
  }
  return completedPhase();
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
  (window as any).beginWorkout = beginWorkout;
  (window as any).restartWorkout = restartWorkout;
  (window as any).requestEarlyCooldown = requestEarlyCooldown;
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
  beginWorkout,
  restartWorkout,
  requestEarlyCooldown,
  planEarlyCooldownTransition,
  actualElapsedSeconds,
  lastPersistedElapsedFromHrSamples,
  workoutRelativeHrSample,
  getPhase,
  formatTime,
  adjustedBlockLengths,
  updateRing,
  hrTargetText,
  parseHrTargetRange,
};
