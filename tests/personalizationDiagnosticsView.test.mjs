import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS,
  buildPersonalizationDiagnosticsModel,
  createPersonalizationDiagnosticsExport,
  extractTrustedPersonalizationAssessmentContexts,
  extractTrustedPersonalizationCharacterizations,
  extractTrustedPersonalizationWorkoutContexts,
  personalizationDiagnosticDetailHtml,
  personalizationDiagnosticsExportJson,
  personalizationDiagnosticsHtml,
  summarizePersonalizationEvidenceCollection,
} from "../dist/personalizationDiagnosticsView.js";

function phase(overrides = {}) {
  return {
    phaseId: "sustain",
    kind: "work",
    intensityId: "aerobic_base",
    detailName: "Aerobic Base",
    activeStartSec: 0,
    activeEndSec: 180,
    shadowOutcome: "candidate",
    legacyHeartRate: { min: 115, max: 130 },
    candidatePower: { minWatts: 110, maxWatts: 140 },
    evidenceCoverage: {
      plannedDurationSec: 180, observedDurationSec: 180, hrCoveredSeconds: 180,
      powerCoveredSeconds: 180, jointCoveredSeconds: 180,
      hrCoverageRatio: 1, powerCoverageRatio: 1, jointCoverageRatio: 1,
    },
    observedHeartRate: {
      sampleCount: 180, meanBpm: 124, medianBpm: 124, minBpm: 112, maxBpm: 133,
      belowBandSeconds: 15, insideBandSeconds: 150, aboveBandSeconds: 15,
      insideBandRatio: 150 / 180, earlyWindowMedianBpm: 121, lateWindowMedianBpm: 128,
      heartRateChangeLateVsEarlyBpm: 7,
    },
    observedPowerProvenance: "measured_watts",
    observedPower: {
      provenance: "measured_watts", sampleCount: 180, medianWatts: 125,
      q1Watts: 120, q3Watts: 130, minWatts: 105, maxWatts: 145,
      belowCandidateSeconds: 10, insideCandidateSeconds: 160, aboveCandidateSeconds: 10,
      insideCandidateRatio: 160 / 180,
    },
    stableInBandWorkload: {
      sampleCount: 120, medianWatts: 125, q1Watts: 120, q3Watts: 130,
      minWatts: 115, maxWatts: 135,
    },
    controllerContext: {
      available: true,
      observed: { coveredSeconds: 180, lowerBoundSeconds: 0, upperBoundSeconds: 0 },
      desired: { coveredSeconds: 180, lowerBoundSeconds: 0, upperBoundSeconds: 0 },
      commanded: { coveredSeconds: 180, lowerBoundSeconds: 0, upperBoundSeconds: 0 },
      anyBoundarySaturationSeconds: 0, saturationRatio: 0,
      lowerBoundaryDecisionCount: 0, upperBoundaryDecisionCount: 0,
    },
    candidateDomainMargins: {
      heartRateToLowerBoundaryBpm: 2, heartRateToUpperBoundaryBpm: 8,
      wattsToLowerBoundary: 10, wattsToUpperBoundary: 10, bucket: "edge",
    },
    comparison: {
      candidateMidpointWatts: 125, observedInBandMedianWatts: 125,
      signedDifferenceWatts: 0, absoluteDifferenceWatts: 0, signedDifferencePercent: 0,
      candidateContainsObservedMedian: true, candidateObservedOverlapWatts: 10,
      candidateObservedOverlapRatio: 1, agreement: "inside_candidate",
    },
    characterizationOutcome: "characterized",
    ...overrides,
  };
}

