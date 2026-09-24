import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";

import {
  PHASE_E1_SHADOW_POLICY,
  evaluatePersonalizedPrescription,
} from "../dist/personalizedPrescription.js";
import {
  PHASE_E2_CHARACTERIZATION_POLICY_V1,
  aggregatePersonalizedPrescriptionCharacterizations,
  characterizePersonalizedPrescription,
  parsePersonalizedPrescriptionCharacterization,
  personalizedPrescriptionDiagnosticRows,
} from "../dist/personalizedPrescriptionCharacterization.js";
import { deriveWorkoutResponse } from "../dist/workoutResponse.js";
import { resolveWorkoutPrescription } from "../dist/workoutPrescription.js";
import { machineHeartRateTargetFromResolved } from "../dist/workoutPrescription.js";
import { createMachineGuidanceState } from "../dist/machines/guidance.js";
import { getProFormSmartPower10Guidance } from "../dist/machines/proformSmartPower10.js";
import { buildSisuWorkoutPayload } from "../dist/sisuSync.js";
import { startSession } from "../dist/sessionStore.js";
import { generateWorkoutSummary } from "../dist/workoutSummary.js";
import {
  buildPersonalizationDiagnosticsModel,
  createPersonalizationDiagnosticsExport,
  extractTrustedPersonalizationAssessmentContexts,
  extractTrustedPersonalizationCharacterizations,
  extractTrustedPersonalizationWorkoutContexts,
} from "../dist/personalizationDiagnosticsView.js";
import {
  getAllWorkoutSummaries,
  resetWorkoutStorageForTests,
  storeHrSample,
  storeOrdinaryBikeTelemetrySample,
  storeWorkoutSummary,
} from "../dist/workoutStorage.js";
import { parseWorkoutTemplateDocument } from "../dist/workoutTemplate.js";
import { transformWorkoutData } from "../dist/workoutData.js";
import { APP_VERSION } from "../dist/version.js";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const RESOLVED_AT = "2026-09-20T12:00:00.000Z";
const CREATED_AT = "2026-09-20T12:03:00.000Z";
const SESSION = "e2-session";
const ATHLETE = "athlete-e2";
const KG_PER_LB = 0.45359237;
const rawWorkoutData = JSON.parse(readFileSync(new URL("../data.json", import.meta.url), "utf8"));

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function profile() {
  return {
    schemaVersion: 1,
    athleteId: ATHLETE,
    demographics: { ageYears: 40, bodyMassLbs: 80 / KG_PER_LB },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function fitness(calibrationSource = "measured_watts", overrides = {}) {
  const points = [
    { stageId: "stage-1", watts: 100, heartRateBpm: 110, workloadSource: calibrationSource },
    { stageId: "stage-2", watts: 150, heartRateBpm: 135, workloadSource: calibrationSource },
    { stageId: "stage-3", watts: 200, heartRateBpm: 160, workloadSource: calibrationSource },
  ];
  return {
    schemaVersion: 1,
    athleteId: ATHLETE,
    hrWorkloadCalibration: {
      value: {
        slopeBpmPerWatt: 0.5,
        interceptBpm: 60,
        rSquared: 1,
        observedMinWatts: 100,
        observedMaxWatts: 200,
        points,
        protocol: { id: "bike-submax-70rpm", version: 1 },
        predictedHrMaxBpm: 180,
        predictedHrMaxSource: "demographic_estimate",
        profileInputSnapshot: { ageYears: 40, bodyMassKg: 80 },
        ...overrides,
      },
      source: "formal_assessment",
      quality: "high",
      observedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:01:00.000Z",
      algorithm: { id: "bike-submax-linear-hr-workload", version: 1 },
      evidenceSessionIds: ["formal-e2"],
    },
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
}

function prescription(target = "115-130") {
  return resolveWorkoutPrescription({
    workoutSelector: "Tuesday",
    blocks: { warm: 0, sustain: 3, cool: 0 },
    hrTargets: {
      main_set: target,
      main_set_intensity_id: "aerobic_base",
      main_set_kind: "work",
      intervals: null,
    },
    resolvedAt: RESOLVED_AT,
  });
}

function shadow({ target = "115-130", activity = "bike", intent = "aerobic_base",
  calibrationSource = "measured_watts" } = {}) {
  return evaluatePersonalizedPrescription({
    legacyPrescription: prescription(target),
    workoutIntent: intent,
    activity,
    athleteId: ATHLETE,
    profile: profile(),
    fitnessState: fitness(calibrationSource),
    policy: PHASE_E1_SHADOW_POLICY,
    resolvedAt: RESOLVED_AT,
  });
}

function bikeSample(second, watts, source = "measured_watts", resistance = 8, extras = {}) {
  return {
    schemaVersion: 1,
    athleteId: ATHLETE,
    sessionId: SESSION,
    activeSec: second,
    observedAt: new Date(Date.parse(RESOLVED_AT) + second * 1000).toISOString(),
    availability: "fresh",
    sourceSampleId: `sample-${second}`,
    freshnessMs: 0,
    watts: { value: watts, source, freshnessMs: 0 },
    cadenceRpm: { value: 70, source: "measured", freshnessMs: 0 },
    observedResistance: { value: resistance, source: "observed", freshnessMs: 0 },
    desiredResistance: resistance,
    commandedResistance: resistance,
    ...extras,
  };
}

function fixture(options = {}) {
  const duration = options.duration ?? 180;
  const target = options.target ?? "115-130";
  const activity = options.activity ?? "bike";
  const intent = options.intent ?? "aerobic_base";
  const calibrationSource = options.calibrationSource ?? "measured_watts";
  const e1 = shadow({ target, activity, intent, calibrationSource });
  const hrSeconds = options.hrSeconds ?? ((second) => true);
  const powerSeconds = options.powerSeconds ?? ((second) => true);
  const hrAt = options.hrAt ?? ((second) => second < 30 ? 105 : 120);
  const wattsAt = options.wattsAt ?? (() => 125);
  const powerSourceAt = options.powerSourceAt ?? (() => "measured_watts");
  const resistanceAt = options.resistanceAt ?? (() => 8);
  const hrSamples = Array.from({ length: duration }, (_, second) => second)
    .filter(hrSeconds)
    .map((second) => ({ session_id: SESSION, timestamp_sec: second, hr: hrAt(second) }));
  const bikeSamples = Array.from({ length: duration }, (_, second) => second)
    .filter(powerSeconds)
    .map((second) => bikeSample(second, wattsAt(second), powerSourceAt(second), resistanceAt(second)));
  if (options.extraBikeSamples) bikeSamples.push(...options.extraBikeSamples);
  const response = deriveWorkoutResponse({
    athleteId: ATHLETE,
    sessionId: SESSION,
    blocks: { warm: 0, sustain: 3, cool: 0 },
    resolvedPrescription: prescription(target),
    completedActiveSec: duration,
    cancelled: false,
    hrSamples,
    bikeSamples,
  });
  const summary = {
    external_session_id: SESSION,
    athlete_id: ATHLETE,
    day: "Tuesday",
    intent,
    activity,
  };
  const characterization = characterizePersonalizedPrescription({
    summary,
    shadowEvaluation: e1,
    workoutResponse: response,
    hrSamples,
    bikeSamples,
    machineDecisionAudit: options.machineDecisionAudit ?? [],
    policy: PHASE_E2_CHARACTERIZATION_POLICY_V1,
    createdAt: CREATED_AT,
  });
  return { e1, response, summary, hrSamples, bikeSamples, characterization,
    phase: characterization?.phases[0] };
}

function clone(value) {
  return structuredClone(value);
}

test("E2 deterministically characterizes strong measured evidence with interpretable components", () => {
  const first = fixture();
  const second = fixture();
  assert.deepEqual(first.characterization, second.characterization);
  assert.equal(first.characterization.activationEligible, false);
  assert.equal(first.phase.characterizationOutcome, "characterized");
  assert.deepEqual(first.phase.evidenceCoverage, {
    plannedDurationSec: 180, observedDurationSec: 180,
    hrCoveredSeconds: 180, powerCoveredSeconds: 180, jointCoveredSeconds: 180,
    hrCoverageRatio: 1, powerCoverageRatio: 1, jointCoverageRatio: 1,
  });
  assert.equal(first.phase.observedHeartRate.medianBpm, 120);
  assert.equal(first.phase.observedHeartRate.insideBandSeconds, 150);
  assert.equal(first.phase.observedHeartRate.heartRateChangeLateVsEarlyBpm, 0);
  assert.equal(first.phase.observedPower.medianWatts, 125);
  assert.equal(first.phase.stableInBandWorkload.sampleCount, 150);
  assert.equal(first.phase.stableInBandWorkload.medianWatts, 125);
  assert.equal(first.phase.comparison.signedDifferenceWatts, 0);
  assert.equal(first.phase.comparison.candidateContainsObservedMedian, true);
});

test("stable in-band workload is descriptively below, inside, or above the E1 candidate", () => {
  const below = fixture({ wattsAt: () => 100 }).phase;
  const inside = fixture({ wattsAt: () => 130 }).phase;
  const above = fixture({ wattsAt: () => 150 }).phase;
  assert.equal(below.comparison.agreement, "below_candidate");
  assert.equal(below.comparison.signedDifferenceWatts, -25);
  assert.equal(inside.comparison.agreement, "inside_candidate");
  assert.equal(above.comparison.agreement, "above_candidate");
  assert.equal(above.comparison.signedDifferenceWatts, 25);
});

test("coverage exclusions distinguish insufficient HR, power, and joint evidence", () => {
  const lowHr = fixture({ hrSeconds: (second) => second < 100 }).phase;
  const lowPower = fixture({ powerSeconds: (second) => second < 100 }).phase;
  const lowJoint = fixture({
    hrSeconds: (second) => second < 144,
    powerSeconds: (second) => second >= 36,
  }).phase;
  assert.equal(lowHr.exclusionReason, "insufficient_hr_coverage");
  assert.equal(lowPower.exclusionReason, "insufficient_power_coverage");
  assert.equal(lowJoint.evidenceCoverage.hrCoverageRatio, 0.8);
  assert.equal(lowJoint.evidenceCoverage.powerCoverageRatio, 0.8);
  assert.equal(lowJoint.evidenceCoverage.jointCoverageRatio, 0.6);
  assert.equal(lowJoint.exclusionReason, "insufficient_joint_coverage");
});

test("missing rows remain explicit gaps and malformed telemetry cannot become workload evidence", () => {
  const missing = fixture({ hrSeconds: () => false, powerSeconds: () => false }).phase;
  assert.equal(missing.characterizationOutcome, "telemetry_unavailable");
  assert.equal(missing.exclusionReason, "missing_telemetry");
  const malformed = fixture({
    powerSeconds: () => false,
    extraBikeSamples: [bikeSample(50, Number.NaN)],
  }).phase;
  assert.equal(malformed.evidenceCoverage.powerCoveredSeconds, 0);
  assert.equal(malformed.exclusionReason, "insufficient_power_coverage");
});

test("active-second evidence excludes pauses without wall-clock interpolation", () => {
  const result = fixture();
  assert.equal(result.phase.evidenceCoverage.observedDurationSec, 180);
  assert.equal(result.phase.evidenceCoverage.jointCoveredSeconds, 180);
  assert.equal(result.phase.evidenceCoverage.jointCoverageRatio, 1);
  assert.equal("wallClockDurationSec" in result.phase.evidenceCoverage, false);
});

test("observed measured and cadence-calibrated power remain separate; mixed provenance fails closed", () => {
  const measured = fixture().phase;
  const calibrated = fixture({
    calibrationSource: "calibrated_at_verified_cadence",
    powerSourceAt: () => "calibrated_watts",
  }).phase;
  const mixed = fixture({ powerSourceAt: (second) => second < 90 ? "measured_watts" : "calibrated_watts" }).phase;
  assert.equal(measured.observedPowerProvenance, "measured_watts");
  assert.equal(calibrated.observedPowerProvenance, "calibrated_watts");
  assert.equal(calibrated.characterizationOutcome, "characterized");
  assert.equal(mixed.observedPowerProvenance, "mixed");
  assert.equal(mixed.characterizationOutcome, "unsupported_observed_provenance");
  assert.equal(mixed.exclusionReason, "unsupported_power_provenance");
  assert.equal(mixed.comparison, undefined);
});

test("controller boundary saturation preserves observed, desired, and commanded distinctions", () => {
  const lower = fixture({
    resistanceAt: (second) => second < 45 ? 1 : 8,
    machineDecisionAudit: [{
      version: 1, kind: "evaluation", elapsedSeconds: 20, phaseKind: "work", phaseId: "sustain",
      phaseElapsedSeconds: 20, phaseDurationSeconds: 180, targetHeartRateMin: 115,
      targetHeartRateMax: 130, representativeHeartRate: 140, resistanceBefore: 1,
      resistanceAfter: 1, heartRateAssessment: "high", decision: "decrease", constraint: "r1_floor",
      decisionReason: "lower_resistance_bound", evaluationKind: "initial",
    }],
  }).phase;
  const upper = fixture({ resistanceAt: (second) => second < 30 ? 15 : 8 }).phase;
  assert.equal(lower.controllerContext.observed.lowerBoundSeconds, 45);
  assert.equal(lower.controllerContext.desired.lowerBoundSeconds, 45);
  assert.equal(lower.controllerContext.commanded.lowerBoundSeconds, 45);
  assert.equal(lower.controllerContext.anyBoundarySaturationSeconds, 45);
  assert.equal(lower.controllerContext.saturationRatio, 0.25);
  assert.equal(lower.controllerContext.lowerBoundaryDecisionCount, 1);
  assert.equal(upper.controllerContext.observed.upperBoundSeconds, 30);
});

test("candidate-domain margins distinguish an assessment edge from the interior without changing eligibility", () => {
  const edge = fixture().phase;
  const interior = fixture({ target: "125-140", wattsAt: () => 145, hrAt: () => 130 }).phase;
  assert.equal(edge.candidateDomainMargins.bucket, "edge");
  assert.equal(edge.candidateDomainMargins.heartRateToLowerBoundaryBpm, 5);
  assert.equal(interior.candidateDomainMargins.bucket, "interior");
  assert.equal(edge.characterizationOutcome, "characterized");
  assert.equal(interior.characterizationOutcome, "characterized");
});

test("settling policy removes phase-start and post-resistance-change HR-lag contamination", () => {
  const result = fixture({
    hrAt: (second) => second < 30 ? 100 : 120,
    wattsAt: (second) => second < 30 || (second >= 60 && second < 90) ? 200 : 125,
    resistanceAt: (second) => second < 60 ? 8 : 9,
  }).phase;
  assert.equal(PHASE_E2_CHARACTERIZATION_POLICY_V1.settlingSeconds, 30);
  assert.equal(result.stableInBandWorkload.sampleCount, 120);
  assert.equal(result.stableInBandWorkload.medianWatts, 125);
  assert.equal(result.comparison.signedDifferenceWatts, 0);
});

test("a phase without enough settled in-band evidence is not given an invented comparison", () => {
  const result = fixture({ hrAt: (second) => second >= 30 && second < 40 ? 120 : 100 }).phase;
  assert.equal(result.exclusionReason, "insufficient_settled_in_band_evidence");
  assert.equal(result.characterizationOutcome, "insufficient_evidence");
  assert.equal(result.stableInBandWorkload, undefined);
  assert.equal(result.comparison, undefined);
});

test("fallback E1 phases are counted as not-candidate and never receive comparison statistics", () => {
  const result = fixture({ intent: "unsupported-intent" }).phase;
  assert.equal(result.shadowOutcome, "fallback");
  assert.equal(result.characterizationOutcome, "not_candidate");
  assert.equal(result.candidatePower, undefined);
  assert.equal(result.comparison, undefined);
});

test("strict E2 reader validates E1 linkage, ownership, phase identity, candidates, and future schemas", () => {
  const { characterization, e1, response } = fixture();
  const expected = {
    athleteId: ATHLETE,
    sessionId: SESSION,
    workoutSelector: "Tuesday",
    activity: "bike",
    workoutResponse: response,
  };
  assert.deepEqual(parsePersonalizedPrescriptionCharacterization(characterization, e1, expected), characterization);
  for (const mutate of [
    (value) => { value.schemaVersion = 2; },
    (value) => { value.athleteId = "wrong-athlete"; },
    (value) => { value.workoutSessionId = "wrong-session"; },
    (value) => { value.phases[0].phaseId = "forged-phase"; },
    (value) => { value.phases[0].activeStartSec += 1; },
    (value) => { value.phases[0].candidatePower.minWatts += 1; },
    (value) => { value.phases[0].comparison.signedDifferenceWatts = Number.NaN; },
    (value) => { value.sourceShadow.resolvedAt = "2020-01-01T00:00:00.000Z"; },
  ]) {
    const forged = clone(characterization);
    mutate(forged);
    assert.equal(parsePersonalizedPrescriptionCharacterization(forged, e1, expected), null);
  }
});

test("aggregate reports cohort sizes, exclusions, medians, inside proportion, and stable ordering", () => {
  const inside = fixture().characterization;
  const above = fixture({ wattsAt: () => 150 }).characterization;
  above.workoutSessionId = "e2-session-above";
  const calibrated = fixture({
    calibrationSource: "calibrated_at_verified_cadence",
    powerSourceAt: () => "calibrated_watts",
  }).characterization;
  calibrated.workoutSessionId = "e2-session-calibrated";
  const excluded = fixture({ powerSeconds: () => false }).characterization;
  excluded.workoutSessionId = "e2-session-excluded";
  const records = [inside, above, calibrated, excluded];
  const aggregate = aggregatePersonalizedPrescriptionCharacterizations(records);
  assert.deepEqual(aggregatePersonalizedPrescriptionCharacterizations([...records].reverse()), aggregate);
  assert.equal(aggregate.workoutCount, 4);
  assert.equal(aggregate.candidatePhases, 4);
  assert.equal(aggregate.evaluableCandidatePhases, 3);
  assert.equal(aggregate.groups.length, 3);
  const measured = aggregate.groups.find((group) =>
    group.calibrationWorkloadProvenance === "measured_watts" && group.observedPowerProvenance === "measured_watts" &&
    group.exclusionCounts.insufficient_power_coverage === undefined);
  assert.equal(measured.completedWorkouts, 2);
  assert.equal(measured.signedDifferenceWatts.count, 2);
  assert.equal(measured.signedDifferenceWatts.median, 12.5);
  assert.deepEqual(measured.observedMedianInsideCandidate, { count: 1, total: 2, proportion: 0.5 });
  const zeroEvidence = aggregate.groups.find((group) => group.observedPowerProvenance === "unavailable");
  assert.equal(zeroEvidence.evaluableCandidatePhases, 0);
  assert.equal(zeroEvidence.absoluteDifferenceWatts.count, 0);
});

test("aggregate keeps fallback, intent, quality, and saturation cohorts explicit", () => {
  const candidate = fixture().characterization;
  const fallback = fixture({ intent: "unsupported-intent" }).characterization;
  fallback.workoutSessionId = "aggregate-fallback";
  const threshold = clone(candidate);
  threshold.workoutSessionId = "aggregate-threshold";
  threshold.workoutIntent = "threshold";
  const moderate = clone(candidate);
  moderate.workoutSessionId = "aggregate-moderate";
  moderate.formalAssessmentQuality = "moderate";
  const saturated = fixture({ resistanceAt: () => 15 }).characterization;
  saturated.workoutSessionId = "aggregate-saturated";
  const aggregate = aggregatePersonalizedPrescriptionCharacterizations([
    candidate, fallback, threshold, moderate, saturated,
  ]);
  assert.equal(aggregate.candidatePhases, 4);
  assert.equal(aggregate.fallbackPhases, 1);
  assert.ok(aggregate.groups.some((group) => group.workoutIntent === "threshold"));
  assert.ok(aggregate.groups.some((group) => group.formalAssessmentQuality === "moderate"));
  assert.ok(aggregate.groups.some((group) => group.controllerSaturationIncidence.count === 1));
});

test("developer diagnostics expose readable local-only rows", () => {
  const rows = personalizedPrescriptionDiagnosticRows([fixture().characterization]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].legacyHeartRate, "115-130 bpm");
  assert.equal(rows[0].candidateWatts, "110-140 W");
  assert.equal(rows[0].observedInBandWatts, 125);
  assert.equal(rows[0].outcome, "characterized");
});

test("the pure E2 reducer has no clock, storage, profile, or FitnessState dependency", () => {
  const baseline = fixture();
  const priorStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("E2 touched storage"); },
  });
  try {
    const repeated = characterizePersonalizedPrescription({
      summary: baseline.summary,
      shadowEvaluation: baseline.e1,
      workoutResponse: baseline.response,
      hrSamples: baseline.hrSamples,
      bikeSamples: baseline.bikeSamples,
      policy: PHASE_E2_CHARACTERIZATION_POLICY_V1,
      createdAt: CREATED_AT,
    });
    assert.deepEqual(repeated, baseline.characterization);
  } finally {
    if (priorStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: priorStorage });
  }
});

