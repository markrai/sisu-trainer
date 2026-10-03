/**
 * Pure adaptive VO2 stage planner (protocol v3).
 *
 * Portable: no DOM, Capacitor, BLE, or machine UI state. Machine-specific
 * watts<->resistance conversion stays behind the injected calibration lookup
 * (existing machine-profile seam); this module never invents a watts table.
 *
 * The estimator remains authoritative. This planner provides preventative
 * guidance only: it predicts likely HR response from eligible observations
 * and refuses to prescribe a stage it cannot justify as safe and useful.
 * It never overrides estimator rejection.
 */
import {
  VO2_PROTOCOL_VERSION_V3,
  type Vo2AdaptiveDecisionReasonCode,
  type Vo2AdaptiveStageProvenance,
  type Vo2AdaptiveTerminationProvenance,
  type Vo2ProtocolTerminationReasonV3,
} from "./types.js";
import {
  VO2_ESTIMATOR_MIN_HR_BPM,
  VO2_ESTIMATOR_SUBMAX_HRMAX_FRACTION,
  VO2_MIN_ELIGIBLE_STAGES,
  VO2_PREDICTED_HRMAX_MAX,
  VO2_PREDICTED_HRMAX_MIN,
  estimatorSubmaxHrCeilingBpm,
  fitHrVsWatts,
} from "./vo2Estimator.js";
import { VO2_PROTOCOL_MAX_RESISTANCE } from "./vo2Protocol.js";
import { AUTOMATIC_RESISTANCE_MIN } from "./machines/proformSmartPower10.js";

export const VO2_ADAPTIVE_PLANNER_VERSION = 1 as const;

/**
 * HR safety margin below the hard estimator ceiling.
 * planning_ceiling = hard_ceiling - margin.
 *
 * Rationale: the real age-46 trace (85W/121.2bpm, 102W/132.3bpm) predicts
 * 143.3bpm at 119W via two-point linear fit, but measured 154.1bpm
 * (10.8bpm underprediction). Margin 5 would still allow v1's unsafe 119W
 * (143.3 < 144.4 planning). Margin 10 refuses any third stage (max-safe
 * 113W admits no calibrated level above 108W). Margin 8 steers 102W->114W
 * (R9, predicted 140.1 < 141.4 planning, 9.3bpm total below hard 149.4)
 * instead of v1's 102W->123W (R10). Meaningful (>>0.1bpm), not 84.9% vs 85%.
 */
export const VO2_ADAPTIVE_SAFETY_MARGIN_BPM = 8;

/** Minimum useful workload separation in watts (estimator watts). */
export const VO2_ADAPTIVE_MIN_WATT_SEPARATION = 5;

/** Preferred step when far from the ceiling. */
export const VO2_ADAPTIVE_NORMAL_WATT_INCREMENT = 20;

/** Never exceed v1's fixed 25W step. */
export const VO2_ADAPTIVE_MAX_WATT_INCREMENT = 25;

/** Minimum step; planner refuses if it cannot achieve this safely. */
export const VO2_ADAPTIVE_MIN_WATT_INCREMENT = 5;

/** Preserve the "up to 30 min" bound: 5 warmup + 4x5 work + 5 cooldown. */
export const VO2_ADAPTIVE_MAX_WORK_STAGES = 4;

/** One lower retry after an above-ceiling stage; prevents oscillation. */
export const VO2_ADAPTIVE_MAX_RETRIES_AFTER_ABOVE_CEILING = 1;

/** First stage bootstraps with v1's rule (no HR data yet): warmup + 25W. */
export const VO2_ADAPTIVE_BOOTSTRAP_WATT_STEP = 25;

/** Conservative step when slope is unknown (<2 eligible points). */
export const VO2_ADAPTIVE_FALLBACK_WATT_STEP = 15;

/**
 * With <2 points the slope is unknown, so require this much headroom below
 * planning (18bpm below hard with margin 8) before attempting a small step.
 */
export const VO2_ADAPTIVE_FALLBACK_MIN_HEADROOM_BPM = 10;

/** Provenance label: predicted within this of planning counts as "near ceiling". */
export const VO2_ADAPTIVE_NEAR_CEILING_THRESHOLD_BPM = 10;

