import { getHrTargets, getPlan, getWorkoutMetadata } from "./workoutData.js";
import { todayName } from "./utils/dateTime.js";
import { Activity, HrTargetsForDay, PlanBlock, WorkoutPhaseState } from "./types.js";
import {
  getSession,
  startSession,
  pauseSession,
  resumeSession,
  clearSession,
  getEarlyCooldownElapsed,
  setEarlyCooldownElapsed,
  persistVo2ProtocolRuntime,
  type PhasePlanSnapshot,
  type SessionData,
  type SessionStorage,
} from "./sessionStore.js";
import { handleWorkoutCancellation } from "./workoutLifecycle.js";
import { resetMachineGuidanceRuntime } from "./machines/runtime.js";
import { getActiveWorkoutActivity, requireAllowedActivity } from "./workoutActivity.js";
import {
  advanceVo2Protocol,
  createVo2ProtocolRuntime,
  evaluateVo2PreflightForUi,
  getVo2ProtocolPhase,
  isVo2WorkoutSelector,
  vo2ProtocolNeedsHrEvaluation,
  vo2ProtocolVoiceCues,
  isStaleVo2ProtocolTick,
  type Vo2ProtocolRuntime,
} from "./vo2Protocol.js";
import { getHrSamples } from "./workoutStorage.js";
import {
  clearBikeTelemetrySamples,
  recordBikeTelemetrySample,
  type TelemetryTraceStorage,
} from "./bikeTelemetryTrace.js";
import type { BikeTelemetrySample } from "./vo2Workload.js";

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

export type Vo2LimitReachedDecision =
  | { type: "unavailable" }
  | { type: "already-in-cooldown"; resume: boolean }
  | { type: "enter-limit-reached"; elapsedSec: number; resume: boolean };

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

/** Authoritative active workout clock (excludes paused time). */
const activeElapsedSeconds = actualElapsedSeconds;


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

/** Record bike telemetry on the same pause-safe active clock as HR / VO₂ protocol elapsed. */
function recordVo2ActiveBikeTelemetry(
  session: Pick<SessionData, "startTime" | "sessionId" | "paused" | "pausedElapsed">,
  metrics: Omit<BikeTelemetrySample, "timestamp_sec">,
  now = Date.now(),
  storage?: TelemetryTraceStorage
): number | null {
  if (!session.sessionId) return null;
  const clock = workoutRelativeHrSample(session, now);
  if (!clock) return null;
  recordBikeTelemetrySample(
    session.sessionId,
    { timestamp_sec: clock.elapsedSec, ...metrics },
    storage
  );
  return clock.elapsedSec;
}

function releaseReplacedSessionTelemetry(day: string, nextSessionId: string | null): void {
  const previousId = getSession(day).sessionId;
  if (previousId && previousId !== nextSessionId) {
    clearBikeTelemetrySamples(previousId);
  }
}

function planEarlyCooldownTransition(input: {
  blocks: PlanBlock | null | undefined;
  hasSession: boolean;
  elapsedSec: number;
  paused: boolean;
  earlyCooldownElapsed?: number | null;
  vo2Protocol?: Vo2ProtocolRuntime | null;
}): EarlyCooldownDecision {
  if (!input.hasSession || !input.blocks || input.blocks.cool <= 0) {
    return { type: "unavailable" };
  }
  const phase = getPhase(input.elapsedSec, input.blocks, input.earlyCooldownElapsed, {
    vo2Protocol: input.vo2Protocol,
  });
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
  const snapshot = getSession(day).phasePlan;
  if (snapshot?.blocks) return snapshot.blocks;
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
      vo2Protocol: session.vo2ProtocolRuntime,
    });
    if (decision.type === "unavailable") return decision;
    if (decision.type === "enter-early-cooldown") {
      setEarlyCooldownElapsed(dayToUse, decision.elapsedSec, storage);
      tickVo2Protocol(dayToUse, decision.elapsedSec, false, storage);
    }
    if (session.paused) resumeSession(dayToUse, storage, now);
    if (typeof (window as any).requestWakeLock === "function") (window as any).requestWakeLock();
    if (typeof (window as any).updateDisplay === "function") (window as any).updateDisplay();
    return decision;
  } finally {
    earlyCooldownInFlight = false;
  }
}

let vo2LimitReachedInFlight = false;

