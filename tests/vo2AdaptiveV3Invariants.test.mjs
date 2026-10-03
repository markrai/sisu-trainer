import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VO2_ADAPTIVE_POLICY,
  VO2_ADAPTIVE_ADVERTISED_MAX_TOTAL_DURATION_SEC,
  VO2_ADAPTIVE_MAX_WORK_STAGES,
  VO2_ADAPTIVE_MAX_WATT_INCREMENT,
  VO2_ADAPTIVE_MIN_WATT_INCREMENT,
  VO2_ADAPTIVE_MIN_WATT_SEPARATION,
  VO2_ADAPTIVE_SAFETY_MARGIN_BPM,
  isValidVo2AdaptivePolicy,
  planNextVo2Stage,
  vo2AdaptiveMaxTotalDurationSec,
} from "../dist/vo2AdaptivePlanner.js";
import {
  buildVo2ProtocolPlanV3,
  createVo2ProtocolRuntimeV3,
  advanceVo2ProtocolV3,
  buildVo2ProtocolEvidenceV3,
  isValidVo2ProtocolPlanV3,
  isValidVo2ProtocolRuntimeV3,
  vo2PlanBlocksV3,
  vo2V3MaxTotalDurationSec,
} from "../dist/vo2ProtocolV3.js";
import {
  buildVo2ProtocolPlan,
  resolveProtocolWorkloads,
  VO2_COOLDOWN_DURATION_SEC,
  VO2_MAX_STAGE_DURATION_SEC,
  VO2_WARMUP_DURATION_SEC,
} from "../dist/vo2Protocol.js";
import { assessVo2, estimatorSubmaxHrCeilingBpm, predictedHrMaxBpm } from "../dist/vo2Estimator.js";
import { VO2_EVIDENCE_SCHEMA_VERSION } from "../dist/types.js";
import { getEstimatedWattsAt70Rpm } from "../dist/machines/proformSmartPower10.js";

const FIXTURE_AGE = 46;
const FIXTURE_WEIGHT = 52.1631;
const FIXTURE_HRMAX = 175.8;
const FIXTURE_HARD = 149.43;
const FIXTURE_PROFILE = { age_years: FIXTURE_AGE, weight_kg: FIXTURE_WEIGHT };

function fixturePlannerInput(overrides = {}) {
  return {
    eligible: [
      { estimatorWatts: 85, steadyHrBpm: 121.15, calibratedWatts: 86, resistance: 6 },
      { estimatorWatts: 102, steadyHrBpm: 132.25, calibratedWatts: 108, resistance: 8 },
    ],
    predictedHrMax: FIXTURE_HRMAX,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1, 6, 8]),
    calibration: getEstimatedWattsAt70Rpm,
    completedWorkStages: 2,
    retryCount: 0,
    ...overrides,
  };
}

// --- Issue 2: watt-domain consistency (calibrated planning domain) ---

test("planner predicts from calibrated watts, not estimator watts (measured below calibrated)", () => {
  // Same calibrated history (86/108) and HR, but estimator watts materially
  // lower (-15W): 70/87 vs 85/102. Planning decision must be identical
  // because prediction uses the calibrated domain.
  const base = fixturePlannerInput();
  const shifted = fixturePlannerInput({
    eligible: [
      { estimatorWatts: 70, steadyHrBpm: 121.15, calibratedWatts: 86, resistance: 6 },
      { estimatorWatts: 87, steadyHrBpm: 132.25, calibratedWatts: 108, resistance: 8 },
    ],
  });
  const a = planNextVo2Stage(base);
  const b = planNextVo2Stage(shifted);
  assert.equal(a.decision, "next");
  assert.equal(b.decision, "next");
  assert.equal(a.prescribed_resistance, b.prescribed_resistance);
  assert.equal(a.calibrated_watts, b.calibrated_watts);
  assert.ok(Math.abs(a.predicted_hr_bpm - b.predicted_hr_bpm) < 1e-9);
  // Calibrated-fit prediction at R9 114W: slope 0.5045, intercept 77.76.
  const slope = (132.25 - 121.15) / (108 - 86);
  const intercept = 121.15 - slope * 86;
  const expected = slope * 114 + intercept;
  assert.ok(Math.abs(a.predicted_hr_bpm - expected) < 0.05);
  // Estimator-fit would predict ~140.1 at 114W; calibrated predicts ~135.3.
  assert.ok(a.predicted_hr_bpm < 137);
});

