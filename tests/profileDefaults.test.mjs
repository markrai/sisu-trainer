import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  BLANK_PROFILE,
  getProfile,
  parseExplicitVo2ProfileInputs,
  PROFILE_WEIGHT_LBS_TO_KG,
} from "../dist/profile.js";
import { calculateZoneMinutes, mapHrToZone } from "../dist/zoneCalculator.js";
import { adjustedBlockLengths } from "../dist/workoutLogic.js";
import { assessVo2 } from "../dist/vo2Estimator.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("unset profile stays blank and is not an explicit VO2 input", () => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  try {
    const profile = getProfile();
    assert.deepEqual(profile, BLANK_PROFILE);
    assert.equal(profile.age, "");
    assert.equal(profile.weight, "");
    assert.equal(profile.height, "");
    assert.equal(profile.sex, "");
    assert.equal(profile.vo2, "");
    assert.deepEqual(parseExplicitVo2ProfileInputs(profile), {});
    assert.deepEqual(parseExplicitVo2ProfileInputs(BLANK_PROFILE), {});
  } finally {
    globalThis.localStorage = previous;
  }
});

test("saved user-confirmed age and weight remain explicit VO2 inputs", () => {
  const parsed = parseExplicitVo2ProfileInputs({ age: "40", weight: "176.37", sex: "female", height: "66", vo2: "" });
  assert.equal(parsed.age_years, 40);
  assert.ok(Math.abs(parsed.weight_kg - 176.37 * PROFILE_WEIGHT_LBS_TO_KG) < 1e-6);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "sex"), false);
});

test("placeholder-like numbers would become VO2 inputs only if actually stored", () => {
  const storedDefaults = parseExplicitVo2ProfileInputs({ age: 25, weight: 150, sex: "male", height: 70, vo2: "" });
  assert.equal(storedDefaults.age_years, 25);
  assert.ok(storedDefaults.weight_kg > 0);
  assert.deepEqual(parseExplicitVo2ProfileInputs(BLANK_PROFILE), {});
});

test("HR zones do not use profile age, weight, height, or sex", () => {
  assert.equal(mapHrToZone(100), 1);
  assert.equal(mapHrToZone(120), 2);
  assert.equal(mapHrToZone(140), 3);
  const minutes = calculateZoneMinutes([
    { session_id: "zones", timestamp_sec: 0, hr: 120 },
    { session_id: "zones", timestamp_sec: 1, hr: 120 },
  ]);
  assert.deepEqual(Object.keys(minutes).sort(), ["z1", "z2", "z3", "z4", "z5"]);
  assert.equal(typeof minutes.z1, "number");
  assert.equal(typeof minutes.z2, "number");
});

test("ordinary workout length is independent of blank profile", () => {
  const blocks = { warm: 5, sustain: 25, cool: 5 };
  assert.deepEqual(adjustedBlockLengths(blocks, null), blocks);
  assert.deepEqual(adjustedBlockLengths(blocks, { hrv: 80 }), blocks);
});

test("blank profile cannot produce a VO2 estimate", () => {
  const result = assessVo2(
    {
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
        stages: [],
        termination: { reason: "protocol_complete" },
        automatic_submax_hr_ceiling_available: false,
      },
    },
    parseExplicitVo2ProfileInputs(BLANK_PROFILE)
  );
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.reason_codes.includes("missing_profile_age"), true);
  assert.equal(result.reason_codes.includes("missing_profile_weight"), true);
});

test("non-VO2 profile consumers do not import getProfile", async () => {
  const files = [
    "zoneCalculator.ts",
    "workoutData.ts",
    "workoutLogic.ts",
    "workoutActivity.ts",
    "machines/guidance.ts",
    "machines/runtime.ts",
    "downregulation/index.ts",
    "sisuSync.ts",
  ];
  for (const relative of files) {
    const src = await readFile(new URL("../src/" + relative, import.meta.url), "utf8");
    assert.equal(src.includes("from \"./profile.js\""), false, relative);
    assert.equal(src.includes("from \"../profile.js\""), false, relative);
    assert.equal(src.includes("getProfile("), false, relative);
  }
  const summary = await readFile(new URL("../src/workoutSummary.ts", import.meta.url), "utf8");
  assert.equal(summary.includes("readExplicitVo2ProfileInputs"), true);
  assert.match(summary, /if \(isVo2WorkoutSelector\(day\)\) \{[\s\S]*readExplicitVo2ProfileInputs/);
});
