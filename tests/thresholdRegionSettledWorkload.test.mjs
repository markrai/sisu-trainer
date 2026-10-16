import test from "node:test";
import assert from "node:assert/strict";

import {
  THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1,
  THRESHOLD_REGION_ORDINARY_WORKOUT_SHADOW_RESOLVER_ID_V1,
  THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1,
  evaluateThresholdRegionSettledWorkloadContract,
  segmentControllerHeldResistance,
  thresholdRegionSettledPolicyIsProductionReady,
} from "../dist/thresholdRegionSettledWorkload.js";
import { PHASE_E2_HELD_WORKLOAD_POLICY_V1 } from "../dist/personalizedPrescriptionCharacterization.js";
import { PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1 } from "../dist/types.js";

const ATHLETE = "afa677b3-9682-4fb9-8f7d-af77375975d7";
const SESSION = "6f4612a2-fe0e-4976-9444-8dc1df81c141";
const ANCHOR = "2026-10-11T18:18:38.106Z";
const ENDED = "2026-10-16T14:59:14.030Z";
const BASE = Date.parse("2026-10-16T14:29:48.416Z");

function isoAtActiveSec(activeSec) {
  return new Date(BASE + activeSec * 1000).toISOString();
}

function bikeSample(activeSec, {
  resistance,
  watts,
  wattsSource = "measured_watts",
  cadence = 67,
  availability = "fresh",
  observedResistance,
  desiredResistance,
  commandedResistance,
} = {}) {
  const held = resistance;
  const sample = {
    schemaVersion: 1,
    athleteId: ATHLETE,
    sessionId: SESSION,
    activeSec,
    observedAt: isoAtActiveSec(activeSec),
    availability,
  };
  const obs = observedResistance ?? held;
  if (obs != null) {
    sample.observedResistance = { value: obs, source: "observed", freshnessMs: 0 };
  }
  const desired = desiredResistance ?? held;
  if (desired != null) sample.desiredResistance = desired;
  const commanded = commandedResistance ?? held;
  if (commanded != null) sample.commandedResistance = commanded;
  if (watts != null) {
    sample.watts = { value: watts, source: wattsSource, freshnessMs: 0 };
  }
  if (cadence != null) {
    sample.cadenceRpm = { value: cadence, source: "measured", freshnessMs: 0 };
  }
  return sample;
}

function holdAudit(elapsedSeconds, resistance = 10, representativeHeartRate = 159, extras = {}) {
  return {
    version: 1,
    kind: "evaluation",
    elapsedSeconds,
    phaseKind: "work",
    phaseId: "sustain",
    phaseElapsedSeconds: elapsedSeconds - 600,
    phaseDurationSeconds: 1200,
    representativeHeartRate,
    resistanceBefore: resistance,
    resistanceAfter: resistance,
    heartRateAssessment: "target",
    decision: "hold",
    decisionReason: "within_target_policy",
    evaluationKind: "after_hold",
    constraint: "target_hold",
    targetHeartRateMin: 155,
    targetHeartRateMax: 162,
    ...extras,
  };
}

/**
 * SYNTHETIC dense fixture (every-second telemetry). Useful for gate logic, but
 * NOT an Oct 16 replay — real bike telemetry is intermittent.
 */
