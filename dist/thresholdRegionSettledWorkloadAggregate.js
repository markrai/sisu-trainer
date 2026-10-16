/**
 * Threshold-region settled-workload multi-session aggregation contract
 * (design / shadow-only).
 *
 * Scientific claim: across repeated ordinary Threshold workouts on the same
 * athlete and compatible machine/calibration/HR-band lineage, qualifying
 * single-session settled observations support a repeatable measured workload
 * associated with the workout's legacy Threshold HR region.
 *
 * This is NOT FTP, lactate / ventilatory threshold, critical power, E1
 * inversion, Phase D whole-phase refinement, UI advice, or active control.
 *
 * Independence unit: one workout session → at most one observation.
 * Aggregate statistic: unweighted median of session measured-watt medians.
 *
 * Production emission requires unresolved scientific fields to be set.
 */
import { canonicalMedian } from "./stats.js";
import { medianAbsoluteDeviation } from "./performedLoad.js";
import { THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1, THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1, THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1, THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1, THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1, } from "./thresholdRegionSettledWorkload.js";
/** Aggregate evidence schema identity (distinct from single-session observation). */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1 = "threshold-region-settled-workload-aggregate";
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_VERSION_V1 = 1;
/** Aggregation policy identity (distinct from single-session admission policy). */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1 = "threshold-region-settled-workload-aggregate-policy";
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1 = 1;
/** Provenance label for the multi-session claim. */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1 = "ordinary_workout_settled_threshold_region_aggregate";
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1 = {
    id: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1,
    version: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1,
    independenceUnit: "session",
    aggregateStatistic: "median_of_session_medians",
    minSessions: 3,
    minDistinctDates: 3,
    maxCrossSessionMadRatio: null,
    trendHandling: "diagnostic_only",
    maxObservationAgeDays: null,
    allowShadowCandidateEligibility: true,
};
function unresolvedAggregateFields(policy) {
    const fields = [];
    if (policy.maxCrossSessionMadRatio === null)
        fields.push("maxCrossSessionMadRatio");
    if (policy.maxObservationAgeDays === null)
        fields.push("maxObservationAgeDays");
    return fields;
}
export function thresholdRegionAggregatePolicyIsProductionReady(policy = THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1) {
    return unresolvedAggregateFields(policy).length === 0;
}
function isValidObservationPayload(observation) {
    return (observation.schemaId === THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1 &&
        observation.schemaVersion === THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1 &&
        observation.provenance === THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1 &&
        observation.workoutIntent === "threshold" &&
        observation.intensityId === "threshold" &&
        observation.eligibleForPrescription === false &&
        observation.interpretation === "descriptive_observation_only" &&
        typeof observation.athleteId === "string" &&
        typeof observation.sessionId === "string" &&
        typeof observation.machineId === "string" &&
        typeof observation.machineProfileVersion === "number" &&
        Number.isFinite(observation.machineProfileVersion) &&
        typeof observation.formalAnchorObservedAt === "string" &&
        Number.isFinite(observation.targetHrMin) &&
        Number.isFinite(observation.targetHrMax) &&
        Number.isFinite(observation.measuredWattsMedian) &&
        observation.measuredWattsMedian > 0 &&
        typeof observation.workoutDate === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(observation.workoutDate));
}
function compatibilityKeyFrom(observation) {
    return {
        athleteId: observation.athleteId,
        machineId: observation.machineId,
        machineProfileVersion: observation.machineProfileVersion,
        formalAnchorObservedAt: observation.formalAnchorObservedAt,
        targetHrMin: observation.targetHrMin,
        targetHrMax: observation.targetHrMax,
        admissionPolicyId: THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1,
        admissionPolicyVersion: THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1,
        observationSchemaId: THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1,
        observationSchemaVersion: THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1,
        observationProvenance: THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1,
    };
}
function keysEqual(a, b) {
    return (a.athleteId === b.athleteId &&
        a.machineId === b.machineId &&
        a.machineProfileVersion === b.machineProfileVersion &&
        a.formalAnchorObservedAt === b.formalAnchorObservedAt &&
        a.targetHrMin === b.targetHrMin &&
        a.targetHrMax === b.targetHrMax &&
        a.admissionPolicyId === b.admissionPolicyId &&
        a.admissionPolicyVersion === b.admissionPolicyVersion &&
        a.observationSchemaId === b.observationSchemaId &&
        a.observationSchemaVersion === b.observationSchemaVersion &&
        a.observationProvenance === b.observationProvenance);
}
function compatibilityFailures(expected, actual) {
    const failures = [];
    if (actual.athleteId !== expected.athleteId)
        failures.push("incompatible_athlete");
    if (actual.machineId !== expected.machineId)
        failures.push("incompatible_machine");
    if (actual.machineProfileVersion !== expected.machineProfileVersion) {
        failures.push("incompatible_machine_profile");
    }
    if (actual.formalAnchorObservedAt !== expected.formalAnchorObservedAt) {
        failures.push("incompatible_formal_anchor");
    }
    if (actual.targetHrMin !== expected.targetHrMin || actual.targetHrMax !== expected.targetHrMax) {
        failures.push("incompatible_target_hr_band");
    }
    if (actual.admissionPolicyId !== expected.admissionPolicyId ||
        actual.admissionPolicyVersion !== expected.admissionPolicyVersion) {
        failures.push("incompatible_admission_policy");
    }
    if (actual.observationSchemaId !== expected.observationSchemaId ||
        actual.observationSchemaVersion !== expected.observationSchemaVersion) {
        failures.push("incompatible_observation_schema");
    }
    if (actual.observationProvenance !== expected.observationProvenance) {
        failures.push("incompatible_provenance");
    }
    return failures;
}
/** Chronological by workoutDate then sessionId. */
function chronological(observations) {
    return [...observations].sort((a, b) => a.workoutDate.localeCompare(b.workoutDate) || a.sessionId.localeCompare(b.sessionId));
}
export function classifyCrossSessionTrend(sessionMediansChronological) {
    if (sessionMediansChronological.length < 2)
        return "flat";
    let rises = 0;
    let falls = 0;
    for (let i = 1; i < sessionMediansChronological.length; i += 1) {
        const delta = sessionMediansChronological[i] - sessionMediansChronological[i - 1];
        if (delta > 0)
            rises += 1;
        else if (delta < 0)
            falls += 1;
    }
    if (rises > 0 && falls === 0)
        return "rising";
    if (falls > 0 && rises === 0)
        return "falling";
    if (rises === 0 && falls === 0)
        return "flat";
    return "mixed";
}
function ageDays(newerIsoDate, olderIsoDate) {
    const a = Date.parse(`${newerIsoDate}T00:00:00.000Z`);
    const b = Date.parse(`${olderIsoDate}T00:00:00.000Z`);
    if (!Number.isFinite(a) || !Number.isFinite(b))
        return null;
    return Math.round((a - b) / (24 * 3600 * 1000));
}
/**
 * Evaluate multi-session aggregation over qualifying single-session
 * observations. Fail-closed when scientific policy fields remain unresolved.
 */