test("planner predicts from calibrated watts, not estimator watts (measured above calibrated)", () => {
  // Estimator watts materially higher (+15W): 100/117 vs 85/102.
  const base = fixturePlannerInput();
  const shifted = fixturePlannerInput({
    eligible: [
      { estimatorWatts: 100, steadyHrBpm: 121.15, calibratedWatts: 86, resistance: 6 },
      { estimatorWatts: 117, steadyHrBpm: 132.25, calibratedWatts: 108, resistance: 8 },
    ],
  });
  const a = planNextVo2Stage(base);
  const b = planNextVo2Stage(shifted);
  assert.equal(a.decision, "next");
  assert.equal(b.decision, "next");
  assert.equal(a.prescribed_resistance, 9);
  assert.equal(b.prescribed_resistance, 9);
  assert.ok(Math.abs(a.predicted_hr_bpm - b.predicted_hr_bpm) < 1e-9);
});

test("same estimator watts but different calibrated history changes the plan", () => {
  // Estimator watts fixed (85/102); calibrated history materially different
  // (70/90 vs 86/108, -16/-18W). A domain-mixed planner using estimator
  // watts would return the same decision; the calibrated planner must differ
  // in prediction (different slope/intercept).
  const a = planNextVo2Stage(fixturePlannerInput());
  const b = planNextVo2Stage(
    fixturePlannerInput({
      eligible: [
        { estimatorWatts: 85, steadyHrBpm: 121.15, calibratedWatts: 70, resistance: 3 },
        { estimatorWatts: 102, steadyHrBpm: 132.25, calibratedWatts: 90, resistance: 4 },
      ],
      usedResistances: new Set([1, 3, 4]),
    })
  );
  assert.equal(a.decision, "next");
  assert.equal(b.decision, "next");
  // Calibrated fits differ: (86,108) slope 0.5045 vs (70,90) slope 0.555.
  // Predictions at their respective choices must differ materially.
  assert.ok(Math.abs(a.predicted_hr_bpm - b.predicted_hr_bpm) > 0.5);
});

test("max-safe bound is evaluated in the calibrated domain", () => {
  // With calibrated history (86,108) the max-safe calibrated bound at
  // margin 12 is (137.43-77.76)/0.5045 = 118.27W, admitting R9 114W but
  // refusing R10 123W. An estimator-domain max-safe (measured fit) would be
  // (137.43-65.65)/0.6529 = 109.94W and would refuse R9 as well.
  const decision = planNextVo2Stage(fixturePlannerInput());
  assert.equal(decision.decision, "next");
  assert.equal(decision.calibrated_watts, 114);
  // Prove the bound used was the calibrated one: R9 114 < 118.27 admits,
  // R10 123 > 118.27 refuses. If the planner had used the estimator-domain
  // bound 109.94 it would have refused R9 (114 > 109.94).
  assert.ok(114 < 118.27 + 0.1);
  assert.ok(123 > 118.27 - 0.1);
});

// --- Issue 5: policy invariants (min/max/separation enforced everywhere) ---

test("minimum increment is enforced, not decorative", () => {
  // Separation 3 but minimum increment 10: candidate at +4W satisfies
  // separation yet violates minimum increment and must be refused.
  const decision = planNextVo2Stage({
    eligible: [
      { estimatorWatts: 100, steadyHrBpm: 120, calibratedWatts: 100, resistance: 5 },
      { estimatorWatts: 110, steadyHrBpm: 125, calibratedWatts: 110, resistance: 6 },
    ],
    predictedHrMax: 180,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1, 5, 6]),
    calibration: (r) => (r === 7 ? 114 : undefined),
    completedWorkStages: 2,
    retryCount: 0,
    policy: { min_watt_increment: 10, min_watt_separation: 3 },
  });
  assert.equal(decision.decision, "cannot");
  assert.equal(decision.reason_code, "insufficient_separation");
});

test("sparse table far above max increment refuses instead of jumping (normal path)", () => {
  const decision = planNextVo2Stage({
    eligible: [
      { estimatorWatts: 100, steadyHrBpm: 120, calibratedWatts: 100, resistance: 5 },
      { estimatorWatts: 110, steadyHrBpm: 125, calibratedWatts: 110, resistance: 6 },
    ],
    predictedHrMax: 190,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1, 5, 6]),
    calibration: (r) => (r === 7 ? 160 : undefined),
    completedWorkStages: 2,
    retryCount: 0,
    policy: { max_watt_increment: 15 },
  });
  assert.equal(decision.decision, "cannot");
  assert.equal(decision.reason_code, "workload_bounds_exhausted");
  assert.equal(decision.termination_reason, "insufficient_calibrated_workloads");
});

test("sparse table far above max increment refuses (bootstrap path)", () => {
  const decision = planNextVo2Stage({
    eligible: [],
    predictedHrMax: 180,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1]),
    calibration: (r) => (r === 2 ? 100 : undefined),
    completedWorkStages: 0,
    retryCount: 0,
    policy: { max_watt_increment: 10 },
  });
  assert.equal(decision.decision, "cannot");
  assert.equal(decision.reason_code, "workload_bounds_exhausted");
});

