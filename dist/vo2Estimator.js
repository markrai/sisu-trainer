import { VO2_ASSESSMENT_SCHEMA_VERSION, VO2_PROTOCOL_ID, VO2_PROTOCOL_VERSION, } from "./types.js";
/** Versioned submaximal cycle-ergometer estimator. Bound to protocol id AND version. */
export const VO2_ESTIMATOR_ID = "bike-submax-linear-hr-workload";
export const VO2_ESTIMATOR_VERSION = 1;
/** Estimator v1 consumes only protocol `bike-submax-70rpm` version 1. */
export const VO2_ESTIMATOR_PROTOCOL_VERSION = VO2_PROTOCOL_VERSION;
/** Minimum accepted steady-state stages required to estimate. Matches protocol target. */
export const VO2_MIN_ACCEPTED_STAGES = 3;
export const VO2_MIN_ELIGIBLE_STAGES = 3;
/**
 * Tanaka et al. (2001) age-predicted HRmax (bpm):
 * HRmax = 208 − (0.7 × age_years)
 */
export const TANAKA_HRMAX_INTERCEPT = 208;
export const TANAKA_HRMAX_AGE_COEFFICIENT = 0.7;
/**
 * ACSM leg-cycle relative VO2 (ml/kg/min) from predicted maximal watts:
 * VO2 = (10.8 × watts / weight_kg) + 7
 */
export const ACSM_CYCLE_VO2_WATTS_COEFFICIENT = 10.8;
export const ACSM_CYCLE_VO2_RESTING_ML_KG_MIN = 7;
/** Reject rather than clamp. Linear fit must meet this R². */
export const VO2_MIN_R_SQUARED = 0.7;
export const VO2_FIT_QUALITY_HIGH_R_SQUARED = 0.95;
export const VO2_FIT_QUALITY_MODERATE_R_SQUARED = 0.85;
/**
 * Estimator-v1 HR operating envelope. This is a submaximal validity constraint
 * for this custom protocol, not an official YMCA test rule.
 * Minimum: 110 bpm. Maximum: strictly below 85% of Tanaka predicted HRmax.
 */
