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
}

export interface SisuSettings {
  key: "config";
  host: string;
  port: number;
  protocol?: "https" | "http";
  last_connected: string;
  last_sync: string | null;
}