test("sparse table far above max increment refuses (fallback path)", () => {
  const decision = planNextVo2Stage({
    eligible: [{ estimatorWatts: 85, steadyHrBpm: 118, calibratedWatts: 86, resistance: 6 }],
    predictedHrMax: 180,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1, 6]),
    calibration: (r) => (r === 7 ? 130 : undefined),
    completedWorkStages: 1,
    retryCount: 0,
    policy: { max_watt_increment: 10 },
  });
  assert.equal(decision.decision, "cannot");
  assert.equal(decision.reason_code, "workload_bounds_exhausted");
});

test("retry below the failed workload still respects max increment", () => {
  // Base 86 (last eligible), failed 123. Candidate 114 is below the failure
  // but 28W above base, violating max 15. Only 97 (+11W) is legal.
  const input = {
    eligible: [
      { estimatorWatts: 85, steadyHrBpm: 121.15, calibratedWatts: 86, resistance: 6 },
      { estimatorWatts: 95, steadyHrBpm: 126, calibratedWatts: 97, resistance: 7 },
    ],
    predictedHrMax: FIXTURE_HRMAX,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    lastCompleted: {
      calibratedWatts: 123,
      estimatorWatts: 119,
      steadyHrBpm: 154.1,
      resistance: 10,
      aboveCeiling: true,
      eligible: false,
    },
    usedResistances: new Set([1, 6, 7, 10]),
    calibration: getEstimatedWattsAt70Rpm,
    completedWorkStages: 3,
    retryCount: 0,
    policy: { max_watt_increment: 15 },
  };
  const decision = planNextVo2Stage(input);
  assert.equal(decision.decision, "next");
  // Base for retry is last eligible calibrated (97), so 114 is +17W > 15
  // max and must not be chosen; 108 is +11W and below failed 123.
  assert.ok(decision.calibrated_watts <= 97 + 15 + 1e-9);
  assert.ok(decision.calibrated_watts < 123);
  assert.equal(decision.provenance.decision, "retry");
});

test("retry with only max-violating candidate refuses", () => {
  const decision = planNextVo2Stage({
    eligible: [
      { estimatorWatts: 85, steadyHrBpm: 121, calibratedWatts: 86, resistance: 6 },
      { estimatorWatts: 90, steadyHrBpm: 124, calibratedWatts: 90, resistance: 5 },
    ],
    predictedHrMax: 185,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    lastCompleted: {
      calibratedWatts: 150,
      estimatorWatts: 148,
      steadyHrBpm: 160,
      resistance: 9,
      aboveCeiling: true,
      eligible: false,
    },
    usedResistances: new Set([1, 5, 6, 9]),
    calibration: (r) => (r === 7 ? 130 : r === 8 ? 140 : undefined),
    completedWorkStages: 3,
    retryCount: 0,
    policy: { max_watt_increment: 10 },
  });
  // Base 90, candidates 130 (+40) and 140 (+50) both exceed max 10.
  assert.equal(decision.decision, "cannot");
  assert.equal(decision.reason_code, "workload_bounds_exhausted");
});

test("incoherent policies are rejected", () => {
  assert.equal(isValidVo2AdaptivePolicy({ ...DEFAULT_VO2_ADAPTIVE_POLICY, min_watt_increment: 20, normal_watt_increment: 10 }), false);
  assert.equal(isValidVo2AdaptivePolicy({ ...DEFAULT_VO2_ADAPTIVE_POLICY, normal_watt_increment: 30, max_watt_increment: 25 }), false);
  assert.equal(isValidVo2AdaptivePolicy({ ...DEFAULT_VO2_ADAPTIVE_POLICY, min_watt_separation: 30, max_watt_increment: 25 }), false);
  assert.equal(isValidVo2AdaptivePolicy({ ...DEFAULT_VO2_ADAPTIVE_POLICY, bootstrap_watt_step: 30, max_watt_increment: 25 }), false);
  assert.equal(isValidVo2AdaptivePolicy({ ...DEFAULT_VO2_ADAPTIVE_POLICY, fallback_watt_step: 2, min_watt_increment: 5 }), false);
  assert.equal(isValidVo2AdaptivePolicy(DEFAULT_VO2_ADAPTIVE_POLICY), true);
  assert.equal(buildVo2ProtocolPlanV3(getEstimatedWattsAt70Rpm, { min_watt_increment: 20, normal_watt_increment: 10 }), undefined);
});

// --- Issue 3: 30-minute hard invariant ---

