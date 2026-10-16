import test from "node:test";
import assert from "node:assert/strict";

import {
  THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1,
  evaluateThresholdRegionSettledWorkloadAggregate,
  thresholdRegionAggregatePolicyIsProductionReady,
  summarizeSessionMedianSeries,
  classifyCrossSessionTrend,
} from "../dist/thresholdRegionSettledWorkloadAggregate.js";
import {
  THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1,
  THRESHOLD_REGION_ORDINARY_WORKOUT_SHADOW_RESOLVER_ID_V1,
} from "../dist/thresholdRegionSettledWorkload.js";
import { PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1 } from "../dist/types.js";

const ATHLETE = "afa677b3-9682-4fb9-8f7d-af77375975d7";
const ANCHOR = "2026-10-11T18:18:38.106Z";
const MACHINE = "proform-smart-power-10";

function observation({
  sessionId = "session-a",
  workoutDate = "2026-10-16",
  athleteId = ATHLETE,
  machineId = MACHINE,
  machineProfileVersion = 1,
  formalAnchorObservedAt = ANCHOR,
  targetHrMin = 155,
  targetHrMax = 162,
  measuredWattsMedian = 114,
  measuredWattsMad = 6,
  hrMedian = 158,
  hrInBandFraction = 0.96,
  heldResistance = 10,
  postSettlingDurationSec = 246,
  sessionEndedAt,
} = {}) {
  return {
    schemaId: THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1,
    schemaVersion: THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1,
    provenance: THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1,
    athleteId,
    sessionId,
    machineId,
    machineProfileVersion,
    workoutIntent: "threshold",
    intensityId: "threshold",
    targetHrMin,
    targetHrMax,
    windowStartSec: 1051,
    windowEndSecExclusive: 1051 + postSettlingDurationSec + 120,
    settledFromSec: 1051 + 120,
    qualifyingDurationSec: Math.min(postSettlingDurationSec, 200),
    postSettlingDurationSec,
    heldResistance,
    hrMedian,
    hrInBandFraction,
    hrCoverageRatio: 1,
    measuredWattsMedian,
    measuredWattsMad,
    measuredWattsSampleCount: 180,
    measuredWattsCoverageRatio: 0.83,
    cadenceMedian: 67,
    cadenceCoverageRatio: 0.83,
    controllerSettledProvenance: "controller_held_resistance_plus_target_hold_audit",
    formalAnchorObservedAt,
    quality: "unverified",
    eligibleForPrescription: false,
    interpretation: "descriptive_observation_only",
    workoutDate,
    sessionEndedAt: sessionEndedAt ?? `${workoutDate}T15:00:00.000Z`,
  };
}

function completePolicy(overrides = {}) {
  return {
    ...THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1,
    maxCrossSessionMadRatio: 0.08,
    maxObservationAgeDays: 90,
    ...overrides,
  };
}

function threeStable(overrides = {}) {
  return [
    observation({ sessionId: "s1", workoutDate: "2026-10-12", measuredWattsMedian: 112, ...overrides }),
    observation({ sessionId: "s2", workoutDate: "2026-10-14", measuredWattsMedian: 114, ...overrides }),
    observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 116, ...overrides }),
  ];
}

test("aggregate identities are distinct from single-session, Phase D, and E1 resolver", () => {
  assert.equal(
    THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1,
    "threshold-region-settled-workload-aggregate"
  );
  assert.notEqual(
    THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1,
    THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1
  );
  assert.notEqual(
    THRESHOLD_REGION_ORDINARY_WORKOUT_SHADOW_RESOLVER_ID_V1,
    PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1
  );
  assert.equal(
    THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_PROVENANCE_V1,
    "ordinary_workout_settled_threshold_region_aggregate"
  );
  assert.equal(THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1.minSessions, 3);
  assert.equal(THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1.minDistinctDates, 3);
  assert.equal(THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1.maxCrossSessionMadRatio, null);
  assert.equal(THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_POLICY_V1.maxObservationAgeDays, null);
  assert.equal(thresholdRegionAggregatePolicyIsProductionReady(), false);
});

test("default policy remains non-emitting until unresolved scientific fields are set", () => {
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: threeStable(),
  });
  assert.equal(result.policyProductionReady, false);
  assert.ok(result.unresolvedPolicyFields.includes("maxCrossSessionMadRatio"));
  assert.ok(result.unresolvedPolicyFields.includes("maxObservationAgeDays"));
  assert.ok(result.failures.includes("policy_threshold_unresolved"));
  assert.equal(result.aggregate, null);
  assert.equal(result.diagnostics.aggregateMeasuredWattsMedian, 114);
});

test("wrong athlete rejects", () => {
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      ...threeStable().slice(0, 2),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", athleteId: "other-athlete" }),
    ],
    policy: completePolicy(),
  });
  assert.ok(result.rejected.some((r) => r.failures.includes("incompatible_athlete")));
  assert.ok(result.failures.includes("insufficient_observations"));
  assert.equal(result.aggregate, null);
});

