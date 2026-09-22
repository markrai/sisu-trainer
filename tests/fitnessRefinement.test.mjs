import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";

import {
  FITNESS_REFINEMENT_ALGORITHM_V1,
  qualifyWorkoutResponseForPassiveFitness,
  rebuildPassiveFitnessProjection,
  rebuildStoredPassiveFitnessProjection,
} from "../dist/fitnessRefinement.js";
import { parseFitnessState, readFitnessState } from "../dist/fitnessState.js";
import { ATHLETE_PROFILE_STORAGE_KEY, migrateLegacyProfile } from "../dist/profile.js";
import {
  deleteWorkoutSummary,
  getAllWorkoutSummaries,
  resetWorkoutStorageForTests,
  storeWorkoutSummary,
} from "../dist/workoutStorage.js";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function scalar(value, coverageRatio = 1, duration = 600, spread = 4) {
  return {
    sampleCount: Math.round(duration * coverageRatio), coverageRatio,
    mean: value, median: value, min: value - spread, max: value + spread, end: value,
  };
}

function ordinarySummary({
  sessionId = "session-1", athleteId = "athlete-a",
  endedAt = "2026-01-01T12:10:00.000Z", watts = 200, hr = 150,
  provenance = "measured_watts", intensityId = "threshold", activity = "bike",
  cancelled = false, completionFraction = 1, sessionHrCoverage = 1,
  freshBikeCoverage = 1, phaseHrCoverage = 1, phaseWattsCoverage = 1,
  phaseCadenceCoverage = 1, phaseDurationSec = 600,
  completedPhaseSec = phaseDurationSec, wattsSpread = 4, cadenceSpread = 4,
  includeWatts = true, includeCadence = true, includeControllerResistance = false,
} = {}) {
  const plannedActiveSec = phaseDurationSec;
  const completedActiveSec = Math.round(plannedActiveSec * completionFraction);
  const phase = {
    phaseInstanceId: `${sessionId}:main`, phaseId: "main",
    kind: intensityId === "recovery" ? "recovery" : "work", intensityId,
    activeStartSec: 0, activeEndSec: plannedActiveSec, plannedDurationSec: plannedActiveSec,
    completedDurationSec: completedPhaseSec,
    hr: scalar(hr, phaseHrCoverage, completedPhaseSec, 8),
    ...(includeWatts ? { watts: { ...scalar(watts, phaseWattsCoverage, completedPhaseSec, wattsSpread), provenance } } : {}),
    ...(includeCadence ? { cadenceRpm: scalar(72, phaseCadenceCoverage, completedPhaseSec, cadenceSpread) } : {}),
    ...(includeControllerResistance ? {
      desiredResistance: scalar(9, 1, completedPhaseSec, 1),
      commandedResistance: scalar(9, 1, completedPhaseSec, 1),
    } : {}),
  };
  return {
    external_session_id: sessionId, athlete_id: athleteId,
    startedAt: new Date(Date.parse(endedAt) - completedActiveSec * 1000).toISOString(), endedAt,
    category: "cardio", intent: "threshold calibration", duration_minutes: completedActiveSec / 60,
    primary_zone: 4, stress_profile: "high",
    zone_minutes: { z1: 0, z2: 0, z3: 0, z4: completedActiveSec / 60, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] }, activity, cancelled,
    workout_response: {
      schemaVersion: 1, athleteId, sessionId,
      completion: { plannedActiveSec, completedActiveSec, completionFraction, cancelled, earlyCooldown: false },
      evidence: {
        hr: {
          expectedDurationSec: completedActiveSec,
          validSampleCount: Math.round(completedActiveSec * sessionHrCoverage),
          coverageRatio: sessionHrCoverage,
          source: sessionHrCoverage > 0 ? "ble_chest_strap" : "unavailable",
        },
        bike: {
          expectedDurationSec: completedActiveSec, rowCount: completedActiveSec,
          freshSampleCount: Math.round(completedActiveSec * freshBikeCoverage),
          staleSampleCount: completedActiveSec - Math.round(completedActiveSec * freshBikeCoverage),
          unavailableSampleCount: 0, implicitMissingCount: 0,
          freshRowCoverageRatio: freshBikeCoverage,
          wattsProvenance: includeWatts ? provenance : "unavailable",
        },
        rawTelemetry: { store: "ordinary_bike_telemetry", schemaVersion: 1 },
      },
      phases: [phase],
    },
  };
}

function trajectory(watts, options = {}) {
  return watts.map((value, index) => ordinarySummary({
    sessionId: `session-${index + 1}`,
    endedAt: `2026-01-${String(index + 1).padStart(2, "0")}T12:10:00.000Z`,
    watts: value, ...options,
  }));
}

function rebuild(summaries, currentState = null, athleteId = "athlete-a") {
  return rebuildPassiveFitnessProjection({ athleteId, currentState, workoutSummaries: summaries });
}