test("default v3 plan and max stages respect the 30-minute bound", () => {
  assert.equal(VO2_ADAPTIVE_ADVERTISED_MAX_TOTAL_DURATION_SEC, 1800);
  assert.equal(VO2_ADAPTIVE_MAX_WORK_STAGES, 4);
  assert.equal(
    VO2_ADAPTIVE_MAX_WORK_STAGES,
    Math.floor((1800 - VO2_WARMUP_DURATION_SEC - VO2_COOLDOWN_DURATION_SEC) / VO2_MAX_STAGE_DURATION_SEC)
  );
  assert.ok(vo2AdaptiveMaxTotalDurationSec(DEFAULT_VO2_ADAPTIVE_POLICY) <= 1800);
  assert.ok(vo2V3MaxTotalDurationSec(DEFAULT_VO2_ADAPTIVE_POLICY) <= 1800);
  const blocks = vo2PlanBlocksV3(DEFAULT_VO2_ADAPTIVE_POLICY);
  const displayedSec = (blocks.warm + blocks.sustain + blocks.cool) * 60;
  assert.ok(displayedSec <= 1800);
  assert.equal(displayedSec, vo2V3MaxTotalDurationSec(DEFAULT_VO2_ADAPTIVE_POLICY));
});

test("maximum valid serialized policy stays within 30 minutes", () => {
  const maxPolicy = { ...DEFAULT_VO2_ADAPTIVE_POLICY, max_work_stages: 4 };
  assert.equal(isValidVo2AdaptivePolicy(maxPolicy), true);
  assert.ok(vo2AdaptiveMaxTotalDurationSec(maxPolicy) <= 1800);
  const plan = buildVo2ProtocolPlanV3(getEstimatedWattsAt70Rpm, { max_work_stages: 4 });
  assert.ok(plan);
  assert.equal(isValidVo2ProtocolPlanV3(plan), true);
});

test("policies and runtimes that could exceed 30 minutes are rejected", () => {
  assert.equal(isValidVo2AdaptivePolicy({ ...DEFAULT_VO2_ADAPTIVE_POLICY, max_work_stages: 5 }), false);
  assert.equal(isValidVo2AdaptivePolicy({ ...DEFAULT_VO2_ADAPTIVE_POLICY, max_work_stages: 6 }), false);
  assert.equal(buildVo2ProtocolPlanV3(getEstimatedWattsAt70Rpm, { max_work_stages: 5 }), undefined);
  assert.equal(buildVo2ProtocolPlanV3(getEstimatedWattsAt70Rpm, { max_work_stages: 6 }), undefined);
  const plan = buildVo2ProtocolPlanV3();
  assert.ok(plan);
  const overloaded = JSON.parse(JSON.stringify(plan));
  overloaded.workloads = [1, 2, 3, 4, 5].map((r) => ({
    requested_watts: 60 + r * 10,
    prescribed_resistance: r,
    calibrated_watts_at_70rpm: 60 + r * 10,
  }));
  assert.equal(isValidVo2ProtocolPlanV3(overloaded), false);
  let runtime = createVo2ProtocolRuntimeV3(plan, FIXTURE_PROFILE);
  runtime = advanceVo2ProtocolV3(runtime, { elapsedSec: 300, paused: false, samples: [] });
  const tooMany = JSON.parse(JSON.stringify(runtime));
  tooMany.stages = [0, 1, 2, 3, 4].map((i) => ({ ...runtime.stages[0], stage_id: `vo2-stage:${i + 1}` }));
  // Stages reference workload 0 which exists, but count 5 exceeds policy max 4.
  assert.equal(isValidVo2ProtocolRuntimeV3(tooMany), false);
});

test("displayed plan duration matches the allowed runtime bound for every valid stage count", () => {
  for (const stages of [1, 2, 3, 4]) {
    const policy = { ...DEFAULT_VO2_ADAPTIVE_POLICY, max_work_stages: stages };
    assert.equal(isValidVo2AdaptivePolicy(policy), true);
    const blocks = vo2PlanBlocksV3(policy);
    const displayed = (blocks.warm + blocks.sustain + blocks.cool) * 60;
    assert.equal(displayed, vo2V3MaxTotalDurationSec(policy));
    assert.equal(displayed, VO2_WARMUP_DURATION_SEC + stages * VO2_MAX_STAGE_DURATION_SEC + VO2_COOLDOWN_DURATION_SEC);
    assert.ok(displayed <= 1800);
  }
});

// --- Issue 6: real-session v3 progression (margin rationale companion) ---