function syntheticDenseHoldFixture(overrides = {}) {
  const hrByActiveSec = new Map();
  const bikeSamples = [];
  for (let sec = 600; sec < 900; sec++) {
    const r = sec < 700 ? 8 : sec < 800 ? 9 : 11;
    hrByActiveSec.set(sec, 130 + Math.floor((sec - 600) / 20));
    bikeSamples.push(bikeSample(sec, { resistance: r, watts: 90 + (r - 8) * 8 }));
  }
  for (let sec = 900; sec < 990; sec++) {
    hrByActiveSec.set(sec, 165);
    bikeSamples.push(bikeSample(sec, { resistance: 12, watts: 140 }));
  }
  for (let sec = 990; sec < 1050; sec++) {
    hrByActiveSec.set(sec, 162);
    bikeSamples.push(bikeSample(sec, { resistance: 11, watts: 125 }));
  }
  for (let sec = 1050; sec < 1417; sec++) {
    const hr = sec < 1170 ? 158 : sec < 1300 ? 160 : 157;
    hrByActiveSec.set(sec, hr);
    const watts = sec % 47 === 0 ? 57 : 110 + (sec % 5);
    bikeSamples.push(bikeSample(sec, { resistance: 10, watts, cadence: 66 + (sec % 3) }));
  }

  const audit = [
    holdAudit(1110, 10, 162),
    holdAudit(1170, 10, 159),
    holdAudit(1230, 10, 159),
    holdAudit(1290, 10, 160),
    holdAudit(1350, 10, 157),
    holdAudit(1410, 10, 157),
  ];

  return {
    expectedAthleteId: ATHLETE,
    sessionId: SESSION,
    athleteId: ATHLETE,
    activity: "bike",
    intent: "threshold",
    intensityId: "threshold",
    machineId: "proform-smart-power-10",
    machineProfileVersion: 1,
    formalAnchorObservedAt: ANCHOR,
    sessionEndedAt: ENDED,
    workActiveStartSec: 600,
    workActiveEndSecExclusive: 1417,
    targetHrMin: 155,
    targetHrMax: 162,
    hrByActiveSec,
    bikeSamples,
    machineDecisionAudit: audit,
    ...overrides,
  };
}

/**
 * Real-gap-shaped fixture: sustained controller hold at R10 with intermittent
 * bike rows (gaps of 2–4 s like Oct 16), observed resistance consistent when
 * present, HR largely 155–162, fresh measured watts at realistic coverage.
 * Preserves the gap pattern that previously fragmented segmentStableResistance.
 */
function oct16RealGapShapedFixture(overrides = {}) {
  const hrByActiveSec = new Map();
  const bikeSamples = [];

  // Dense ramp / overshoot / correction (pre-hold) — synthetic preamble.
  for (let sec = 600; sec < 1050; sec++) {
    const r = sec < 750 ? 8 : sec < 870 ? 11 : sec < 990 ? 12 : 11;
    hrByActiveSec.set(sec, sec < 900 ? 145 : 165);
    bikeSamples.push(bikeSample(sec, { resistance: r, watts: 90 + r * 4 }));
  }

  // Contiguous commanded R10 hold 1050–1417 with intermittent telemetry.
  // First sample at 1050 mirrors real lag: commanded 10, observed still 11.
  bikeSamples.push(bikeSample(1050, {
    resistance: 10,
    observedResistance: 11,
    desiredResistance: 10,
    commandedResistance: 10,
    watts: 120,
  }));
  hrByActiveSec.set(1050, 164);

  // Gap pattern inspired by Oct 16 held R10 (1051–1417): mostly contiguous
  // samples with intermittent 2–3 s holes and a rare 4 s hole. Density stays
  // near the real ~0.83 measured-watt coverage — enough that the old
  // maxObservationGapSec=2 splitter would fragment the hold, but evidence
  // coverage still clears the resolved 0.80 gate.
  const presentSecs = [];
  let sec = 1051;
  let gapCycle = 0;
  while (sec <= 1417) {
    presentSecs.push(sec);
    gapCycle += 1;
    let step = 1;
    if (gapCycle % 11 === 0) step = 2;
    if (gapCycle % 29 === 0) step = 3;
    if (gapCycle % 97 === 0) step = 4;
    sec += step;
  }
  if (presentSecs[presentSecs.length - 1] !== 1417) presentSecs.push(1417);

  for (const activeSec of presentSecs) {
    const hr = activeSec < 1170 ? 158 : activeSec < 1300 ? 160 : 157;
    hrByActiveSec.set(activeSec, hr);
    // Fill HR on gap seconds too (HR stream is denser than bike in reality).
    const watts = activeSec % 47 === 0 ? 57 : 110 + (activeSec % 5);
    bikeSamples.push(bikeSample(activeSec, {
      resistance: 10,
      watts,
      cadence: 66 + (activeSec % 3),
    }));
  }
  for (let s = 1051; s <= 1417; s++) {
    if (!hrByActiveSec.has(s)) {
      hrByActiveSec.set(s, s < 1170 ? 158 : s < 1300 ? 160 : 157);
    }
  }

  const audit = [
    holdAudit(1110, 10, 162, { evaluationKind: "after_decrease" }),
    holdAudit(1170, 10, 159),
    holdAudit(1230, 10, 159),
    holdAudit(1290, 10, 160),
    holdAudit(1350, 10, 157),
    holdAudit(1410, 10, 157),
  ];

  return {
    expectedAthleteId: ATHLETE,
    sessionId: SESSION,
    athleteId: ATHLETE,
    activity: "bike",
    intent: "threshold",
    intensityId: "threshold",
    machineId: "proform-smart-power-10",
    machineProfileVersion: 1,
    formalAnchorObservedAt: ANCHOR,
    sessionEndedAt: ENDED,
    workActiveStartSec: 600,
    workActiveEndSecExclusive: 1418,
    targetHrMin: 155,
    targetHrMax: 162,
    hrByActiveSec,
    bikeSamples,
    machineDecisionAudit: audit,
    ...overrides,
  };
}

