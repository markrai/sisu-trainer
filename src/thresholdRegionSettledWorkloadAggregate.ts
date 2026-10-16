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

import {
  THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1,
  type ThresholdRegionSettledWorkloadObservationV1,
} from "./thresholdRegionSettledWorkload.js";
import {
  classifyCrossSessionTrend,
  compatibilityKeyFromObservation as steadyStateCompatibilityKeyFromObservation,
  evaluateSteadyStateSettledWorkloadAggregate,
  steadyStateAggregatePolicyIsProductionReady,
  summarizeSessionMedianSeries,
  workoutDateFromSessionEndedAt,
  type SteadyStateAggregateCompatibilityKeyV1,
  type SteadyStateAggregateEvaluationV1,
  type SteadyStateAggregateFailureCode,
  type SteadyStateAggregateTrendDirection,
  type SteadyStateSettledWorkloadAggregatePolicyV1,
  type SteadyStateSettledWorkloadAggregateV1,
  STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1,
} from "./steadyStateSettledWorkloadAggregate.js";

export {
  classifyCrossSessionTrend,
  summarizeSessionMedianSeries,
  workoutDateFromSessionEndedAt,
};

/** Aggregate evidence schema identity (Threshold-named; unshipped design contract). */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1 =
  "threshold-region-settled-workload-aggregate" as const;
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_VERSION_V1 = 1 as const;

/** Aggregation policy identity (distinct from single-session admission policy). */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1 =
  "threshold-region-settled-workload-aggregate-policy" as const;
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1 = 1 as const;

/** Provenance label for the multi-session Threshold claim. */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1 =
  "ordinary_workout_settled_threshold_region_aggregate" as const;

export type ThresholdRegionAggregateFailureCode = SteadyStateAggregateFailureCode;
export type ThresholdRegionAggregateTrendDirection = SteadyStateAggregateTrendDirection;

export type ThresholdRegionSettledWorkloadAggregatePolicyV1 =
  SteadyStateSettledWorkloadAggregatePolicyV1 & {
    id: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1;
    version: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1;
  };

export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1: ThresholdRegionSettledWorkloadAggregatePolicyV1 =
  {
    ...STEADY_STATE_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1,
    id: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1,
    version: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1,
    contractIdentity: {
      schemaId: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1,
      schemaVersion: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_VERSION_V1,
      provenance: THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1,
    },
  };

/** Explicit compatibility lineage — all fields must match for aggregation. */
export type ThresholdRegionAggregateCompatibilityKeyV1 = SteadyStateAggregateCompatibilityKeyV1;

export type ThresholdRegionSettledWorkloadAggregateV1 = SteadyStateSettledWorkloadAggregateV1 & {
  schemaId: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1;
  schemaVersion: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_VERSION_V1;
  provenance: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1;
  aggregatePolicyId: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1;
  aggregatePolicyVersion: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1;
};

export type ThresholdRegionAggregateEvaluationV1 = Omit<
  SteadyStateAggregateEvaluationV1,
  "policy" | "aggregate" | "acceptedObservations"
> & {
  policy: ThresholdRegionSettledWorkloadAggregatePolicyV1 | SteadyStateSettledWorkloadAggregatePolicyV1;
  acceptedObservations: ThresholdRegionSettledWorkloadObservationV1[];
  aggregate: ThresholdRegionSettledWorkloadAggregateV1 | null;
};

export type ThresholdRegionAggregateObservationInputV1 = ThresholdRegionSettledWorkloadObservationV1;

export function thresholdRegionAggregatePolicyIsProductionReady(
  policy: ThresholdRegionSettledWorkloadAggregatePolicyV1 | SteadyStateSettledWorkloadAggregatePolicyV1 =
    THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1
): boolean {
  return steadyStateAggregatePolicyIsProductionReady(policy);
}

export function compatibilityKeyFromObservation(
  observation: ThresholdRegionSettledWorkloadObservationV1
): ThresholdRegionAggregateCompatibilityKeyV1 {
  return steadyStateCompatibilityKeyFromObservation(observation);
}

export { canonicalObservationDuplicateFingerprint } from "./steadyStateSettledWorkloadAggregate.js";

/**
 * Evaluate multi-session Threshold aggregation. Delegates to the generic
 * steady-state aggregate with Threshold contract identity.
 */
export function evaluateThresholdRegionSettledWorkloadAggregate(args: {
  observations: readonly ThresholdRegionAggregateObservationInputV1[];
  expectedCompatibility?: ThresholdRegionAggregateCompatibilityKeyV1;
  policy?: ThresholdRegionSettledWorkloadAggregatePolicyV1 | SteadyStateSettledWorkloadAggregatePolicyV1;
  asOfDate?: string;
}): ThresholdRegionAggregateEvaluationV1 {
  const policy = args.policy ?? THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1;
  const result = evaluateSteadyStateSettledWorkloadAggregate({
    observations: args.observations,
    expectedCompatibility: args.expectedCompatibility,
    policy,
    asOfDate: args.asOfDate,
  });

  return {
    ...result,
    policy,
    acceptedObservations: result.acceptedObservations as ThresholdRegionSettledWorkloadObservationV1[],
    aggregate: result.aggregate as ThresholdRegionSettledWorkloadAggregateV1 | null,
  };
}

/** Re-export Threshold single-session identity constants used by aggregate tests. */
export {
  THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1,
};
