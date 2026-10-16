/**
 * Threshold adapter over the generic steady-state settled-workload aggregate.
 *
 * Preserves Threshold aggregate schema / provenance identities.
 * Session independence, median-of-medians, lineage, duplicates, and trend
 * diagnostics live in `steadyStateSettledWorkloadAggregate.ts`.
 *
 * Non-production-ready while maxCrossSessionMadRatio / maxObservationAgeDays
 * remain null. Design / shadow-only.
 */
import { THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1, THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1, THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1, } from "./thresholdRegionSettledWorkload.js";
import { classifyCrossSessionTrend, compatibilityKeyFromObservation as steadyStateCompatibilityKeyFromObservation, evaluateSteadyStateSettledWorkloadAggregate, steadyStateAggregatePolicyIsProductionReady, summarizeSessionMedianSeries, workoutDateFromSessionEndedAt, STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1, } from "./steadyStateSettledWorkloadAggregate.js";
export { classifyCrossSessionTrend, summarizeSessionMedianSeries, workoutDateFromSessionEndedAt, };
/** Aggregate evidence schema identity (Threshold-named; unshipped design contract). */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1 = "threshold-region-settled-workload-aggregate";
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_VERSION_V1 = 1;
/** Aggregation policy identity (distinct from single-session admission policy). */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1 = "threshold-region-settled-workload-aggregate-policy";
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1 = 1;
/** Provenance label for the multi-session Threshold claim. */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1 = "ordinary_workout_settled_threshold_region_aggregate";
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1 = {
    ...STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1,
    id: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1,
    version: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1,
    contractIdentity: {
        schemaId: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1,
        schemaVersion: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_VERSION_V1,
        provenance: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1,
    },
};
export function thresholdRegionAggregatePolicyIsProductionReady(policy = THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1) {
    return steadyStateAggregatePolicyIsProductionReady(policy);
}
export function compatibilityKeyFromObservation(observation) {
    return steadyStateCompatibilityKeyFromObservation(observation);
}
export { canonicalObservationDuplicateFingerprint } from "./steadyStateSettledWorkloadAggregate.js";
/**
 * Evaluate multi-session Threshold aggregation. Delegates to the generic
 * steady-state aggregate with Threshold contract identity.
 */
export function evaluateThresholdRegionSettledWorkloadAggregate(args) {
    var _a;
    const policy = (_a = args.policy) !== null && _a !== void 0 ? _a : THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1;
    const result = evaluateSteadyStateSettledWorkloadAggregate({
        observations: args.observations,
        expectedCompatibility: args.expectedCompatibility,
        policy,
        asOfDate: args.asOfDate,
    });
    return {
        ...result,
        policy,
        acceptedObservations: result.acceptedObservations,
        aggregate: result.aggregate,
    };
}
/** Re-export Threshold single-session identity constants used by aggregate tests. */
export { THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1, THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1, THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1, };