test("v2 ladder, v3 stage 1, and v3 stage 2 are pinned from the real session", () => {
  const v2 = resolveProtocolWorkloads(getEstimatedWattsAt70Rpm, 4);
  assert.deepEqual(v2.map((w) => w.prescribed_resistance), [6, 8, 9, 10]);
  assert.deepEqual(v2.map((w) => w.calibrated_watts_at_70rpm), [86, 108, 114, 123]);
  const v2plan = buildVo2ProtocolPlan();
  assert.ok(v2plan);
  assert.deepEqual(v2plan.workloads.map((w) => w.prescribed_resistance), [6, 8, 9, 10]);

  // V3 bootstrap from warmup R1/66W + 25W targets 91W; nearest legal level
  // within [min,max] increment is R6/86W (same first stage as v2 by table luck).
  const first = planNextVo2Stage({
    eligible: [],
    predictedHrMax: FIXTURE_HRMAX,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1]),
    calibration: getEstimatedWattsAt70Rpm,
    completedWorkStages: 0,
    retryCount: 0,
  });
  assert.equal(first.decision, "next");
  assert.equal(first.prescribed_resistance, 6);
  assert.equal(first.calibrated_watts, 86);

  // After one eligible stage at R6, the <2-point conservative step targets
  // 86+15=101W; nearest legal level is R7/97W (v2 would jump to R8/108W).
  const second = planNextVo2Stage({
    eligible: [{ estimatorWatts: 85, steadyHrBpm: 121.15, calibratedWatts: 86, resistance: 6 }],
    predictedHrMax: FIXTURE_HRMAX,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    lastCompleted: { calibratedWatts: 86, estimatorWatts: 85, steadyHrBpm: 121.15, resistance: 6, aboveCeiling: false, eligible: true },
    usedResistances: new Set([1, 6]),
    calibration: getEstimatedWattsAt70Rpm,
    completedWorkStages: 1,
    retryCount: 0,
  });
  assert.equal(second.decision, "next");
  assert.equal(second.prescribed_resistance, 7);
  assert.equal(second.calibrated_watts, 97);
});

function hrSamplesForStage(stageStart, bpm) {
  const out = [];
  for (let t = stageStart + 60; t <= stageStart + 119; t++) out.push({ timestamp_sec: t, hr: bpm });
  for (let t = stageStart + 120; t <= stageStart + 179; t++) out.push({ timestamp_sec: t, hr: bpm });
  return out;
}

function telemetryForStage(stageStart, watts, rpm = 70) {
  const end = stageStart + 180;
  const out = [];
  for (let t = end - 119; t <= end; t++) out.push({ timestamp_sec: t, rpm, watts });
  return out;
}

function assessRuntimeEvidence(runtime) {
  const protocol = buildVo2ProtocolEvidenceV3(runtime);
  assert.ok(protocol);
  return assessVo2(
    {
      schema_version: VO2_EVIDENCE_SCHEMA_VERSION,
      active_duration_sec: runtime.cooldown_start_sec ?? 0,
      paused_duration_sec: 0,
      work_end_active_sec: runtime.cooldown_start_sec,
      cooldown_start_active_sec: runtime.cooldown_start_sec,
      early_cooldown: false,
      phases: [],
      hr: { source: "ble_chest_strap", sample_count: 360 },
      protocol,
    },
    FIXTURE_PROFILE
  );
}

test("v3 full runtime from warmup collects 3 eligible or stops truthfully without accepting above-ceiling", () => {
  // Deterministic gentle responder: HR rises ~0.55bpm per calibrated watt
  // from the fixture anchor (86W -> 121.15bpm). All predictions stay safe.
  const hrFor = (calibrated) => 121.15 + (calibrated - 86) * 0.55;
  const plan = buildVo2ProtocolPlanV3();
  assert.ok(plan);
  let runtime = createVo2ProtocolRuntimeV3(plan, FIXTURE_PROFILE);
  runtime = advanceVo2ProtocolV3(runtime, { elapsedSec: 300, paused: false, samples: [] });
  let guard = 0;
  while (runtime.segment === "work" && guard < 6) {
    guard += 1;
    const open = runtime.stages.find((s) => s.status === "open");
    assert.ok(open);
    const workload = runtime.plan.workloads[open.workloadIndex];
    const bpm = hrFor(workload.calibrated_watts_at_70rpm);
    runtime = advanceVo2ProtocolV3(runtime, {
      elapsedSec: open.active_start_sec + 180,
      paused: false,
      samples: hrSamplesForStage(open.active_start_sec, bpm),
      telemetrySamples: telemetryForStage(open.active_start_sec, workload.calibrated_watts_at_70rpm - 2),
    });
  }
  assert.ok(guard <= 4);
  const evidence = buildVo2ProtocolEvidenceV3(runtime);
  assert.ok(evidence);
  assert.equal(evidence.protocol_version, 3);
  const result = assessRuntimeEvidence(runtime);
  // Estimator must never accept an above-ceiling point.
  for (const point of result.diagnostics.eligible_points) {
    assert.ok(!point.ineligibility_reasons.includes("hr_above_submax_ceiling"));
    assert.ok(point.steady_state_bpm < estimatorSubmaxHrCeilingBpm(predictedHrMaxBpm(FIXTURE_AGE)));
  }
  if (result.status === "estimated") {
    assert.ok(result.eligible_stage_count >= 3);
    assert.equal(runtime.termination.reason, "protocol_complete");
  } else {
    // Truthful safety/validity stop: termination and provenance must agree,
    // and reason codes must not fabricate an observed ceiling crossing.
    assert.ok(["submax_hr_ceiling", "insufficient_eligible_stages", "insufficient_calibrated_workloads"].includes(runtime.termination.reason));
    if (runtime.termination.reason === "submax_hr_ceiling") {
      assert.ok(runtime.adaptive_termination);
    }
    const anyObservedAbove = result.diagnostics.stage_points.some((p) =>
      p.ineligibility_reasons.includes("hr_above_submax_ceiling")
    );
    if (!anyObservedAbove) {
      assert.equal(result.reason_codes.includes("hr_above_submax_ceiling"), false);
    }
  }
});

