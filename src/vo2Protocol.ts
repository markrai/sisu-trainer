import {
  VO2_PROTOCOL_ID,
  VO2_PROTOCOL_VERSION,
  type PlanBlock,
  type Vo2ProtocolEvidence,
  type Vo2ProtocolStageEvidence,
  type Vo2ProtocolStageHrEvidence,
  type Vo2ProtocolStageStatus,
  type Vo2ProtocolTerminationReason,
  type WorkoutMetadata,
  type WorkoutPhaseState,
} from "./types.js";
export { VO2_PROTOCOL_ID, VO2_PROTOCOL_VERSION } from "./types.js";
import { getEstimatedWattsAt70Rpm, AUTOMATIC_RESISTANCE_MIN, AUTOMATIC_RESISTANCE_MAX } from "./machines/proformSmartPower10.js";
import type { MachineId } from "./machines/trace.js";
import { getMachineDefinition } from "./machines/registry.js";
import { getSelectedMachineId } from "./machines/selection.js";
import { summarizeVo2StageWorkload, VO2_PRESCRIBED_CADENCE_RPM, type BikeTelemetrySample } from "./vo2Workload.js";

export { VO2_PRESCRIBED_CADENCE_RPM };
export const VO2_WORKOUT_SELECTOR_ID = "VO2MaxEstimation";
export const VO2_WORKOUT_LABEL = "VO2 Max Estimation";
export const VO2_WORKOUT_INTENT = "vo2_estimation";
export const VO2_WARMUP_DURATION_SEC = 300;
export const VO2_COOLDOWN_DURATION_SEC = 300;
export const VO2_NOMINAL_STAGE_DURATION_SEC = 180;
export const VO2_MAX_EXTENSION_MINUTES = 2;
export const VO2_MAX_STAGE_DURATION_SEC = 300;
export const VO2_MIN_HR_SAMPLES_PER_WINDOW = 45;
export const VO2_STEADY_STATE_DELTA_BPM = 5;
export const VO2_TARGET_WORK_STAGES = 3;
export const VO2_MAX_WORK_STAGES = 4;
export const VO2_NOMINAL_WATT_STEP = 25;
export const VO2_HR_FRESHNESS_MS = 3000;
export const VO2_UPCOMING_RESISTANCE_LEAD_SEC = 10;
export const VO2_CALIBRATION_MACHINE_ID = "proform-smart-power-10";
/** Protocol-v1 end-to-end commandable ceiling. Not the physical bike maximum. */
export const VO2_PROTOCOL_MAX_RESISTANCE = 10;
export const VO2_EVAL_RELATIVE_SECONDS = [0, 180, 240, 300] as const;
const VO2_TERMINATION_REASONS: readonly Vo2ProtocolTerminationReason[] = [
  "protocol_complete",
  "submax_hr_ceiling",
  "early_cooldown",
  "limit_reached",
  "user_cancelled",
  "hr_lost",
  "insufficient_calibrated_workloads",
  "other",
];

export interface Vo2ResolvedWorkload {
  requested_watts: number;
  prescribed_resistance: number;
  calibrated_watts_at_70rpm: number;
}

export interface Vo2ProtocolPlan {
  protocol_id: typeof VO2_PROTOCOL_ID;
  protocol_version: typeof VO2_PROTOCOL_VERSION;
  prescribed_cadence_rpm: typeof VO2_PRESCRIBED_CADENCE_RPM;
  warmup_resistance: number;
  warmup_calibrated_watts_at_70rpm: number;
  warmup_duration_sec: number;
  cooldown_duration_sec: number;
  workloads: Vo2ResolvedWorkload[];
}

export interface Vo2ProtocolStageRuntime {
  stage_id: string;
  workloadIndex: number;
  active_start_sec: number;
  active_end_sec: number | null;
  extensions: number;
  status: Vo2ProtocolStageStatus | "open";
  last_eval_relative_sec: number;
  hr?: Vo2ProtocolStageHrEvidence;
  upcoming_announced: boolean;
  extension_announced: boolean;
}

export interface Vo2ProtocolRuntime {
  plan: Vo2ProtocolPlan;
  segment: "warmup" | "work" | "cooldown" | "complete";
  stages: Vo2ProtocolStageRuntime[];
  cooldown_start_sec: number | null;
  termination?: { reason: Vo2ProtocolTerminationReason };
  start_announced: boolean;
  upcoming_warmup_announced: boolean;
}

export type Vo2WattsLookup = (resistance: number) => number | undefined;

export function isVo2WorkoutSelector(day: string | null | undefined): boolean {
  return day === VO2_WORKOUT_SELECTOR_ID;
}

