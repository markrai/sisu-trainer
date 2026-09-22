import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import {
  FITNESS_STATE_STORAGE_KEY,
  VO2_FITNESS_PROJECTION_V1,
  captureAthleteFitnessSnapshot,
  isSupportedVo2FitnessEstimator,
  isSupportedVo2FitnessProtocol,
  parseFitnessState,
  promoteVo2AssessmentToFitnessState,
  promoteVo2SummaryToStoredFitnessState,
  readFitnessState,
  storeFitnessState,
} from "../dist/fitnessState.js";
import {
  ATHLETE_PROFILE_STORAGE_KEY,
  PROFILE_WEIGHT_LBS_TO_KG,
  migrateLegacyProfile,
} from "../dist/profile.js";
import { assessVo2 } from "../dist/vo2Estimator.js";
import {
  emitWorkoutSummary,
} from "../dist/workoutSummary.js";
import {
  getAllWorkoutSummaries,
  resetWorkoutStorageForTests,
} from "../dist/workoutStorage.js";

function memoryStorage(initial = {}, failKey) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (key === failKey) throw new Error(`write failed: ${key}`);
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function athleteProfile(athleteId = "athlete-fitness") {
  return migrateLegacyProfile(
    { age: 40, weight: 80 / PROFILE_WEIGHT_LBS_TO_KG, height: 70, sex: "female", vo2: 55 },
    athleteId,
    "2026-09-01T12:00:00.000Z"
  );
}

function protocolEvidence({
  heartRates = [120, 130, 140],
  workloadSources = ["measured_watts", "measured_watts", "measured_watts"],
  includeRejected = true,
} = {}) {
  const watts = [100, 125, 150];
  const stages = watts.map((stageWatts, index) => {
    const source = workloadSources[index];
    return {
      stage_id: `stage-${index + 1}`,
      active_start_sec: 300 + index * 180,
      active_end_sec: 480 + index * 180,
      requested_watts: stageWatts,
      prescribed_resistance: 3 + index,
      calibrated_watts_at_70rpm: stageWatts,
      status: "accepted",
      nominal_duration_sec: 180,
      actual_duration_sec: 180,
      hr: {
        sample_count: 120,
        minute_2_mean_bpm: heartRates[index],
        minute_3_mean_bpm: heartRates[index],
        final_two_window_delta_bpm: 0,
        steady_state_bpm: heartRates[index],
      },
      workload: {
        source,
        estimator_watts: stageWatts,
        calibrated_watts_at_70rpm: stageWatts,
        measured_watts_median: source === "measured_watts" ? stageWatts : undefined,
        measured_watts_sample_count: source === "measured_watts" ? 100 : 0,
        measured_cadence_median_rpm: 70,
        measured_cadence_sample_count: 100,
        cadence_in_band_ratio: 1,
        cadence_measured: true,
        watts_measured: source === "measured_watts",
      },
    };
  });
  if (includeRejected) {
    stages.push({
      stage_id: "stage-rejected",
      active_start_sec: 840,
      active_end_sec: 1020,
      requested_watts: 175,
      prescribed_resistance: 6,
      calibrated_watts_at_70rpm: 175,
      status: "unstable_hr",
      nominal_duration_sec: 180,
      actual_duration_sec: 180,
      hr: { sample_count: 120, steady_state_bpm: 150 },
      workload: {
        source: "measured_watts",
        estimator_watts: 175,
        calibrated_watts_at_70rpm: 175,
        measured_watts_median: 175,
        measured_watts_sample_count: 100,
        measured_cadence_median_rpm: 70,
        measured_cadence_sample_count: 100,
        cadence_in_band_ratio: 1,
        cadence_measured: true,
        watts_measured: true,
      },
    });
  }
  return {
    schema_version: 1,
    activity: "bike",
    intent: "vo2_estimation",
    day: "VO2MaxEstimation",
    active_duration_sec: 1200,
    paused_duration_sec: 0,
    work_end_active_sec: 1020,
    cooldown_start_active_sec: 1020,
    early_cooldown: false,
    phases: [],
    hr: { source: "ble_chest_strap", sample_count: 360 },
    protocol: {
      protocol_id: "bike-submax-70rpm",
      protocol_version: 1,
      prescribed_cadence_rpm: 70,
      stages,
      termination: { reason: "protocol_complete" },
      automatic_submax_hr_ceiling_available: false,
    },
  };
}

