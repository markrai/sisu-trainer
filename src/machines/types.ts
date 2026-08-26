import type { Activity, WorkoutPhaseKind } from "../types.js";
import type { MachineId } from "./trace.js";

export type { MachineId, MachineGuidanceTraceEntry } from "./trace.js";

export interface MachineDefinition {
  id: MachineId;
  name: string;
  activity: Activity;
  profileVersion: number;
}

export interface EquipmentSelection {
  bike?: MachineId;
  elliptical?: MachineId;
}

export interface MachineHeartRateSample {
  elapsedSeconds: number;
  bpm: number;
}

export interface CompletedShortWorkPhase {
  phaseId: string;
  phaseDurationSeconds: number;
  resistance: number;
  targetHeartRateMin?: number;
  targetHeartRateMax?: number;
  recentHeartRates: readonly MachineHeartRateSample[];
}

export interface MachineGuidanceContext {
  machineId: MachineId;
  activity: Activity;
  phaseKind: WorkoutPhaseKind;
  phaseId: string;
  phaseElapsedSeconds: number;
  phaseDurationSeconds: number;
  workoutElapsedSeconds: number;
  intervalIndex?: number;
  heartRateBpm?: number;
  targetHeartRateMin?: number;
  targetHeartRateMax?: number;
  recentHeartRates: readonly MachineHeartRateSample[];
  previousGuidance?: MachineGuidance;
  completedShortWork?: CompletedShortWorkPhase;
  learnedStartingResistance?: number;
}

export interface MachineGuidance {
  machineId: MachineId;
  resistance?: number;
  cadenceRpm?: number;
  estimatedWatts?: number;
  action: "hold" | "increase" | "decrease" | "set";
  reason: string;
}

export interface MachineGuidanceState {
  currentPhaseId?: string;
  currentPhaseKind?: WorkoutPhaseKind;
  currentResistance?: number;
  currentCadenceRpm?: number;
  nextWorkResistance?: number;
  lastEvaluationPhaseElapsedSeconds?: number;
  shortIntervalEvaluated: boolean;
  mediumIntervalEvaluated: boolean;
}

export interface MachineGuidanceResult {
  guidance: MachineGuidance;
  state: MachineGuidanceState;
}

export interface MachineAdapter {
  definition: MachineDefinition;
  getGuidance(context: MachineGuidanceContext, state: MachineGuidanceState): MachineGuidanceResult;
}

export interface MachineGuidanceVoiceEvent {
  machineId: MachineId;
  phaseId: string;
  phaseKind: WorkoutPhaseKind;
  phaseDisplayName: string;
  intervalIndex?: number;
  phaseChanged: boolean;
  recommendationChanged: boolean;
  guidance: MachineGuidance;
}