function record(id = "session-a", overrides = {}) {
  return {
    schemaVersion: 1,
    characterizer: { id: "personalized-prescription-characterization", version: 1 },
    mode: "diagnostic",
    activationEligible: false,
    sourceShadow: {
      resolverId: "personalized-prescription-shadow", resolverVersion: 1,
      shadowSchemaVersion: 1, resolvedAt: "2026-09-20T12:00:00.000Z",
    },
    athleteId: "athlete-a",
    workoutSessionId: id,
    workoutSelector: "Monday",
    workoutIntent: "Aerobic Base",
    activity: "bike",
    formalAssessmentQuality: "high",
    calibrationWorkloadProvenance: "measured_watts",
    policy: {
      id: "e2-characterization-policy", version: 1, minObservedPhaseDurationSec: 60,
      minHrCoverageRatio: 0.75, minPowerCoverageRatio: 0.75, minJointCoverageRatio: 0.65,
      settlingSeconds: 30, minSettledInBandSeconds: 15, heartRateChangeWindowSeconds: 60,
      minHeartRateChangeWindowSamples: 30, domainEdgeFraction: 0.1,
    },
    phases: [phase()],
    createdAt: "2026-09-20T12:30:00.000Z",
    ...overrides,
  };
}

function evaluation(overrides = {}) {
  return { athleteId: "athlete-a", workoutSelector: "Monday", activity: "bike", activationEligible: false, ...overrides };
}

function historyRow(characterization = record(), overrides = {}) {
  return { summary: {
    athlete_id: "athlete-a", external_session_id: characterization.workoutSessionId,
    day: "Monday", activity: "bike", shadow_prescription_evaluation: evaluation(),
    shadow_prescription_characterization: characterization, ...overrides,
  } };
}

test("diagnostic extraction accepts only owner/session/selector-linked E1 plus E2 from trusted history", () => {
  const valid = record();
  const history = [
    historyRow(valid),
    historyRow(record("e1-only"), { shadow_prescription_characterization: undefined }),
    historyRow(record("wrong-owner", { athleteId: "athlete-b" })),
    historyRow(record("wrong-session"), { external_session_id: "different-session" }),
    historyRow(record("wrong-selector"), { day: "Tuesday" }),
    { summary: { athlete_id: "athlete-a", external_session_id: "legacy", day: "Monday", activity: "bike" } },
  ];
  assert.deepEqual(extractTrustedPersonalizationCharacterizations(history, "athlete-a"), [valid]);
});

test("detail context comes from the frozen trusted E1 snapshot, never current FitnessState", () => {
  const characterization = record();
  const frozenEvaluation = evaluation({
    fitnessEvidenceSnapshot: {
      metricObservedAt: "2026-09-18T14:30:00.000Z",
      quality: "high",
      calibration: {
        workloadProvenance: "measured_watts",
        observedMinWatts: 100,
        observedMaxWatts: 150,
        points: [
          { heartRateBpm: 120 },
          { heartRateBpm: 140 },
        ],
      },
    },
  });
  const history = [historyRow(characterization, { shadow_prescription_evaluation: frozenEvaluation })];
  const contexts = extractTrustedPersonalizationAssessmentContexts(history, "athlete-a");
  const model = buildPersonalizationDiagnosticsModel(
    [characterization],
    EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS,
    contexts
  );
  assert.deepEqual(model.rows[0].assessmentContext, {
    observedAt: "2026-09-18T14:30:00.000Z",
    quality: "high",
    calibrationProvenance: "measured_watts",
    observedMinHeartRateBpm: 120,
    observedMaxHeartRateBpm: 140,
    observedMinWatts: 100,
    observedMaxWatts: 150,
  });
  assert.match(personalizationDiagnosticDetailHtml(model.rows[0]), /100–150 W/);
});