function assessmentFixture(options = {}) {
  const athlete = athleteProfile(options.athleteId);
  const vo2Evidence = protocolEvidence(options);
  const assessment = assessVo2(vo2Evidence, { age_years: 40, weight_kg: 80 });
  const endedAt = options.endedAt ?? "2026-09-21T12:30:00.000Z";
  const startedAt = new Date(Date.parse(endedAt) - 30 * 60 * 1000).toISOString();
  const summary = {
    external_session_id: options.sessionId ?? "fitness-session",
    athlete_id: athlete.athleteId,
    athlete_fitness_snapshot: {
      athleteId: athlete.athleteId,
      profileSchemaVersion: 1,
    },
    startedAt,
    endedAt,
    category: "cardio",
    intent: "vo2_estimation",
    duration_minutes: 30,
    primary_zone: 3,
    stress_profile: "moderate",
    zone_minutes: { z1: 0, z2: 0, z3: 30, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    day: "VO2MaxEstimation",
    vo2_evidence: vo2Evidence,
    vo2_assessment: assessment,
  };
  return { athlete, assessment, summary };
}

function promote(fixture, currentState = null, updatedAt = "2026-09-21T12:31:00.000Z") {
  return promoteVo2AssessmentToFitnessState({
    currentState,
    athleteProfile: fixture.athlete,
    workoutSummary: fixture.summary,
    assessment: fixture.assessment,
    updatedAt,
  });
}

test("fitness state parser and local persistence reconstruct strict versioned records", () => {
  const fixture = assessmentFixture();
  const promoted = promote(fixture);
  assert.ok(promoted);
  const parsed = parseFitnessState(deepClone(promoted));
  assert.deepEqual(parsed, promoted);
  assert.equal(parsed.athleteId, fixture.athlete.athleteId);
  assert.equal(parsed.updatedAt, "2026-09-21T12:31:00.000Z");

  const storage = memoryStorage();
  assert.equal(storeFitnessState(promoted, storage), true);
  assert.deepEqual(readFitnessState(fixture.athlete.athleteId, storage), promoted);
  assert.equal(readFitnessState("different-athlete", storage), null);
  assert.equal(parseFitnessState({ ...promoted, schemaVersion: 2 }), null);
  assert.equal(parseFitnessState({ ...promoted, athleteId: "" }), null);
  assert.equal(parseFitnessState({ ...promoted, vo2Max: { ...promoted.vo2Max, value: "bad" } }), null);
  assert.equal(parseFitnessState({ ...promoted, updatedAt: "not-a-date" }), null);
});

test("persisted v1 fitness state uses permanent supported identities and rejects unknown versions", () => {
  const fixture = assessmentFixture();
  const persistedV1 = deepClone(promote(fixture));
  assert.ok(persistedV1);

  const v1EstimatorId = "bike-submax-linear-hr-workload";
  const v1ProtocolId = "bike-submax-70rpm";
  assert.equal(VO2_FITNESS_PROJECTION_V1.estimatorId, v1EstimatorId);
  assert.equal(VO2_FITNESS_PROJECTION_V1.protocolId, v1ProtocolId);
  assert.equal(isSupportedVo2FitnessEstimator(v1EstimatorId, 1), true);
  assert.equal(isSupportedVo2FitnessEstimator(v1EstimatorId, 2), false);
  assert.equal(isSupportedVo2FitnessProtocol(v1ProtocolId, 1), true);
  assert.equal(isSupportedVo2FitnessProtocol(v1ProtocolId, 2), false);
  assert.deepEqual(parseFitnessState(persistedV1), persistedV1);

  const futureEstimator = deepClone(persistedV1);
  futureEstimator.vo2Max.algorithm.version = 2;
  assert.equal(parseFitnessState(futureEstimator), null);

  const futureProtocol = deepClone(persistedV1);
  futureProtocol.hrWorkloadCalibration.value.protocol.version = 2;
  assert.equal(parseFitnessState(futureProtocol), null);

  const unknownEstimator = deepClone(persistedV1);
  unknownEstimator.vo2Max.algorithm.id = "unknown-estimator";
  assert.equal(parseFitnessState(unknownEstimator), null);
});

test("qualified formal assessment promotes exact VO2, extrapolated watts, and eligible calibration only", () => {
  const fixture = assessmentFixture();
  const originalSummary = deepClone(fixture.summary);
  const state = promote(fixture);
  assert.ok(state);
  assert.equal(state.vo2Max.value, fixture.assessment.estimate_ml_kg_min);
  assert.equal(state.vo2Max.source, "formal_assessment");
  assert.equal(state.vo2Max.quality, "high");
  assert.deepEqual(state.vo2Max.algorithm, {
    id: "bike-submax-linear-hr-workload",
    version: 1,
  });
  assert.deepEqual(state.vo2Max.evidenceSessionIds, [fixture.summary.external_session_id]);
  assert.equal(state.predictedMaxWatts.value, fixture.assessment.diagnostics.predicted_max_watts);
  assert.equal(state.predictedMaxWatts.source, "formal_assessment");
  assert.equal(state.predictedMaxWatts.derivation, "demographic_hrmax_extrapolation");
  assert.equal(state.predictedMaxWatts.predictedHrMaxSource, "demographic_estimate");
  assert.equal(state.hrWorkloadCalibration.value.slopeBpmPerWatt, fixture.assessment.diagnostics.slope);
  assert.equal(state.hrWorkloadCalibration.value.interceptBpm, fixture.assessment.diagnostics.intercept);
  assert.equal(state.hrWorkloadCalibration.value.rSquared, fixture.assessment.diagnostics.r_squared);
  assert.equal(state.hrWorkloadCalibration.value.points.length, 3);
  assert.equal(state.hrWorkloadCalibration.value.points.some((point) => point.stageId === "stage-rejected"), false);
  assert.deepEqual(state.hrWorkloadCalibration.value.protocol, {
    id: "bike-submax-70rpm",
    version: 1,
  });
  assert.equal(state.hrWorkloadCalibration.value.predictedHrMaxSource, "demographic_estimate");
  assert.equal("observedHrMax" in state, false);
  assert.deepEqual(fixture.summary, originalSummary);
});

test("promotion fails closed for insufficient, unsupported, malformed, or foreign evidence", () => {
  const fixture = assessmentFixture();
  const insufficient = deepClone(fixture);
  insufficient.assessment.status = "insufficient_evidence";
  assert.equal(promote(insufficient), null);

  const unsupportedEstimator = deepClone(fixture);
  unsupportedEstimator.assessment.estimator_version = 99;
  assert.equal(promote(unsupportedEstimator), null);

  const unsupportedProtocol = deepClone(fixture);
  unsupportedProtocol.assessment.input_snapshot.protocol_version = 99;
  assert.equal(promote(unsupportedProtocol), null);

  const malformedRegression = deepClone(fixture);
  malformedRegression.assessment.diagnostics.slope = "bad";
  assert.equal(promote(malformedRegression), null);

  const malformedHistorical = deepClone(fixture);
  delete malformedHistorical.assessment.diagnostics;
  assert.doesNotThrow(() => promote(malformedHistorical));
  assert.equal(promote(malformedHistorical), null);

  const rejectedPoint = deepClone(fixture);
  rejectedPoint.assessment.diagnostics.eligible_points[0].estimator_eligible = false;
  assert.equal(promote(rejectedPoint), null);

  const foreign = deepClone(fixture);
  foreign.summary.athlete_id = "different-athlete";
  assert.equal(promote(foreign), null);
});

test("fit quality maps directly and cadence-calibrated workload can only downgrade it", () => {
  const high = assessmentFixture({ heartRates: [120, 130, 140] });
  assert.equal(high.assessment.fit_quality, "high");
  assert.equal(promote(high).vo2Max.quality, "high");

  const moderate = assessmentFixture({ heartRates: [120, 135, 140] });
  assert.equal(moderate.assessment.fit_quality, "moderate");
  assert.equal(promote(moderate).vo2Max.quality, "moderate");

  const low = assessmentFixture({ heartRates: [120, 142, 145] });
  assert.equal(low.assessment.fit_quality, "low");
  assert.equal(promote(low).vo2Max.quality, "low");

  const calibrated = assessmentFixture({
    workloadSources: [
      "calibrated_at_verified_cadence",
      "calibrated_at_verified_cadence",
      "calibrated_at_verified_cadence",
    ],
  });
  assert.equal(calibrated.assessment.fit_quality, "high");
  const calibratedState = promote(calibrated);
  assert.equal(calibratedState.vo2Max.quality, "moderate");
  assert.equal(calibratedState.hrWorkloadCalibration.quality, "moderate");
});

test("formal assessment precedence follows evidence time and invalid updates preserve prior state", () => {
  const first = assessmentFixture({
    sessionId: "assessment-first",
    endedAt: "2026-09-20T12:30:00.000Z",
  });
  const firstState = promote(first, null, "2026-09-20T12:31:00.000Z");
  assert.ok(firstState);
  assert.equal(first.athlete.userEnteredVo2.quality, "unverified");
  assert.equal(firstState.vo2Max.source, "formal_assessment");
  assert.notEqual(firstState.vo2Max.value, first.athlete.userEnteredVo2.value);

  const newer = assessmentFixture({
    sessionId: "assessment-newer",
    endedAt: "2026-09-21T12:30:00.000Z",
    heartRates: [120, 135, 140],
  });
  const newerState = promote(newer, firstState, "2026-09-21T12:31:00.000Z");
  assert.ok(newerState);
  assert.deepEqual(newerState.vo2Max.evidenceSessionIds, ["assessment-newer"]);

  const olderProcessedLater = assessmentFixture({
    sessionId: "assessment-older",
    endedAt: "2026-09-19T12:30:00.000Z",
  });
  assert.equal(
    promote(olderProcessedLater, newerState, "2026-09-22T12:31:00.000Z"),
    null
  );

  const invalidNewer = assessmentFixture({
    sessionId: "assessment-invalid",
    endedAt: "2026-09-22T12:30:00.000Z",
  });
  invalidNewer.assessment.status = "insufficient_evidence";
  const frozen = deepClone(newerState);
  assert.equal(promote(invalidNewer, newerState, "2026-09-22T12:31:00.000Z"), null);
  assert.deepEqual(newerState, frozen);
});

test("athlete fitness snapshot identifies state without copying the full model", () => {
  const fixture = assessmentFixture();
  const state = promote(fixture);
  const storage = memoryStorage({
    [ATHLETE_PROFILE_STORAGE_KEY]: JSON.stringify(fixture.athlete),
    [FITNESS_STATE_STORAGE_KEY]: JSON.stringify(state),
  });
  assert.deepEqual(captureAthleteFitnessSnapshot(storage), {
    athleteId: fixture.athlete.athleteId,
    profileSchemaVersion: 1,
    fitnessStateSchemaVersion: 1,
    fitnessUpdatedAt: state.updatedAt,
  });
});

test("qualified stored promotion persists the athlete-owned current projection", () => {
  const fixture = assessmentFixture({ endedAt: "2026-09-20T12:30:00.000Z" });
  const storage = memoryStorage({
    [ATHLETE_PROFILE_STORAGE_KEY]: JSON.stringify(fixture.athlete),
  });
  assert.equal(
    promoteVo2SummaryToStoredFitnessState(
      fixture.summary,
      storage,
      "2026-09-20T12:31:00.000Z"
    ),
    "promoted"
  );
  const stored = readFitnessState(fixture.athlete.athleteId, storage);
  assert.ok(stored);
  assert.equal(stored.vo2Max.value, fixture.assessment.estimate_ml_kg_min);
  assert.deepEqual(stored.vo2Max.evidenceSessionIds, [fixture.summary.external_session_id]);
});

test("stored promotion failure leaves an already-saved immutable workout summary intact", async () => {
  const previousIndexedDb = globalThis.indexedDB;
  const previousKeyRange = globalThis.IDBKeyRange;
  const previousStorage = globalThis.localStorage;
  globalThis.indexedDB = indexedDB;
  globalThis.IDBKeyRange = IDBKeyRange;
  const fixture = assessmentFixture({
    sessionId: "fitness-write-failure",
    endedAt: "2026-09-20T12:30:00.000Z",
  });
  const storage = memoryStorage(
    { [ATHLETE_PROFILE_STORAGE_KEY]: JSON.stringify(fixture.athlete) },
    FITNESS_STATE_STORAGE_KEY
  );
  globalThis.localStorage = storage;
  try {
    await resetWorkoutStorageForTests();
    const original = deepClone(fixture.summary);
    await emitWorkoutSummary(fixture.summary);
    const stored = (await getAllWorkoutSummaries()).find(
      (row) => row.summary.external_session_id === fixture.summary.external_session_id
    );
    assert.ok(stored);
    assert.deepEqual(stored.summary, original);
    assert.equal(storage.getItem(FITNESS_STATE_STORAGE_KEY), null);
    assert.equal(
      promoteVo2SummaryToStoredFitnessState(
        fixture.summary,
        storage,
        "2026-09-20T12:31:00.000Z"
      ),
      "persistence_failed"
    );
  } finally {
    await resetWorkoutStorageForTests();
    globalThis.indexedDB = previousIndexedDb;
    globalThis.IDBKeyRange = previousKeyRange;
    globalThis.localStorage = previousStorage;
  }
});

test("historical v1 assessments are re-verified with version-bound v1 semantics", () => {
  const fixture = assessmentFixture();
  const v1Assessment = deepClone(fixture.assessment);
  v1Assessment.estimator_id = "bike-submax-linear-hr-workload";
  v1Assessment.estimator_version = 1;
  v1Assessment.input_snapshot.protocol_id = "bike-submax-70rpm";
  v1Assessment.input_snapshot.protocol_version = 1;
  v1Assessment.diagnostics.expected_protocol_id = "bike-submax-70rpm";
  v1Assessment.diagnostics.expected_protocol_version = 1;
  v1Assessment.diagnostics.observed_protocol_id = "bike-submax-70rpm";
  v1Assessment.diagnostics.observed_protocol_version = 1;

  const v1Fixture = deepClone(fixture);
  v1Fixture.assessment = v1Assessment;
  v1Fixture.summary.vo2_evidence.protocol.protocol_id = "bike-submax-70rpm";
  v1Fixture.summary.vo2_evidence.protocol.protocol_version = 1;

  const promoted = promote(v1Fixture);
  assert.ok(promoted, "v1 assessment should still promote");
  assert.equal(promoted.vo2Max.algorithm.version, 1);
  assert.equal(promoted.hrWorkloadCalibration.value.protocol.version, 1);
});

test("demographic changes after assessment do not invalidate historical evidence", () => {
  // Regression for: assessment @ weight A, age Y
  // Later: athlete changes to weight B, age Y+1
  // Same athleteId → assessment still promotes (immutable snapshot)
  const fixture = assessmentFixture();
  const assessedProfile = deepClone(fixture.athlete);
  assert.equal(assessedProfile.demographics.ageYears, 40);
  assert.equal(assessedProfile.demographics.bodyMassLbs, 80 / PROFILE_WEIGHT_LBS_TO_KG);

  // Promote with original profile - should succeed
  const originalState = promote(fixture, null, "2026-09-21T12:31:00.000Z");
  assert.ok(originalState, "assessment should promote with original demographics");

  // Simulate athlete's profile changes over time
  const updatedProfile = deepClone(fixture.athlete);
  updatedProfile.demographics.ageYears = 41; // aged a year
  updatedProfile.demographics.bodyMassLbs = 85 / PROFILE_WEIGHT_LBS_TO_KG; // gained weight
  updatedProfile.updatedAt = "2026-09-25T12:31:00.000Z";

  // Try to promote the same assessment with the new profile
  const laterState = promoteVo2AssessmentToFitnessState({
    currentState: originalState,
    athleteProfile: updatedProfile,
    workoutSummary: fixture.summary,
    assessment: fixture.assessment,
    updatedAt: "2026-09-25T12:35:00.000Z",
  });

  // Should still fail because it's not newer than the original
  assert.equal(laterState, null, "cannot promote same assessment twice");

  // But test that the assessment WOULD promote if not for the timing issue
  const hypotheticalPromotion = promoteVo2AssessmentToFitnessState({
    currentState: null,
    athleteProfile: updatedProfile,
    workoutSummary: fixture.summary,
    assessment: fixture.assessment,
    updatedAt: "2026-09-25T12:35:00.000Z",
  });

  assert.ok(
    hypotheticalPromotion,
    "assessment snapshot is immutable and independent of current demographic changes"
  );
  assert.equal(hypotheticalPromotion.vo2Max.value, fixture.assessment.estimate_ml_kg_min);
  assert.deepEqual(hypotheticalPromotion.hrWorkloadCalibration.value.profileInputSnapshot, {
    ageYears: 40,
    bodyMassKg: 80,
  });
});

test("unsupported estimator and protocol versions are rejected", () => {
  const fixture = assessmentFixture();

  // Unsupported estimator version
  const unsupportedEstimator = deepClone(fixture);
  unsupportedEstimator.assessment.estimator_version = 2;
  assert.equal(promote(unsupportedEstimator), null, "v2 estimator should be rejected");

  // Unsupported protocol in input snapshot
  const unsupportedProtocolSnapshot = deepClone(fixture);
  unsupportedProtocolSnapshot.assessment.input_snapshot.protocol_version = 2;
  assert.equal(promote(unsupportedProtocolSnapshot), null, "v2 protocol in snapshot should be rejected");

  // Unsupported protocol in observed evidence
  const unsupportedProtocolObserved = deepClone(fixture);
  unsupportedProtocolObserved.summary.vo2_evidence.protocol.protocol_version = 2;
  assert.equal(promote(unsupportedProtocolObserved), null, "v2 protocol in evidence should be rejected");

  // Unsupported protocol in diagnostics expected
  const unsupportedExpected = deepClone(fixture);
  unsupportedExpected.assessment.diagnostics.expected_protocol_version = 2;
  assert.equal(promote(unsupportedExpected), null, "v2 protocol in expected should be rejected");

  // Unsupported protocol in diagnostics observed
  const unsupportedObservedDiagnostics = deepClone(fixture);
  unsupportedObservedDiagnostics.assessment.diagnostics.observed_protocol_version = 2;
  assert.equal(promote(unsupportedObservedDiagnostics), null, "v2 protocol in diagnostics should be rejected");
});