test("policy reuses E2 held-workload settling/gap floors and stays distinct from E1 resolver id", () => {
  assert.equal(
    THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1.settlingSeconds,
    PHASE_E2_HELD_WORKLOAD_POLICY_V1.settlingSeconds
  );
  assert.equal(
    THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1.maxObservationGapSec,
    PHASE_E2_HELD_WORKLOAD_POLICY_V1.maxObservationGapSec
  );
  assert.equal(
    THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1.minQualifyingSeconds,
    PHASE_E2_HELD_WORKLOAD_POLICY_V1.minQualifyingSeconds
  );
  assert.notEqual(
    THRESHOLD_REGION_ORDINARY_WORKOUT_SHADOW_RESOLVER_ID_V1,
    PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1
  );
  assert.equal(THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1, "ordinary_workout_settled_threshold_region");
  assert.equal(thresholdRegionSettledPolicyIsProductionReady(), false);
  assert.deepEqual(
    evaluateThresholdRegionSettledWorkloadContract(syntheticDenseHoldFixture()).unresolvedPolicyFields.sort(),
    ["maxMeasuredWattsMadRatio", "minAdviceGradeDurationSec", "minInBandFraction"].sort()
  );
});

test("synthetic dense fixture accepts settled hold under resolved gates and rejects ramp-only segments", () => {
  const result = evaluateThresholdRegionSettledWorkloadContract(syntheticDenseHoldFixture());
  assert.equal(result.identityFailures.length, 0);
  assert.ok(result.acceptedWindow, "expected a resolved-gate accepting window");
  assert.equal(result.acceptedWindow.windowStartSec, 1050);
  assert.equal(result.acceptedWindow.settledFromSec, 1170);
  assert.ok(result.acceptedWindow.postSettlingDurationSec >= 30);
  assert.ok(result.acceptedWindow.qualifyingSampleCount >= 30);
  assert.ok(result.acceptedWindow.hasTargetHoldCorroboration);
  assert.ok((result.acceptedWindow.hrInBandFraction ?? 0) >= 0.9);
  assert.ok((result.acceptedWindow.measuredWattsMedian ?? 0) > 100);
  assert.ok((result.acceptedWindow.measuredWattsMedian ?? 0) < 130);
  assert.equal(result.observation, null);
  assert.equal(result.policyProductionReady, false);

  const rampish = result.windows.filter((w) => w.windowStartSec < 1050);
  for (const window of rampish) {
    assert.equal(window.acceptsUnderResolvedGates, false);
  }
});

