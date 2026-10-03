import assert from "node:assert/strict";
import test from "node:test";
import { getPhase, startWorkout, tickVo2Protocol } from "../dist/workoutLogic.js";
import { getSession, persistVo2ProtocolRuntime } from "../dist/sessionStore.js";
import { getPlan, installStandaloneVo2Workout } from "../dist/workoutData.js";
import {
  VO2_WORKOUT_SELECTOR_ID,
  buildVo2ProtocolPlan,
  createVo2ProtocolRuntime,
} from "../dist/vo2Protocol.js";
import {
  advanceVo2ProtocolRuntime,
  buildVo2ProtocolEvidenceForRuntime,
  vo2ProtocolUiTargetsForRuntime,
} from "../dist/vo2ProtocolV3.js";
import { VO2_PROTOCOL_VERSION_V3 } from "../dist/types.js";
import { setSelectedMachine } from "../dist/machines/selection.js";
import { migrateLegacyProfile, storeAthleteProfile } from "../dist/profile.js";

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

function installStartFakes() {
  const storage = memoryStorage();
  const prevStorage = globalThis.localStorage;
  const prevWindow = globalThis.window;
  globalThis.localStorage = storage;
  const now = Date.now();
  globalThis.window = {
    getSelectedDay: () => VO2_WORKOUT_SELECTOR_ID,
    generateUUID: () => "session-v3-start",
    hrDeviceName: "Test Strap",
    liveBpm: 80,
    lastBpmUpdateTime: now,
  };
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  const profile = migrateLegacyProfile({ age: 46, weight: 115 }, "athlete-v3", new Date(now).toISOString());
  assert.equal(storeAthleteProfile(profile, storage), true);
  installStandaloneVo2Workout();
  return () => {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  };
}

test("new athlete-started VO2 workout selects adaptive protocol v3", () => {
  const restore = installStartFakes();
  try {
    startWorkout();
    const session = getSession(VO2_WORKOUT_SELECTOR_ID);
    assert.ok(session.startTime);
    assert.equal(session.sessionId, "session-v3-start");
    const runtime = session.vo2ProtocolRuntime;
    assert.ok(runtime);
    assert.equal(runtime.plan.protocol_version, VO2_PROTOCOL_VERSION_V3);
    // Adaptive plan starts with no workloads; the planner appends them.
    assert.deepEqual(runtime.plan.workloads, []);
    assert.equal(runtime.segment, "warmup");
  } finally {
    restore();
  }
});

test("v3 session advances through the live tick and reports phase, guidance, and evidence", () => {
  const restore = installStartFakes();
  try {
    startWorkout();
    const tick = tickVo2Protocol(VO2_WORKOUT_SELECTOR_ID, 300, false);
    assert.ok(tick);
    assert.equal(tick.runtime.plan.protocol_version, VO2_PROTOCOL_VERSION_V3);
    // The persisted v3 runtime round-trips through the session store.
    const reloaded = getSession(VO2_WORKOUT_SELECTOR_ID).vo2ProtocolRuntime;
    assert.ok(reloaded);
    assert.equal(reloaded.plan.protocol_version, VO2_PROTOCOL_VERSION_V3);
    assert.equal(reloaded.plan.workloads.length, 1);
    // Bootstrap first stage: R6/86W with adaptive provenance.
    const workload = reloaded.plan.workloads[0];
    assert.equal(workload.prescribed_resistance, 6);
    assert.equal(workload.calibrated_watts_at_70rpm, 86);
    assert.equal(reloaded.stages.length, 1);
    assert.equal(reloaded.stages[0].adaptive.selected_resistance, 6);
    assert.equal(reloaded.stages[0].adaptive.reason_code, "bootstrap_first_stage");
    // The live phase follows the v3 runtime.
    const phase = getPhase(300, getPlan()[VO2_WORKOUT_SELECTOR_ID], null, { day: VO2_WORKOUT_SELECTOR_ID });
    assert.equal(phase.phaseId, "vo2-stage:1");
    assert.equal(phase.kind, "work");
    // Machine guidance follows the adaptive selected resistance.
    const targets = vo2ProtocolUiTargetsForRuntime(reloaded, phase.phaseId);
    assert.equal(targets.holdResistance, 6);
    assert.equal(targets.holdCadenceRpm, 70);
    assert.equal(targets.holdResistance, reloaded.stages[0].adaptive.selected_resistance);
    // The resulting protocol evidence reports version 3.
    const evidence = buildVo2ProtocolEvidenceForRuntime(reloaded, []);
    assert.ok(evidence);
    assert.equal(evidence.protocol_version, VO2_PROTOCOL_VERSION_V3);
    assert.equal(evidence.stages.length, 1);
  } finally {
    restore();
  }
});

test("persisted v2 sessions keep v2 semantics on every routed path", () => {
  const storage = memoryStorage();
  const plan = buildVo2ProtocolPlan();
  assert.ok(plan);
  assert.equal(plan.protocol_version, 2);
  const runtime = createVo2ProtocolRuntime(plan, { age_years: 46, weight_kg: 52.1631 });
  persistVo2ProtocolRuntime(VO2_WORKOUT_SELECTOR_ID, runtime, storage);
  const reloaded = getSession(VO2_WORKOUT_SELECTOR_ID, storage).vo2ProtocolRuntime;
  assert.ok(reloaded);
  assert.equal(reloaded.plan.protocol_version, 2);
  const next = advanceVo2ProtocolRuntime(reloaded, { elapsedSec: 300, paused: false, samples: [] });
  assert.equal(next.plan.protocol_version, 2);
  assert.equal(next.stages.length, 1);
  const targets = vo2ProtocolUiTargetsForRuntime(next, "vo2-stage:1");
  assert.equal(targets.holdResistance, next.plan.workloads[0].prescribed_resistance);
  const evidence = buildVo2ProtocolEvidenceForRuntime(next, []);
  assert.ok(evidence);
  assert.equal(evidence.protocol_version, 2);
});
