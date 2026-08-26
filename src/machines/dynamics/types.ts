import type { Activity } from "../../types.js";
import type { MachineId } from "../trace.js";
import type { WorkDurationClass } from "../learning/types.js";

export type { WorkDurationClass };

export const DYNAMICS_STORAGE_KEY = "sisu_trainer_hr_dynamics";
export const DYNAMICS_STORE_VERSION = 1 as const;
export const DYNAMICS_SAMPLE_LIMIT = 20;
export const RESPONSE_SEARCH_SECONDS = 90;
export const RESPONSE_ONSET_BPM = 3;
export const RESPONSE_PERSISTENCE_SECONDS = 3;
export const SETTLED_WINDOW_SECONDS = 15;
export const WORK_START_BASELINE_SECONDS = 15;
export const WORK_START_BASELINE_FALLBACK_SECONDS = 10;
export const IN_WORK_BASELINE_SECONDS = 10;
export const ROLLING_ONSET_LOOKBACK_SECONDS = 4;
export const MAX_ABS_HR_DELTA = 40;
export const MAX_ABS_HR_PER_LEVEL = 20;
export const MAX_RESISTANCE_STEP = 2;
export const MIN_OBSERVABLE_WINDOW_SECONDS = 15;

export type HrResponseKind = "work_start" | "resistance_increase" | "resistance_decrease";

export interface MachineHrResponseObservation {
  machineId: MachineId;
  machineProfileVersion: number;
  activity: Activity;
  intent: string;
  durationClass: WorkDurationClass;
  phaseId: string;
  intervalIndex?: number;
  fromResistance?: number;
  toResistance: number;
  resistanceDelta?: number;
  changeElapsedSeconds: number;
  baselineHr?: number;
  settledHr?: number;
  hrDelta?: number;
  responseDelaySeconds?: number;
  observationWindowSeconds: number;
  windowObservable: boolean;
  responseDetected: boolean;
  kind: HrResponseKind;
}

export interface StoredDynamicsEntry {
  workStartDelays: number[];
  workStartHrDeltas: number[];
  increaseDelays: number[];
  increaseHrPerLevel: number[];
  decreaseDelays: number[];
  decreaseHrPerLevel: number[];
  workStartObservationCount: number;
  workStartDetectedResponseCount: number;
  increaseObservationCount: number;
  increaseDetectedResponseCount: number;
  decreaseObservationCount: number;
  decreaseDetectedResponseCount: number;
  updatedAt: string;
}

export interface LearnedHrDynamicsStore {
  version: 1;
  entries: Record<string, StoredDynamicsEntry>;
}

export interface LearnedHrDynamics {
  machineId: MachineId;
  machineProfileVersion: number;
  activity: Activity;
  intent: string;
  durationClass: WorkDurationClass;
  workStartSampleCount: number;
  workStartDelaySampleCount: number;
  medianWorkStartDelaySeconds?: number;
  medianWorkStartHrDelta?: number;
  increaseSampleCount: number;
  increaseDelaySampleCount: number;
  medianIncreaseDelaySeconds?: number;
  medianIncreaseHrDeltaPerStep?: number;
  decreaseSampleCount: number;
  decreaseDelaySampleCount: number;
  medianDecreaseDelaySeconds?: number;
  medianDecreaseHrDeltaPerStep?: number;
  workStartObservationCount: number;
  workStartDetectedResponseCount: number;
  increaseObservationCount: number;
  increaseDetectedResponseCount: number;
  decreaseObservationCount: number;
  decreaseDetectedResponseCount: number;
  timingPersonalized?: boolean;
  updatedAt: string;
}