test("actual-gap-shaped sustained hold qualifies under resolved gates", () => {
  const result = evaluateThresholdRegionSettledWorkloadContract(oct16RealGapShapedFixture());
  assert.equal(result.identityFailures.length, 0);
  assert.ok(result.acceptedWindow, "gap-shaped hold should qualify under resolved gates");
  // Contaminated commanded-10 sample at 1050 (observed 11) is trimmed away.
  assert.equal(result.acceptedWindow.observedResistance, 10);
  assert.equal(result.acceptedWindow.windowStartSec, 1051);
  assert.equal(result.acceptedWindow.settledFromSec, 1171);
  assert.ok(result.acceptedWindow.postSettlingDurationSec >= 200);
  assert.ok(result.acceptedWindow.qualifyingSampleCount >= 30);
  assert.ok(result.acceptedWindow.measuredWattsCoverageRatio >= 0.8);
  assert.ok(result.acceptedWindow.hasTargetHoldCorroboration);
  // 1170 is before settledFrom (1171); corroboration uses post-settle holds only.
  assert.ok(result.acceptedWindow.matchingHoldAuditElapsedSeconds.includes(1230));
  assert.equal(result.observation, null);
});

test("telemetry gaps alone do not masquerade as resistance changes", () => {
  const samples = [];
  // Same commanded/observed resistance with 3-second holes — must stay one window.
  for (const sec of [100, 101, 104, 105, 108, 109, 112, 113, 116]) {
    samples.push(bikeSample(sec, { resistance: 10, watts: 114 }));
  }
  const windows = segmentControllerHeldResistance(samples, 100, 117);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].resistance, 10);
  assert.equal(windows[0].startSec, 100);
  assert.equal(windows[0].endSecInclusive, 116);
});

test("contradictory observed resistance rejects/splits the hold", () => {
  const samples = [
    bikeSample(100, { resistance: 10, watts: 114 }),
    bikeSample(101, { resistance: 10, watts: 114 }),
    bikeSample(102, { resistance: 10, observedResistance: 11, commandedResistance: 10, desiredResistance: 10, watts: 120 }),
    bikeSample(103, { resistance: 10, watts: 114 }),
    bikeSample(104, { resistance: 10, watts: 114 }),
  ];
  const windows = segmentControllerHeldResistance(samples, 100, 105);
  assert.equal(windows.length, 2);
  assert.deepEqual(
    windows.map((w) => ({ r: w.resistance, start: w.startSec, end: w.endSecInclusive })),
    [
      { r: 10, start: 100, end: 101 },
      { r: 10, start: 103, end: 104 },
    ]
  );
});

test("wrong-resistance audit hold cannot corroborate a window", () => {
  const input = oct16RealGapShapedFixture({
    machineDecisionAudit: [
      holdAudit(1170, 12, 159), // wrong resistance
      holdAudit(1230, 9, 159),
    ],
  });
  const result = evaluateThresholdRegionSettledWorkloadContract(input);
  const holdWindow = result.windows.find((w) => w.observedResistance === 10 && w.windowStartSec === 1051);
  assert.ok(holdWindow);
  assert.equal(holdWindow.hasTargetHoldCorroboration, false);
  assert.ok(holdWindow.resolvedGateFailures.includes("missing_target_hold_corroboration"));
  assert.equal(result.acceptedWindow, null);
});

test("correct-resistance target hold can corroborate it", () => {
  const input = oct16RealGapShapedFixture({
    machineDecisionAudit: [holdAudit(1230, 10, 159)],
  });
  const result = evaluateThresholdRegionSettledWorkloadContract(input);
  assert.ok(result.acceptedWindow);
  assert.equal(result.acceptedWindow.hasTargetHoldCorroboration, true);
  assert.deepEqual(result.acceptedWindow.matchingHoldAuditElapsedSeconds, [1230]);
});

test("contract does not hard-code resistance 10 — another held resistance can qualify", () => {
  const input = syntheticDenseHoldFixture();
  for (const sample of input.bikeSamples) {
    if (sample.activeSec >= 1050) {
      sample.observedResistance = { value: 7, source: "observed", freshnessMs: 0 };
      sample.desiredResistance = 7;
      sample.commandedResistance = 7;
    }
  }
  input.machineDecisionAudit = input.machineDecisionAudit.map((entry) => ({
    ...entry,
    resistanceBefore: 7,
    resistanceAfter: 7,
  }));
  const result = evaluateThresholdRegionSettledWorkloadContract(input);
  assert.ok(result.acceptedWindow);
  assert.equal(result.acceptedWindow.observedResistance, 7);
});

