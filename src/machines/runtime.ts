import type { Activity, WorkoutPhaseKind } from "../types.js";
import { createMachineGuidanceState, getMachineGuidance, isSameMachineRecommendation } from "./guidance.js";
import { getMachineDefinition } from "./registry.js";
import { getSelectedMachineId, type EquipmentStorage } from "./selection.js";
import type {
  CompletedShortWorkPhase,
  MachineDefinition,
  MachineGuidance,
  MachineGuidanceState,
  MachineGuidanceTraceEntry,
  MachineGuidanceVoiceEvent,
  MachineHeartRateSample,
  MachineId,
} from "./types.js";

interface PendingShortWorkPhase {
  phaseId: string;
  phaseDurationSeconds: number;
  phaseElapsedSeconds: number;
  workoutElapsedSeconds: number;
  resistance: number;
  targetHeartRateMin?: number;
  targetHeartRateMax?: number;
  recentHeartRates: MachineHeartRateSample[];
}

interface MachineRuntimeState {
  sessionId: string | null;
  machineId?: MachineId;
  guidanceState: MachineGuidanceState;
  previousGuidance?: MachineGuidance;
  recentHeartRates: MachineHeartRateSample[];
  trace: MachineGuidanceTraceEntry[];
  lastPhaseId?: string;
  pendingShortWork?: PendingShortWorkPhase;
}

export interface MachineGuidanceRuntimeInput {
  sessionId: string;
  activity: Activity;
  phaseKind: WorkoutPhaseKind;
  phaseId: string;
  phaseDisplayName: string;
  phaseElapsedSeconds: number;
  phaseDurationSeconds: number;
  workoutElapsedSeconds: number;
  intervalIndex?: number;
  heartRateBpm?: number;
  targetHeartRateMin?: number;
  targetHeartRateMax?: number;
}

export interface MachineGuidanceRuntimeUpdate {
  machine: MachineDefinition;
  guidance: MachineGuidance;
  recommendationChanged: boolean;
  phaseChanged: boolean;
  voiceEvent: MachineGuidanceVoiceEvent | null;
}

export interface MachineUsageSnapshot {
  machineId: MachineId;
  profileVersion: number;
  guidanceTrace: MachineGuidanceTraceEntry[];
}

function newRuntimeState(sessionId: string | null): MachineRuntimeState {
  return {
    sessionId,
    guidanceState: createMachineGuidanceState(),
    recentHeartRates: [],
    trace: [],
  };
}

let runtime = newRuntimeState(null);

export function resetMachineGuidanceRuntime(sessionId: string | null = null): void {
  runtime = newRuntimeState(sessionId);
}

function ensureSession(sessionId: string): void {
  if (runtime.sessionId !== sessionId) resetMachineGuidanceRuntime(sessionId);
}

export function recordMachineHeartRateSample(sessionId: string, elapsedSeconds: number, bpm: number): void {
  if (!sessionId || !Number.isFinite(bpm) || bpm <= 0) return;
  ensureSession(sessionId);
  runtime.recentHeartRates.push({ elapsedSeconds, bpm });
  const cutoff = elapsedSeconds - 15;
  runtime.recentHeartRates = runtime.recentHeartRates
    .filter((sample) => sample.elapsedSeconds >= cutoff)
    .slice(-32);
}

export function appendMachineGuidanceTrace(
  trace: readonly MachineGuidanceTraceEntry[],
  elapsedSeconds: number,
  guidance: MachineGuidance,
  previous?: MachineGuidance
): MachineGuidanceTraceEntry[] {
  if (isSameMachineRecommendation(previous, guidance)) return [...trace];
  if (guidance.resistance === undefined || guidance.cadenceRpm === undefined) return [...trace];
  const entry: MachineGuidanceTraceEntry = {
    elapsedSeconds,
    resistance: guidance.resistance,
    cadenceRpm: guidance.cadenceRpm,
    reason: guidance.reason,
  };
  if (guidance.estimatedWatts !== undefined) entry.estimatedWatts = guidance.estimatedWatts;
  return [...trace, entry];
}

function workPhaseHeartRates(
  samples: readonly MachineHeartRateSample[],
  workoutElapsedSeconds: number,
  phaseElapsedSeconds: number
): MachineHeartRateSample[] {
  const workStart = workoutElapsedSeconds - phaseElapsedSeconds;
  const cutoff = Math.max(workStart, workoutElapsedSeconds - 15);
  return samples
    .filter((sample) => sample.elapsedSeconds >= cutoff && sample.elapsedSeconds <= workoutElapsedSeconds)
    .slice(-32);
}

