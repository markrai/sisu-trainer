import { VO2_MIN_ACCEPTED_STAGES, VO2_MIN_ELIGIBLE_STAGES } from "./vo2Estimator.js";
import { VO2_WORKOUT_LABEL } from "./vo2Protocol.js";
const REASON_PRIORITY = [
    "missing_profile_age",
    "missing_profile_weight",
    "invalid_profile_age",
    "invalid_profile_weight",
    "unsupported_protocol_id",
    "unsupported_protocol_version",
    "too_few_accepted_stages",
    "too_few_eligible_stages",
    "missing_stage_hr",
    "unverified_performed_workload",
    "invalid_workload",
    "invalid_workload_progression",
    "invalid_hr_progression",
    "hr_below_estimator_range",
    "hr_above_submax_ceiling",
    "nonpositive_slope",
    "unstable_regression",
    "invalid_extrapolation",
    "invalid_estimate",
    "missing_protocol_evidence",
];
function primaryReason(codes) {
    for (const code of REASON_PRIORITY) {
        if (codes.includes(code))
            return code;
    }
    return codes[0];
}
export function formatVo2EstimateMlKgMin(value) {
    return value.toFixed(1);
}
export function vo2SelectorOptionText() {
    return VO2_WORKOUT_LABEL + " (up to 30 min)";
}
export function vo2WorkoutBlocksText(blocks) {
    return ("Warm-Up: " +
        blocks.warm +
        " min · Workout: up to " +
        blocks.sustain +
        " min · Cool-Down: " +
        blocks.cool +
        " min");
}
export function genericWorkoutBlocksText(blocks) {
    return "Warm-Up: " + blocks.warm + " min · Workout: " + blocks.sustain + " min · Cool-Down: " + blocks.cool + " min";
}
export function vo2EndWorkoutButtonLabel(isVo2) {
    return isVo2 ? "End test" : "Yes, end and save";
}
export function vo2CancelModalTitle(isVo2) {
    return isVo2 ? "End test?" : "End workout?";
}
export function vo2CancelModalBody(isVo2) {
    return isVo2
        ? "You can cool down, record that you reached your limit, end and save, or keep going."
        : "You can cool down first, end and save now, or keep going.";
}
export function vo2LimitReachedButtonVisible(isVo2, workStillActive) {
    return isVo2 && workStillActive;
}
export function vo2HistoryOutcomeText(result) {
    if (!result)
        return null;
    if (result.status === "estimated" && result.estimate_ml_kg_min != null && Number.isFinite(result.estimate_ml_kg_min)) {
        return "VO₂ " + formatVo2EstimateMlKgMin(result.estimate_ml_kg_min) + " ml/kg/min";
    }
    return "VO₂ estimate unavailable";
}
function profileMissingDetail(codes) {
    const missingAge = codes.includes("missing_profile_age") || codes.includes("invalid_profile_age");
    const missingWeight = codes.includes("missing_profile_weight") || codes.includes("invalid_profile_weight");
    if (missingAge && missingWeight) {
        return "Your age and body weight are required for this estimate. Add them in Settings → Profile.";
    }
    if (missingAge) {
        return "Your age is required for this estimate. Add it in Settings → Profile.";
    }
    return "Your body weight is required for this estimate. Add it in Settings → Profile.";
}
export function vo2InsufficientDetail(result) {
    const reason = primaryReason(result.reason_codes);
    switch (reason) {
        case "missing_profile_age":
        case "missing_profile_weight":
        case "invalid_profile_age":
        case "invalid_profile_weight":
            return profileMissingDetail(result.reason_codes);
        case "too_few_accepted_stages":
            return ("Only " +
                result.accepted_stage_count +
                " stable work stage" +
                (result.accepted_stage_count === 1 ? " was" : "s were") +
                " completed. At least " +
                VO2_MIN_ACCEPTED_STAGES +
                " are required.");
        case "too_few_eligible_stages":
            return ("Only " +
                result.eligible_stage_count +
                " of your stable work stages had usable heart-rate and workload data. At least " +
                VO2_MIN_ELIGIBLE_STAGES +
                " valid submaximal stages are required.");
        case "missing_stage_hr":
            return "One or more stages is missing a stable heart-rate reading.";
        case "unverified_performed_workload":
            return "Performed workload could not be validated from bike telemetry.";
        case "invalid_workload":
        case "invalid_workload_progression":
            return "Stage workloads did not increase as required.";
        case "invalid_hr_progression":
        case "nonpositive_slope":
            return "Heart rate did not increase with workload as required.";
        case "hr_below_estimator_range":
            return "Heart rate stayed below the range this estimate can use.";
        case "hr_above_submax_ceiling":
            return "Heart rate was too close to predicted maximum for a submaximal estimate.";
        case "unstable_regression":
            return "The heart-rate response did not form a reliable pattern.";
        case "invalid_extrapolation":
        case "invalid_estimate":
            return "The estimate could not be projected to maximal heart rate from this data.";
        default:
            return "We recorded the test, but there wasn't enough stable workload and heart-rate data to produce a reliable estimate.";
    }
}
function fitQualityLine(result) {
    if (result.fit_quality === "high")
        return "Strong heart-rate/workload fit.";
    if (result.fit_quality === "moderate")
        return "Adequate heart-rate/workload fit.";
    if (result.fit_quality === "low")
        return "Limited heart-rate/workload fit.";
    return "";
}
function workloadSourceLine(result) {
    var _a;
    const sources = new Set(((_a = result.diagnostics.eligible_points) !== null && _a !== void 0 ? _a : [])
        .map((point) => point.workload_source)
        .filter((source) => source != null));
    if (sources.size === 1 && sources.has("measured_watts")) {
        return "Estimated from your cycling heart-rate response to measured bike workload.";
    }
    if (sources.has("calibrated_at_verified_cadence") && !sources.has("measured_watts")) {
        return "Cadence was verified; workload used the 70-RPM calibration table.";
    }
    return "Estimated from your cycling heart-rate response.";
}
export function vo2AssessmentPresentation(result) {
    if (!result) {
        return {
            title: "VO₂ Max Estimate",
            valueText: "",
            body: "No VO₂ assessment was recorded for this workout.",
            detail: "",
            estimated: false,
        };
    }
    if (result.status === "estimated" && result.estimate_ml_kg_min != null && Number.isFinite(result.estimate_ml_kg_min)) {
        const stages = result.eligible_stage_count || result.stages_used.length;
        return {
            title: "VO₂ Max Estimate",
            valueText: formatVo2EstimateMlKgMin(result.estimate_ml_kg_min) + " ml/kg/min",
            body: "Based on " +
                stages +
                " stable stage" +
                (stages === 1 ? "" : "s") +
                ". " +
                workloadSourceLine(result),
            detail: fitQualityLine(result),
            estimated: true,
        };
    }
    return {
        title: "Not enough data to estimate VO₂ max",
        valueText: "",
        body: "We recorded the test, but there wasn't enough stable workload and heart-rate data to produce a reliable estimate.",
        detail: vo2InsufficientDetail(result),
        estimated: false,
    };
}