test("wrong machine / profile rejects", () => {
  const machine = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      ...threeStable().slice(0, 2),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", machineId: "other-bike" }),
    ],
    policy: completePolicy(),
  });
  assert.ok(machine.rejected.some((r) => r.failures.includes("incompatible_machine")));

  const profile = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      ...threeStable().slice(0, 2),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", machineProfileVersion: 2 }),
    ],
    policy: completePolicy(),
  });
  assert.ok(profile.rejected.some((r) => r.failures.includes("incompatible_machine_profile")));
});

test("different target HR band rejects", () => {
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      ...threeStable().slice(0, 2),
      observation({
        sessionId: "s3",
        workoutDate: "2026-10-16",
        targetHrMin: 150,
        targetHrMax: 157,
      }),
    ],
    policy: completePolicy(),
  });
  assert.ok(result.rejected.some((r) => r.failures.includes("incompatible_target_hr_band")));
});

test("new formal anchor starts a new lineage", () => {
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      ...threeStable().slice(0, 2),
      observation({
        sessionId: "s3",
        workoutDate: "2026-10-16",
        formalAnchorObservedAt: "2026-10-15T12:00:00.000Z",
      }),
    ],
    policy: completePolicy(),
  });
  assert.ok(result.rejected.some((r) => r.failures.includes("incompatible_formal_anchor")));
  assert.equal(result.acceptedObservations.length, 2);
});

test("same session cannot count twice; multiple windows cannot inflate session count", () => {
  const dup = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      observation({ sessionId: "s1", workoutDate: "2026-10-12", measuredWattsMedian: 112 }),
      observation({ sessionId: "s1", workoutDate: "2026-10-12", measuredWattsMedian: 130 }),
      observation({ sessionId: "s2", workoutDate: "2026-10-14", measuredWattsMedian: 114 }),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 116 }),
    ],
    policy: completePolicy(),
  });
  assert.ok(dup.rejected.some((r) => r.failures.includes("duplicate_session_id")));
  assert.equal(dup.acceptedObservations.length, 3);
  assert.deepEqual(
    dup.acceptedObservations.map((o) => o.measuredWattsMedian),
    [112, 114, 116]
  );
});

test("minimum-session and minimum-date boundaries", () => {
  const twoSessions = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: threeStable().slice(0, 2),
    policy: completePolicy(),
  });
  assert.ok(twoSessions.failures.includes("insufficient_observations"));
  assert.equal(twoSessions.aggregate, null);

  const threeSameDate = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      observation({ sessionId: "s1", workoutDate: "2026-10-16", measuredWattsMedian: 112 }),
      observation({ sessionId: "s2", workoutDate: "2026-10-16", measuredWattsMedian: 114 }),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 116 }),
    ],
    policy: completePolicy(),
  });
  assert.ok(threeSameDate.failures.includes("insufficient_distinct_dates"));
  assert.equal(threeSameDate.aggregate, null);

  const exactlyThree = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: threeStable(),
    policy: completePolicy(),
  });
  assert.ok(exactlyThree.aggregate);
  assert.equal(exactlyThree.aggregate.sessionCount, 3);
  assert.equal(exactlyThree.aggregate.distinctDateCount, 3);
});

test("stable repeated watts pass under complete policy and are shadow-candidate eligible", () => {
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: threeStable(),
    policy: completePolicy(),
  });
  assert.equal(result.policyProductionReady, true);
  assert.ok(result.aggregate);
  assert.equal(result.aggregate.aggregateMeasuredWattsMedian, 114);
  assert.equal(result.aggregate.interpretation, "descriptive_aggregate_only");
  assert.equal(result.aggregate.eligibleForPrescription, false);
  assert.equal(result.aggregate.eligibleForShadowCandidate, true);
  assert.equal(result.aggregate.quality, "unverified");
  assert.equal(result.aggregate.schemaId, THRESHOLD_REGION_SETTLED_WORKLOAD_AGGREGATE_SCHEMA_ID_V1);
  assert.ok(result.aggregate.crossSessionWattsMadRatio <= 0.08);
});