test("rejects brief target pass-through (short post-settling)", () => {
  const hrByActiveSec = new Map();
  const bikeSamples = [];
  for (let sec = 600; sec < 780; sec++) {
    hrByActiveSec.set(sec, 158);
    bikeSamples.push(bikeSample(sec, { resistance: 9, watts: 120 }));
  }
  for (let sec = 780; sec < 820; sec++) {
    hrByActiveSec.set(sec, 159);
    bikeSamples.push(bikeSample(sec, { resistance: 10, watts: 114 }));
  }
  const result = evaluateThresholdRegionSettledWorkloadContract({
    ...syntheticDenseHoldFixture(),
    workActiveEndSecExclusive: 820,
    hrByActiveSec,
    bikeSamples,
    machineDecisionAudit: [holdAudit(800)],
  });
  assert.equal(result.acceptedWindow, null);
  assert.ok(
    result.windows.every((w) =>
      w.resolvedGateFailures.includes("insufficient_post_settling_duration") ||
      w.resolvedGateFailures.includes("missing_target_hold_corroboration") ||
      w.resolvedGateFailures.length > 0
    )
  );
});

test("rejects stale/unavailable watts and calibrated-only workload", () => {
  const base = syntheticDenseHoldFixture();
  for (const sample of base.bikeSamples) {
    if (sample.activeSec >= 1170) sample.availability = "stale";
  }
  const stale = evaluateThresholdRegionSettledWorkloadContract(base);
  assert.equal(stale.acceptedWindow, null);

  const calibrated = syntheticDenseHoldFixture();
  for (const sample of calibrated.bikeSamples) {
    if (sample.activeSec >= 1050 && sample.watts) sample.watts.source = "calibrated_watts";
  }
  const cal = evaluateThresholdRegionSettledWorkloadContract(calibrated);
  assert.equal(cal.acceptedWindow, null);
  assert.ok(
    cal.windows.some((w) =>
      w.resolvedGateFailures.includes("non_measured_watt_provenance") ||
      w.resolvedGateFailures.includes("insufficient_measured_watt_coverage")
    )
  );
});

test("rejects athlete mismatch, machine provenance mismatch, and pre-anchor session", () => {
  assert.deepEqual(
    evaluateThresholdRegionSettledWorkloadContract(syntheticDenseHoldFixture({ athleteId: "other" })).identityFailures,
    ["athlete_mismatch"]
  );
  assert.ok(
    evaluateThresholdRegionSettledWorkloadContract(
      syntheticDenseHoldFixture({ machineId: undefined, machineProfileVersion: undefined })
    ).identityFailures.includes("missing_machine_provenance")
  );
  assert.ok(
    evaluateThresholdRegionSettledWorkloadContract(
      syntheticDenseHoldFixture({ sessionEndedAt: "2026-10-10T00:00:00.000Z" })
    ).identityFailures.includes("pre_formal_anchor")
  );
});

test("malformed session timestamp fails closed", () => {
  const result = evaluateThresholdRegionSettledWorkloadContract(
    syntheticDenseHoldFixture({ sessionEndedAt: "not-a-timestamp" })
  );
  assert.ok(result.identityFailures.includes("invalid_session_or_anchor_timestamp"));
  assert.equal(result.acceptedWindow, null);
});

test("malformed formal-anchor timestamp fails closed", () => {
  const result = evaluateThresholdRegionSettledWorkloadContract(
    syntheticDenseHoldFixture({ formalAnchorObservedAt: "yesterday" })
  );
  assert.ok(result.identityFailures.includes("invalid_session_or_anchor_timestamp"));
  assert.equal(result.acceptedWindow, null);
});