test("diagnostics expose persisted machine, app, schema, and assessment identity without inventing missing values", () => {
  const characterization = record();
  const frozenEvaluation = evaluation({
    schemaVersion: 1,
    fitnessEvidenceSnapshot: {
      fitnessStateSchemaVersion: 3,
      metricObservedAt: "2026-09-18T14:30:00.000Z",
      quality: "high",
      algorithm: { id: "bike-submax-linear-hr-workload", version: 1 },
      evidenceSessionIds: ["formal-session-a"],
      calibration: {
        workloadProvenance: "measured_watts",
        observedMinWatts: 100,
        observedMaxWatts: 150,
        protocol: { id: "bike-submax-70rpm", version: 1 },
        points: [{ heartRateBpm: 120 }, { heartRateBpm: 140 }],
      },
    },
  });
  const history = [historyRow(characterization, {
    app_version: "0.9.11",
    machine_id: "proform-smart-power-10",
    machine_profile_version: 1,
    resolved_prescription: { schemaVersion: 1 },
    shadow_prescription_evaluation: frozenEvaluation,
  })];
  const assessmentContexts = extractTrustedPersonalizationAssessmentContexts(history, "athlete-a");
  const workoutContexts = extractTrustedPersonalizationWorkoutContexts(history, "athlete-a");
  const model = buildPersonalizationDiagnosticsModel(
    [characterization], EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS, assessmentContexts, workoutContexts
  );
  assert.deepEqual(workoutContexts["session-a"], {
    appVersion: "0.9.11",
    machineId: "proform-smart-power-10",
    machineProfileVersion: 1,
    activePrescriptionSchemaVersion: 1,
    shadowSchemaVersion: 1,
    characterizationSchemaVersion: 1,
  });
  assert.deepEqual(assessmentContexts["session-a"].evidenceSessionIds, ["formal-session-a"]);
  assert.match(personalizationDiagnosticDetailHtml(model.rows[0]), /bike-submax-linear-hr-workload@1/);
  assert.equal(createPersonalizationDiagnosticsExport(model).diagnosticRows[0].workoutContext.appVersion, "0.9.11");

  const historical = extractTrustedPersonalizationWorkoutContexts([historyRow(characterization)], "athlete-a");
  assert.equal(historical["session-a"].appVersion, null);
  assert.equal(historical["session-a"].machineId, null);
});

test("all-record evidence summary distinguishes readiness cohorts, intents, domains, exclusions, and determinate saturation", () => {
  const measured = record("measured", { workoutIntent: "aerobic_base" });
  const calibrated = record("calibrated", {
    workoutIntent: "aerobic_volume",
    calibrationWorkloadProvenance: "calibrated_at_verified_cadence",
    phases: [phase({
      observedPowerProvenance: "calibrated_watts",
      observedPower: { ...phase().observedPower, provenance: "calibrated_watts" },
      candidateDomainMargins: { ...phase().candidateDomainMargins, bucket: "interior" },
      controllerContext: {
        ...phase().controllerContext,
        anyBoundarySaturationSeconds: 10,
        saturationRatio: 10 / 180,
        upperBoundaryDecisionCount: 1,
      },
    })],
  });
  const excluded = record("excluded", {
    workoutIntent: "threshold",
    phases: [phase({
      shadowOutcome: "fallback",
      candidatePower: undefined,
      comparison: undefined,
      characterizationOutcome: "not_candidate",
      exclusionReason: "phase_evidence_unavailable",
    })],
  });
  const summary = summarizePersonalizationEvidenceCollection([measured, calibrated, excluded]);
  assert.deepEqual(summary, {
    completedWorkoutsWithE2: 3,
    candidatePhases: 2,
    evaluableCandidatePhases: 2,
    measuredToMeasuredObservations: 1,
    cadenceCalibratedObservations: 1,
    aerobicBaseCandidatePhases: 1,
    aerobicVolumeCandidatePhases: 1,
    interiorCandidatePhases: 1,
    edgeCandidatePhases: 1,
    saturatedCandidatePhases: 1,
    saturationDeterminateCandidatePhases: 2,
    saturationIncidence: 0.5,
    exclusionCounts: {
      phase_too_short: 0,
      missing_telemetry: 0,
      insufficient_hr_coverage: 0,
      insufficient_power_coverage: 0,
      insufficient_joint_coverage: 0,
      insufficient_settled_in_band_evidence: 0,
      unsupported_power_provenance: 0,
      phase_evidence_unavailable: 1,
    },
  });
  const html = personalizationDiagnosticsHtml(buildPersonalizationDiagnosticsModel([measured, calibrated, excluded]));
  assert.match(html, /All persisted E2 evidence/);
  assert.match(html, /Measured → measured observations/);
  assert.match(html, /Aerobic-volume candidate phases/);
  assert.match(html, /Saturated \/ saturation-determinate candidates/);
});