test("single outlier handling via median; unstable cross-session watts fail", () => {
  // One extreme outlier: median stays 114; MAD with n=3 resists a single spike
  // (abs deviations 2,0,36 → MAD=2), which is intentional robustness — the
  // aggregate central value is not pulled to 150.
  const withOutlier = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      observation({ sessionId: "s1", workoutDate: "2026-10-12", measuredWattsMedian: 112 }),
      observation({ sessionId: "s2", workoutDate: "2026-10-14", measuredWattsMedian: 114 }),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 150 }),
    ],
    policy: completePolicy({ maxCrossSessionMadRatio: 0.05 }),
  });
  assert.equal(withOutlier.diagnostics.aggregateMeasuredWattsMedian, 114);
  assert.ok((withOutlier.diagnostics.crossSessionWattsMadRatio ?? 1) < 0.05);
  assert.ok(withOutlier.aggregate);

  // Dispersed triangular pattern: MAD/median exceeds a tight gate.
  const unstable = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      observation({ sessionId: "s1", workoutDate: "2026-10-12", measuredWattsMedian: 105 }),
      observation({ sessionId: "s2", workoutDate: "2026-10-14", measuredWattsMedian: 114 }),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 123 }),
    ],
    policy: completePolicy({ maxCrossSessionMadRatio: 0.05 }),
  });
  assert.equal(unstable.diagnostics.aggregateMeasuredWattsMedian, 114);
  assert.ok((unstable.diagnostics.crossSessionWattsMadRatio ?? 0) > 0.05);
  assert.ok(unstable.failures.includes("unstable_cross_session_workload"));
  assert.equal(unstable.aggregate, null);

  const mild = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: threeStable(),
    policy: completePolicy({ maxCrossSessionMadRatio: 0.05 }),
  });
  // 112,114,116 → MAD=2, median=114, ratio≈0.0175 → pass
  assert.ok(mild.aggregate);
});

test("trend is diagnostic only under v1 policy", () => {
  assert.equal(classifyCrossSessionTrend([100, 105, 110, 115]), "rising");
  assert.equal(classifyCrossSessionTrend([115, 110, 105, 100]), "falling");
  assert.equal(classifyCrossSessionTrend([110, 114, 112]), "mixed");
  assert.equal(classifyCrossSessionTrend([114, 114, 114]), "flat");

  const rising = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      observation({ sessionId: "s1", workoutDate: "2026-10-12", measuredWattsMedian: 100 }),
      observation({ sessionId: "s2", workoutDate: "2026-10-14", measuredWattsMedian: 105 }),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 110 }),
      observation({ sessionId: "s4", workoutDate: "2026-10-18", measuredWattsMedian: 115 }),
    ],
    policy: completePolicy({ maxCrossSessionMadRatio: 0.2 }),
  });
  assert.equal(rising.diagnostics.trendDirection, "rising");
  assert.ok(rising.aggregate);
  assert.equal(rising.aggregate.trendDirection, "rising");
  assert.ok(!rising.failures.includes("unstable_cross_session_workload"));
});

test("same watts across incompatible machines still reject on provenance", () => {
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      observation({ sessionId: "s1", workoutDate: "2026-10-12", measuredWattsMedian: 114 }),
      observation({
        sessionId: "s2",
        workoutDate: "2026-10-14",
        measuredWattsMedian: 114,
        machineId: "other-machine",
      }),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 114 }),
    ],
    policy: completePolicy(),
  });
  assert.ok(result.rejected.some((r) => r.failures.includes("incompatible_machine")));
  assert.equal(result.aggregate, null);
});

test("sensitivity helper matches design matrix medians", () => {
  const cases = [
    { watts: [114], expectMedian: 114 },
    { watts: [114, 115], expectMedian: 114.5 },
    { watts: [112, 114, 116], expectMedian: 114 },
    { watts: [105, 114, 123], expectMedian: 114 },
    { watts: [112, 114, 150], expectMedian: 114 },
    { watts: [110, 114, 118, 120], expectMedian: 116 },
    { watts: [100, 105, 110, 115], expectMedian: 107.5 },
  ];
  for (const c of cases) {
    const summary = summarizeSessionMedianSeries(c.watts);
    assert.equal(summary.median, c.expectMedian, `watts=${c.watts}`);
  }
  const trending = summarizeSessionMedianSeries([100, 105, 110, 115]);
  assert.equal(trending.trendDirection, "rising");
  assert.ok((trending.spanRatio ?? 0) > 0.1);
});

test("stale observation fails when age gate is set", () => {
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: [
      observation({ sessionId: "s1", workoutDate: "2026-01-01", measuredWattsMedian: 112 }),
      observation({ sessionId: "s2", workoutDate: "2026-01-08", measuredWattsMedian: 114 }),
      observation({ sessionId: "s3", workoutDate: "2026-10-16", measuredWattsMedian: 116 }),
    ],
    policy: completePolicy({ maxObservationAgeDays: 60 }),
    asOfDate: "2026-10-16",
  });
  assert.ok(result.failures.includes("stale_observation"));
  assert.equal(result.aggregate, null);
});

test("admission policy lineage identity is recorded on emitted aggregate", () => {
  const result = evaluateThresholdRegionSettledWorkloadAggregate({
    observations: threeStable(),
    policy: completePolicy(),
  });
  assert.equal(result.aggregate.admissionPolicyId, THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1);
  assert.equal(result.compatibility.observationProvenance, THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1);
});
