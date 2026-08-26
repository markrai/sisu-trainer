import type { Activity, WorkoutPhaseKind } from "../types.js";

export type MachineId = "proform-smart-power-10";

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

export interface MachineGuidanceTraceEntry {
  elapsedSeconds: number;
  resistance: number;
  cadenceRpm: number;
  estimatedWatts?: number;
  reason: string;
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
