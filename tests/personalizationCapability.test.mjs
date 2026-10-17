import test from "node:test";
import assert from "node:assert/strict";

import {
  PERSONALIZATION_CAPABILITIES_V1,
  personalizationShadowPrescriptionEnabledForIntensity,
  personalizationShadowPrescriptionEnabledIntensities,
} from "../dist/personalizationCapability.js";
import { PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES } from "../dist/personalizedPrescription.js";

test("shadow prescription is enabled only for aerobic_base and threshold", () => {
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("aerobic_base"), true);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("threshold"), true);

  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("warmup_easy"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("vo2_short"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("vo2_long"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("recovery"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("strength_support"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("cooldown"), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity(""), false);
  assert.equal(personalizationShadowPrescriptionEnabledForIntensity("unknown_intensity"), false);
});

test("enabled intensities derive from capability rows, not a second allowlist", () => {
  const enabledFromTable = PERSONALIZATION_CAPABILITIES_V1.filter((row) => row.shadowPrescription).map(
    (row) => row.intensityId
  );
  assert.deepEqual(personalizationShadowPrescriptionEnabledIntensities(), enabledFromTable);
  for (const intensityId of personalizationShadowPrescriptionEnabledIntensities()) {
    assert.equal(personalizationShadowPrescriptionEnabledForIntensity(intensityId), true);
  }
});

test("current shadow capability set equals immutable E1 schema-v1 allowedIntensities", () => {
  // Tripwire: if PERSONALIZATION_CAPABILITIES_V1 enables another shadow intensity,
  // current capability behavior no longer fits E1 schema v1 — version the
  // policy/evaluation contract deliberately before widening writes.
  assert.deepEqual(PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES, ["aerobic_base", "threshold"]);
  assert.deepEqual(
    personalizationShadowPrescriptionEnabledIntensities(),
    [...PERSONALIZED_PRESCRIPTION_V1_ALLOWED_INTENSITIES]
  );
});