function requestVo2LimitReached(day?: string, options?: EarlyCooldownRequestOptions): Vo2LimitReachedDecision {
  if (vo2LimitReachedInFlight) return { type: "unavailable" };
  vo2LimitReachedInFlight = true;
  try {
    const dayToUse = day || (typeof (window as any).getSelectedDay === "function" ? (window as any).getSelectedDay() : todayName());
    if (!isVo2WorkoutSelector(dayToUse)) return { type: "unavailable" };
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
      vo2Protocol: session.vo2ProtocolRuntime,
    });
    if (decision.type === "unavailable") return decision;
    if (decision.type === "already-in-cooldown") return decision;
    markVo2ProtocolLimitReached(dayToUse, decision.elapsedSec, storage);
    if (session.paused) resumeSession(dayToUse, storage, now);
    if (typeof (window as any).requestWakeLock === "function") (window as any).requestWakeLock();
    if (typeof (window as any).updateDisplay === "function") (window as any).updateDisplay();
    return { type: "enter-limit-reached", elapsedSec: decision.elapsedSec, resume: session.paused };
  } finally {
    vo2LimitReachedInFlight = false;
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

/** Freeze the plan inputs the live runtime will use for this session. */
function capturePhasePlanSnapshot(day: string): PhasePlanSnapshot | null {
  const base = getPlan()[day];
  if (!base) return null;
  const blocks = adjustedBlockLengths(base, null);
  const hrTargets = getHrTargets()[day] ?? null;
  return {
    blocks: { warm: blocks.warm, sustain: blocks.sustain, cool: blocks.cool },
    hrTargets: hrTargets ? JSON.parse(JSON.stringify(hrTargets)) : null,
  };
}

function beginWorkout(activity?: Activity) {
  const day = typeof (window as any).getSelectedDay === "function" ? (window as any).getSelectedDay() : todayName();
  if (isVo2WorkoutSelector(day)) {
    const preflight = evaluateVo2PreflightForUi();
    if (preflight.ok === false) {
      if (typeof (window as any).showToast === "function") {
        (window as any).showToast(preflight.message, "error");
      }
      return;
    }
    const allowed = getWorkoutMetadata()[day]?.activities ?? [];
    const resolved = activity !== undefined
      ? requireAllowedActivity(allowed, activity)
      : getActiveWorkoutActivity(allowed);
    if (allowed.length > 1 && resolved === undefined) return;
    const startTime = Date.now();
    const phasePlan = capturePhasePlanSnapshot(day);
    const runtime = createVo2ProtocolRuntime(preflight.plan);
    let sessionId: string | null = null;
    if (typeof (window as any).generateUUID === "function") {
      sessionId = (window as any).generateUUID();
      releaseReplacedSessionTelemetry(day, sessionId);
      startSession(day, startTime, sessionId, resolved, undefined, phasePlan);
    } else {
      releaseReplacedSessionTelemetry(day, null);
      startSession(day, startTime, null, resolved, undefined, phasePlan);
    }
    persistVo2ProtocolRuntime(day, runtime);
    resetMachineGuidanceRuntime(sessionId);
    if (typeof (window as any).initDB === "function") {
      (window as any).initDB().catch((err: any) => console.error("Failed to init DB:", err));
    }
    if (typeof (window as any).requestWakeLock === "function") {
      (window as any).requestWakeLock();
    }
    if (typeof (window as any).updateDisplay === "function") (window as any).updateDisplay();
    return;
  }
  const allowed = getWorkoutMetadata()[day]?.activities ?? [];
  const resolved = activity !== undefined
    ? requireAllowedActivity(allowed, activity)
    : getActiveWorkoutActivity(allowed);
  if (allowed.length > 1 && resolved === undefined) return;
  const startTime = Date.now();
  const phasePlan = capturePhasePlanSnapshot(day);
  let sessionId: string | null = null;
  if (typeof (window as any).generateUUID === "function") {
    sessionId = (window as any).generateUUID();
    releaseReplacedSessionTelemetry(day, sessionId);
    startSession(day, startTime, sessionId, resolved, undefined, phasePlan);
    if (typeof (window as any).initDB === "function") {
      (window as any).initDB().catch((err: any) => console.error("Failed to init DB:", err));
    }
  } else {
    releaseReplacedSessionTelemetry(day, null);
    startSession(day, startTime, null, resolved, undefined, phasePlan);
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
  const elapsedSec = actualElapsedSeconds(session.startTime, session.paused, session.pausedElapsed, Date.now());
  markVo2ProtocolCancelled(day, elapsedSec);

  await handleWorkoutCancellation(day);

  if (typeof (window as any).releaseWakeLock === "function") {
    await (window as any).releaseWakeLock();
  }

  clearSession(day);
  resetMachineGuidanceRuntime();

  if (session.sessionId) {
    clearBikeTelemetrySamples(session.sessionId);
    if (typeof (window as any).clearHrSamples === "function") {
      await (window as any).clearHrSamples(session.sessionId).catch((err: any) => console.error("Error clearing HR samples:", err));
    }
  }

  if (typeof (window as any).updateDisplay === "function") (window as any).updateDisplay();
}

export interface GetPhaseOptions {
  day?: string;
  hrTargets?: HrTargetsForDay | null;
  vo2Protocol?: Vo2ProtocolRuntime | null;
}

function resolveDayHrTargets(day: string, hrTargets?: HrTargetsForDay | null): HrTargetsForDay | null | undefined {
  return hrTargets !== undefined ? hrTargets : getHrTargets()[day];
}

function getIntervalRuntime(
  day: string,
  sustainElapsed: number,
  hrTargets?: HrTargetsForDay | null
) {
  const intervals = resolveDayHrTargets(day, hrTargets)?.intervals;
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

function resolveVo2ProtocolRuntime(day: string, options?: GetPhaseOptions): Vo2ProtocolRuntime | null | undefined {
  if (options && Object.prototype.hasOwnProperty.call(options, "vo2Protocol")) return options.vo2Protocol;
  if (!isVo2WorkoutSelector(day)) return undefined;
  return getSession(day).vo2ProtocolRuntime;
}

function getPhase(
  elapsedSec: number,
  blocks: PlanBlock,
  earlyCooldownElapsed?: number | null,
  options?: GetPhaseOptions
): WorkoutPhaseState {
  const day =
    options?.day ??
    (typeof (window as any).getSelectedDay === "function" ? (window as any).getSelectedDay() : todayName());
  const vo2Runtime = resolveVo2ProtocolRuntime(day, options);
  if (vo2Runtime) return getVo2ProtocolPhase(elapsedSec, vo2Runtime, earlyCooldownElapsed);
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
    const day =
      options?.day ??
      (typeof (window as any).getSelectedDay === "function" ? (window as any).getSelectedDay() : todayName());
    const dayHrTargets = resolveDayHrTargets(day, options?.hrTargets);
    const sustainElapsed = Math.max(0, elapsedSec - w);
    const intervalRuntime = getIntervalRuntime(day, sustainElapsed, dayHrTargets);
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
      kind: dayHrTargets?.main_set_kind ?? "work",
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

function tickVo2Protocol(
  day: string,
  elapsedSec: number,
  paused: boolean,
  storage?: SessionStorage,
  samples: readonly { timestamp_sec: number; hr: number }[] = []
): { runtime: Vo2ProtocolRuntime; cues: string[] } | null {
  const session = getSession(day, storage);
  if (!session.vo2ProtocolRuntime) return null;
  const before = session.vo2ProtocolRuntime;
  if (isStaleVo2ProtocolTick(before, elapsedSec)) {
    return { runtime: before, cues: [] };
  }
  const next = advanceVo2Protocol(before, {
    elapsedSec,
    paused,
    samples,
    earlyCooldownElapsed: getEarlyCooldownElapsed(day, storage),
  });
  persistVo2ProtocolRuntime(day, next, storage);
  return { runtime: next, cues: vo2ProtocolVoiceCues(before, next, elapsedSec) };
}

async function tickVo2ProtocolWithCanonicalHr(
  day: string,
  elapsedSec: number,
  paused: boolean,
  storage?: SessionStorage
): Promise<{ runtime: Vo2ProtocolRuntime; cues: string[] } | null> {
  const session = getSession(day, storage);
  if (!session.vo2ProtocolRuntime) return null;
  let samples: { timestamp_sec: number; hr: number }[] = [];
  if (
    session.sessionId &&
    vo2ProtocolNeedsHrEvaluation(session.vo2ProtocolRuntime, elapsedSec, paused)
  ) {
    samples = await getHrSamples(session.sessionId);
  }
  return tickVo2Protocol(day, elapsedSec, paused, storage, samples);
}

function markVo2ProtocolCancelled(
  day: string,
  elapsedSec: number,
  storage?: SessionStorage
): void {
  const session = getSession(day, storage);
  if (!session.vo2ProtocolRuntime) return;
  persistVo2ProtocolRuntime(
    day,
    advanceVo2Protocol(session.vo2ProtocolRuntime, {
      elapsedSec,
      paused: session.paused,
      samples: [],
      cancelled: true,
    }),
    storage
  );
}

function markVo2ProtocolLimitReached(
  day: string,
  elapsedSec: number,
  storage?: SessionStorage
): void {
  const session = getSession(day, storage);
  if (!session.vo2ProtocolRuntime) return;
  persistVo2ProtocolRuntime(
    day,
    advanceVo2Protocol(session.vo2ProtocolRuntime, {
      elapsedSec,
      paused: session.paused,
      samples: [],
      limitReached: true,
    }),
    storage
  );
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

function hrTargetText(
  phaseName: string,
  day: string,
  elapsedSec: number,
  blocks: PlanBlock,
  hrTargets?: HrTargetsForDay | null
) {
  const dayHrTargets = resolveDayHrTargets(day, hrTargets);
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
      const intervalRuntime = getIntervalRuntime(day, sustainElapsed, dayHrTargets);
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
  (window as any).requestVo2LimitReached = requestVo2LimitReached;
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
  requestVo2LimitReached,
  planEarlyCooldownTransition,
  actualElapsedSeconds,
  activeElapsedSeconds,
  lastPersistedElapsedFromHrSamples,
  workoutRelativeHrSample,
  recordVo2ActiveBikeTelemetry,
  capturePhasePlanSnapshot,
  getPhase,
  formatTime,
  adjustedBlockLengths,
  updateRing,
  hrTargetText,
  parseHrTargetRange,
  tickVo2Protocol,
  tickVo2ProtocolWithCanonicalHr,
  markVo2ProtocolCancelled,
  markVo2ProtocolLimitReached,
};