export function vo2PlanBlocks(): PlanBlock {
  return {
    warm: VO2_WARMUP_DURATION_SEC / 60,
    sustain: (VO2_MAX_WORK_STAGES * VO2_MAX_STAGE_DURATION_SEC) / 60,
    cool: VO2_COOLDOWN_DURATION_SEC / 60,
  };
}

export function vo2WorkoutMetadata(): WorkoutMetadata {
  return {
    type: VO2_WORKOUT_LABEL,
    intent: VO2_WORKOUT_INTENT,
    activities: ["bike"],
  };
}

export function listCalibrated70RpmWorkloads(
  getWatts: Vo2WattsLookup = getEstimatedWattsAt70Rpm
): Vo2ResolvedWorkload[] {
  const list: Vo2ResolvedWorkload[] = [];
  const maxResistance = Math.min(AUTOMATIC_RESISTANCE_MAX, VO2_PROTOCOL_MAX_RESISTANCE);
  for (let resistance = AUTOMATIC_RESISTANCE_MIN; resistance <= maxResistance; resistance++) {
    const watts = getWatts(resistance);
    if (watts == null || !Number.isFinite(watts) || watts <= 0) continue;
    list.push({
      requested_watts: watts,
      prescribed_resistance: resistance,
      calibrated_watts_at_70rpm: watts,
    });
  }
  return list;
}

export function resolveNearestCalibratedWorkload(
  targetWatts: number,
  options?: {
    getWatts?: Vo2WattsLookup;
    usedResistances?: ReadonlySet<number>;
    minWattsExclusive?: number;
  }
): Vo2ResolvedWorkload | undefined {
  const getWatts = options?.getWatts ?? getEstimatedWattsAt70Rpm;
  const used = options?.usedResistances ?? new Set<number>();
  const minWatts = options?.minWattsExclusive ?? 0;
  const candidates = listCalibrated70RpmWorkloads(getWatts).filter(
    (entry) => !used.has(entry.prescribed_resistance) && entry.calibrated_watts_at_70rpm > minWatts
  );
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => {
    const da = Math.abs(a.calibrated_watts_at_70rpm - targetWatts);
    const db = Math.abs(b.calibrated_watts_at_70rpm - targetWatts);
    if (da !== db) return da - db;
    return a.prescribed_resistance - b.prescribed_resistance;
  });
  const best = candidates[0];
  return {
    requested_watts: targetWatts,
    prescribed_resistance: best.prescribed_resistance,
    calibrated_watts_at_70rpm: best.calibrated_watts_at_70rpm,
  };
}

export function resolveProtocolWorkloads(
  getWatts: Vo2WattsLookup = getEstimatedWattsAt70Rpm,
  maxStages = VO2_MAX_WORK_STAGES
): Vo2ResolvedWorkload[] {
  const calibrated = listCalibrated70RpmWorkloads(getWatts);
  if (calibrated.length === 0) return [];
  const warmup = calibrated[0];
  const used = new Set<number>([warmup.prescribed_resistance]);
  const resolved: Vo2ResolvedWorkload[] = [];
  let lastWatts = warmup.calibrated_watts_at_70rpm;
  while (resolved.length < maxStages) {
    const requested = lastWatts + VO2_NOMINAL_WATT_STEP;
    const next = resolveNearestCalibratedWorkload(requested, {
      getWatts,
      usedResistances: used,
      minWattsExclusive: lastWatts,
    });
    if (!next) break;
    used.add(next.prescribed_resistance);
    lastWatts = next.calibrated_watts_at_70rpm;
    resolved.push(next);
  }
  return resolved;
}

export function buildVo2ProtocolPlan(getWatts: Vo2WattsLookup = getEstimatedWattsAt70Rpm): Vo2ProtocolPlan | undefined {
  const calibrated = listCalibrated70RpmWorkloads(getWatts);
  if (calibrated.length === 0) return undefined;
  const easiest = calibrated[0];
  const workloads = resolveProtocolWorkloads(getWatts, VO2_MAX_WORK_STAGES);
  if (workloads.length < VO2_TARGET_WORK_STAGES) return undefined;
  return {
    protocol_id: VO2_PROTOCOL_ID,
    protocol_version: VO2_PROTOCOL_VERSION,
    prescribed_cadence_rpm: VO2_PRESCRIBED_CADENCE_RPM,
    warmup_resistance: easiest.prescribed_resistance,
    warmup_calibrated_watts_at_70rpm: easiest.calibrated_watts_at_70rpm,
    warmup_duration_sec: VO2_WARMUP_DURATION_SEC,
    cooldown_duration_sec: VO2_COOLDOWN_DURATION_SEC,
    workloads,
  };
}