export function evaluateThresholdRegionSettledWorkloadAggregate(args) {
    var _a, _b, _c, _d, _e, _f;
    const policy = (_a = args.policy) !== null && _a !== void 0 ? _a : THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1;
    const unresolved = unresolvedAggregateFields(policy);
    const rejected = [];
    const accepted = [];
    const seenSessions = new Set();
    const valid = args.observations.filter((observation) => {
        var _a;
        if (!isValidObservationPayload(observation)) {
            rejected.push({
                sessionId: (_a = observation === null || observation === void 0 ? void 0 : observation.sessionId) !== null && _a !== void 0 ? _a : "unknown",
                failures: ["invalid_observation_payload"],
            });
            return false;
        }
        return true;
    });
    const expected = (_b = args.expectedCompatibility) !== null && _b !== void 0 ? _b : (valid[0] ? compatibilityKeyFrom(valid[0]) : null);
    for (const observation of chronological(valid)) {
        if (!expected)
            break;
        if (seenSessions.has(observation.sessionId)) {
            rejected.push({ sessionId: observation.sessionId, failures: ["duplicate_session_id"] });
            continue;
        }
        const key = compatibilityKeyFrom(observation);
        const incompat = compatibilityFailures(expected, key);
        if (incompat.length > 0) {
            rejected.push({ sessionId: observation.sessionId, failures: incompat });
            continue;
        }
        seenSessions.add(observation.sessionId);
        accepted.push(observation);
    }
    const ordered = chronological(accepted);
    const sessionMedians = ordered.map((o) => o.measuredWattsMedian);
    const dates = [...new Set(ordered.map((o) => o.workoutDate))].sort();
    const aggregateMedian = (_c = canonicalMedian(sessionMedians)) !== null && _c !== void 0 ? _c : null;
    const crossMad = sessionMedians.length > 0 ? (_d = medianAbsoluteDeviation(sessionMedians)) !== null && _d !== void 0 ? _d : null : null;
    const crossMadRatio = aggregateMedian != null && aggregateMedian > 0 && crossMad != null
        ? crossMad / aggregateMedian
        : null;
    const trendDirection = sessionMedians.length > 0 ? classifyCrossSessionTrend(sessionMedians) : null;
    const spanRatio = aggregateMedian != null && aggregateMedian > 0 && sessionMedians.length > 0
        ? (Math.max(...sessionMedians) - Math.min(...sessionMedians)) / aggregateMedian
        : null;
    const failures = [];
    if (!expected) {
        failures.push("insufficient_observations");
    }
    else {
        if (ordered.length < policy.minSessions)
            failures.push("insufficient_observations");
        if (dates.length < policy.minDistinctDates)
            failures.push("insufficient_distinct_dates");
        if (aggregateMedian == null || aggregateMedian <= 0) {
            failures.push("non_positive_aggregate_watts");
        }
        if (policy.maxCrossSessionMadRatio !== null) {
            if (crossMadRatio == null || crossMadRatio > policy.maxCrossSessionMadRatio) {
                failures.push("unstable_cross_session_workload");
            }
        }
        if (policy.maxObservationAgeDays !== null && ordered.length > 0) {
            const newest = dates[dates.length - 1];
            const asOf = (_e = args.asOfDate) !== null && _e !== void 0 ? _e : newest;
            for (const observation of ordered) {
                const age = ageDays(asOf, observation.workoutDate);
                if (age == null || age > policy.maxObservationAgeDays) {
                    failures.push("stale_observation");
                    break;
                }
            }
        }
    }
    if (unresolved.length > 0)
        failures.push("policy_threshold_unresolved");
    const diagnostics = {
        sessionMeasuredWattsMedians: sessionMedians,
        aggregateMeasuredWattsMedian: aggregateMedian,
        crossSessionWattsMad: crossMad,
        crossSessionWattsMadRatio: crossMadRatio,
        trendDirection,
        sessionWattsSpanRatio: spanRatio,
        distinctDateCount: dates.length,
    };
    const policyProductionReady = unresolved.length === 0;
    let aggregate = null;
    const emissionBlockers = failures.filter((code) => code !== "policy_threshold_unresolved");
    if (policyProductionReady &&
        expected &&
        emissionBlockers.length === 0 &&
        aggregateMedian != null &&
        crossMad != null &&
        crossMadRatio != null &&
        trendDirection != null &&
        spanRatio != null) {
        const newest = ordered[ordered.length - 1];
        aggregate = {
            schemaId: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1,
            schemaVersion: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_VERSION_V1,
            provenance: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1,
            compatibility: expected,
            sessionIds: ordered.map((o) => o.sessionId),
            workoutDates: dates,
            sessionCount: ordered.length,
            distinctDateCount: dates.length,
            aggregateMeasuredWattsMedian: aggregateMedian,
            crossSessionWattsMad: crossMad,
            crossSessionWattsMadRatio: crossMadRatio,
            sessionMeasuredWattsMedians: sessionMedians,
            trendDirection,
            sessionWattsSpanRatio: spanRatio,
            quality: "unverified",
            interpretation: "descriptive_aggregate_only",
            eligibleForPrescription: false,
            eligibleForShadowCandidate: policy.allowShadowCandidateEligibility,
            observedAt: (_f = newest.sessionEndedAt) !== null && _f !== void 0 ? _f : `${newest.workoutDate}T00:00:00.000Z`,
            admissionPolicyId: THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1,
            admissionPolicyVersion: THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1,
            aggregatePolicyId: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1,
            aggregatePolicyVersion: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1,
        };
    }
    return {
        policy,
        policyProductionReady,
        unresolvedPolicyFields: unresolved,
        compatibility: expected,
        acceptedObservations: ordered,
        rejected,
        failures: [...new Set(failures)],
        diagnostics,
        aggregate,
    };
}
/** Pure helper for sensitivity / design analysis of session-median series. */
export function summarizeSessionMedianSeries(sessionMedians) {
    var _a, _b;
    const median = (_a = canonicalMedian(sessionMedians)) !== null && _a !== void 0 ? _a : null;
    const mad = sessionMedians.length > 0 ? (_b = medianAbsoluteDeviation(sessionMedians)) !== null && _b !== void 0 ? _b : null : null;
    const madRatio = median != null && median > 0 && mad != null ? mad / median : null;
    const spanRatio = median != null && median > 0 && sessionMedians.length > 0
        ? (Math.max(...sessionMedians) - Math.min(...sessionMedians)) / median
        : null;
    return {
        median,
        mad,
        madRatio,
        trendDirection: classifyCrossSessionTrend(sessionMedians),
        spanRatio,
    };
}