test("rejects missing target-hold corroboration and mostly out-of-band HR when occupancy gate is set", () => {
  const noHold = evaluateThresholdRegionSettledWorkloadContract(
    syntheticDenseHoldFixture({ machineDecisionAudit: [] })
  );
  assert.equal(noHold.acceptedWindow, null);
  assert.ok(
    noHold.windows.some((w) => w.resolvedGateFailures.includes("missing_target_hold_corroboration"))
  );

  const outOfBand = syntheticDenseHoldFixture({
    policy: {
      ...THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1,
      minInBandFraction: 0.8,
    },
  });
  for (const [sec, _hr] of outOfBand.hrByActiveSec) {
    if (sec >= 1170) outOfBand.hrByActiveSec.set(sec, 140);
  }
  const result = evaluateThresholdRegionSettledWorkloadContract(outOfBand);
  assert.equal(result.acceptedWindow, null);
  assert.ok(
    result.windows.some((w) => w.resolvedGateFailures.includes("insufficient_in_band_occupancy"))
  );
});

test("insufficient measured-watt coverage still rejects", () => {
  const input = oct16RealGapShapedFixture();
  // Drop most post-settle bike watts so coverage falls well below 0.80.
  input.bikeSamples = input.bikeSamples.filter((sample) => {
    if (sample.activeSec < 1171) return true;
    return sample.activeSec % 10 === 0;
  });
  const result = evaluateThresholdRegionSettledWorkloadContract(input);
  assert.equal(result.acceptedWindow, null);
  assert.ok(
    result.windows.some((w) =>
      w.observedResistance === 10 &&
      w.resolvedGateFailures.includes("insufficient_measured_watt_coverage")
    )
  );
});

test("large unsupported telemetry gap still rejects where evidence becomes inadequate", () => {
  const hrByActiveSec = new Map();
  const bikeSamples = [];
  // Controller holds R10 for a long elapsed span, but bike evidence only exists
  // in a thin band — coverage fails even though load continuity is intact.
  for (let sec = 600; sec < 900; sec++) {
    hrByActiveSec.set(sec, 158);
    if (sec < 620 || sec >= 880) {
      bikeSamples.push(bikeSample(sec, { resistance: 10, watts: 114 }));
    }
  }
  // Keep a couple of mid-hold samples so controller span still covers 600–899.
  bikeSamples.push(bikeSample(700, { resistance: 10, watts: 114 }));
  bikeSamples.push(bikeSample(800, { resistance: 10, watts: 114 }));
  bikeSamples.sort((a, b) => a.activeSec - b.activeSec);

  const result = evaluateThresholdRegionSettledWorkloadContract({
    ...syntheticDenseHoldFixture(),
    workActiveStartSec: 600,
    workActiveEndSecExclusive: 900,
    hrByActiveSec,
    bikeSamples,
    machineDecisionAudit: [holdAudit(780, 10, 158), holdAudit(840, 10, 158)],
  });
  assert.equal(result.acceptedWindow, null);
  const window = result.windows.find((w) => w.observedResistance === 10);
  assert.ok(window);
  assert.ok(window.windowStartSec === 600 && window.windowEndSecExclusive === 900);
  assert.ok(
    window.resolvedGateFailures.includes("insufficient_measured_watt_coverage") ||
      window.resolvedGateFailures.includes("insufficient_cadence_coverage") ||
      window.resolvedGateFailures.includes("insufficient_post_settling_duration")
  );
});