test("E2 has zero feedback imports into control, E1, FitnessState, or passive refinement", () => {
  const e2Source = readFileSync(new URL("../src/personalizedPrescriptionCharacterization.ts", import.meta.url), "utf8");
  assert.doesNotMatch(e2Source, /from ["']\.\/fitnessState/);
  assert.doesNotMatch(e2Source, /from ["']\.\/fitnessRefinement/);
  assert.doesNotMatch(e2Source, /from ["']\.\/machines\/proform/);
  for (const file of ["workoutLogic.ts", "workoutPrescription.ts", "machines/proformSmartPower10.ts",
    "fitnessState.ts", "fitnessRefinement.ts"]) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /personalizedPrescriptionCharacterization/);
  }
  const before = shadow();
  const storedFitness = { ...fitness(), passiveAerobicObservation: { marker: "unchanged" } };
  const storage = memoryStorage({ fitness_state_v1: JSON.stringify(storedFitness) });
  const legacy = prescription();
  const machineTarget = machineHeartRateTargetFromResolved(legacy.phases[0]);
  const controllerInput = {
    machineId: "proform-smart-power-10", activity: "bike", phaseKind: "work", phaseId: "sustain",
    phaseElapsedSeconds: 90, phaseDurationSeconds: 180, workoutElapsedSeconds: 90,
    recentHeartRates: Array.from({ length: 11 }, (_, index) => ({ elapsedSeconds: index, bpm: 110 })),
    ...machineTarget,
  };
  const guidanceBefore = getProFormSmartPower10Guidance(controllerInput, createMachineGuidanceState());
  fixture({ wattsAt: () => 500 });
  const after = shadow();
  const guidanceAfter = getProFormSmartPower10Guidance(controllerInput, createMachineGuidanceState());
  assert.deepEqual(after, before);
  assert.deepEqual(machineTarget, { targetHeartRateMin: 115, targetHeartRateMax: 130 });
  assert.deepEqual(guidanceAfter, guidanceBefore);
  assert.equal(storage.getItem("fitness_state_v1"), JSON.stringify(storedFitness));
});

test("history round-trips valid E1 plus E2 and drops malformed E2 independently", async () => {
  await resetWorkoutStorageForTests();
  const { characterization, e1, response } = fixture();
  const base = {
    external_session_id: SESSION,
    athlete_id: ATHLETE,
    startedAt: RESOLVED_AT,
    endedAt: CREATED_AT,
    category: "cardio",
    intent: "aerobic_base",
    duration_minutes: 3,
    primary_zone: 2,
    stress_profile: "low",
    zone_minutes: { z1: 0, z2: 3, z3: 0, z4: 0, z5: 0 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    day: "Tuesday",
    activity: "bike",
    shadow_prescription_evaluation: e1,
    shadow_prescription_characterization: characterization,
    workout_response: response,
  };
  assert.equal(await storeWorkoutSummary(base), true);
  assert.equal(await storeWorkoutSummary({
    ...base,
    external_session_id: "e2-e1-only",
    workout_response: undefined,
    shadow_prescription_characterization: undefined,
  }), true);
  assert.equal(await storeWorkoutSummary({
    ...base,
    external_session_id: "e2-legacy-none",
    workout_response: undefined,
    shadow_prescription_evaluation: undefined,
    shadow_prescription_characterization: undefined,
  }), true);
  const malformed = clone(characterization);
  malformed.phases[0].candidatePower.maxWatts += 1;
  assert.equal(await storeWorkoutSummary({ ...base, external_session_id: "e2-malformed",
    shadow_prescription_characterization: { ...malformed, workoutSessionId: "e2-malformed" } }), true);
  globalThis.localStorage = memoryStorage({
    fitness_state_v1: JSON.stringify(fitness("measured_watts", { interceptBpm: 5 })),
  });
  const history = await getAllWorkoutSummaries();
  const valid = history.find((row) => row.summary.external_session_id === SESSION).summary;
  const invalid = history.find((row) => row.summary.external_session_id === "e2-malformed").summary;
  const e1Only = history.find((row) => row.summary.external_session_id === "e2-e1-only").summary;
  const legacy = history.find((row) => row.summary.external_session_id === "e2-legacy-none").summary;
  assert.deepEqual(valid.shadow_prescription_characterization, characterization);
  assert.deepEqual(valid.shadow_prescription_evaluation, e1);
  assert.equal(invalid.shadow_prescription_characterization, undefined);
  assert.deepEqual(invalid.shadow_prescription_evaluation, e1);
  assert.deepEqual(e1Only.shadow_prescription_evaluation, e1);
  assert.equal(e1Only.shadow_prescription_characterization, undefined);
  assert.equal(legacy.shadow_prescription_evaluation, undefined);
  assert.equal(legacy.shadow_prescription_characterization, undefined);
});

test("ordinary workout finalization creates the E2 summary record deterministically once", async () => {
  await resetWorkoutStorageForTests();
  const bikeWorkoutData = clone(rawWorkoutData);
  bikeWorkoutData.weekly_plan.find((workout) => workout.day === "Tuesday").activities = ["bike"];
  transformWorkoutData(parseWorkoutTemplateDocument(bikeWorkoutData), Date.parse(RESOLVED_AT));
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  globalThis.window = { getWorkoutMetadata: () => ({ Tuesday: { intent: "aerobic_base", activities: ["bike"] } }) };
  const e1 = shadow();
  startSession("Tuesday", Date.parse(RESOLVED_AT), SESSION, "bike", storage, {
    blocks: { warm: 0, sustain: 3, cool: 0 },
    hrTargets: null,
    resolvedPrescription: prescription(),
    shadowPrescriptionEvaluation: e1,
  }, { athleteId: ATHLETE, profileSchemaVersion: 1, fitnessStateSchemaVersion: 1,
    fitnessUpdatedAt: "2026-09-01T00:01:00.000Z" });
  for (let second = 0; second < 180; second += 1) {
    await storeHrSample(SESSION, second, second < 30 ? 105 : 120);
    await storeOrdinaryBikeTelemetrySample(bikeSample(second, 125));
  }
  const first = await generateWorkoutSummary(SESSION, Date.parse(RESOLVED_AT), Date.parse(CREATED_AT), "Tuesday");
  const second = await generateWorkoutSummary(SESSION, Date.parse(RESOLVED_AT), Date.parse(CREATED_AT), "Tuesday");
  assert.ok(first.shadow_prescription_characterization);
  assert.deepEqual(second.shadow_prescription_characterization, first.shadow_prescription_characterization);
  assert.deepEqual(first.shadow_prescription_characterization.sourceShadow.resolvedAt, e1.resolvedAt);
  assert.equal(first.app_version, APP_VERSION);

  first.machine_id = "proform-smart-power-10";
  first.machine_profile_version = 1;
  assert.equal(await storeWorkoutSummary(first), true);
  globalThis.localStorage = memoryStorage({
    fitness_state_v1: JSON.stringify(fitness("measured_watts", { interceptBpm: 5 })),
  });
  const reloadedHistory = await getAllWorkoutSummaries();
  const records = extractTrustedPersonalizationCharacterizations(reloadedHistory, ATHLETE);
  const model = buildPersonalizationDiagnosticsModel(
    records,
    undefined,
    extractTrustedPersonalizationAssessmentContexts(reloadedHistory, ATHLETE),
    extractTrustedPersonalizationWorkoutContexts(reloadedHistory, ATHLETE)
  );
  const exported = createPersonalizationDiagnosticsExport(model);
  assert.equal(records.length, 1);
  assert.equal(model.evidenceCollectionSummary.completedWorkoutsWithE2, 1);
  assert.equal(model.evidenceCollectionSummary.measuredToMeasuredObservations, 1);
  assert.deepEqual(exported.characterizationRecords, records);
  assert.equal(exported.diagnosticRows[0].workoutContext.appVersion, APP_VERSION);
  assert.equal(exported.diagnosticRows[0].workoutContext.machineId, "proform-smart-power-10");
});

test("persisted E2 evidence from multiple sessions accumulates and reloads without overwriting", async () => {
  await resetWorkoutStorageForTests();
  const { characterization, e1, response } = fixture();
  const summaryFor = (sessionId, startedAt) => {
    const linkedResponse = { ...clone(response), sessionId };
    const linkedCharacterization = { ...clone(characterization), workoutSessionId: sessionId };
    return {
      external_session_id: sessionId,
      app_version: APP_VERSION,
      athlete_id: ATHLETE,
      startedAt,
      endedAt: CREATED_AT,
      category: "cardio",
      intent: "aerobic_base",
      duration_minutes: 3,
      primary_zone: 2,
      stress_profile: "low",
      zone_minutes: { z1: 0, z2: 3, z3: 0, z4: 0, z5: 0 },
      hr_trace: { sampling_interval_seconds: 60, samples: [] },
      day: "Tuesday",
      activity: "bike",
      shadow_prescription_evaluation: clone(e1),
      shadow_prescription_characterization: linkedCharacterization,
      workout_response: linkedResponse,
    };
  };
  assert.equal(await storeWorkoutSummary(summaryFor("e2-session-one", "2026-09-20T11:00:00.000Z")), true);
  assert.equal(await storeWorkoutSummary(summaryFor("e2-session-two", "2026-09-20T12:00:00.000Z")), true);

  const history = await getAllWorkoutSummaries();
  const records = extractTrustedPersonalizationCharacterizations(history, ATHLETE);
  const exported = createPersonalizationDiagnosticsExport(buildPersonalizationDiagnosticsModel(records));
  assert.deepEqual(new Set(records.map((record) => record.workoutSessionId)),
    new Set(["e2-session-one", "e2-session-two"]));
  assert.equal(exported.aggregate.workoutCount, 2);
  assert.equal(exported.characterizationRecords.length, 2);
});

test("SISU payload explicitly strips E1 and E2 diagnostics", () => {
  const { characterization, e1 } = fixture();
  const payload = buildSisuWorkoutPayload({
    external_session_id: SESSION,
    app_version: APP_VERSION,
    shadow_prescription_evaluation: e1,
    shadow_prescription_characterization: characterization,
  });
  assert.equal("app_version" in payload, false);
  assert.equal("shadow_prescription_evaluation" in payload, false);
  assert.equal("shadow_prescription_characterization" in payload, false);
});