test("qualification accepts steady owned bike work and exposes normalized observed evidence", () => {
  const result = qualifyWorkoutResponseForPassiveFitness(ordinarySummary(), "athlete-a");
  assert.equal(result.qualified, true);
  assert.deepEqual(result.observations[0], {
    athleteId: "athlete-a", sessionId: "session-1", workoutDate: "2026-01-01",
    observedAt: "2026-01-01T12:10:00.000Z", intensityId: "threshold",
    heartRateBpm: 150, watts: 200, workloadSource: "measured_watts",
    phaseCount: 1, completedDurationSec: 600,
  });
});

test("qualification rejects ownership, completion, coverage, activity, phase, and stability failures", () => {
  const cases = [
    [ordinarySummary({ athleteId: "athlete-b" }), "ownership_mismatch"],
    [ordinarySummary({ activity: "strength" }), "activity_not_bike"],
    [ordinarySummary({ cancelled: true }), "cancelled"],
    [ordinarySummary({ completionFraction: 0.7, completedPhaseSec: 420 }), "low_completion"],
    [ordinarySummary({ sessionHrCoverage: 0.5 }), "low_session_hr_coverage"],
    [ordinarySummary({ freshBikeCoverage: 0.5 }), "low_fresh_workload_coverage"],
    [ordinarySummary({ intensityId: "vo2_short" }), "unsupported_phase_semantics"],
    [ordinarySummary({ intensityId: "recovery" }), "unsupported_phase_semantics"],
    [ordinarySummary({ phaseDurationSec: 300 }), "phase_too_short"],
    [ordinarySummary({ completionFraction: 0.85, completedPhaseSec: 510 }), "low_phase_completion"],
    [ordinarySummary({ phaseHrCoverage: 0.5 }), "low_phase_hr_coverage"],
    [ordinarySummary({ phaseWattsCoverage: 0.5 }), "low_phase_workload_coverage"],
    [ordinarySummary({ watts: 900 }), "implausible_watts"],
    [ordinarySummary({ hr: 220 }), "implausible_hr"],
    [ordinarySummary({ wattsSpread: 80 }), "unstable_workload"],
    [ordinarySummary({ cadenceSpread: 20 }), "missing_or_unstable_cadence"],
  ];
  for (const [summary, expectedReason] of cases) {
    const result = qualifyWorkoutResponseForPassiveFitness(summary, "athlete-a");
    assert.equal(result.qualified, false, expectedReason);
    assert.ok(result.rejectionReasons.includes(expectedReason), expectedReason);
  }
});

test("commanded resistance and unavailable watts never become passive workload", () => {
  const result = qualifyWorkoutResponseForPassiveFitness(
    ordinarySummary({ includeWatts: false, includeControllerResistance: true }), "athlete-a"
  );
  assert.equal(result.qualified, false);
  assert.ok(result.rejectionReasons.includes("unsupported_workload_provenance"));
});

test("one workout and repeated sessions on one date cannot promote passive fitness", () => {
  assert.equal(rebuild([ordinarySummary()]).state, null);
  const sameDate = trajectory([190, 195, 200, 205]).map((summary, index) => ({
    ...summary, endedAt: `2026-01-01T${String(12 + index).padStart(2, "0")}:10:00.000Z`,
  }));
  assert.equal(rebuild(sameDate).state, null);
});

test("four measured independent dates establish a low-quality comparable-HR projection", () => {
  const result = rebuild(trajectory([198, 200, 202, 200]));
  assert.equal(result.diagnostics.status, "eligible");
  assert.equal(result.state.schemaVersion, 2);
  assert.equal(result.state.passiveAerobicTrend.source, "workout_observation");
  assert.equal(result.state.passiveAerobicTrend.quality, "low");
  assert.equal(result.state.passiveAerobicTrend.value.projectedComparableWorkloadWatts, 200);
  assert.deepEqual(result.state.passiveAerobicTrend.value.workloadSourceClasses, ["measured_watts"]);
});

test("calibrated watts remain explicit and require an extra independent session", () => {
  assert.equal(rebuild(trajectory([180, 181, 182, 183], { provenance: "calibrated_watts" })).state, null);
  const five = rebuild(trajectory([180, 181, 182, 183, 184], { provenance: "calibrated_watts" }));
  assert.equal(five.state.passiveAerobicTrend.quality, "low");
  assert.deepEqual(five.state.passiveAerobicTrend.value.workloadSourceClasses, ["calibrated_watts"]);
});

test("stable, improving, anomalous-bad, and repeated-deterioration trajectories are conservative", () => {
  const stable = rebuild(trajectory([200, 200, 201, 199, 200, 200, 201, 199]));
  assert.equal(stable.state.passiveAerobicTrend.value.projectedComparableWorkloadWatts, 200);
  const improving = rebuild(trajectory([180, 182, 184, 186, 190, 194, 198, 202]));
  const improved = improving.state.passiveAerobicTrend.value.projectedComparableWorkloadWatts;
  assert.ok(improved > improving.state.passiveAerobicTrend.value.baselineComparableWorkloadWatts);
  assert.ok(improved < 196);
  const beforeBad = rebuild(trajectory([200, 200, 200, 200]));
  const oneBad = rebuild(trajectory([200, 200, 200, 200, 120]));
  assert.equal(oneBad.state.passiveAerobicTrend.value.projectedComparableWorkloadWatts,
    beforeBad.state.passiveAerobicTrend.value.projectedComparableWorkloadWatts);
  const declining = rebuild(trajectory([200, 200, 200, 200, 180, 178, 176]));
  assert.ok(declining.state.passiveAerobicTrend.value.projectedComparableWorkloadWatts < 200);
  assert.ok(declining.state.passiveAerobicTrend.value.projectedComparableWorkloadWatts >= 198.5);
});

