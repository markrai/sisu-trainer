import type { MachineDecisionAuditEntry } from "./machines/audit/types.js";
import type { MachineGuidanceTraceEntry, MachineId } from "./machines/trace.js";

export type DayName =
  | "Monday"
  | "Tuesday"
  | "Wednesday"
  | "Thursday"
  | "Friday"
  | "Saturday"
  | "Sunday";

export interface PlanBlock {
  warm: number;
  sustain: number;
  cool: number;
}

export type Activity = "bike" | "elliptical" | "strength";

export type WorkoutPhaseKind = "warmup" | "work" | "recovery" | "cooldown";

export interface WorkoutPhaseState {
  phase: "Warm-Up" | "Sustain" | "Cool-Down" | "Completed";
  kind: WorkoutPhaseKind | "completed";
  phaseId: string;
  phaseElapsedSeconds: number;
  phaseDurationSeconds: number;
  timeLeft: number;
  done: boolean;
  detailName?: string;
  intervalIndex?: number;
}

export interface WorkoutMetadata {
  type: string;
  intent: string;
  activities: Activity[];
}

export interface HrIntervalPhase {
  phase: string;
  kind: WorkoutPhaseKind;
  duration: number;
  target_hr_bpm?: string | number;
}

export interface HrIntervalTargets {
  phases: HrIntervalPhase[];
  repetitions: number;
  isSequence: boolean;
}

export interface HrTargetsForDay {
  warmup?: string | number;
  warmup_subsections?: Array<{
    name: string;
    start_min: number;
    end_min: number;
    target_hr_bpm: string | number;
  }>;
  cooldown?: string | number;
  main_set?: string | number;
  main_set_kind?: WorkoutPhaseKind;
  intervals: HrIntervalTargets | null;
}

export type Plan = Record<DayName | string, PlanBlock | null>;
export type MetadataByDay = Record<DayName | string, WorkoutMetadata | undefined>;
export type HrTargetsByDay = Record<DayName | string, HrTargetsForDay | undefined>;

export interface Profile {
  weight: number | string;
  height: number | string;
  age: number | string;
  sex: "male" | "female" | "" | string;
  vo2: number | string;
}

export interface HrSample {
  session_id: string;
  timestamp_sec: number;
  hr: number;
}

export interface ZoneMinutes {
  z1: number;
  z2: number;
  z3: number;
  z4: number;
  z5: number;
}

/** Local evidence for a future VO2 estimator. Not a VO2 result. */
export const VO2_EVIDENCE_SCHEMA_VERSION = 1 as const;

export interface Vo2EvidencePhasePrescription {
  /** Prescribed HR target text or number from the workout plan (not measured). */
  target_hr_bpm?: string | number;
  target_hr_min?: number;
  target_hr_max?: number;
}

export interface Vo2EvidencePhase {
  phase_id: string;
  kind: WorkoutPhaseKind;
  detail_name?: string;
  interval_index?: number;
  active_start_sec: number;
  active_end_sec: number;
  prescribed?: Vo2EvidencePhasePrescription;
}

export interface Vo2EvidenceHr {
  /** Chest-strap BLE is the only live HR source today. */
  source: "ble_chest_strap" | "absent";
  /** Count of active-workout HR samples (pause-era HR is not stored as workout samples). */
  sample_count: number;
  first_active_elapsed_sec?: number;
  last_active_elapsed_sec?: number;
}

export interface Vo2EvidenceMachine {
  machine_id?: MachineId;
  machine_profile_version?: number;
  guidance_trace_entry_count?: number;
}

export const VO2_PROTOCOL_ID = "bike-submax-70rpm" as const;
export const VO2_PROTOCOL_VERSION = 1 as const;
export type Vo2ProtocolId = typeof VO2_PROTOCOL_ID;
export type Vo2ProtocolVersion = typeof VO2_PROTOCOL_VERSION;

export type Vo2ProtocolStageStatus =
  | "accepted"
  | "unstable_hr"
  | "insufficient_hr"
  | "incomplete";

export type Vo2ProtocolTerminationReason =
  | "protocol_complete"
  | "submax_hr_ceiling"
  | "early_cooldown"
  | "user_cancelled"
  | "hr_lost"
  | "insufficient_calibrated_workloads"
  | "other";

export interface Vo2ProtocolStageHrEvidence {
  sample_count: number;
  minute_2_mean_bpm?: number;
  minute_3_mean_bpm?: number;
  final_two_window_delta_bpm?: number;
  steady_state_bpm?: number;
}

export interface Vo2ProtocolStageEvidence {
  stage_id: string;
  active_start_sec: number;
  active_end_sec: number;
  requested_watts?: number;
  prescribed_resistance: number;
  calibrated_watts_at_70rpm: number;
  status: Vo2ProtocolStageStatus;
  nominal_duration_sec: number;
  actual_duration_sec: number;
  hr?: Vo2ProtocolStageHrEvidence;
}

export interface Vo2ProtocolEvidence {
  protocol_id: Vo2ProtocolId;
  protocol_version: Vo2ProtocolVersion;
  prescribed_cadence_rpm: number;
  stages: Vo2ProtocolStageEvidence[];
  termination: {
    reason: Vo2ProtocolTerminationReason;
  };
  /** Whether an authoritative HRmax ceiling was available to enforce 85% HRmax. */
  automatic_submax_hr_ceiling_available: boolean;
}

export interface Vo2Evidence {
  schema_version: typeof VO2_EVIDENCE_SCHEMA_VERSION;
  activity?: Activity;
  intent?: string;
  day?: DayName | string;
  /** Active workout elapsed at completion (excludes paused time). */
  active_duration_sec: number;
  /** Cumulative paused wall time during the session. */
  paused_duration_sec: number;
  /** Active elapsed when meaningful work ended; null if work never ended. */
  work_end_active_sec: number | null;
  /** Active elapsed when cooldown started; null if cooldown never started. */
  cooldown_start_active_sec: number | null;
  early_cooldown: boolean;
  cancelled?: boolean;
  phases: Vo2EvidencePhase[];
  hr: Vo2EvidenceHr;
  machine?: Vo2EvidenceMachine;
  /** Present only for the standalone VO2 Max Estimation protocol. */
  protocol?: Vo2ProtocolEvidence;
}

export interface WorkoutSummary {
  external_session_id: string;
  startedAt: string;
  endedAt: string;
  category: "cardio";
  intent: string;
  duration_minutes: number;
  primary_zone: number;
  stress_profile: "low" | "moderate" | "high";
  zone_minutes: ZoneMinutes;
  hr_trace: {
    sampling_interval_seconds: number;
    samples: Array<{ t: number; hr: number }>;
  };
  day?: DayName | string;
  /** True when the user ended the workout early (cancel). Still saved in history. */
  cancelled?: boolean;
  activity?: Activity;
  machine_id?: MachineId;
  machine_profile_version?: number;
  machine_guidance_trace?: MachineGuidanceTraceEntry[];
  machine_decision_audit?: MachineDecisionAuditEntry[];
  /**
   * Pause-safe stage-aware physiological evidence for a future VO2 estimator.
   * Absent on historical workouts that predate this format.
   */
  vo2_evidence?: Vo2Evidence;
}

export interface SisuSettings {
  key: "config";
  host: string;
  port: number;
  protocol?: "https" | "http";
  last_connected: string;
  last_sync: string | null;
}