test("diagnostics preserve measured and cadence-calibrated cohorts rather than pooling them", () => {
  const calibrated = record("session-b", {
    calibrationWorkloadProvenance: "calibrated_at_verified_cadence",
    phases: [phase({ observedPowerProvenance: "calibrated_watts", observedPower: {
      ...phase().observedPower, provenance: "calibrated_watts",
    } })],
  });
  const model = buildPersonalizationDiagnosticsModel([record(), calibrated]);
  assert.equal(model.aggregate.workoutCount, 2);
  assert.equal(model.aggregate.groups.length, 2);
  assert.deepEqual(new Set(model.aggregate.groups.map((group) => group.calibrationWorkloadProvenance)),
    new Set(["measured_watts", "calibrated_at_verified_cadence"]));
  assert.deepEqual(new Set(model.aggregate.groups.map((group) => group.observedPowerProvenance)),
    new Set(["measured_watts", "calibrated_watts"]));
});

test("all six cohort filters affect only visible phases and visible aggregates", () => {
  const alternate = record("session-b", {
    workoutIntent: "Threshold", formalAssessmentQuality: "moderate",
    calibrationWorkloadProvenance: "calibrated_at_verified_cadence",
    phases: [phase({
      intensityId: "threshold", observedPowerProvenance: "calibrated_watts",
      candidateDomainMargins: { ...phase().candidateDomainMargins, bucket: "interior" },
    })],
  });
  const records = [record(), alternate];
  const before = structuredClone(records);
  const filters = [
    ["workoutIntent", "Threshold"], ["intensity", "threshold"],
    ["calibrationProvenance", "calibrated_at_verified_cadence"],
    ["observedPowerProvenance", "calibrated_watts"], ["assessmentQuality", "moderate"],
    ["domainBucket", "interior"],
  ];
  for (const [key, value] of filters) {
    const model = buildPersonalizationDiagnosticsModel(records, {
      ...EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS, [key]: value,
    });
    assert.equal(model.aggregate.workoutCount, 1, `${key} filter`);
    assert.equal(model.rows.length, 1, `${key} rows`);
    assert.equal(model.rows[0].record.workoutSessionId, "session-b", `${key} record`);
    assert.equal(model.evidenceCollectionSummary.completedWorkoutsWithE2, 2, `${key} all-evidence count`);
  }
  assert.deepEqual(records, before);
  const unfiltered = buildPersonalizationDiagnosticsModel(records);
  assert.equal(createPersonalizationDiagnosticsExport(unfiltered).characterizationRecords.length, 2);
});

test("insufficient evidence remains visible with its exclusion count and no invented comparison", () => {
  const excludedPhase = phase({
    evidenceCoverage: { ...phase().evidenceCoverage, powerCoveredSeconds: 72, jointCoveredSeconds: 72, powerCoverageRatio: 0.4, jointCoverageRatio: 0.4 },
    stableInBandWorkload: undefined, comparison: undefined,
    characterizationOutcome: "insufficient_evidence", exclusionReason: "insufficient_power_coverage",
  });
  const model = buildPersonalizationDiagnosticsModel([record("excluded", { phases: [excludedPhase] })]);
  assert.equal(model.aggregate.candidatePhases, 1);
  assert.equal(model.aggregate.evaluableCandidatePhases, 0);
  assert.equal(model.exclusionCounts.insufficient_power_coverage, 1);
  assert.equal(model.rows[0].deltaWatts, null);
  assert.match(personalizationDiagnosticsHtml(model), /Insufficient power coverage/);
});