function completedShortWorkFromPending(
  pending: PendingShortWorkPhase,
  liveSamples: readonly MachineHeartRateSample[]
): CompletedShortWorkPhase {
  const workStart = pending.workoutElapsedSeconds - pending.phaseElapsedSeconds;
  const workEnd = workStart + pending.phaseDurationSeconds;
  const merged = new Map<number, MachineHeartRateSample>();
  for (const sample of [...pending.recentHeartRates, ...liveSamples]) {
    if (sample.elapsedSeconds >= workEnd - 15 && sample.elapsedSeconds < workEnd) {
      merged.set(sample.elapsedSeconds, sample);
    }
  }
  return {
    phaseId: pending.phaseId,
    phaseDurationSeconds: pending.phaseDurationSeconds,
    resistance: pending.resistance,
    targetHeartRateMin: pending.targetHeartRateMin,
    targetHeartRateMax: pending.targetHeartRateMax,
    recentHeartRates: [...merged.values()].sort((a, b) => a.elapsedSeconds - b.elapsedSeconds).slice(-32),
  };
}

export function updateMachineGuidanceRuntime(
  input: MachineGuidanceRuntimeInput,
  storage?: EquipmentStorage
): MachineGuidanceRuntimeUpdate | null {
  ensureSession(input.sessionId);
  runtime.recentHeartRates = runtime.recentHeartRates.filter(
    (sample) => sample.elapsedSeconds >= input.workoutElapsedSeconds - 15 &&
      sample.elapsedSeconds <= input.workoutElapsedSeconds
  );
  const machineId = getSelectedMachineId(input.activity, storage);
  if (!machineId) return null;
  const machine = getMachineDefinition(machineId);
  if (!machine || machine.activity !== input.activity) return null;
  if (runtime.machineId !== machineId) {
    runtime.machineId = machineId;
    runtime.guidanceState = createMachineGuidanceState();
    runtime.previousGuidance = undefined;
    runtime.trace = [];
    runtime.lastPhaseId = undefined;
    runtime.pendingShortWork = undefined;
  }
  const leavingShortWork = runtime.pendingShortWork !== undefined &&
    (input.phaseId !== runtime.pendingShortWork.phaseId || input.phaseKind !== "work");
  const completedShortWork = leavingShortWork && runtime.pendingShortWork && !runtime.guidanceState.shortIntervalEvaluated
    ? completedShortWorkFromPending(runtime.pendingShortWork, runtime.recentHeartRates)
    : undefined;
  if (leavingShortWork) runtime.pendingShortWork = undefined;
  const phaseChanged = runtime.lastPhaseId !== input.phaseId;
  const result = getMachineGuidance(
    {
      machineId,
      activity: input.activity,
      phaseKind: input.phaseKind,
      phaseId: input.phaseId,
      phaseElapsedSeconds: input.phaseElapsedSeconds,
      phaseDurationSeconds: input.phaseDurationSeconds,
      workoutElapsedSeconds: input.workoutElapsedSeconds,
      intervalIndex: input.intervalIndex,
      heartRateBpm: input.heartRateBpm,
      targetHeartRateMin: input.targetHeartRateMin,
      targetHeartRateMax: input.targetHeartRateMax,
      recentHeartRates: runtime.recentHeartRates,
      previousGuidance: runtime.previousGuidance,
      completedShortWork,
    },
    runtime.guidanceState
  );
  if (!result) return null;
  const previous = runtime.previousGuidance;
  const recommendationChanged = !isSameMachineRecommendation(previous, result.guidance);
  runtime.trace = appendMachineGuidanceTrace(runtime.trace, input.workoutElapsedSeconds, result.guidance, previous);
  runtime.guidanceState = result.state;
  runtime.previousGuidance = result.guidance;
  runtime.lastPhaseId = input.phaseId;
  if (input.phaseKind === "work" && input.phaseDurationSeconds <= 75) {
    runtime.pendingShortWork = {
      phaseId: input.phaseId,
      phaseDurationSeconds: input.phaseDurationSeconds,
      phaseElapsedSeconds: input.phaseElapsedSeconds,
      workoutElapsedSeconds: input.workoutElapsedSeconds,
      resistance: result.state.currentResistance ?? result.guidance.resistance ?? 11,
      targetHeartRateMin: input.targetHeartRateMin,
      targetHeartRateMax: input.targetHeartRateMax,
      recentHeartRates: workPhaseHeartRates(
        runtime.recentHeartRates,
        input.workoutElapsedSeconds,
        input.phaseElapsedSeconds
      ),
    };
  }
  const voiceEvent = phaseChanged || recommendationChanged
    ? {
        machineId,
        phaseId: input.phaseId,
        phaseKind: input.phaseKind,
        phaseDisplayName: input.phaseDisplayName,
        intervalIndex: input.intervalIndex,
        phaseChanged,
        recommendationChanged,
        guidance: result.guidance,
      }
    : null;
  return {
    machine,
    guidance: result.guidance,
    recommendationChanged,
    phaseChanged,
    voiceEvent,
  };
}

export function getMachineUsageSnapshot(sessionId: string): MachineUsageSnapshot | null {
  if (runtime.sessionId !== sessionId || !runtime.machineId) return null;
  const machine = getMachineDefinition(runtime.machineId);
  if (!machine) return null;
  return {
    machineId: machine.id,
    profileVersion: machine.profileVersion,
    guidanceTrace: runtime.trace.map((entry) => ({ ...entry })),
  };
}