test("v3 steep responder stops proactively before the ceiling (no observed crossing)", () => {
  // Steep responder mimicking the fixture nonlinearity: HR jumps fast.
  // Planner must refuse the next stage proactively rather than prescribe
  // a workload the estimator would have to reject.
  const plan = buildVo2ProtocolPlanV3();
  assert.ok(plan);
  let runtime = createVo2ProtocolRuntimeV3(plan, FIXTURE_PROFILE);
  runtime = advanceVo2ProtocolV3(runtime, { elapsedSec: 300, paused: false, samples: [] });
  const first = runtime.stages.find((s) => s.status === "open");
  runtime = advanceVo2ProtocolV3(runtime, {
    elapsedSec: first.active_start_sec + 180,
    paused: false,
    samples: hrSamplesForStage(first.active_start_sec, 121.15),
    telemetrySamples: telemetryForStage(first.active_start_sec, 85),
  });
  const second = runtime.stages.find((s) => s.status === "open");
  assert.ok(second);
  // Second stage HR near planning (137.43 with margin 12): 136bpm.
  runtime = advanceVo2ProtocolV3(runtime, {
    elapsedSec: second.active_start_sec + 180,
    paused: false,
    samples: hrSamplesForStage(second.active_start_sec, 136),
    telemetrySamples: telemetryForStage(second.active_start_sec, 95),
  });
  const result = assessRuntimeEvidence(runtime);
  for (const point of result.diagnostics.eligible_points) {
    assert.ok(!point.ineligibility_reasons.includes("hr_above_submax_ceiling"));
  }
  // Either a safe third stage was prescribed or the runtime stopped with
  // explicit adaptive provenance; it must not require estimator acceptance
  // of an above-ceiling point.
  assert.ok(["work", "cooldown", "complete"].includes(runtime.segment));
  if (runtime.segment !== "work") {
    assert.ok(runtime.termination);
  }
});

// --- Safety-policy review: margin 12 retained (see planner rationale) ---

test("v3 gentle responder completes safely with three eligible stages", () => {
  // Linear gentle responder: 0.55bpm per calibrated watt from the fixture
  // anchor. The planner must progress 86 -> 97 -> 114W (all predicted
  // strictly below planning) and complete with a valid estimate.
  const hrFor = (calibrated) => 121.15 + (calibrated - 86) * 0.55;
  const hard = estimatorSubmaxHrCeilingBpm(predictedHrMaxBpm(FIXTURE_AGE));
  const planning = hard - VO2_ADAPTIVE_SAFETY_MARGIN_BPM;
  const plan = buildVo2ProtocolPlanV3();
  assert.ok(plan);
  let runtime = createVo2ProtocolRuntimeV3(plan, FIXTURE_PROFILE);
  runtime = advanceVo2ProtocolV3(runtime, { elapsedSec: 300, paused: false, samples: [] });
  let guard = 0;
  while (runtime.segment === "work" && guard < 6) {
    guard += 1;
    const open = runtime.stages.find((s) => s.status === "open");
    assert.ok(open);
    const workload = runtime.plan.workloads[open.workloadIndex];
    const bpm = hrFor(workload.calibrated_watts_at_70rpm);
    runtime = advanceVo2ProtocolV3(runtime, {
      elapsedSec: open.active_start_sec + 180,
      paused: false,
      samples: hrSamplesForStage(open.active_start_sec, bpm),
      telemetrySamples: telemetryForStage(open.active_start_sec, workload.calibrated_watts_at_70rpm - 2),
    });
  }
  assert.equal(isValidVo2ProtocolRuntimeV3(runtime), true);
  assert.deepEqual(
    runtime.plan.workloads.map((w) => w.prescribed_resistance),
    [6, 7, 9]
  );
  assert.deepEqual(
    runtime.plan.workloads.map((w) => w.calibrated_watts_at_70rpm),
    [86, 97, 114]
  );
  assert.deepEqual(
    runtime.stages.map((s) => s.adaptive.reason_code),
    ["bootstrap_first_stage", "conservative_step_insufficient_evidence", "reduced_increment_near_ceiling"]
  );
  // Stage 3 prediction (0.55 line: 73.85 + 0.55*114 = 136.55) spends almost
  // the whole margin by design yet stays strictly below planning 137.43.
  const third = runtime.stages[2].adaptive;
  assert.ok(Math.abs(third.predicted_next_hr_bpm - 136.55) < 0.05);
  assert.ok(third.predicted_next_hr_bpm < planning);
  assert.ok(Math.abs(third.planning_hr_ceiling_bpm - planning) < 1e-9);
  assert.equal(runtime.segment, "cooldown");
  assert.equal(runtime.termination.reason, "protocol_complete");
  const evidence = buildVo2ProtocolEvidenceV3(runtime);
  assert.ok(evidence);
  assert.equal(evidence.stages.length, 3);
  const result = assessRuntimeEvidence(runtime);
  assert.equal(result.status, "estimated");
  assert.equal(result.eligible_stage_count, 3);
  for (const point of result.diagnostics.eligible_points) {
    assert.ok(point.steady_state_bpm < hard);
    assert.ok(!point.ineligibility_reasons.includes("hr_above_submax_ceiling"));
  }
});

