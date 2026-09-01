import assert from "node:assert/strict";
import test from "node:test";
import {
  formatVo2EstimateMlKgMin,
  genericWorkoutBlocksText,
  vo2AssessmentPresentation,
  vo2CancelModalTitle,
  vo2EndWorkoutButtonLabel,
  vo2HistoryOutcomeText,
  vo2InsufficientDetail,
  vo2LimitReachedButtonVisible,
  vo2SelectorOptionText,
  vo2WorkoutBlocksText,
} from "../dist/vo2AssessmentView.js";
import { assessVo2 } from "../dist/vo2Estimator.js";
import { vo2PlanBlocks } from "../dist/vo2Protocol.js";

function acceptedStage(id, watts, hr) {
  return {
    stage_id: id,
    active_start_sec: 0,
    active_end_sec: 180,
    requested_watts: watts,
    prescribed_resistance: 2,
    calibrated_watts_at_70rpm: watts,
    status: "accepted",
    nominal_duration_sec: 180,
    actual_duration_sec: 180,
    hr: { sample_count: 120, steady_state_bpm: hr },
    workload: {
      source: "measured_watts",
      estimator_watts: watts,
      calibrated_watts_at_70rpm: watts,
      measured_watts_median: watts,
      measured_watts_sample_count: 90,
      measured_cadence_median_rpm: 70,
      measured_cadence_sample_count: 90,
      cadence_in_band_ratio: 1,
      cadence_measured: true,
      watts_measured: true,
    },
  };
}

function evidence(stages, termination = "protocol_complete") {
  return {
    schema_version: 1,
    active_duration_sec: 900,
    paused_duration_sec: 0,
    work_end_active_sec: 840,
    cooldown_start_active_sec: 840,
    early_cooldown: false,
    phases: [],
    hr: { source: "ble_chest_strap", sample_count: 10 },
    protocol: {
      protocol_id: "bike-submax-70rpm",
      protocol_version: 1,
      prescribed_cadence_rpm: 70,
      stages,
      termination: { reason: termination },
      automatic_submax_hr_ceiling_available: false,
    },
  };
}

const linearThree = [
  acceptedStage("vo2-stage:1", 100, 120),
  acceptedStage("vo2-stage:2", 125, 130),
  acceptedStage("vo2-stage:3", 150, 140),
];

test("estimated result presentation uses one decimal and does not claim lab precision", () => {
  const result = assessVo2(evidence(linearThree), { age_years: 40, weight_kg: 80 });
  const view = vo2AssessmentPresentation(result);
  assert.equal(view.estimated, true);
  assert.equal(view.title, "VO₂ Max Estimate");
  assert.equal(view.valueText, formatVo2EstimateMlKgMin(40.75) + " ml/kg/min");
  assert.equal(view.valueText, "40.8 ml/kg/min");
  assert.match(view.body, /3 stable stages/);
  assert.match(view.body, /cycling heart-rate response/);
  assert.equal(view.detail, "Strong heart-rate/workload fit.");
  assert.equal(result.fit_quality, "high");
  assert.equal(result.confidence, undefined);
  assert.equal(vo2HistoryOutcomeText(result), "VO₂ 40.8 ml/kg/min");
});

test("insufficient result is explicit", () => {
  const result = assessVo2(evidence(linearThree.slice(0, 2), "user_cancelled"), {
    age_years: 40,
    weight_kg: 80,
  });
  const view = vo2AssessmentPresentation(result);
  assert.equal(view.estimated, false);
  assert.equal(view.title, "Not enough data to estimate VO₂ max");
  assert.equal(view.valueText, "");
  assert.match(view.body, /enough stable workload/i);
  assert.match(view.detail, /Only 2 stable work stages/);
  assert.equal(vo2HistoryOutcomeText(result), "VO₂ estimate unavailable");
});

test("too_few_accepted_stages describes accepted_stage_count", () => {
  const result = assessVo2(evidence(linearThree.slice(0, 2), "user_cancelled"), {
    age_years: 40,
    weight_kg: 80,
  });
  assert.equal(result.accepted_stage_count, 2);
  assert.equal(result.eligible_stage_count, 2);
  assert.equal(result.reason_codes.includes("too_few_accepted_stages"), true);
  const detail = vo2InsufficientDetail(result);
  assert.match(detail, /Only 2 stable work stages were completed/);
  assert.equal(detail.includes("usable heart-rate"), false);
});

test("too_few_eligible_stages describes eligible_stage_count not accepted_stage_count", () => {
  const stages = [
    acceptedStage("vo2-stage:1", 100, 109),
    acceptedStage("vo2-stage:2", 125, 120),
    acceptedStage("vo2-stage:3", 150, 130),
  ];
  const result = assessVo2(evidence(stages), { age_years: 40, weight_kg: 80 });
  assert.equal(result.accepted_stage_count, 3);
  assert.equal(result.eligible_stage_count, 2);
  assert.equal(result.reason_codes.includes("too_few_eligible_stages"), true);
  const detail = vo2InsufficientDetail({
    reason_codes: result.reason_codes,
    accepted_stage_count: result.accepted_stage_count,
    eligible_stage_count: result.eligible_stage_count,
  });
  assert.match(detail, /Only 2 of your stable work stages had usable heart-rate and workload data/);
  assert.match(detail, /At least 3 valid submaximal stages are required/);
  assert.equal(detail.includes("Only 3 stable work stages"), false);
});

test("three accepted and eligible stages are not described as insufficient", () => {
  const result = assessVo2(evidence(linearThree), { age_years: 40, weight_kg: 80 });
  assert.equal(result.accepted_stage_count, 3);
  assert.equal(result.eligible_stage_count, 3);
  assert.equal(result.status, "estimated");
  assert.equal(result.reason_codes.includes("too_few_accepted_stages"), false);
  assert.equal(result.reason_codes.includes("too_few_eligible_stages"), false);
  const view = vo2AssessmentPresentation(result);
  assert.equal(view.estimated, true);
  assert.equal(view.detail.includes("Only"), false);
});

test("missing profile result tells the user where to add age and weight", () => {
  const result = assessVo2(evidence(linearThree), {});
  const detail = vo2InsufficientDetail(result);
  assert.match(detail, /age and body weight/i);
  assert.match(detail, /Settings → Profile/);
  const view = vo2AssessmentPresentation(result);
  assert.equal(view.estimated, false);
  assert.equal(view.detail, detail);
});

test("history has no VO2 line when assessment is absent", () => {
  assert.equal(vo2HistoryOutcomeText(undefined), null);
});

test("VO2 stop labels and limit-reached visibility", () => {
  assert.equal(vo2EndWorkoutButtonLabel(true), "End test");
  assert.equal(vo2EndWorkoutButtonLabel(false), "Yes, end and save");
  assert.equal(vo2CancelModalTitle(true), "End test?");
  assert.equal(vo2CancelModalTitle(false), "End workout?");
  assert.equal(vo2LimitReachedButtonVisible(true, true), true);
  assert.equal(vo2LimitReachedButtonVisible(true, false), false);
  assert.equal(vo2LimitReachedButtonVisible(false, true), false);
});

test("selector and blocks describe duration as an upper bound", () => {
  assert.equal(vo2SelectorOptionText(), "VO2 Max Estimation (up to 30 min)");
  const blocks = vo2PlanBlocks();
  assert.match(vo2WorkoutBlocksText(blocks), /up to 20 min/);
  assert.equal(genericWorkoutBlocksText(blocks).includes("up to"), false);
});