test("minQualifyingSeconds counts joint HR+watt samples, not merely elapsed span", () => {
  const hrByActiveSec = new Map();
  const bikeSamples = [];
  // Long elapsed post-settle span, but only 20 joint HR+watt seconds.
  for (let sec = 600; sec < 900; sec++) {
    hrByActiveSec.set(sec, 158);
  }
  for (let sec = 600; sec < 900; sec++) {
    if (sec < 720 || sec % 9 === 0) {
      bikeSamples.push(bikeSample(sec, { resistance: 10, watts: 114 }));
    } else if (sec === 899) {
      bikeSamples.push(bikeSample(sec, { resistance: 10, watts: 114 }));
    }
  }
  // Ensure controller endpoints exist
  if (!bikeSamples.some((s) => s.activeSec === 600)) {
    bikeSamples.push(bikeSample(600, { resistance: 10, watts: 114 }));
  }
  bikeSamples.sort((a, b) => a.activeSec - b.activeSec);

  const result = evaluateThresholdRegionSettledWorkloadContract({
    ...syntheticDenseHoldFixture(),
    workActiveStartSec: 600,
    workActiveEndSecExclusive: 900,
    hrByActiveSec,
    bikeSamples,
    machineDecisionAudit: [holdAudit(780, 10, 158)],
    policy: {
      ...THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1,
      minQualifyingSeconds: 30,
    },
  });
  const window = result.windows.find((w) => w.observedResistance === 10);
  assert.ok(window);
  assert.ok(window.postSettlingDurationSec >= 30, "elapsed span is long");
  assert.ok(window.qualifyingSampleCount < 30, `qualifying=${window.qualifyingSampleCount}`);
  assert.ok(window.resolvedGateFailures.includes("insufficient_post_settling_duration"));
  assert.equal(result.acceptedWindow, null);
});

test("rare watt outliers do not inflate MAD the way min/max span would", () => {
  const input = syntheticDenseHoldFixture({
    policy: {
      ...THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1,
      maxMeasuredWattsMadRatio: 0.05,
    },
  });
  for (const sample of input.bikeSamples) {
    if (sample.activeSec >= 1170 && sample.watts) {
      sample.watts.value = sample.activeSec % 47 === 0 ? 57 : 114;
    }
  }
  const result = evaluateThresholdRegionSettledWorkloadContract(input);
  assert.ok(result.acceptedWindow);
  assert.ok((result.acceptedWindow.measuredWattsMadRatio ?? 1) < 0.05);
});

test("rejects unstable settled workload when MAD ratio gate is set", () => {
  const hrByActiveSec = new Map();
  const bikeSamples = [];
  for (let sec = 600; sec < 900; sec++) {
    hrByActiveSec.set(sec, 158);
    bikeSamples.push(bikeSample(sec, {
      resistance: 9,
      watts: sec % 2 === 0 ? 70 : 150,
      cadence: 68,
    }));
  }
  const result = evaluateThresholdRegionSettledWorkloadContract({
    ...syntheticDenseHoldFixture(),
    workActiveStartSec: 600,
    workActiveEndSecExclusive: 900,
    hrByActiveSec,
    bikeSamples,
    machineDecisionAudit: [holdAudit(780, 9, 158), holdAudit(840, 9, 158)],
    policy: {
      ...THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1,
      maxMeasuredWattsMadRatio: 0.1,
    },
  });
  const window = result.windows.find((w) => w.observedResistance === 9);
  assert.ok(window);
  assert.ok((window.measuredWattsMadRatio ?? 0) > 0.1, `madRatio=${window.measuredWattsMadRatio}`);
  assert.equal(result.acceptedWindow, null);
  assert.ok(window.resolvedGateFailures.includes("unstable_measured_workload"));
});

test("production observation requires complete policy; schema identity is set when emitted", () => {
  const completePolicy = {
    ...THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1,
    minInBandFraction: 0.8,
    maxMeasuredWattsMadRatio: 0.25,
    minAdviceGradeDurationSec: 60,
  };
  assert.equal(thresholdRegionSettledPolicyIsProductionReady(completePolicy), true);
  const result = evaluateThresholdRegionSettledWorkloadContract(
    syntheticDenseHoldFixture({ policy: completePolicy })
  );
  assert.ok(result.acceptedWindow);
  assert.ok(result.observation);
  assert.equal(result.observation.schemaId, THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1);
  assert.equal(result.observation.eligibleForPrescription, false);
  assert.equal(result.observation.interpretation, "descriptive_observation_only");
  assert.equal(result.observation.provenance, THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1);
  assert.equal(
    result.observation.controllerSettledProvenance,
    "controller_held_resistance_plus_target_hold_audit"
  );
});
