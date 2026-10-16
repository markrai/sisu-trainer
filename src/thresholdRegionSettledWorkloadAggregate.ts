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
import {
  THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1,
  type ThresholdRegionSettledWorkloadObservationV1,
} from "./thresholdRegionSettledWorkload.js";

/** Aggregate evidence schema identity (distinct from single-session observation). */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1 =
  "threshold-region-settled-workload-aggregate" as const;
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_VERSION_V1 = 1 as const;

/** Aggregation policy identity (distinct from single-session admission policy). */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1 =
  "threshold-region-settled-workload-aggregate-policy" as const;
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1 = 1 as const;

/** Provenance label for the multi-session claim. */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1 =
  "ordinary_workout_settled_threshold_region_aggregate" as const;

export type ThresholdRegionAggregateFailureCode =
  | "insufficient_observations"
  | "insufficient_distinct_dates"
  | "incompatible_athlete"
  | "incompatible_machine"
  | "incompatible_machine_profile"
  | "incompatible_formal_anchor"
  | "incompatible_target_hr_band"
  | "incompatible_admission_policy"
  | "incompatible_observation_schema"
  | "incompatible_provenance"
  | "duplicate_session_id"
  | "invalid_observation_payload"
  | "unstable_cross_session_workload"
  | "stale_observation"
  | "policy_threshold_unresolved"
  | "non_positive_aggregate_watts";

export type ThresholdRegionAggregateTrendDirection = "flat" | "rising" | "falling" | "mixed";

/**
 * Aggregation policy. `null` scientific fields keep emission fail-closed.
 *
 * Quantity floors (3/3) are product-policy judgments informed by repeated-
 * measure reliability literature and the need for a one-outlier-resistant
 * median+MAD — NOT a copy of Phase D's 4/4 rule.
 */
export interface ThresholdRegionSettledWorkloadAggregatePolicyV1 {
  id: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1;
  version: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1;
  /** Independence unit: session (not window, not telemetry-second). */
  independenceUnit: "session";
  /** Unweighted median of per-session measured-watt medians. */
  aggregateStatistic: "median_of_session_medians";
  /** Minimum distinct sessionIds after compatibility filtering. */
  minSessions: number;
  /** Minimum distinct calendar dates (UTC YYYY-MM-DD from observedAt / session). */
  minDistinctDates: number;
  /**
   * UNRESOLVED: max MAD(sessionMedians) / median(sessionMedians).
   * Distinct from single-session within-hold MAD ratio (0.10).
   */
  maxCrossSessionMadRatio: number | null;
  /**
   * Trend handling. v1 records direction diagnostically and does not reject
   * solely on monotonicity (insufficient real multi-session evidence to set
   * a rejection threshold).
   */
  trendHandling: "diagnostic_only";
  /**
   * UNRESOLVED: optional max age in days from newest observation.
   * Lineage changes (anchor / machine profile / HR band) invalidate regardless.
   */
  maxObservationAgeDays: number | null;
  /**
   * When true and policy is production-ready, emitted aggregates may set
   * `eligibleForShadowCandidate=true`. Prescription remains false.
   */
  allowShadowCandidateEligibility: boolean;
}