export function createVo2ProtocolRuntime(plan: Vo2ProtocolPlan): Vo2ProtocolRuntime {
  return {
    plan,
    segment: "warmup",
    stages: [],
    cooldown_start_sec: null,
    start_announced: false,
    upcoming_warmup_announced: false,
  };
}

export type Vo2PreflightOk = { ok: true; plan: Vo2ProtocolPlan };
export type Vo2PreflightFail = { ok: false; reason: string; message: string };
export type Vo2PreflightResult = Vo2PreflightOk | Vo2PreflightFail;

export function evaluateVo2Preflight(input: {
  hrDeviceConnected: boolean;
  liveBpm: number | null | undefined;
  lastBpmUpdateTime: number | null | undefined;
  now?: number;
  activityMachineId?: MachineId;
  getWatts?: Vo2WattsLookup;
}): Vo2PreflightResult {
  const now = input.now ?? Date.now();
  const hrFresh =
    input.hrDeviceConnected &&
    input.liveBpm != null &&
    input.liveBpm > 0 &&
    input.lastBpmUpdateTime != null &&
    now - input.lastBpmUpdateTime <= VO2_HR_FRESHNESS_MS;
  if (!hrFresh) {
    return { ok: false, reason: "hr_required", message: "Heart-rate strap required" };
  }
  const machineId = input.activityMachineId;
  if (!machineId) {
    return { ok: false, reason: "no_machine", message: "No calibrated 70 RPM bike profile selected" };
  }
  const machine = getMachineDefinition(machineId);
  if (!machine || machine.activity !== "bike" || machine.id !== VO2_CALIBRATION_MACHINE_ID) {
    return { ok: false, reason: "no_machine", message: "No calibrated 70 RPM bike profile selected" };
  }
  const plan = buildVo2ProtocolPlan(input.getWatts);
  if (!plan) {
    return { ok: false, reason: "insufficient_workloads", message: "Not enough calibrated workload levels for this test" };
  }
  return { ok: true, plan };
}

export function evaluateVo2PreflightForUi(now = Date.now()): Vo2PreflightResult {
  return evaluateVo2Preflight({
    hrDeviceConnected: Boolean((window as any).hrDeviceName),
    liveBpm: (window as any).liveBpm as number | null,
    lastBpmUpdateTime: (window as any).lastBpmUpdateTime as number | null,
    now,
    activityMachineId: getSelectedMachineId("bike"),
  });
}