export interface Vo2AdaptivePolicy {
  policy_version: 1;
  safety_margin_bpm: number;
  min_watt_separation: number;
  normal_watt_increment: number;
  max_watt_increment: number;
  min_watt_increment: number;
  max_work_stages: number;
  max_retries_after_above_ceiling: number;
  bootstrap_watt_step: number;
  fallback_watt_step: number;
  fallback_min_headroom_bpm: number;
  near_ceiling_threshold_bpm: number;
  min_resistance: number;
  max_resistance: number;
}

export const DEFAULT_VO2_ADAPTIVE_POLICY: Vo2AdaptivePolicy = {
  policy_version: 1,
  safety_margin_bpm: VO2_ADAPTIVE_SAFETY_MARGIN_BPM,
  min_watt_separation: VO2_ADAPTIVE_MIN_WATT_SEPARATION,
  normal_watt_increment: VO2_ADAPTIVE_NORMAL_WATT_INCREMENT,
  max_watt_increment: VO2_ADAPTIVE_MAX_WATT_INCREMENT,
  min_watt_increment: VO2_ADAPTIVE_MIN_WATT_INCREMENT,
  max_work_stages: VO2_ADAPTIVE_MAX_WORK_STAGES,
  max_retries_after_above_ceiling: VO2_ADAPTIVE_MAX_RETRIES_AFTER_ABOVE_CEILING,
  bootstrap_watt_step: VO2_ADAPTIVE_BOOTSTRAP_WATT_STEP,
  fallback_watt_step: VO2_ADAPTIVE_FALLBACK_WATT_STEP,
  fallback_min_headroom_bpm: VO2_ADAPTIVE_FALLBACK_MIN_HEADROOM_BPM,
  near_ceiling_threshold_bpm: VO2_ADAPTIVE_NEAR_CEILING_THRESHOLD_BPM,
  min_resistance: AUTOMATIC_RESISTANCE_MIN,
  max_resistance: VO2_PROTOCOL_MAX_RESISTANCE,
};

export interface Vo2EligibleObservation {
  /** Estimator watts (measured median). */
  watts: number;
  steadyHrBpm: number;
  calibratedWatts: number;
  resistance: number;
}

export interface Vo2AdaptiveLastCompleted {
  calibratedWatts: number;
  measuredWatts?: number;
  steadyHrBpm?: number;
  resistance: number;
  /** True when the shared classifier flagged hr_above_submax_ceiling. */
  aboveCeiling: boolean;
  eligible: boolean;
}

export type Vo2AdaptiveWattsLookup = (resistance: number) => number | undefined;

export interface Vo2AdaptivePlannerInput {
  eligible: readonly Vo2EligibleObservation[];
  predictedHrMax: number;
  warmupCalibratedWatts: number;
  warmupResistance: number;
  lastCompleted?: Vo2AdaptiveLastCompleted;
  usedResistances: ReadonlySet<number>;
  calibration: Vo2AdaptiveWattsLookup;
  completedWorkStages: number;
  retryCount: number;
  policy?: Partial<Vo2AdaptivePolicy>;
}

export type Vo2AdaptivePlannerResult =
  | {
      decision: "complete";
      reason_code: Extract<Vo2AdaptiveDecisionReasonCode, "sufficient_evidence">;
      eligible_count: number;
    }
  | {
      decision: "next";
      reason_code: Vo2AdaptiveDecisionReasonCode;
      target_watts: number;
      prescribed_resistance: number;
      calibrated_watts: number;
      predicted_hr_bpm?: number;
      provenance: Vo2AdaptiveStageProvenance;
    }
  | {
      decision: "cannot";
      reason_code: Vo2AdaptiveDecisionReasonCode;
      termination_reason: Vo2ProtocolTerminationReasonV3;
      provenance: Vo2AdaptiveTerminationProvenance;
    };