test("presentation makes candidate non-control semantics, domain, saturation, and descriptive HR change explicit", () => {
  const model = buildPersonalizationDiagnosticsModel([record()]);
  const html = personalizationDiagnosticsHtml(model);
  const detail = personalizationDiagnosticDetailHtml(model.rows[0]);
  assert.match(html, /Candidate watts/);
  assert.match(html, /Observed in-band/);
  assert.match(detail, /Assessment domain/);
  assert.match(detail, /Edge/);
  assert.match(detail, /Late vs early HR/);
  assert.match(detail, /\+7 bpm/);
  assert.match(detail, /Controller saturation/);
  assert.doesNotMatch(`${html}${detail}`, /cardiovascular drift|fatigue|dehydration|ready to activate|personalization validated/i);
});

test("empty history renders an explanatory no-data state and clean zero aggregate", () => {
  const model = buildPersonalizationDiagnosticsModel([]);
  assert.equal(model.aggregate.workoutCount, 0);
  assert.equal(model.rows.length, 0);
  assert.match(personalizationDiagnosticsHtml(model), /No personalization characterization data yet/);
});

test("diagnostic export is deterministic, provenance-preserving, and excludes profile and raw telemetry", () => {
  const model = buildPersonalizationDiagnosticsModel([record()]);
  const before = structuredClone(model.records);
  const first = personalizationDiagnosticsExportJson(model);
  assert.equal(first, personalizationDiagnosticsExportJson(model));
  assert.deepEqual(model.records, before);
  const exported = createPersonalizationDiagnosticsExport(model);
  assert.equal(exported.characterizationRecords[0].calibrationWorkloadProvenance, "measured_watts");
  assert.equal(exported.characterizationRecords[0].phases[0].candidatePower.minWatts, 110);
  assert.equal(exported.characterizationRecords[0].phases[0].evidenceCoverage.jointCoverageRatio, 1);
  assert.equal(exported.characterizationRecords[0].phases[0].stableInBandWorkload.medianWatts, 125);
  assert.equal(exported.characterizationRecords[0].phases[0].comparison.absoluteDifferenceWatts, 0);
  assert.equal(exported.characterizationRecords[0].phases[0].candidateDomainMargins.bucket, "edge");
  assert.equal(exported.characterizationRecords[0].phases[0].controllerContext.saturationRatio, 0);
  assert.equal(first.includes("hr_trace"), false);
  assert.equal(first.includes("demographics"), false);
  assert.equal(first.includes("FitnessState"), false);
});

test("E3 presentation has no import path into prescription, machine control, fitness, passive refinement, or SISU", async () => {
  const diagnosticsSource = await readFile(new URL("../src/personalizationDiagnosticsView.ts", import.meta.url), "utf8");
  const statusSource = await readFile(new URL("../src/personalizationStatus.ts", import.meta.url), "utf8");
  const uiSource = await readFile(new URL("../src/uiControls.ts", import.meta.url), "utf8");
  assert.doesNotMatch(diagnosticsSource, /from ["']\.\/(?:workoutPrescription|bikeBridge|fitnessState|fitnessRefinement|sisuSync)|indexedDB|parsePersonalizedPrescription/);
  assert.doesNotMatch(statusSource, /personalizedPrescription|workoutPrescription|bikeBridge|fitnessRefinement|sisuSync/);
  assert.match(uiSource, /getAllWorkoutSummaries\(\)[\s\S]*extractTrustedPersonalizationCharacterizations/);
  assert.match(uiSource, /exportPersonalizationDiagnostics\(\)[\s\S]*EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS/);
  assert.doesNotMatch(uiSource, /parsePersonalizedPrescriptionCharacterization/);
});

test("UI markup identifies diagnostics as developer-only and keeps normal history wording restrained", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const uiSource = await readFile(new URL("../src/uiControls.ts", import.meta.url), "utf8");
  assert.match(html, /Personalization diagnostics/);
  assert.match(html, /Candidate watts are experimental predictions[^<]+They did not control the workout/);
  assert.match(html, /Observed in-band watts represent settled workload while heart rate was within the legacy target range/);
  assert.match(uiSource, /Personalization evaluation recorded/);
  assert.doesNotMatch(uiSource, /Your personalized target was/);
});