export const VO2_ESTIMATOR_MIN_HR_BPM = 110;
export const VO2_ESTIMATOR_SUBMAX_HRMAX_FRACTION = 0.85;
export const VO2_AGE_YEARS_MIN = 10;
export const VO2_AGE_YEARS_MAX = 100;
export const VO2_WEIGHT_KG_MIN = 20;
export const VO2_WEIGHT_KG_MAX = 250;
export const VO2_ESTIMATE_MIN_ML_KG_MIN = 10;
export const VO2_ESTIMATE_MAX_ML_KG_MIN = 100;
export const VO2_PREDICTED_HRMAX_MIN = 120;
export const VO2_PREDICTED_HRMAX_MAX = 220;
export const VO2_PREDICTED_MAX_WATTS_MAX = 800;
export function predictedHrMaxBpm(ageYears) {
    return TANAKA_HRMAX_INTERCEPT - TANAKA_HRMAX_AGE_COEFFICIENT * ageYears;
}
export function estimatorSubmaxHrCeilingBpm(predictedHrMax) {
    return VO2_ESTIMATOR_SUBMAX_HRMAX_FRACTION * predictedHrMax;
}
export function cycleVo2MlKgMin(predictedMaxWatts, weightKg) {
    return (ACSM_CYCLE_VO2_WATTS_COEFFICIENT * predictedMaxWatts) / weightKg + ACSM_CYCLE_VO2_RESTING_ML_KG_MIN;
}
function isPositiveFinite(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function copyPoint(point) {
    return {
        ...point,
        ineligibility_reasons: [...point.ineligibility_reasons],
    };
}
function classifyAcceptedStage(stage, predictedHrMax) {
    var _a, _b, _c, _d;
    const reasons = [];
    const workload = stage.workload;
    const source = (_a = workload === null || workload === void 0 ? void 0 : workload.source) !== null && _a !== void 0 ? _a : "prescribed_only";
    const estimatorWatts = isPositiveFinite(workload === null || workload === void 0 ? void 0 : workload.estimator_watts) ? workload.estimator_watts : undefined;
    const hr = isPositiveFinite((_b = stage.hr) === null || _b === void 0 ? void 0 : _b.steady_state_bpm) ? stage.hr.steady_state_bpm : undefined;
    const point = {
        stage_id: stage.stage_id,
        protocol_accepted: true,
        estimator_eligible: false,
        ineligibility_reasons: reasons,
        workload_source: source,
        calibrated_watts_at_70rpm: stage.calibrated_watts_at_70rpm,
        cadence_measured: (_c = workload === null || workload === void 0 ? void 0 : workload.cadence_measured) !== null && _c !== void 0 ? _c : false,
        watts_measured: (_d = workload === null || workload === void 0 ? void 0 : workload.watts_measured) !== null && _d !== void 0 ? _d : false,
    };
    if (hr != null)
        point.steady_state_bpm = hr;
    if (estimatorWatts != null)
        point.watts = estimatorWatts;
    if ((workload === null || workload === void 0 ? void 0 : workload.measured_cadence_median_rpm) != null) {
        point.measured_cadence_median_rpm = workload.measured_cadence_median_rpm;
    }
    if ((workload === null || workload === void 0 ? void 0 : workload.measured_watts_median) != null)
        point.measured_watts_median = workload.measured_watts_median;
    if ((workload === null || workload === void 0 ? void 0 : workload.measured_watts_sample_count) != null) {
        point.measured_watts_sample_count = workload.measured_watts_sample_count;
    }
    if ((workload === null || workload === void 0 ? void 0 : workload.measured_cadence_sample_count) != null) {
        point.measured_cadence_sample_count = workload.measured_cadence_sample_count;
    }
    if ((workload === null || workload === void 0 ? void 0 : workload.cadence_in_band_ratio) != null)
        point.cadence_in_band_ratio = workload.cadence_in_band_ratio;
    if (hr == null)
        reasons.push("missing_stage_hr");
    if (source === "prescribed_only" || estimatorWatts == null) {
        reasons.push("unverified_performed_workload");
    }
    else if (!isPositiveFinite(stage.calibrated_watts_at_70rpm) && source !== "measured_watts") {
        reasons.push("invalid_workload");
    }
    if (hr != null) {
        if (hr < VO2_ESTIMATOR_MIN_HR_BPM)
            reasons.push("hr_below_estimator_range");
        if (predictedHrMax != null && hr >= estimatorSubmaxHrCeilingBpm(predictedHrMax)) {
            reasons.push("hr_above_submax_ceiling");
        }
    }
    point.estimator_eligible = reasons.length === 0;
    return point;
}
function lastDefinedWatts(points) {
    for (let i = points.length - 1; i >= 0; i--) {
        if (points[i].watts != null)
            return points[i].watts;
    }
    return undefined;
}
function workloadsIncrease(points) {
    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1].watts;
        const next = points[i].watts;
        if (prev == null || next == null || next <= prev)
            return false;
    }
    return true;
}
function hrIncreases(points) {
    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1].steady_state_bpm;
        const next = points[i].steady_state_bpm;
        if (prev == null || next == null || next <= prev)
            return false;
    }
    return true;
}
export function fitHrVsWatts(points) {
    const usable = points.filter((point) => isPositiveFinite(point.watts) && isPositiveFinite(point.steady_state_bpm));
    const n = usable.length;
    if (n < 2)
        return undefined;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (const point of usable) {
        const x = point.watts;
        const y = point.steady_state_bpm;
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumXX += x * x;
    }
    const denom = n * sumXX - sumX * sumX;
    if (!Number.isFinite(denom) || denom === 0)
        return undefined;
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    if (!Number.isFinite(slope) || !Number.isFinite(intercept))
        return undefined;
    const meanY = sumY / n;
    let ssTot = 0;
    let ssRes = 0;
    for (const point of usable) {
        const x = point.watts;
        const y = point.steady_state_bpm;
        const predicted = slope * x + intercept;
        ssRes += (y - predicted) ** 2;
        ssTot += (y - meanY) ** 2;
    }
    if (!Number.isFinite(ssTot) || ssTot === 0)
        return undefined;
    const r_squared = 1 - ssRes / ssTot;
    if (!Number.isFinite(r_squared))
        return undefined;
    return { slope, intercept, r_squared };
}
function fitQualityFromRSquared(rSquared) {
    if (rSquared >= VO2_FIT_QUALITY_HIGH_R_SQUARED)
        return "high";
    if (rSquared >= VO2_FIT_QUALITY_MODERATE_R_SQUARED)
        return "moderate";
    return "low";
}
function uniqueReasons(codes) {
    const seen = new Set();
    const out = [];
    for (const code of codes) {
        if (seen.has(code))
            continue;
        seen.add(code);
        out.push(code);
    }
    return out;
}
function baseDiagnostics(extra = {}) {
    var _a, _b;
    return {
        accepted_points: (_a = extra.accepted_points) !== null && _a !== void 0 ? _a : [],
        eligible_points: (_b = extra.eligible_points) !== null && _b !== void 0 ? _b : [],
        min_r_squared: VO2_MIN_R_SQUARED,
        estimator_min_hr_bpm: VO2_ESTIMATOR_MIN_HR_BPM,
        estimator_submax_hrmax_fraction: VO2_ESTIMATOR_SUBMAX_HRMAX_FRACTION,
        expected_protocol_id: VO2_PROTOCOL_ID,
        expected_protocol_version: VO2_ESTIMATOR_PROTOCOL_VERSION,
        ...extra,
    };
}
function result(partial) {
    const built = {
        schema_version: VO2_ASSESSMENT_SCHEMA_VERSION,
        estimator_id: VO2_ESTIMATOR_ID,
        estimator_version: VO2_ESTIMATOR_VERSION,
        status: partial.status,
        termination_reason: partial.termination_reason,
        reason_codes: uniqueReasons(partial.reason_codes),
        accepted_stage_count: partial.accepted_stage_count,
        eligible_stage_count: partial.eligible_stage_count,
        stages_used: partial.stages_used,
        input_snapshot: partial.input_snapshot,
        diagnostics: partial.diagnostics,
    };
    if (partial.highest_accepted_workload_watts != null) {
        built.highest_accepted_workload_watts = partial.highest_accepted_workload_watts;
    }
    if (partial.estimate_ml_kg_min != null)
        built.estimate_ml_kg_min = partial.estimate_ml_kg_min;
    if (partial.fit_quality)
        built.fit_quality = partial.fit_quality;
    return built;
}
function snapshotFromProfile(profile, protocolId, protocolVersion) {
    const snapshot = {};
    if (typeof profile.age_years === "number" && Number.isFinite(profile.age_years)) {
        snapshot.age_years = profile.age_years;
    }
    if (typeof profile.weight_kg === "number" && Number.isFinite(profile.weight_kg)) {
        snapshot.weight_kg = profile.weight_kg;
    }
    if (snapshot.age_years != null) {
        const hrMax = predictedHrMaxBpm(snapshot.age_years);
        if (Number.isFinite(hrMax))
            snapshot.predicted_hr_max = hrMax;
    }
    if (protocolId != null)
        snapshot.protocol_id = protocolId;
    if (protocolVersion != null)
        snapshot.protocol_version = protocolVersion;
    return snapshot;
}
function ageValid(age) {
    return typeof age === "number" && Number.isFinite(age) && age >= VO2_AGE_YEARS_MIN && age <= VO2_AGE_YEARS_MAX;
}
function weightValid(weightKg) {
    return (typeof weightKg === "number" &&
        Number.isFinite(weightKg) &&
        weightKg >= VO2_WEIGHT_KG_MIN &&
        weightKg <= VO2_WEIGHT_KG_MAX);
}
/**
 * Pure VO2 assessment from durable protocol evidence + explicit profile inputs.
 * Does not read DOM, clocks, or workout duration.
 */