export const THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1: ThresholdRegionSettledWorkloadAggregatePolicyV1 =
  {
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

/** Explicit compatibility lineage — all fields must match for aggregation. */
export interface ThresholdRegionAggregateCompatibilityKeyV1 {
  athleteId: string;
  machineId: string;
  machineProfileVersion: number;
  formalAnchorObservedAt: string;
  targetHrMin: number;
  targetHrMax: number;
  admissionPolicyId: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1;
  admissionPolicyVersion: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1;
  observationSchemaId: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1;
  observationSchemaVersion: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1;
  observationProvenance: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1;
}

export interface ThresholdRegionSettledWorkloadAggregateV1 {
  schemaId: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1;
  schemaVersion: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_VERSION_V1;
  provenance: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1;
  compatibility: ThresholdRegionAggregateCompatibilityKeyV1;
  sessionIds: string[];
  workoutDates: string[];
  sessionCount: number;
  distinctDateCount: number;
  /** Unweighted median of session measured-watt medians. */
  aggregateMeasuredWattsMedian: number;
  /** MAD across session medians (not within-session MAD). */
  crossSessionWattsMad: number;
  crossSessionWattsMadRatio: number;
  sessionMeasuredWattsMedians: number[];
  trendDirection: ThresholdRegionAggregateTrendDirection;
  /** Peak-to-peak span / aggregate median (diagnostic). */
  sessionWattsSpanRatio: number;
  quality: "unverified";
  interpretation: "descriptive_aggregate_only";
  eligibleForPrescription: false;
  /**
   * Structurally eligible to feed a future shadow candidate once the
   * aggregation policy is production-ready. Not UI advice.
   */
  eligibleForShadowCandidate: boolean;
  observedAt: string;
  admissionPolicyId: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1;
  admissionPolicyVersion: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1;
  aggregatePolicyId: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_ID_V1;
  aggregatePolicyVersion: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_VERSION_V1;
}

export interface ThresholdRegionAggregateEvaluationV1 {
  policy: ThresholdRegionSettledWorkloadAggregatePolicyV1;
  policyProductionReady: boolean;
  unresolvedPolicyFields: Array<keyof ThresholdRegionSettledWorkloadAggregatePolicyV1>;
  compatibility: ThresholdRegionAggregateCompatibilityKeyV1 | null;
  acceptedObservations: ThresholdRegionSettledWorkloadObservationV1[];
  rejected: Array<{
    sessionId: string;
    failures: ThresholdRegionAggregateFailureCode[];
  }>;
  failures: ThresholdRegionAggregateFailureCode[];
  /** Diagnostics even when aggregate is not emitted. */
  diagnostics: {
    sessionMeasuredWattsMedians: number[];
    aggregateMeasuredWattsMedian: number | null;
    crossSessionWattsMad: number | null;
    crossSessionWattsMadRatio: number | null;
    trendDirection: ThresholdRegionAggregateTrendDirection | null;
    sessionWattsSpanRatio: number | null;
    distinctDateCount: number;
  };
  aggregate: ThresholdRegionSettledWorkloadAggregateV1 | null;
}

function unresolvedAggregateFields(
  policy: ThresholdRegionSettledWorkloadAggregatePolicyV1
): Array<keyof ThresholdRegionSettledWorkloadAggregatePolicyV1> {
  const fields: Array<keyof ThresholdRegionSettledWorkloadAggregatePolicyV1> = [];
  if (policy.maxCrossSessionMadRatio === null) fields.push("maxCrossSessionMadRatio");
  if (policy.maxObservationAgeDays === null) fields.push("maxObservationAgeDays");
  return fields;
}

export function thresholdRegionAggregatePolicyIsProductionReady(
  policy: ThresholdRegionSettledWorkloadAggregatePolicyV1 = THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1
): boolean {
  return unresolvedAggregateFields(policy).length === 0;
}

/**
 * Extended observation input for aggregation: single-session observation plus
 * the session calendar date (UTC) used for distinct-date counting.
 */
export type ThresholdRegionAggregateObservationInputV1 =
  ThresholdRegionSettledWorkloadObservationV1 & {
    workoutDate: string;
    sessionEndedAt?: string;
  };

function isValidObservationPayload(
  observation: ThresholdRegionAggregateObservationInputV1
): boolean {
  return (
    observation.schemaId === THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1 &&
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
    /^\d{4}-\d{2}-\d{2}$/.test(observation.workoutDate)
  );
}

function compatibilityKeyFrom(
  observation: ThresholdRegionAggregateObservationInputV1
): ThresholdRegionAggregateCompatibilityKeyV1 {
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

function keysEqual(
  a: ThresholdRegionAggregateCompatibilityKeyV1,
  b: ThresholdRegionAggregateCompatibilityKeyV1
): boolean {
  return (
    a.athleteId === b.athleteId &&
    a.machineId === b.machineId &&
    a.machineProfileVersion === b.machineProfileVersion &&
    a.formalAnchorObservedAt === b.formalAnchorObservedAt &&
    a.targetHrMin === b.targetHrMin &&
    a.targetHrMax === b.targetHrMax &&
    a.admissionPolicyId === b.admissionPolicyId &&
    a.admissionPolicyVersion === b.admissionPolicyVersion &&
    a.observationSchemaId === b.observationSchemaId &&
    a.observationSchemaVersion === b.observationSchemaVersion &&
    a.observationProvenance === b.observationProvenance
  );
}

function compatibilityFailures(
  expected: ThresholdRegionAggregateCompatibilityKeyV1,
  actual: ThresholdRegionAggregateCompatibilityKeyV1
): ThresholdRegionAggregateFailureCode[] {
  const failures: ThresholdRegionAggregateFailureCode[] = [];
  if (actual.athleteId !== expected.athleteId) failures.push("incompatible_athlete");
  if (actual.machineId !== expected.machineId) failures.push("incompatible_machine");
  if (actual.machineProfileVersion !== expected.machineProfileVersion) {
    failures.push("incompatible_machine_profile");
  }
  if (actual.formalAnchorObservedAt !== expected.formalAnchorObservedAt) {
    failures.push("incompatible_formal_anchor");
  }
  if (actual.targetHrMin !== expected.targetHrMin || actual.targetHrMax !== expected.targetHrMax) {
    failures.push("incompatible_target_hr_band");
  }
  if (
    actual.admissionPolicyId !== expected.admissionPolicyId ||
    actual.admissionPolicyVersion !== expected.admissionPolicyVersion
  ) {
    failures.push("incompatible_admission_policy");
  }
  if (
    actual.observationSchemaId !== expected.observationSchemaId ||
    actual.observationSchemaVersion !== expected.observationSchemaVersion
  ) {
    failures.push("incompatible_observation_schema");
  }
  if (actual.observationProvenance !== expected.observationProvenance) {
    failures.push("incompatible_provenance");
  }
  return failures;
}

/** Chronological by workoutDate then sessionId. */
function chronological(
  observations: readonly ThresholdRegionAggregateObservationInputV1[]
): ThresholdRegionAggregateObservationInputV1[] {
  return [...observations].sort(
    (a, b) =>
      a.workoutDate.localeCompare(b.workoutDate) || a.sessionId.localeCompare(b.sessionId)
  );
}

export function classifyCrossSessionTrend(
  sessionMediansChronological: readonly number[]
): ThresholdRegionAggregateTrendDirection {
  if (sessionMediansChronological.length < 2) return "flat";
  let rises = 0;
  let falls = 0;
  for (let i = 1; i < sessionMediansChronological.length; i += 1) {
    const delta = sessionMediansChronological[i]! - sessionMediansChronological[i - 1]!;
    if (delta > 0) rises += 1;
    else if (delta < 0) falls += 1;
  }
  if (rises > 0 && falls === 0) return "rising";
  if (falls > 0 && rises === 0) return "falling";
  if (rises === 0 && falls === 0) return "flat";
  return "mixed";
}

function ageDays(newerIsoDate: string, olderIsoDate: string): number | null {
  const a = Date.parse(`${newerIsoDate}T00:00:00.000Z`);
  const b = Date.parse(`${olderIsoDate}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / (24 * 3600 * 1000));
}

/**
 * Evaluate multi-session aggregation over qualifying single-session
 * observations. Fail-closed when scientific policy fields remain unresolved.
 */
export function evaluateThresholdRegionSettledWorkloadAggregate(args: {
  observations: readonly ThresholdRegionAggregateObservationInputV1[];
  /**
   * Expected compatibility lineage. Defaults to the first valid observation's
   * key when omitted (typical single-athlete design path).
   */
  expectedCompatibility?: ThresholdRegionAggregateCompatibilityKeyV1;
  policy?: ThresholdRegionSettledWorkloadAggregatePolicyV1;
  /** Reference "today" for age checks (UTC YYYY-MM-DD). Defaults to newest observation date. */
  asOfDate?: string;
}): ThresholdRegionAggregateEvaluationV1 {
  const policy = args.policy ?? THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1;
  const unresolved = unresolvedAggregateFields(policy);
  const rejected: ThresholdRegionAggregateEvaluationV1["rejected"] = [];
  const accepted: ThresholdRegionAggregateObservationInputV1[] = [];
  const seenSessions = new Set<string>();

  const valid = args.observations.filter((observation) => {
    if (!isValidObservationPayload(observation)) {
      rejected.push({
        sessionId: observation?.sessionId ?? "unknown",
        failures: ["invalid_observation_payload"],
      });
      return false;
    }
    return true;
  });

  const expected =
    args.expectedCompatibility ??
    (valid[0] ? compatibilityKeyFrom(valid[0]) : null);

  for (const observation of chronological(valid)) {
    if (!expected) break;
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
  const aggregateMedian = canonicalMedian(sessionMedians) ?? null;
  const crossMad =
    sessionMedians.length > 0 ? medianAbsoluteDeviation(sessionMedians) ?? null : null;
  const crossMadRatio =
    aggregateMedian != null && aggregateMedian > 0 && crossMad != null
      ? crossMad / aggregateMedian
      : null;
  const trendDirection =
    sessionMedians.length > 0 ? classifyCrossSessionTrend(sessionMedians) : null;
  const spanRatio =
    aggregateMedian != null && aggregateMedian > 0 && sessionMedians.length > 0
      ? (Math.max(...sessionMedians) - Math.min(...sessionMedians)) / aggregateMedian
      : null;

  const failures: ThresholdRegionAggregateFailureCode[] = [];
  if (!expected) {
    failures.push("insufficient_observations");
  } else {
    if (ordered.length < policy.minSessions) failures.push("insufficient_observations");
    if (dates.length < policy.minDistinctDates) failures.push("insufficient_distinct_dates");
    if (aggregateMedian == null || aggregateMedian <= 0) {
      failures.push("non_positive_aggregate_watts");
    }
    if (policy.maxCrossSessionMadRatio !== null) {
      if (crossMadRatio == null || crossMadRatio > policy.maxCrossSessionMadRatio) {
        failures.push("unstable_cross_session_workload");
      }
    }
    if (policy.maxObservationAgeDays !== null && ordered.length > 0) {
      const newest = dates[dates.length - 1]!;
      const asOf = args.asOfDate ?? newest;
      for (const observation of ordered) {
        const age = ageDays(asOf, observation.workoutDate);
        if (age == null || age > policy.maxObservationAgeDays) {
          failures.push("stale_observation");
          break;
        }
      }
    }
  }
  if (unresolved.length > 0) failures.push("policy_threshold_unresolved");

  const diagnostics: ThresholdRegionAggregateEvaluationV1["diagnostics"] = {
    sessionMeasuredWattsMedians: sessionMedians,
    aggregateMeasuredWattsMedian: aggregateMedian,
    crossSessionWattsMad: crossMad,
    crossSessionWattsMadRatio: crossMadRatio,
    trendDirection,
    sessionWattsSpanRatio: spanRatio,
    distinctDateCount: dates.length,
  };

  const policyProductionReady = unresolved.length === 0;
  let aggregate: ThresholdRegionSettledWorkloadAggregateV1 | null = null;
  const emissionBlockers = failures.filter((code) => code !== "policy_threshold_unresolved");
  if (
    policyProductionReady &&
    expected &&
    emissionBlockers.length === 0 &&
    aggregateMedian != null &&
    crossMad != null &&
    crossMadRatio != null &&
    trendDirection != null &&
    spanRatio != null
  ) {
    const newest = ordered[ordered.length - 1]!;
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
      observedAt: newest.sessionEndedAt ?? `${newest.workoutDate}T00:00:00.000Z`,
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
export function summarizeSessionMedianSeries(sessionMedians: readonly number[]): {
  median: number | null;
  mad: number | null;
  madRatio: number | null;
  trendDirection: ThresholdRegionAggregateTrendDirection;
  spanRatio: number | null;
} {
  const median = canonicalMedian(sessionMedians) ?? null;
  const mad = sessionMedians.length > 0 ? medianAbsoluteDeviation(sessionMedians) ?? null : null;
  const madRatio = median != null && median > 0 && mad != null ? mad / median : null;
  const spanRatio =
    median != null && median > 0 && sessionMedians.length > 0
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