function resolvePolicy(overrides?: Partial<Vo2AdaptivePolicy>): Vo2AdaptivePolicy {
  return { ...DEFAULT_VO2_ADAPTIVE_POLICY, ...(overrides ?? {}) };
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function lastEligible(input: Vo2AdaptivePlannerInput): Vo2EligibleObservation | undefined {
  return input.eligible.length > 0 ? input.eligible[input.eligible.length - 1] : undefined;
}

function listCandidates(
  calibration: Vo2AdaptiveWattsLookup,
  policy: Vo2AdaptivePolicy,
  used: ReadonlySet<number>
): Array<{ resistance: number; watts: number }> {
  const out: Array<{ resistance: number; watts: number }> = [];
  for (let r = policy.min_resistance; r <= policy.max_resistance; r++) {
    if (!Number.isInteger(r)) continue;
    if (used.has(r)) continue;
    const watts = calibration(r);
    if (!isPositiveFinite(watts)) continue;
    out.push({ resistance: r, watts: watts as number });
  }
  out.sort((a, b) => a.watts - b.watts || a.resistance - b.resistance);
  return out;
}

function slopeFromEligible(
  eligible: readonly Vo2EligibleObservation[]
): { slope: number; intercept: number } | undefined {
  if (eligible.length < 2) return undefined;
  const fit = fitHrVsWatts(
    eligible.map((point) => ({ watts: point.watts, steady_state_bpm: point.steadyHrBpm })) as Array<{
      watts?: number;
      steady_state_bpm?: number;
    }> as unknown as Parameters<typeof fitHrVsWatts>[0]
  );
  if (!fit || !Number.isFinite(fit.slope) || !Number.isFinite(fit.intercept)) return undefined;
  return { slope: fit.slope, intercept: fit.intercept };
}

function cannot(
  reason_code: Vo2AdaptiveDecisionReasonCode,
  termination_reason: Vo2ProtocolTerminationReasonV3,
  input: Vo2AdaptivePlannerInput,
  policy: Vo2AdaptivePolicy,
  hard: number,
  planning: number,
  extra?: { predicted_hr_bpm?: number; last_measured_watts?: number; last_steady_hr_bpm?: number }
): Vo2AdaptivePlannerResult {
  const last = lastEligible(input);
  const provenance: Vo2AdaptiveTerminationProvenance = {
    provenance_version: 1,
    eligible_stage_count: input.eligible.length,
    completed_work_stage_count: input.completedWorkStages,
    retry_count: input.retryCount,
    hard_hr_ceiling_bpm: hard,
    planning_hr_ceiling_bpm: planning,
    planning_margin_bpm: policy.safety_margin_bpm,
    reason_code,
    termination_reason,
  };
  const measured = extra?.last_measured_watts ?? last?.watts ?? input.lastCompleted?.measuredWatts;
  const hr = extra?.last_steady_hr_bpm ?? last?.steadyHrBpm ?? input.lastCompleted?.steadyHrBpm;
  if (measured != null) provenance.last_measured_watts = measured;
  if (hr != null) provenance.last_steady_hr_bpm = hr;
  if (extra?.predicted_hr_bpm != null) provenance.predicted_hr_bpm = extra.predicted_hr_bpm;
  return { decision: "cannot", reason_code, termination_reason, provenance };
}

/**
 * Pure planner: given eligible observations and estimator envelope, decide
 * Complete | NextStage(target) | CannotContinue(reason).
 */
export function planNextVo2Stage(rawInput: Vo2AdaptivePlannerInput): Vo2AdaptivePlannerResult {
  const policy = resolvePolicy(rawInput.policy);
  const input: Vo2AdaptivePlannerInput = { ...rawInput, policy };
  const predictedHrMax = input.predictedHrMax;
  if (
    !Number.isFinite(predictedHrMax) ||
    predictedHrMax < VO2_PREDICTED_HRMAX_MIN ||
    predictedHrMax > VO2_PREDICTED_HRMAX_MAX
  ) {
    return cannot(
      "hr_safety_no_safe_target",
      "submax_hr_ceiling",
      input,
      policy,
      Number.NaN,
      Number.NaN
    );
  }
  const hard = estimatorSubmaxHrCeilingBpm(predictedHrMax);
  const planning = hard - policy.safety_margin_bpm;

  if (input.eligible.length >= VO2_MIN_ELIGIBLE_STAGES) {
    return {
      decision: "complete",
      reason_code: "sufficient_evidence",
      eligible_count: input.eligible.length,
    };
  }
  if (input.completedWorkStages >= policy.max_work_stages) {
    return cannot("stage_limit_reached", "insufficient_eligible_stages", input, policy, hard, planning);
  }

  const last = lastEligible(input);
  const lastCompleted = input.lastCompleted;
  void VO2_PROTOCOL_VERSION_V3;
  void VO2_ESTIMATOR_SUBMAX_HRMAX_FRACTION;

  if (lastCompleted?.aboveCeiling === true) {
    if (input.retryCount >= policy.max_retries_after_above_ceiling) {
      return cannot("retry_limit_reached", "submax_hr_ceiling", input, policy, hard, planning, {
        last_measured_watts: lastCompleted.measuredWatts ?? last?.watts,
        last_steady_hr_bpm: lastCompleted.steadyHrBpm ?? last?.steadyHrBpm,
      });
    }
    const baseCalibrated = last?.calibratedWatts ?? input.warmupCalibratedWatts;
    const ceilingWatts = lastCompleted.calibratedWatts;
    const candidates = listCandidates(input.calibration, policy, input.usedResistances).filter(
      (entry) => entry.watts > baseCalibrated + policy.min_watt_separation - 1e-9 && entry.watts < ceilingWatts - 1e-9
    );
    if (candidates.length === 0) {
      return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, hard, planning, {
        last_measured_watts: last?.watts,
        last_steady_hr_bpm: last?.steadyHrBpm,
      });
    }
    if (input.eligible.length >= 2) {
      const line = slopeFromEligible(input.eligible);
      if (!line || !(line.slope > 0)) {
        return cannot("nonpositive_slope", "insufficient_eligible_stages", input, policy, hard, planning);
      }
      const safe = candidates
        .map((entry) => ({ entry, predicted: line.slope * entry.watts + line.intercept }))
        .filter(
          (row) =>
            Number.isFinite(row.predicted) &&
            row.predicted < planning - 1e-9 &&
            row.predicted >= VO2_ESTIMATOR_MIN_HR_BPM - 1e-9
        )
        .sort((a, b) => b.entry.watts - a.entry.watts);
      const chosen = safe[0];
      if (!chosen) {
        return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, hard, planning, {
          last_measured_watts: last?.watts,
          last_steady_hr_bpm: last?.steadyHrBpm,
        });
      }
      const provenance: Vo2AdaptiveStageProvenance = {
        provenance_version: VO2_ADAPTIVE_PLANNER_VERSION,
        prior_eligible_stage_count: input.eligible.length,
        hard_hr_ceiling_bpm: hard,
        planning_hr_ceiling_bpm: planning,
        planning_margin_bpm: policy.safety_margin_bpm,
        predicted_next_hr_bpm: chosen.predicted,
        selected_target_watts: chosen.entry.watts,
        selected_calibrated_watts: chosen.entry.watts,
        selected_resistance: chosen.entry.resistance,
        decision: "retry",
        reason_code: "retry_lower_after_above_ceiling",
      };
      if (last) {
        provenance.previous_measured_watts = last.watts;
        provenance.previous_steady_hr_bpm = last.steadyHrBpm;
      }
      return {
        decision: "next",
        reason_code: "retry_lower_after_above_ceiling",
        target_watts: chosen.entry.watts,
        prescribed_resistance: chosen.entry.resistance,
        calibrated_watts: chosen.entry.watts,
        predicted_hr_bpm: chosen.predicted,
        provenance,
      };
    }
    const headroomHr = last?.steadyHrBpm;
    if (headroomHr == null || headroomHr > planning - policy.fallback_min_headroom_bpm) {
      return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, hard, planning, {
        last_measured_watts: last?.watts,
        last_steady_hr_bpm: headroomHr ?? lastCompleted.steadyHrBpm,
      });
    }
    const target = baseCalibrated + policy.fallback_watt_step;
    const sorted = [...candidates].sort(
      (a, b) => Math.abs(a.watts - target) - Math.abs(b.watts - target) || a.watts - b.watts
    );
    const chosen = sorted[0];
    const provenance: Vo2AdaptiveStageProvenance = {
      provenance_version: VO2_ADAPTIVE_PLANNER_VERSION,
      prior_eligible_stage_count: input.eligible.length,
      hard_hr_ceiling_bpm: hard,
      planning_hr_ceiling_bpm: planning,
      planning_margin_bpm: policy.safety_margin_bpm,
      selected_target_watts: target,
      selected_calibrated_watts: chosen.watts,
      selected_resistance: chosen.resistance,
      decision: "retry",
      reason_code: "retry_lower_after_above_ceiling",
    };
    if (last) {
      provenance.previous_measured_watts = last.watts;
      provenance.previous_steady_hr_bpm = last.steadyHrBpm;
    }
    return {
      decision: "next",
      reason_code: "retry_lower_after_above_ceiling",
      target_watts: target,
      prescribed_resistance: chosen.resistance,
      calibrated_watts: chosen.watts,
      provenance,
    };
  }

  if (input.eligible.length >= 2) {
    const line = slopeFromEligible(input.eligible);
    if (!line || !(line.slope > 0)) {
      return cannot("nonpositive_slope", "insufficient_eligible_stages", input, policy, hard, planning);
    }
    const maxSafeWatts = (planning - line.intercept) / line.slope;
    const minWattsForFloor = (VO2_ESTIMATOR_MIN_HR_BPM - line.intercept) / line.slope;
    if (!(maxSafeWatts > 0) || minWattsForFloor > maxSafeWatts) {
      return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, hard, planning, {
        last_measured_watts: last?.watts,
        last_steady_hr_bpm: last?.steadyHrBpm,
      });
    }
    const baseCalibrated = last?.calibratedWatts ?? input.warmupCalibratedWatts;
    let target = Math.min(baseCalibrated + policy.normal_watt_increment, maxSafeWatts);
    target = Math.min(target, baseCalibrated + policy.max_watt_increment);
    const allAboveBase = listCandidates(input.calibration, policy, input.usedResistances).filter(
      (entry) => entry.watts > baseCalibrated + 1e-9
    );
    if (allAboveBase.length === 0) {
      return cannot(
        "workload_bounds_exhausted",
        "insufficient_calibrated_workloads",
        input,
        policy,
        hard,
        planning
      );
    }
    const above = allAboveBase.filter(
      (entry) => entry.watts > baseCalibrated + policy.min_watt_separation - 1e-9
    );
    if (above.length === 0) {
      return cannot("insufficient_separation", "insufficient_eligible_stages", input, policy, hard, planning, {
        last_measured_watts: last?.watts,
        last_steady_hr_bpm: last?.steadyHrBpm,
      });
    }
    const safe = above
      .map((entry) => ({ entry, predicted: line.slope * entry.watts + line.intercept }))
      .filter(
        (row) =>
          Number.isFinite(row.predicted) &&
          row.predicted < planning - 1e-9 &&
          row.predicted >= VO2_ESTIMATOR_MIN_HR_BPM - 1e-9
      );
    if (safe.length === 0) {
      const anyAbovePlanning = above.some((entry) => {
        const predicted = line.slope * entry.watts + line.intercept;
        return Number.isFinite(predicted) && predicted >= planning - 1e-9;
      });
      if (anyAbovePlanning) {
        return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, hard, planning, {
          last_measured_watts: last?.watts,
          last_steady_hr_bpm: last?.steadyHrBpm,
        });
      }
      return cannot("below_floor_no_safe_target", "insufficient_eligible_stages", input, policy, hard, planning);
    }
    safe.sort(
      (a, b) =>
        Math.abs(a.entry.watts - target) - Math.abs(b.entry.watts - target) || a.entry.watts - b.entry.watts
    );
    const chosen = safe[0];
    const nearCeiling = planning - chosen.predicted < policy.near_ceiling_threshold_bpm;
    const reason_code: Vo2AdaptiveDecisionReasonCode = nearCeiling
      ? "reduced_increment_near_ceiling"
      : "safe_increment";
    const provenance: Vo2AdaptiveStageProvenance = {
      provenance_version: VO2_ADAPTIVE_PLANNER_VERSION,
      prior_eligible_stage_count: input.eligible.length,
      hard_hr_ceiling_bpm: hard,
      planning_hr_ceiling_bpm: planning,
      planning_margin_bpm: policy.safety_margin_bpm,
      predicted_next_hr_bpm: chosen.predicted,
      selected_target_watts: target,
      selected_calibrated_watts: chosen.entry.watts,
      selected_resistance: chosen.entry.resistance,
      decision: "next",
      reason_code,
    };
    if (last) {
      provenance.previous_measured_watts = last.watts;
      provenance.previous_steady_hr_bpm = last.steadyHrBpm;
    }
    return {
      decision: "next",
      reason_code,
      target_watts: target,
      prescribed_resistance: chosen.entry.resistance,
      calibrated_watts: chosen.entry.watts,
      predicted_hr_bpm: chosen.predicted,
      provenance,
    };
  }

  if (input.completedWorkStages === 0) {
    const target = input.warmupCalibratedWatts + policy.bootstrap_watt_step;
    const candidates = listCandidates(input.calibration, policy, input.usedResistances).filter(
      (entry) => entry.watts > input.warmupCalibratedWatts + policy.min_watt_separation - 1e-9
    );
    if (candidates.length === 0) {
      return cannot(
        "workload_bounds_exhausted",
        "insufficient_calibrated_workloads",
        input,
        policy,
        hard,
        planning
      );
    }
    const sorted = [...candidates].sort(
      (a, b) => Math.abs(a.watts - target) - Math.abs(b.watts - target) || a.watts - b.watts
    );
    const chosen = sorted[0];
    const provenance: Vo2AdaptiveStageProvenance = {
      provenance_version: VO2_ADAPTIVE_PLANNER_VERSION,
      prior_eligible_stage_count: 0,
      hard_hr_ceiling_bpm: hard,
      planning_hr_ceiling_bpm: planning,
      planning_margin_bpm: policy.safety_margin_bpm,
      selected_target_watts: target,
      selected_calibrated_watts: chosen.watts,
      selected_resistance: chosen.resistance,
      decision: "next",
      reason_code: "bootstrap_first_stage",
    };
    return {
      decision: "next",
      reason_code: "bootstrap_first_stage",
      target_watts: target,
      prescribed_resistance: chosen.resistance,
      calibrated_watts: chosen.watts,
      provenance,
    };
  }

  const baseCalibrated =
    last?.calibratedWatts ?? lastCompleted?.calibratedWatts ?? input.warmupCalibratedWatts;
  const headroomHr = last?.steadyHrBpm ?? lastCompleted?.steadyHrBpm;
  if (headroomHr != null && headroomHr > planning - policy.fallback_min_headroom_bpm) {
    return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, hard, planning, {
      last_measured_watts: last?.watts ?? lastCompleted?.measuredWatts,
      last_steady_hr_bpm: headroomHr,
    });
  }
  const target = baseCalibrated + policy.fallback_watt_step;
  const candidates = listCandidates(input.calibration, policy, input.usedResistances).filter(
    (entry) => entry.watts > baseCalibrated + policy.min_watt_separation - 1e-9
  );
  if (candidates.length === 0) {
    return cannot(
      "workload_bounds_exhausted",
      "insufficient_calibrated_workloads",
      input,
      policy,
      hard,
      planning
    );
  }
  const sorted = [...candidates].sort(
    (a, b) => Math.abs(a.watts - target) - Math.abs(b.watts - target) || a.watts - b.watts
  );
  const chosen = sorted[0];
  const provenance: Vo2AdaptiveStageProvenance = {
    provenance_version: VO2_ADAPTIVE_PLANNER_VERSION,
    prior_eligible_stage_count: input.eligible.length,
    hard_hr_ceiling_bpm: hard,
    planning_hr_ceiling_bpm: planning,
    planning_margin_bpm: policy.safety_margin_bpm,
    selected_target_watts: target,
    selected_calibrated_watts: chosen.watts,
    selected_resistance: chosen.resistance,
    decision: "next",
    reason_code: "conservative_step_insufficient_evidence",
  };
  if (last) {
    provenance.previous_measured_watts = last.watts;
    provenance.previous_steady_hr_bpm = last.steadyHrBpm;
  } else if (lastCompleted?.steadyHrBpm != null) {
    provenance.previous_steady_hr_bpm = lastCompleted.steadyHrBpm;
    if (lastCompleted.measuredWatts != null) {
      provenance.previous_measured_watts = lastCompleted.measuredWatts;
    }
  }
  return {
    decision: "next",
    reason_code: "conservative_step_insufficient_evidence",
    target_watts: target,
    prescribed_resistance: chosen.resistance,
    calibrated_watts: chosen.watts,
    provenance,
  };
}
