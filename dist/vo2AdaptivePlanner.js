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
import { VO2_PROTOCOL_VERSION_V3, } from "./types.js";
import { VO2_ESTIMATOR_MIN_HR_BPM, VO2_ESTIMATOR_SUBMAX_HRMAX_FRACTION, VO2_MIN_ELIGIBLE_STAGES, VO2_PREDICTED_HRMAX_MAX, VO2_PREDICTED_HRMAX_MIN, estimatorSubmaxHrCeilingBpm, fitHrVsWatts, } from "./vo2Estimator.js";
import { VO2_PROTOCOL_MAX_RESISTANCE } from "./vo2Protocol.js";
import { AUTOMATIC_RESISTANCE_MIN } from "./machines/proformSmartPower10.js";
export const VO2_ADAPTIVE_PLANNER_VERSION = 1;
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
export const DEFAULT_VO2_ADAPTIVE_POLICY = {
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
function resolvePolicy(overrides) {
    return { ...DEFAULT_VO2_ADAPTIVE_POLICY, ...(overrides !== null && overrides !== void 0 ? overrides : {}) };
}
function isPositiveFinite(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function lastEligible(input) {
    return input.eligible.length > 0 ? input.eligible[input.eligible.length - 1] : undefined;
}
function listCandidates(calibration, policy, used) {
    const out = [];
    for (let r = policy.min_resistance; r <= policy.max_resistance; r++) {
        if (!Number.isInteger(r))
            continue;
        if (used.has(r))
            continue;
        const watts = calibration(r);
        if (!isPositiveFinite(watts))
            continue;
        out.push({ resistance: r, watts: watts });
    }
    out.sort((a, b) => a.watts - b.watts || a.resistance - b.resistance);
    return out;
}
function slopeFromEligible(eligible) {
    if (eligible.length < 2)
        return undefined;
    const fit = fitHrVsWatts(eligible.map((point) => ({ watts: point.watts, steady_state_bpm: point.steadyHrBpm })));
    if (!fit || !Number.isFinite(fit.slope) || !Number.isFinite(fit.intercept))
        return undefined;
    return { slope: fit.slope, intercept: fit.intercept };
}
function cannot(reason_code, termination_reason, input, policy, hard, planning, extra) {
    var _a, _b, _c, _d, _e, _f;
    const last = lastEligible(input);
    const provenance = {
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
    const measured = (_b = (_a = extra === null || extra === void 0 ? void 0 : extra.last_measured_watts) !== null && _a !== void 0 ? _a : last === null || last === void 0 ? void 0 : last.watts) !== null && _b !== void 0 ? _b : (_c = input.lastCompleted) === null || _c === void 0 ? void 0 : _c.measuredWatts;
    const hr = (_e = (_d = extra === null || extra === void 0 ? void 0 : extra.last_steady_hr_bpm) !== null && _d !== void 0 ? _d : last === null || last === void 0 ? void 0 : last.steadyHrBpm) !== null && _e !== void 0 ? _e : (_f = input.lastCompleted) === null || _f === void 0 ? void 0 : _f.steadyHrBpm;
    if (measured != null)
        provenance.last_measured_watts = measured;
    if (hr != null)
        provenance.last_steady_hr_bpm = hr;
    if ((extra === null || extra === void 0 ? void 0 : extra.predicted_hr_bpm) != null)
        provenance.predicted_hr_bpm = extra.predicted_hr_bpm;
    return { decision: "cannot", reason_code, termination_reason, provenance };
}
/**
 * Pure planner: given eligible observations and estimator envelope, decide
 * Complete | NextStage(target) | CannotContinue(reason).
 */
export function planNextVo2Stage(rawInput) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const policy = resolvePolicy(rawInput.policy);
    const input = { ...rawInput, policy };
    const predictedHrMax = input.predictedHrMax;
    if (!Number.isFinite(predictedHrMax) ||
        predictedHrMax < VO2_PREDICTED_HRMAX_MIN ||
        predictedHrMax > VO2_PREDICTED_HRMAX_MAX) {
        return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, Number.NaN, Number.NaN);
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
    if ((lastCompleted === null || lastCompleted === void 0 ? void 0 : lastCompleted.aboveCeiling) === true) {
        if (input.retryCount >= policy.max_retries_after_above_ceiling) {
            return cannot("retry_limit_reached", "submax_hr_ceiling", input, policy, hard, planning, {
                last_measured_watts: (_a = lastCompleted.measuredWatts) !== null && _a !== void 0 ? _a : last === null || last === void 0 ? void 0 : last.watts,
                last_steady_hr_bpm: (_b = lastCompleted.steadyHrBpm) !== null && _b !== void 0 ? _b : last === null || last === void 0 ? void 0 : last.steadyHrBpm,
            });
        }
        const baseCalibrated = (_c = last === null || last === void 0 ? void 0 : last.calibratedWatts) !== null && _c !== void 0 ? _c : input.warmupCalibratedWatts;
        const ceilingWatts = lastCompleted.calibratedWatts;
        const candidates = listCandidates(input.calibration, policy, input.usedResistances).filter((entry) => entry.watts > baseCalibrated + policy.min_watt_separation - 1e-9 && entry.watts < ceilingWatts - 1e-9);
        if (candidates.length === 0) {
            return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, hard, planning, {
                last_measured_watts: last === null || last === void 0 ? void 0 : last.watts,
                last_steady_hr_bpm: last === null || last === void 0 ? void 0 : last.steadyHrBpm,
            });
        }
        if (input.eligible.length >= 2) {
            const line = slopeFromEligible(input.eligible);
            if (!line || !(line.slope > 0)) {
                return cannot("nonpositive_slope", "insufficient_eligible_stages", input, policy, hard, planning);
            }
            const safe = candidates
                .map((entry) => ({ entry, predicted: line.slope * entry.watts + line.intercept }))
                .filter((row) => Number.isFinite(row.predicted) &&
                row.predicted < planning - 1e-9 &&
                row.predicted >= VO2_ESTIMATOR_MIN_HR_BPM - 1e-9)
                .sort((a, b) => b.entry.watts - a.entry.watts);
            const chosen = safe[0];
            if (!chosen) {
                return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, hard, planning, {
                    last_measured_watts: last === null || last === void 0 ? void 0 : last.watts,
                    last_steady_hr_bpm: last === null || last === void 0 ? void 0 : last.steadyHrBpm,
                });
            }
            const provenance = {
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
        const headroomHr = last === null || last === void 0 ? void 0 : last.steadyHrBpm;
        if (headroomHr == null || headroomHr > planning - policy.fallback_min_headroom_bpm) {
            return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, hard, planning, {
                last_measured_watts: last === null || last === void 0 ? void 0 : last.watts,
                last_steady_hr_bpm: headroomHr !== null && headroomHr !== void 0 ? headroomHr : lastCompleted.steadyHrBpm,
            });
        }
        const target = baseCalibrated + policy.fallback_watt_step;
        const sorted = [...candidates].sort((a, b) => Math.abs(a.watts - target) - Math.abs(b.watts - target) || a.watts - b.watts);
        const chosen = sorted[0];
        const provenance = {
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
                last_measured_watts: last === null || last === void 0 ? void 0 : last.watts,
                last_steady_hr_bpm: last === null || last === void 0 ? void 0 : last.steadyHrBpm,
            });
        }
        const baseCalibrated = (_d = last === null || last === void 0 ? void 0 : last.calibratedWatts) !== null && _d !== void 0 ? _d : input.warmupCalibratedWatts;
        let target = Math.min(baseCalibrated + policy.normal_watt_increment, maxSafeWatts);
        target = Math.min(target, baseCalibrated + policy.max_watt_increment);
        const allAboveBase = listCandidates(input.calibration, policy, input.usedResistances).filter((entry) => entry.watts > baseCalibrated + 1e-9);
        if (allAboveBase.length === 0) {
            return cannot("workload_bounds_exhausted", "insufficient_calibrated_workloads", input, policy, hard, planning);
        }
        const above = allAboveBase.filter((entry) => entry.watts > baseCalibrated + policy.min_watt_separation - 1e-9);
        if (above.length === 0) {
            return cannot("insufficient_separation", "insufficient_eligible_stages", input, policy, hard, planning, {
                last_measured_watts: last === null || last === void 0 ? void 0 : last.watts,
                last_steady_hr_bpm: last === null || last === void 0 ? void 0 : last.steadyHrBpm,
            });
        }
        const safe = above
            .map((entry) => ({ entry, predicted: line.slope * entry.watts + line.intercept }))
            .filter((row) => Number.isFinite(row.predicted) &&
            row.predicted < planning - 1e-9 &&
            row.predicted >= VO2_ESTIMATOR_MIN_HR_BPM - 1e-9);
        if (safe.length === 0) {
            const anyAbovePlanning = above.some((entry) => {
                const predicted = line.slope * entry.watts + line.intercept;
                return Number.isFinite(predicted) && predicted >= planning - 1e-9;
            });
            if (anyAbovePlanning) {
                return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, hard, planning, {
                    last_measured_watts: last === null || last === void 0 ? void 0 : last.watts,
                    last_steady_hr_bpm: last === null || last === void 0 ? void 0 : last.steadyHrBpm,
                });
            }
            return cannot("below_floor_no_safe_target", "insufficient_eligible_stages", input, policy, hard, planning);
        }
        safe.sort((a, b) => Math.abs(a.entry.watts - target) - Math.abs(b.entry.watts - target) || a.entry.watts - b.entry.watts);
        const chosen = safe[0];
        const nearCeiling = planning - chosen.predicted < policy.near_ceiling_threshold_bpm;
        const reason_code = nearCeiling
            ? "reduced_increment_near_ceiling"
            : "safe_increment";
        const provenance = {
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
        const candidates = listCandidates(input.calibration, policy, input.usedResistances).filter((entry) => entry.watts > input.warmupCalibratedWatts + policy.min_watt_separation - 1e-9);
        if (candidates.length === 0) {
            return cannot("workload_bounds_exhausted", "insufficient_calibrated_workloads", input, policy, hard, planning);
        }
        const sorted = [...candidates].sort((a, b) => Math.abs(a.watts - target) - Math.abs(b.watts - target) || a.watts - b.watts);
        const chosen = sorted[0];
        const provenance = {
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
    const baseCalibrated = (_f = (_e = last === null || last === void 0 ? void 0 : last.calibratedWatts) !== null && _e !== void 0 ? _e : lastCompleted === null || lastCompleted === void 0 ? void 0 : lastCompleted.calibratedWatts) !== null && _f !== void 0 ? _f : input.warmupCalibratedWatts;
    const headroomHr = (_g = last === null || last === void 0 ? void 0 : last.steadyHrBpm) !== null && _g !== void 0 ? _g : lastCompleted === null || lastCompleted === void 0 ? void 0 : lastCompleted.steadyHrBpm;
    if (headroomHr != null && headroomHr > planning - policy.fallback_min_headroom_bpm) {
        return cannot("hr_safety_no_safe_target", "submax_hr_ceiling", input, policy, hard, planning, {
            last_measured_watts: (_h = last === null || last === void 0 ? void 0 : last.watts) !== null && _h !== void 0 ? _h : lastCompleted === null || lastCompleted === void 0 ? void 0 : lastCompleted.measuredWatts,
            last_steady_hr_bpm: headroomHr,
        });
    }
    const target = baseCalibrated + policy.fallback_watt_step;
    const candidates = listCandidates(input.calibration, policy, input.usedResistances).filter((entry) => entry.watts > baseCalibrated + policy.min_watt_separation - 1e-9);
    if (candidates.length === 0) {
        return cannot("workload_bounds_exhausted", "insufficient_calibrated_workloads", input, policy, hard, planning);
    }
    const sorted = [...candidates].sort((a, b) => Math.abs(a.watts - target) - Math.abs(b.watts - target) || a.watts - b.watts);
    const chosen = sorted[0];
    const provenance = {
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
    }
    else if ((lastCompleted === null || lastCompleted === void 0 ? void 0 : lastCompleted.steadyHrBpm) != null) {
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