export function assessVo2(evidence, profile = {}) {
    var _a, _b, _c;
    const protocol = evidence === null || evidence === void 0 ? void 0 : evidence.protocol;
    const termination_reason = (_b = (_a = protocol === null || protocol === void 0 ? void 0 : protocol.termination) === null || _a === void 0 ? void 0 : _a.reason) !== null && _b !== void 0 ? _b : "other";
    const snapshot = snapshotFromProfile(profile, protocol === null || protocol === void 0 ? void 0 : protocol.protocol_id, protocol === null || protocol === void 0 ? void 0 : protocol.protocol_version);
    const reasons = [];
    const diagnostics = baseDiagnostics();
    if (protocol) {
        diagnostics.observed_protocol_id = protocol.protocol_id;
        diagnostics.observed_protocol_version = protocol.protocol_version;
    }
    if (!protocol) {
        reasons.push("missing_protocol_evidence");
    }
    else if (protocol.protocol_id !== VO2_PROTOCOL_ID) {
        reasons.push("unsupported_protocol_id");
    }
    else if (protocol.protocol_version !== VO2_ESTIMATOR_PROTOCOL_VERSION) {
        reasons.push("unsupported_protocol_version");
    }
    if (profile.age_years == null || (typeof profile.age_years === "number" && !Number.isFinite(profile.age_years))) {
        reasons.push("missing_profile_age");
    }
    else if (!ageValid(profile.age_years)) {
        reasons.push("invalid_profile_age");
    }
    if (profile.weight_kg == null || (typeof profile.weight_kg === "number" && !Number.isFinite(profile.weight_kg))) {
        reasons.push("missing_profile_weight");
    }
    else if (!weightValid(profile.weight_kg)) {
        reasons.push("invalid_profile_weight");
    }
    const predictedHrMax = ageValid(profile.age_years) ? predictedHrMaxBpm(profile.age_years) : undefined;
    const acceptedStages = ((_c = protocol === null || protocol === void 0 ? void 0 : protocol.stages) !== null && _c !== void 0 ? _c : []).filter((stage) => stage.status === "accepted");
    const acceptedPoints = acceptedStages.map((stage) => classifyAcceptedStage(stage, predictedHrMax));
    const eligiblePoints = acceptedPoints.filter((point) => point.estimator_eligible);
    diagnostics.accepted_points = acceptedPoints.map(copyPoint);
    diagnostics.eligible_points = eligiblePoints.map(copyPoint);
    const stageReasons = [];
    for (const point of acceptedPoints)
        stageReasons.push(...point.ineligibility_reasons);
    const stages_used = eligiblePoints.map((point) => point.stage_id);
    const highest = eligiblePoints.length > 0
        ? eligiblePoints[eligiblePoints.length - 1].watts
        : lastDefinedWatts(acceptedPoints);
    if (acceptedPoints.length < VO2_MIN_ACCEPTED_STAGES) {
        reasons.push("too_few_accepted_stages");
        reasons.push(...stageReasons);
    }
    else if (eligiblePoints.length < VO2_MIN_ELIGIBLE_STAGES) {
        reasons.push("too_few_eligible_stages");
        reasons.push(...stageReasons);
    }
    if (eligiblePoints.length >= 2 && !workloadsIncrease(eligiblePoints))
        reasons.push("invalid_workload_progression");
    if (eligiblePoints.length >= 2 && !hrIncreases(eligiblePoints))
        reasons.push("invalid_hr_progression");
    const fail = (extra = [], diag = diagnostics) => result({
        status: "insufficient_evidence",
        termination_reason,
        reason_codes: [...reasons, ...extra],
        accepted_stage_count: acceptedPoints.length,
        eligible_stage_count: eligiblePoints.length,
        stages_used,
        highest_accepted_workload_watts: highest,
        input_snapshot: snapshot,
        diagnostics: diag,
    });
    if (reasons.length > 0)
        return fail();
    const fit = fitHrVsWatts(eligiblePoints);
    diagnostics.slope = fit === null || fit === void 0 ? void 0 : fit.slope;
    diagnostics.intercept = fit === null || fit === void 0 ? void 0 : fit.intercept;
    diagnostics.r_squared = fit === null || fit === void 0 ? void 0 : fit.r_squared;
    if (!fit)
        return fail(["unstable_regression"]);
    if (!(fit.slope > 0))
        return fail(["nonpositive_slope"]);
    if (fit.r_squared < VO2_MIN_R_SQUARED)
        return fail(["unstable_regression"]);
    const age = profile.age_years;
    const weightKg = profile.weight_kg;
    const hrMax = predictedHrMaxBpm(age);
    diagnostics.predicted_hr_max = hrMax;
    snapshot.predicted_hr_max = hrMax;
    const lastHr = eligiblePoints[eligiblePoints.length - 1].steady_state_bpm;
    if (!Number.isFinite(hrMax) ||
        hrMax < VO2_PREDICTED_HRMAX_MIN ||
        hrMax > VO2_PREDICTED_HRMAX_MAX ||
        hrMax <= lastHr) {
        return fail(["invalid_extrapolation"]);
    }
    const predictedMaxWatts = (hrMax - fit.intercept) / fit.slope;
    diagnostics.predicted_max_watts = predictedMaxWatts;
    const lastWatts = eligiblePoints[eligiblePoints.length - 1].watts;
    if (!Number.isFinite(predictedMaxWatts) ||
        predictedMaxWatts <= lastWatts ||
        predictedMaxWatts > VO2_PREDICTED_MAX_WATTS_MAX) {
        return fail(["invalid_extrapolation"]);
    }
    const estimate = cycleVo2MlKgMin(predictedMaxWatts, weightKg);
    if (!Number.isFinite(estimate) ||
        estimate < VO2_ESTIMATE_MIN_ML_KG_MIN ||
        estimate > VO2_ESTIMATE_MAX_ML_KG_MIN) {
        return fail(["invalid_estimate"]);
    }
    return result({
        status: "estimated",
        termination_reason,
        reason_codes: [],
        accepted_stage_count: acceptedPoints.length,
        eligible_stage_count: eligiblePoints.length,
        stages_used,
        highest_accepted_workload_watts: highest,
        input_snapshot: snapshot,
        diagnostics,
        estimate_ml_kg_min: estimate,
        fit_quality: fitQualityFromRSquared(fit.r_squared),
    });
}
export function attachVo2Assessment(summary, assessment) {
    summary.vo2_assessment = assessment;
    return summary;
}