function validHrSamplesInWindow(
  samples: readonly { timestamp_sec: number; hr: number }[],
  startInclusive: number,
  endInclusive: number
): number[] {
  const values: number[] = [];
  for (const sample of samples) {
    if (!Number.isFinite(sample.timestamp_sec) || !Number.isFinite(sample.hr) || sample.hr <= 0) continue;
    if (sample.timestamp_sec < startInclusive || sample.timestamp_sec > endInclusive) continue;
    values.push(sample.hr);
  }
  return values;
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export interface Vo2StageHrEvaluation {
  ready: boolean;
  sample_count: number;
  minute_2_mean_bpm?: number;
  minute_3_mean_bpm?: number;
  final_two_window_delta_bpm?: number;
  steady_state_bpm?: number;
  coverage_ok: boolean;
  steady: boolean;
}

export function stageWindowBounds(
  stageStartSec: number,
  relativeEvalSec: number
): { firstStart: number; firstEnd: number; secondStart: number; secondEnd: number } | undefined {
  if (relativeEvalSec < VO2_NOMINAL_STAGE_DURATION_SEC) return undefined;
  if (relativeEvalSec >= VO2_MAX_STAGE_DURATION_SEC) {
    return {
      firstStart: stageStartSec + 180,
      firstEnd: stageStartSec + 239,
      secondStart: stageStartSec + 240,
      secondEnd: stageStartSec + 299,
    };
  }
  if (relativeEvalSec >= 240) {
    return {
      firstStart: stageStartSec + 120,
      firstEnd: stageStartSec + 179,
      secondStart: stageStartSec + 180,
      secondEnd: stageStartSec + 239,
    };
  }
  return {
    firstStart: stageStartSec + 60,
    firstEnd: stageStartSec + 119,
    secondStart: stageStartSec + 120,
    secondEnd: stageStartSec + 179,
  };
}

export function evaluateStageHr(
  samples: readonly { timestamp_sec: number; hr: number }[],
  stageStartSec: number,
  elapsedSec: number
): Vo2StageHrEvaluation {
  const relative = elapsedSec - stageStartSec;
  const bounds = stageWindowBounds(stageStartSec, relative);
  if (!bounds) {
    return { ready: false, sample_count: 0, coverage_ok: false, steady: false };
  }
  const first = validHrSamplesInWindow(samples, bounds.firstStart, bounds.firstEnd);
  const second = validHrSamplesInWindow(samples, bounds.secondStart, bounds.secondEnd);
  const all = validHrSamplesInWindow(samples, stageStartSec, elapsedSec);
  const coverage_ok =
    first.length >= VO2_MIN_HR_SAMPLES_PER_WINDOW && second.length >= VO2_MIN_HR_SAMPLES_PER_WINDOW;
  const minute_2_mean_bpm = mean(first);
  const minute_3_mean_bpm = mean(second);
  const delta =
    minute_2_mean_bpm != null && minute_3_mean_bpm != null
      ? Math.abs(minute_3_mean_bpm - minute_2_mean_bpm)
      : undefined;
  const steady = coverage_ok && delta != null && delta <= VO2_STEADY_STATE_DELTA_BPM;
  return {
    ready: true,
    sample_count: all.length,
    minute_2_mean_bpm,
    minute_3_mean_bpm,
    final_two_window_delta_bpm: delta,
    steady_state_bpm: steady ? minute_3_mean_bpm : undefined,
    coverage_ok,
    steady,
  };
}

function cloneRuntime(runtime: Vo2ProtocolRuntime): Vo2ProtocolRuntime {
  return JSON.parse(JSON.stringify(runtime)) as Vo2ProtocolRuntime;
}

function acceptedCount(runtime: Vo2ProtocolRuntime): number {
  return runtime.stages.filter((stage) => stage.status === "accepted").length;
}

function openStage(runtime: Vo2ProtocolRuntime): Vo2ProtocolStageRuntime | undefined {
  return runtime.stages.find((stage) => stage.status === "open");
}

function enterCooldown(runtime: Vo2ProtocolRuntime, elapsedSec: number, reason: Vo2ProtocolTerminationReason): void {
  const open = openStage(runtime);
  if (open && open.active_end_sec == null) {
    open.active_end_sec = Math.max(open.active_start_sec, elapsedSec);
    if (open.status === "open") open.status = "incomplete";
  }
  runtime.segment = "cooldown";
  runtime.cooldown_start_sec = elapsedSec;
  if (!runtime.termination) runtime.termination = { reason };
}

function startNextStage(runtime: Vo2ProtocolRuntime, elapsedSec: number): boolean {
  const index = runtime.stages.length;
  if (index >= runtime.plan.workloads.length || index >= VO2_MAX_WORK_STAGES) return false;
  if (index >= VO2_TARGET_WORK_STAGES && acceptedCount(runtime) >= VO2_TARGET_WORK_STAGES) return false;
  runtime.segment = "work";
  runtime.stages.push({
    stage_id: `vo2-stage:${index + 1}`,
    workloadIndex: index,
    active_start_sec: elapsedSec,
    active_end_sec: null,
    extensions: 0,
    status: "open",
    last_eval_relative_sec: 0,
    upcoming_announced: false,
    extension_announced: false,
  });
  return true;
}

function closeOpenStage(
  runtime: Vo2ProtocolRuntime,
  elapsedSec: number,
  status: Vo2ProtocolStageStatus,
  hr?: Vo2ProtocolStageHrEvidence
): void {
  const open = openStage(runtime);
  if (!open) return;
  open.active_end_sec = Math.max(open.active_start_sec, elapsedSec);
  open.status = status;
  if (hr) open.hr = hr;
}

function evalAtRelative(relative: number): number {
  if (relative >= VO2_MAX_STAGE_DURATION_SEC) return VO2_MAX_STAGE_DURATION_SEC;
  if (relative >= 240) return 240;
  if (relative >= VO2_NOMINAL_STAGE_DURATION_SEC) return VO2_NOMINAL_STAGE_DURATION_SEC;
  return 0;
}

export function vo2ProtocolNeedsHrEvaluation(
  runtime: Vo2ProtocolRuntime | null | undefined,
  elapsedSec: number,
  paused: boolean
): boolean {
  if (!runtime || paused || runtime.segment !== "work") return false;
  const open = openStage(runtime);
  if (!open) return false;
  const relative = Math.max(0, Math.floor(elapsedSec) - open.active_start_sec);
  const evalAt = evalAtRelative(relative);
  return evalAt > 0 && evalAt > open.last_eval_relative_sec;
}

export function isStaleVo2ProtocolTick(runtime: Vo2ProtocolRuntime, elapsedSec: number): boolean {
  const elapsed = Math.max(0, Math.floor(elapsedSec));
  for (const stage of runtime.stages) {
    if (stage.active_start_sec > elapsed) return true;
    if (stage.active_end_sec != null && stage.active_end_sec > elapsed) return true;
  }
  if (runtime.cooldown_start_sec != null && runtime.cooldown_start_sec > elapsed) return true;
  return false;
}

export interface AdvanceVo2ProtocolInput {
  elapsedSec: number;
  paused: boolean;
  samples: readonly { timestamp_sec: number; hr: number }[];
  earlyCooldownElapsed?: number | null;
  cancelled?: boolean;
  limitReached?: boolean;
}

export function advanceVo2Protocol(runtime: Vo2ProtocolRuntime, input: AdvanceVo2ProtocolInput): Vo2ProtocolRuntime {
  const next = cloneRuntime(runtime);
  const elapsed = Math.max(0, Math.floor(input.elapsedSec));
  if (!input.paused && !next.start_announced) next.start_announced = true;
  if (
    next.segment === "warmup" &&
    elapsed >= Math.max(0, next.plan.warmup_duration_sec - VO2_UPCOMING_RESISTANCE_LEAD_SEC)
  ) {
    next.upcoming_warmup_announced = true;
  }
  if (input.cancelled) {
    if (next.segment !== "complete") {
      const open = openStage(next);
      if (open && open.active_end_sec == null) {
        open.active_end_sec = Math.max(open.active_start_sec, elapsed);
        if (open.status === "open") open.status = "incomplete";
      }
      if (!next.termination) next.termination = { reason: "user_cancelled" };
      if (next.segment === "warmup" || next.segment === "work") {
        next.segment = "complete";
      }
    }
    return next;
  }
  if (input.limitReached && next.segment !== "cooldown" && next.segment !== "complete") {
    enterCooldown(next, elapsed, "limit_reached");
    return next;
  }
  if (
    input.earlyCooldownElapsed != null &&
    Number.isFinite(input.earlyCooldownElapsed) &&
    next.segment !== "cooldown" &&
    next.segment !== "complete"
  ) {
    enterCooldown(next, Math.floor(input.earlyCooldownElapsed), "early_cooldown");
    return next;
  }
  if (next.segment === "complete" || input.paused) return next;

  if (next.segment === "warmup") {
    if (elapsed >= next.plan.warmup_duration_sec) {
      if (!startNextStage(next, elapsed)) {
        enterCooldown(next, elapsed, "insufficient_calibrated_workloads");
      }
    }
    return next;
  }

  if (next.segment === "work") {
    const open = openStage(next);
    if (!open) {
      enterCooldown(next, elapsed, "protocol_complete");
      return next;
    }
    const relative = elapsed - open.active_start_sec;
    const plannedDuration = VO2_NOMINAL_STAGE_DURATION_SEC + open.extensions * 60;
    if (relative >= plannedDuration - VO2_UPCOMING_RESISTANCE_LEAD_SEC) {
      open.upcoming_announced = true;
    }
    const evalAt = evalAtRelative(relative);
    if (evalAt > 0 && evalAt > open.last_eval_relative_sec) {
      open.last_eval_relative_sec = evalAt;
      const evaluation = evaluateStageHr(input.samples, open.active_start_sec, open.active_start_sec + evalAt);
      const hr: Vo2ProtocolStageHrEvidence = {
        sample_count: evaluation.sample_count,
      };
      if (evaluation.minute_2_mean_bpm != null) hr.minute_2_mean_bpm = evaluation.minute_2_mean_bpm;
      if (evaluation.minute_3_mean_bpm != null) hr.minute_3_mean_bpm = evaluation.minute_3_mean_bpm;
      if (evaluation.final_two_window_delta_bpm != null) {
        hr.final_two_window_delta_bpm = evaluation.final_two_window_delta_bpm;
      }
      if (evaluation.steady_state_bpm != null) hr.steady_state_bpm = evaluation.steady_state_bpm;
      if (evaluation.steady) {
        closeOpenStage(next, elapsed, "accepted", hr);
        if (!startNextStage(next, elapsed)) {
          enterCooldown(next, elapsed, "protocol_complete");
        }
      } else if (evalAt >= VO2_MAX_STAGE_DURATION_SEC) {
        const status: Vo2ProtocolStageStatus = evaluation.coverage_ok ? "unstable_hr" : "insufficient_hr";
        closeOpenStage(next, elapsed, status, hr);
        if (!startNextStage(next, elapsed)) {
          enterCooldown(next, elapsed, "protocol_complete");
        }
      } else {
        open.extensions = evalAt === VO2_NOMINAL_STAGE_DURATION_SEC ? 1 : 2;
        open.hr = hr;
        open.extension_announced = true;
      }
    }
    return next;
  }

  if (next.segment === "cooldown" && next.cooldown_start_sec != null) {
    if (elapsed >= next.cooldown_start_sec + next.plan.cooldown_duration_sec) {
      next.segment = "complete";
      if (!next.termination) next.termination = { reason: "protocol_complete" };
    }
  }
  return next;
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

export function getVo2ProtocolPhase(
  elapsedSec: number,
  runtime: Vo2ProtocolRuntime,
  earlyCooldownElapsed?: number | null
): WorkoutPhaseState {
  const elapsed = Math.max(0, Math.floor(elapsedSec));
  const cool = runtime.plan.cooldown_duration_sec;
  const early =
    earlyCooldownElapsed != null && Number.isFinite(earlyCooldownElapsed) && earlyCooldownElapsed >= 0
      ? Math.floor(earlyCooldownElapsed)
      : runtime.termination?.reason === "early_cooldown"
        ? runtime.cooldown_start_sec
        : null;
  const cooldownStart = early != null ? early : runtime.cooldown_start_sec;

  if (cooldownStart != null && elapsed >= cooldownStart) {
    const phaseElapsed = elapsed - cooldownStart;
    if (phaseElapsed >= cool) return completedPhase();
    return {
      phase: "Cool-Down",
      kind: "cooldown",
      phaseId: "cooldown",
      phaseElapsedSeconds: phaseElapsed,
      phaseDurationSeconds: cool,
      timeLeft: cool - phaseElapsed,
      done: false,
      detailName: "VO2 cooldown",
    };
  }

  if (elapsed < runtime.plan.warmup_duration_sec && runtime.stages.length === 0) {
    return {
      phase: "Warm-Up",
      kind: "warmup",
      phaseId: "warmup",
      phaseElapsedSeconds: elapsed,
      phaseDurationSeconds: runtime.plan.warmup_duration_sec,
      timeLeft: runtime.plan.warmup_duration_sec - elapsed,
      done: false,
      detailName: "VO2 warmup",
    };
  }

  for (const stage of runtime.stages) {
    const end = stage.active_end_sec ?? Number.POSITIVE_INFINITY;
    if (elapsed >= stage.active_start_sec && elapsed < end) {
      const plannedEnd =
        stage.status === "open"
          ? stage.active_start_sec + VO2_NOMINAL_STAGE_DURATION_SEC + stage.extensions * 60
          : end;
      const phaseDuration = Math.max(VO2_NOMINAL_STAGE_DURATION_SEC, plannedEnd - stage.active_start_sec);
      const phaseElapsed = elapsed - stage.active_start_sec;
      return {
        phase: "Sustain",
        kind: "work",
        phaseId: stage.stage_id,
        phaseElapsedSeconds: phaseElapsed,
        phaseDurationSeconds: phaseDuration,
        timeLeft: Math.max(0, phaseDuration - phaseElapsed),
        done: false,
        detailName: stage.extensions > 0 ? `VO2 stage ${stage.workloadIndex + 1} extension` : `VO2 stage ${stage.workloadIndex + 1}`,
        intervalIndex: stage.workloadIndex + 1,
      };
    }
  }

  if (runtime.segment === "complete") return completedPhase();
  if (elapsed < runtime.plan.warmup_duration_sec) {
    return {
      phase: "Warm-Up",
      kind: "warmup",
      phaseId: "warmup",
      phaseElapsedSeconds: elapsed,
      phaseDurationSeconds: runtime.plan.warmup_duration_sec,
      timeLeft: runtime.plan.warmup_duration_sec - elapsed,
      done: false,
      detailName: "VO2 warmup",
    };
  }
  return completedPhase();
}

export function vo2ProtocolUiTargets(
  runtime: Vo2ProtocolRuntime | null | undefined,
  phaseId: string
): {
  hrTargetTextValue: string;
  targetHeartRateMin: undefined;
  targetHeartRateMax: undefined;
  holdResistance: number | undefined;
  holdCadenceRpm: number | undefined;
} {
  const hold = vo2ProtocolHoldForPhase(runtime, phaseId);
  return {
    hrTargetTextValue: "",
    targetHeartRateMin: undefined,
    targetHeartRateMax: undefined,
    holdResistance: hold?.resistance,
    holdCadenceRpm: hold?.cadenceRpm,
  };
}

export function vo2ProtocolHoldForPhase(runtime: Vo2ProtocolRuntime | null | undefined, phaseId: string): {
  resistance: number;
  cadenceRpm: number;
} | undefined {
  if (!runtime) return undefined;
  if (phaseId === "warmup" || phaseId === "cooldown") {
    return {
      resistance: runtime.plan.warmup_resistance,
      cadenceRpm: runtime.plan.prescribed_cadence_rpm,
    };
  }
  const stage = runtime.stages.find((entry) => entry.stage_id === phaseId);
  if (!stage) return undefined;
  const workload = runtime.plan.workloads[stage.workloadIndex];
  if (!workload) return undefined;
  return {
    resistance: workload.prescribed_resistance,
    cadenceRpm: runtime.plan.prescribed_cadence_rpm,
  };
}

export function vo2ProtocolVoiceCues(
  previous: Vo2ProtocolRuntime | null | undefined,
  next: Vo2ProtocolRuntime,
  _elapsedSec: number
): string[] {
  const cues: string[] = [];
  if (!previous?.start_announced && next.start_announced) {
    cues.push("Test starting. Maintain 70 RPM.");
  }
  if (!previous?.upcoming_warmup_announced && next.upcoming_warmup_announced) {
    cues.push("Upcoming resistance change. Maintain 70 RPM.");
  }
  const prevOpen = previous?.stages.find((stage) => stage.status === "open");
  const nextOpen = next.stages.find((stage) => stage.status === "open");
  if (nextOpen && nextOpen.upcoming_announced && !prevOpen?.upcoming_announced) {
    cues.push("Upcoming resistance change. Maintain 70 RPM.");
  }
  if (
    nextOpen &&
    nextOpen.extension_announced &&
    !prevOpen?.extension_announced &&
    nextOpen.stage_id === prevOpen?.stage_id
  ) {
    cues.push("Stage extension for heart-rate stabilization. Maintain 70 RPM.");
  }
  if (previous && previous.segment !== "cooldown" && next.segment === "cooldown") {
    cues.push("Cooldown.");
  }
  if (previous && previous.segment !== "complete" && next.segment === "complete") {
    cues.push("Test complete.");
  }
  void _elapsedSec;
  return cues;
}

/** Protocol v1 has no authoritative HRmax; do not invent an age-based HRmax formula. */
export function authoritativeHrMaxBpm(): number | undefined {
  return undefined;
}

export function vo2ProtocolDisplayName(phase: WorkoutPhaseState): string {
  return phase.detailName || phase.phase;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isProtocolResistance(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= AUTOMATIC_RESISTANCE_MIN &&
    (value as number) <= VO2_PROTOCOL_MAX_RESISTANCE
  );
}

function isBooleanFlag(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isEvalRelativeSec(value: unknown): boolean {
  return VO2_EVAL_RELATIVE_SECONDS.some((allowed) => allowed === value);
}

function isTerminationReason(value: unknown): value is Vo2ProtocolTerminationReason {
  return typeof value === "string" && (VO2_TERMINATION_REASONS as readonly string[]).includes(value);
}

export function isValidVo2ResolvedWorkload(value: unknown): value is Vo2ResolvedWorkload {
  if (!value || typeof value !== "object") return false;
  const row = value as Vo2ResolvedWorkload;
  return (
    isPositiveFinite(row.requested_watts) &&
    isProtocolResistance(row.prescribed_resistance) &&
    isPositiveFinite(row.calibrated_watts_at_70rpm)
  );
}

export function isValidVo2ProtocolPlan(value: unknown): value is Vo2ProtocolPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Vo2ProtocolPlan;
  if (plan.protocol_id !== VO2_PROTOCOL_ID) return false;
  if (plan.protocol_version !== VO2_PROTOCOL_VERSION) return false;
  if (plan.prescribed_cadence_rpm !== VO2_PRESCRIBED_CADENCE_RPM) return false;
  if (!isProtocolResistance(plan.warmup_resistance) || !isPositiveFinite(plan.warmup_calibrated_watts_at_70rpm)) {
    return false;
  }
  if (plan.warmup_duration_sec !== VO2_WARMUP_DURATION_SEC) return false;
  if (plan.cooldown_duration_sec !== VO2_COOLDOWN_DURATION_SEC) return false;
  if (!Array.isArray(plan.workloads)) return false;
  if (plan.workloads.length < VO2_TARGET_WORK_STAGES || plan.workloads.length > VO2_MAX_WORK_STAGES) return false;
  let previousResolvedWatts = plan.warmup_calibrated_watts_at_70rpm;
  const resistances = new Set<number>([plan.warmup_resistance]);
  for (const workload of plan.workloads) {
    if (!isValidVo2ResolvedWorkload(workload)) return false;
    if (workload.requested_watts !== previousResolvedWatts + VO2_NOMINAL_WATT_STEP) return false;
    if (workload.calibrated_watts_at_70rpm <= previousResolvedWatts) return false;
    if (resistances.has(workload.prescribed_resistance)) return false;
    resistances.add(workload.prescribed_resistance);
    previousResolvedWatts = workload.calibrated_watts_at_70rpm;
  }
  return true;
}

export function isValidVo2ProtocolRuntime(value: unknown): value is Vo2ProtocolRuntime {
  if (!value || typeof value !== "object") return false;
  const runtime = value as Vo2ProtocolRuntime;
  if (!isValidVo2ProtocolPlan(runtime.plan)) return false;
  if (!["warmup", "work", "cooldown", "complete"].includes(runtime.segment)) return false;
  if (runtime.cooldown_start_sec != null && !isNonNegativeFinite(runtime.cooldown_start_sec)) return false;
  if (!isBooleanFlag(runtime.start_announced) || !isBooleanFlag(runtime.upcoming_warmup_announced)) return false;
  if (runtime.termination != null) {
    if (typeof runtime.termination !== "object" || !isTerminationReason(runtime.termination.reason)) return false;
  }
  if (!Array.isArray(runtime.stages)) return false;
  for (const stage of runtime.stages) {
    if (!stage || typeof stage !== "object") return false;
    if (typeof stage.stage_id !== "string" || !stage.stage_id) return false;
    if (!Number.isInteger(stage.workloadIndex) || stage.workloadIndex < 0) return false;
    if (stage.workloadIndex >= runtime.plan.workloads.length) return false;
    if (!isNonNegativeFinite(stage.active_start_sec)) return false;
    if (stage.active_end_sec != null && !isNonNegativeFinite(stage.active_end_sec)) return false;
    if (stage.active_end_sec != null && stage.active_end_sec < stage.active_start_sec) return false;
    if (!Number.isInteger(stage.extensions) || stage.extensions < 0 || stage.extensions > VO2_MAX_EXTENSION_MINUTES) {
      return false;
    }
    if (!isEvalRelativeSec(stage.last_eval_relative_sec)) return false;
    if (!isBooleanFlag(stage.upcoming_announced) || !isBooleanFlag(stage.extension_announced)) return false;
    if (!["accepted", "unstable_hr", "insufficient_hr", "incomplete", "open"].includes(stage.status)) return false;
  }
  return true;
}

export function buildVo2ProtocolEvidence(
  runtime: Vo2ProtocolRuntime,
  telemetrySamples: readonly BikeTelemetrySample[] = []
): Vo2ProtocolEvidence | undefined {
  if (!isValidVo2ProtocolRuntime(runtime)) return undefined;
  const stages: Vo2ProtocolStageEvidence[] = [];
  for (const stage of runtime.stages) {
    const workload = runtime.plan.workloads[stage.workloadIndex];
    if (!isValidVo2ResolvedWorkload(workload)) return undefined;
    const end = stage.active_end_sec ?? stage.active_start_sec;
    const evidence: Vo2ProtocolStageEvidence = {
      stage_id: stage.stage_id,
      active_start_sec: stage.active_start_sec,
      active_end_sec: end,
      requested_watts: workload.requested_watts,
      prescribed_resistance: workload.prescribed_resistance,
      calibrated_watts_at_70rpm: workload.calibrated_watts_at_70rpm,
      status: stage.status === "open" ? "incomplete" : stage.status,
      nominal_duration_sec: VO2_NOMINAL_STAGE_DURATION_SEC,
      actual_duration_sec: Math.max(0, end - stage.active_start_sec),
    };
    if (stage.hr) evidence.hr = stage.hr;
    evidence.workload = summarizeVo2StageWorkload(
      evidence,
      telemetrySamples,
      runtime.plan.prescribed_cadence_rpm
    );
    if (evidence.prescribed_resistance > VO2_PROTOCOL_MAX_RESISTANCE) return undefined;
    stages.push(evidence);
  }
  return {
    protocol_id: runtime.plan.protocol_id,
    protocol_version: runtime.plan.protocol_version,
    prescribed_cadence_rpm: runtime.plan.prescribed_cadence_rpm,
    stages,
    termination: {
      reason: runtime.termination?.reason ?? "other",
    },
    automatic_submax_hr_ceiling_available: false,
  };
}

export function parseVo2ProtocolRuntime(raw: unknown): Vo2ProtocolRuntime | null {
  if (!isValidVo2ProtocolRuntime(raw)) return null;
  return raw;
}