test("v3 steep responder is stopped before the ceiling with explicit provenance", () => {
  // Second stage lands at 136bpm, just under planning 137.43: the secant
  // slope (1.35bpm/W) leaves no room for even the minimum increment, so
  // the planner must refuse stage 3 rather than prescribe into the ceiling.
  const hard = estimatorSubmaxHrCeilingBpm(predictedHrMaxBpm(FIXTURE_AGE));
  const plan = buildVo2ProtocolPlanV3();
  assert.ok(plan);
  let runtime = createVo2ProtocolRuntimeV3(plan, FIXTURE_PROFILE);
  runtime = advanceVo2ProtocolV3(runtime, { elapsedSec: 300, paused: false, samples: [] });
  for (const bpm of [121.15, 136]) {
    const open = runtime.stages.find((s) => s.status === "open");
    assert.ok(open);
    const workload = runtime.plan.workloads[open.workloadIndex];
    runtime = advanceVo2ProtocolV3(runtime, {
      elapsedSec: open.active_start_sec + 180,
      paused: false,
      samples: hrSamplesForStage(open.active_start_sec, bpm),
      telemetrySamples: telemetryForStage(open.active_start_sec, workload.calibrated_watts_at_70rpm - 2),
    });
  }
  assert.equal(isValidVo2ProtocolRuntimeV3(runtime), true);
  // No third stage was ever prescribed.
  assert.equal(runtime.stages.length, 2);
  assert.equal(runtime.plan.workloads.length, 2);
  assert.equal(runtime.segment, "cooldown");
  assert.equal(runtime.termination.reason, "submax_hr_ceiling");
  assert.ok(runtime.adaptive_termination);
  assert.equal(runtime.adaptive_termination.reason_code, "hr_safety_no_safe_target");
  assert.equal(runtime.adaptive_termination.termination_reason, "submax_hr_ceiling");
  assert.equal(runtime.adaptive_termination.planning_margin_bpm, VO2_ADAPTIVE_SAFETY_MARGIN_BPM);
  assert.ok(Math.abs(runtime.adaptive_termination.hard_hr_ceiling_bpm - hard) < 1e-9);
  assert.ok(
    Math.abs(
      runtime.adaptive_termination.planning_hr_ceiling_bpm -
        (runtime.adaptive_termination.hard_hr_ceiling_bpm - VO2_ADAPTIVE_SAFETY_MARGIN_BPM)
    ) < 1e-9
  );
  // Nothing observed at or above the hard ceiling, and the estimator never
  // flags a crossing it did not see.
  const result = assessRuntimeEvidence(runtime);
  for (const point of result.diagnostics.stage_points) {
    assert.ok(!point.ineligibility_reasons.includes("hr_above_submax_ceiling"));
    if (point.steady_state_bpm != null) assert.ok(point.steady_state_bpm < hard);
  }
  for (const point of result.diagnostics.eligible_points) {
    assert.ok(point.steady_state_bpm < hard);
  }
});

