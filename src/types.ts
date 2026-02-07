// Shared domain types for VO2 Max Coach
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

export interface WorkoutMetadata {
  type: string;
  intent: string;
  machine: string;
}

export interface HrIntervalPhase {
  phase: string;
  duration: number; // minutes
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
}

export interface SisuSettings {
  key: "config";
  host: string;
  port: number;
  last_connected: string;
  last_sync: string | null;
}