test("duplicate processing and out-of-order replay are idempotent", () => {
  const evidence = trajectory([180, 182, 184, 186, 190, 194]);
  const chronological = rebuild(evidence);
  const replayed = rebuild([evidence[5], evidence[0], evidence[2], evidence[1], evidence[4], evidence[3], evidence[5]]);
  assert.deepEqual(replayed.state, chronological.state);
  assert.deepEqual(replayed.diagnostics.evidenceSessionIds, chronological.diagnostics.evidenceSessionIds);
});

test("athlete ownership is frozen and foreign or legacy-unowned responses cannot contribute", () => {
  const owned = trajectory([190, 192, 194, 196]);
  const foreign = trajectory([250, 252, 254, 256], { athleteId: "athlete-b" });
  const unowned = structuredClone(ordinarySummary());
  delete unowned.athlete_id;
  const result = rebuild([...owned, ...foreign, unowned]);
  assert.equal(result.state.passiveAerobicTrend.value.observedMaxWatts, 196);
  assert.ok(result.diagnostics.rejectionReasonCounts.ownership_mismatch >= 5);
});

test("formal anchor remains authoritative and excludes old ordinary evidence", () => {
  const formal = {
    schemaVersion: 1, athleteId: "athlete-a",
    vo2Max: {
      value: 45, source: "formal_assessment", quality: "moderate",
      observedAt: "2026-01-05T12:00:00.000Z", updatedAt: "2026-01-05T12:01:00.000Z",
      algorithm: { id: "bike-submax-linear-hr-workload", version: 1 }, evidenceSessionIds: ["formal-1"],
    },
    updatedAt: "2026-01-05T12:01:00.000Z",
  };
  assert.ok(parseFitnessState(formal));
  const old = trajectory([250, 252, 254, 256]);
  const recent = trajectory([190, 192, 194, 196]).map((summary, index) => ({
    ...summary, external_session_id: `recent-${index}`,
    endedAt: `2026-01-${String(index + 6).padStart(2, "0")}T12:10:00.000Z`,
    workout_response: { ...summary.workout_response, sessionId: `recent-${index}` },
  }));
  const result = rebuild([...old, ...recent], formal);
  assert.deepEqual(result.state.vo2Max, formal.vo2Max);
  assert.equal(result.state.passiveAerobicTrend.source, "workout_observation");
  assert.equal(result.state.passiveAerobicTrend.value.observedMaxWatts, 196);
  assert.equal(result.state.passiveAerobicTrend.value.formalAnchorSessionId, "formal-1");
});

test("Phase D v2 persistence is strict and the historical v1 reader stays independent", () => {
  const state = rebuild(trajectory([198, 200, 202, 200])).state;
  assert.deepEqual(parseFitnessState(structuredClone(state)), state);
  const unknownAlgorithm = structuredClone(state);
  unknownAlgorithm.passiveAerobicTrend.algorithm.version = 2;
  assert.equal(parseFitnessState(unknownAlgorithm), null);
  const malformed = structuredClone(state);
  malformed.passiveAerobicTrend.value.distinctWorkoutDateCount = 1;
  assert.equal(parseFitnessState(malformed), null);
  assert.equal(parseFitnessState({ ...state, schemaVersion: 3 }), null);
  assert.equal(parseFitnessState({ ...state, schemaVersion: 1 }), null);
  assert.equal(FITNESS_REFINEMENT_ALGORITHM_V1.id, "fitness-refinement-v1");
});

test("deleting contributing history rebuilds and removes its passive projection", async () => {
  await resetWorkoutStorageForTests();
  const previousStorage = globalThis.localStorage;
  const athlete = migrateLegacyProfile({}, "athlete-a", "2025-12-01T00:00:00.000Z");
  const storage = memoryStorage({ [ATHLETE_PROFILE_STORAGE_KEY]: JSON.stringify(athlete) });
  globalThis.localStorage = storage;
  try {
    const summaries = trajectory([190, 192, 194, 196]);
    for (const summary of summaries) assert.equal(await storeWorkoutSummary(summary), true);
    const rows = await getAllWorkoutSummaries();
    assert.equal(rebuildStoredPassiveFitnessProjection(rows.map((row) => row.summary), storage), "refined");
    assert.ok(readFitnessState("athlete-a", storage)?.passiveAerobicTrend);
    assert.equal(await deleteWorkoutSummary("session-2"), true);
    assert.equal(readFitnessState("athlete-a", storage), null);
  } finally {
    globalThis.localStorage = previousStorage;
    await resetWorkoutStorageForTests();
  }
});