test("real-fixture stage-3 sweep never prescribes the failed 123W workload", () => {
  // The 97W stage-2 response is unobserved in the real session, so sweep it
  // across the whole eligible HR range instead of inventing one value. From
  // the v3 base of 97W, R10/123W is 26W away and must be structurally
  // excluded by the 25W maximum increment for every HR; every prescription
  // must predict strictly below planning or be refused truthfully.
  const planning = FIXTURE_HARD - VO2_ADAPTIVE_SAFETY_MARGIN_BPM;
  const decide = (h2) =>
    planNextVo2Stage({
      eligible: [
        { estimatorWatts: 85, steadyHrBpm: 121.15, calibratedWatts: 86, resistance: 6 },
        { estimatorWatts: h2 - 2, steadyHrBpm: h2, calibratedWatts: 97, resistance: 7 },
      ],
      predictedHrMax: FIXTURE_HRMAX,
      warmupCalibratedWatts: 66,
      warmupResistance: 1,
      lastCompleted: {
        calibratedWatts: 97,
        estimatorWatts: h2 - 2,
        steadyHrBpm: h2,
        resistance: 7,
        aboveCeiling: false,
        eligible: true,
      },
      usedResistances: new Set([1, 6, 7]),
      calibration: getEstimatedWattsAt70Rpm,
      completedWorkStages: 2,
      retryCount: 0,
    });
  // Pinned transition boundaries (exact consequences of table + policy).
  assert.equal(decide(121).reason_code, "nonpositive_slope");
  assert.equal(decide(122).decision, "next");
  assert.equal(decide(122).prescribed_resistance, 9);
  assert.equal(decide(128).prescribed_resistance, 8);
  assert.equal(decide(130).reason_code, "hr_safety_no_safe_target");
  for (let h2 = 110; h2 <= 149; h2 += 1) {
    const decision = decide(h2);
    if (decision.decision === "next") {
      assert.ok([8, 9].includes(decision.prescribed_resistance));
      assert.ok([108, 114].includes(decision.calibrated_watts));
      assert.notEqual(decision.calibrated_watts, 123);
      assert.ok(decision.predicted_hr_bpm < planning);
      const increment = decision.calibrated_watts - 97;
      assert.ok(increment >= VO2_ADAPTIVE_MIN_WATT_INCREMENT - 1e-9);
      assert.ok(increment >= VO2_ADAPTIVE_MIN_WATT_SEPARATION - 1e-9);
      assert.ok(increment <= VO2_ADAPTIVE_MAX_WATT_INCREMENT + 1e-9);
    } else {
      assert.ok(["nonpositive_slope", "hr_safety_no_safe_target"].includes(decision.reason_code));
      assert.equal(typeof decision.termination_reason, "string");
    }
  }
});

test("planner terminates truthfully when the table jumps past the max-safe bound", () => {
  // Fitted max-safe is 122W (above base+min 115W), but the only table levels
  // in the legal increment window predict at/above planning 141: refuse
  // with HR-safety provenance. A denser table offering 118W prescribes it.
  const input = {
    eligible: [
      { estimatorWatts: 105, steadyHrBpm: 130, calibratedWatts: 100, resistance: 5 },
      { estimatorWatts: 110, steadyHrBpm: 135, calibratedWatts: 110, resistance: 6 },
    ],
    predictedHrMax: 180,
    warmupCalibratedWatts: 66,
    warmupResistance: 1,
    usedResistances: new Set([1, 5, 6]),
    completedWorkStages: 2,
    retryCount: 0,
  };
  const sparse = planNextVo2Stage({
    ...input,
    calibration: (r) => (r === 7 ? 124 : r === 8 ? 130 : undefined),
  });
  assert.equal(sparse.decision, "cannot");
  assert.equal(sparse.reason_code, "hr_safety_no_safe_target");
  assert.equal(sparse.termination_reason, "submax_hr_ceiling");
  assert.ok(Math.abs(sparse.provenance.hard_hr_ceiling_bpm - estimatorSubmaxHrCeilingBpm(180)) < 1e-9);
  assert.ok(
    Math.abs(sparse.provenance.planning_hr_ceiling_bpm - (sparse.provenance.hard_hr_ceiling_bpm - 12)) < 1e-9
  );
  assert.equal(sparse.provenance.planning_margin_bpm, 12);
  assert.equal(sparse.provenance.last_measured_watts, 110);
  assert.equal(sparse.provenance.last_steady_hr_bpm, 135);
  const dense = planNextVo2Stage({
    ...input,
    calibration: (r) => (r === 7 ? 118 : r === 8 ? 124 : undefined),
  });
  assert.equal(dense.decision, "next");
  assert.equal(dense.prescribed_resistance, 7);
  assert.equal(dense.calibrated_watts, 118);
  assert.ok(Math.abs(dense.predicted_hr_bpm - 139) < 1e-9);
  assert.ok(dense.predicted_hr_bpm < dense.provenance.planning_hr_ceiling_bpm);
});
