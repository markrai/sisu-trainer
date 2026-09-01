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

/** Local evidence for the VO2 estimator. Not itself a VO2 result. */
export const VO2_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const VO2_ASSESSMENT_SCHEMA_VERSION = 1 as const;

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
  | "limit_reached"
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
  workload?: Vo2ProtocolStageWorkloadEvidence;
}

export interface Vo2ProtocolEvidence {
  /** Observed protocol id. Estimator v1 requires `bike-submax-70rpm`. */
  protocol_id: string;
  /** Observed protocol version. Estimator v1 requires version 1. */
  protocol_version: number;
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

export type Vo2AssessmentStatus = "estimated" | "insufficient_evidence";

export type Vo2AssessmentReasonCode =
  | "missing_protocol_evidence"
  | "unsupported_protocol_id"
  | "unsupported_protocol_version"
  | "missing_profile_age"
  | "missing_profile_weight"
  | "invalid_profile_age"
  | "invalid_profile_weight"
  | "too_few_accepted_stages"
  | "too_few_eligible_stages"
  | "missing_stage_hr"
  | "invalid_workload"
  | "unverified_performed_workload"
  | "invalid_workload_progression"
  | "invalid_hr_progression"
  | "hr_below_estimator_range"
  | "hr_above_submax_ceiling"
  | "nonpositive_slope"
  | "unstable_regression"
  | "invalid_extrapolation"
  | "invalid_estimate";

export type Vo2AssessmentFitQuality = "high" | "moderate" | "low";

export type Vo2WorkloadSource =
  | "measured_watts"
  | "calibrated_at_verified_cadence"
  | "prescribed_only";

export interface Vo2ProtocolStageWorkloadEvidence {
  source: Vo2WorkloadSource;
  /** Watts the estimator may use when this stage is eligible. */
  estimator_watts?: number;
  calibrated_watts_at_70rpm: number;
  measured_watts_median?: number;
  measured_watts_sample_count: number;
  measured_cadence_median_rpm?: number;
  measured_cadence_sample_count: number;
  cadence_in_band_ratio?: number;
  cadence_measured: boolean;
  watts_measured: boolean;
}

export interface Vo2AssessmentPoint {
  stage_id: string;
  protocol_accepted: boolean;
  estimator_eligible: boolean;
  ineligibility_reasons: Vo2AssessmentReasonCode[];
  workload_source?: Vo2WorkloadSource;
  watts?: number;
  calibrated_watts_at_70rpm?: number;
  steady_state_bpm?: number;
  cadence_measured?: boolean;
  watts_measured?: boolean;
  measured_cadence_median_rpm?: number;
  measured_watts_median?: number;
  measured_watts_sample_count?: number;
  measured_cadence_sample_count?: number;
  cadence_in_band_ratio?: number;
}

export interface Vo2AssessmentInputSnapshot {
  age_years?: number;
  weight_kg?: number;
  predicted_hr_max?: number;
  protocol_id?: string;
  protocol_version?: number;
}

export interface Vo2AssessmentDiagnostics {
  accepted_points: Vo2AssessmentPoint[];
  eligible_points: Vo2AssessmentPoint[];
  slope?: number;
  intercept?: number;
  r_squared?: number;
  predicted_hr_max?: number;
  predicted_max_watts?: number;
  min_r_squared: number;
  estimator_min_hr_bpm: number;
  estimator_submax_hrmax_fraction: number;
  expected_protocol_id: string;
  expected_protocol_version: number;
  observed_protocol_id?: string;
  observed_protocol_version?: number;
}

export interface Vo2AssessmentResult {
  schema_version: typeof VO2_ASSESSMENT_SCHEMA_VERSION;
  estimator_id: string;
  estimator_version: number;
  status: Vo2AssessmentStatus;
  termination_reason: Vo2ProtocolTerminationReason;
  estimate_ml_kg_min?: number;
  fit_quality?: Vo2AssessmentFitQuality;
  reason_codes: Vo2AssessmentReasonCode[];
  accepted_stage_count: number;
  eligible_stage_count: number;
  stages_used: string[];
  highest_accepted_workload_watts?: number;
  input_snapshot: Vo2AssessmentInputSnapshot;
  diagnostics: Vo2AssessmentDiagnostics;
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
   * Pause-safe stage-aware physiological evidence for the VO2 estimator.
   * Absent on historical workouts that predate this format.
   */
  vo2_evidence?: Vo2Evidence;
  /**
   * Versioned VO2 assessment for the standalone VO2 Max Estimation workout.
   * Local-only; stripped from SISU ingest. Absent on ordinary workouts.
   */
  vo2_assessment?: Vo2AssessmentResult;
}

export interface SisuSettings {
  key: "config";
  host: string;
  port: number;
  protocol?: "https" | "http";
  last_connected: string;
  last_sync: string | null;
}
