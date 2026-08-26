import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  clampAutomaticResistance,
  getEstimatedWattsAt70Rpm,
  getProFormSmartPower10Guidance,
} from "../dist/machines/proformSmartPower10.js";
import { createMachineGuidanceState, getMachineGuidance } from "../dist/machines/guidance.js";
import { getMachineDefinition, listMachinesForActivity } from "../dist/machines/registry.js";
import {
  EQUIPMENT_STORAGE_KEY,
  getEquipmentSelection,
  resolveSelectedMachine,
  setSelectedMachine,
} from "../dist/machines/selection.js";
import {
  getMachineUsageSnapshot,
  recordMachineHeartRateSample,
  resetMachineGuidanceRuntime,
  updateMachineGuidanceRuntime,
} from "../dist/machines/runtime.js";
import { formatMachineGuidanceSpeech, getMachineGuidanceVoiceKey } from "../dist/voice.js";
import { buildSisuWorkoutPayload } from "../dist/sisuSync.js";
import { applyMachineUsageToSummary } from "../dist/workoutSummary.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

function recent(bpm, count = 11) {
  return Array.from({ length: count }, (_, index) => ({ elapsedSeconds: index, bpm }));
}

function context(overrides = {}) {
  return {
    machineId: "proform-smart-power-10",
    activity: "bike",
    phaseKind: "work",
    phaseId: "work:1",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 60,
    workoutElapsedSeconds: 0,
    intervalIndex: 1,
    targetHeartRateMin: 160,
    targetHeartRateMax: 170,
    recentHeartRates: [],
    ...overrides,
  };
}

test("registry resolves only the supported ProForm bike", () => {
  const machine = getMachineDefinition("proform-smart-power-10");
  assert.equal(machine?.name, "ProForm SMART Power 10.0");
  assert.equal(machine?.activity, "bike");
  assert.deepEqual(listMachinesForActivity("bike").map((entry) => entry.id), ["proform-smart-power-10"]);
  assert.equal(getMachineDefinition("unknown-machine"), undefined);
});

test("empirical calibration is limited to resistance 1 through 15", () => {
  assert.equal(getEstimatedWattsAt70Rpm(1), 66);
  assert.equal(getEstimatedWattsAt70Rpm(8), 108);
  assert.equal(getEstimatedWattsAt70Rpm(15), 201);
  assert.equal(getEstimatedWattsAt70Rpm(16), undefined);
  assert.equal(clampAutomaticResistance(16), 15);
});

test("recovery starts easy, never reacts upward to low HR, and can reduce to one", () => {
  let result = getProFormSmartPower10Guidance(
    context({ phaseKind: "recovery", phaseId: "recovery:1", phaseDurationSeconds: 60, targetHeartRateMin: 120, targetHeartRateMax: 135 }),
    createMachineGuidanceState()
  );
  assert.equal(result.guidance.resistance, 2);
  assert.equal(result.guidance.cadenceRpm, 63);
  assert.equal(result.guidance.estimatedWatts, undefined);
  result = getProFormSmartPower10Guidance(
    context({ phaseKind: "recovery", phaseId: "recovery:1", phaseElapsedSeconds: 40, phaseDurationSeconds: 60, targetHeartRateMin: 120, targetHeartRateMax: 135, recentHeartRates: recent(105) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 2);
  result = getProFormSmartPower10Guidance(
    context({ phaseKind: "recovery", phaseId: "recovery:1", phaseElapsedSeconds: 45, phaseDurationSeconds: 60, targetHeartRateMin: 120, targetHeartRateMax: 135, recentHeartRates: recent(140) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 1);
  result = getProFormSmartPower10Guidance(
    context({ phaseKind: "recovery", phaseId: "recovery:1", phaseElapsedSeconds: 50, phaseDurationSeconds: 60, targetHeartRateMin: 120, targetHeartRateMax: 135, recentHeartRates: recent(145) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 1);
});

test("short intervals hold during the rep and adapt only the next repetition", () => {
  let state = createMachineGuidanceState();
  let result = getProFormSmartPower10Guidance(context(), state);
  assert.equal(result.guidance.resistance, 11);
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 30, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 11);
  assert.equal(result.state.nextWorkResistance, 11);
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 45, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 11);
  assert.equal(result.state.nextWorkResistance, 12);
  result = getProFormSmartPower10Guidance(
    context({ phaseId: "work:2", workoutElapsedSeconds: 120, intervalIndex: 2 }),
    result.state
  );
  assert.equal(result.guidance.resistance, 12);
});

test("short-interval final HR holds in range and reduces when high", () => {
  let result = getProFormSmartPower10Guidance(context(), createMachineGuidanceState());
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 45, recentHeartRates: recent(165) }),
    result.state
  );
  assert.equal(result.state.nextWorkResistance, 11);

  result = getProFormSmartPower10Guidance(context(), createMachineGuidanceState());
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 45, recentHeartRates: recent(175) }),
    result.state
  );
  assert.equal(result.state.nextWorkResistance, 10);
});

test("short-interval automatic guidance never exceeds resistance 15", () => {
  const state = { ...createMachineGuidanceState(), nextWorkResistance: 15 };
  let result = getProFormSmartPower10Guidance(context(), state);
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 45, recentHeartRates: recent(140) }),
    result.state
  );
  assert.equal(result.state.nextWorkResistance, 15);
});

test("medium intervals wait 60 seconds and adjust at most once", () => {
  const medium = context({ phaseDurationSeconds: 120 });
  let result = getProFormSmartPower10Guidance(medium, createMachineGuidanceState());
  assert.equal(result.guidance.resistance, 10);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, phaseElapsedSeconds: 59, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 10);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, phaseElapsedSeconds: 60, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 11);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 120, phaseElapsedSeconds: 100, recentHeartRates: recent(145) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 11);
});

test("long intervals stabilize for 90 seconds and enforce a 60-second cooldown", () => {
  let result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240 }),
    createMachineGuidanceState()
  );
  assert.equal(result.guidance.resistance, 8);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 89, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 8);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 90, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 120, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 150, recentHeartRates: recent(150) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 10);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 210, recentHeartRates: recent(175) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
  result = getProFormSmartPower10Guidance(
    context({ phaseDurationSeconds: 240, phaseElapsedSeconds: 270, recentHeartRates: recent(165) }),
    result.state
  );
  assert.equal(result.guidance.resistance, 9);
});

test("resistance 13 and 14 require a five-bpm deficit and resistance 15 cannot increase", () => {
  for (const resistance of [13, 14]) {
    let result = getProFormSmartPower10Guidance(
      context(),
      { ...createMachineGuidanceState(), nextWorkResistance: resistance }
    );
    result = getProFormSmartPower10Guidance(
      context({ phaseElapsedSeconds: 45, recentHeartRates: recent(156) }),
      result.state
    );
    assert.equal(result.state.nextWorkResistance, resistance);

    result = getProFormSmartPower10Guidance(
      context(),
      { ...createMachineGuidanceState(), nextWorkResistance: resistance }
    );
    result = getProFormSmartPower10Guidance(
      context({ phaseElapsedSeconds: 45, recentHeartRates: recent(155) }),
      result.state
    );
    assert.equal(result.state.nextWorkResistance, resistance + 1);
  }

  let result = getProFormSmartPower10Guidance(
    context(),
    { ...createMachineGuidanceState(), nextWorkResistance: 15 }
  );
  result = getProFormSmartPower10Guidance(
    context({ phaseElapsedSeconds: 45, recentHeartRates: recent(140) }),
    result.state
  );
  assert.equal(result.state.nextWorkResistance, 15);
});

test("generic guidance applies only to a matching selected activity", () => {
  assert.ok(getMachineGuidance(context(), createMachineGuidanceState()));
  assert.equal(
    getMachineGuidance(context({ activity: "elliptical" }), createMachineGuidanceState()),
    null
  );
  const empty = memoryStorage();
  assert.equal(resolveSelectedMachine("bike", empty), undefined);
  const selected = setSelectedMachine("bike", "proform-smart-power-10", empty);
  assert.equal(selected.bike, "proform-smart-power-10");
  assert.equal(resolveSelectedMachine("bike", empty)?.id, "proform-smart-power-10");
  assert.equal(resolveSelectedMachine("elliptical", empty), undefined);
});

test("equipment selection round-trips independently", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  assert.deepEqual(getEquipmentSelection(storage), { bike: "proform-smart-power-10" });
  assert.equal(storage.getItem(EQUIPMENT_STORAGE_KEY), '{"bike":"proform-smart-power-10"}');
  setSelectedMachine("bike", undefined, storage);
  assert.deepEqual(getEquipmentSelection(storage), {});
});

test("runtime emits one voice event and trace entry per changed recommendation", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  resetMachineGuidanceRuntime("session-1");
  const input = {
    sessionId: "session-1",
    activity: "bike",
    phaseKind: "work",
    phaseId: "work:1",
    phaseDisplayName: "hard",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 60,
    workoutElapsedSeconds: 720,
    intervalIndex: 1,
    targetHeartRateMin: 160,
    targetHeartRateMax: 170,
  };
  const first = updateMachineGuidanceRuntime(input, storage);
  assert.ok(first?.voiceEvent);
  assert.match(formatMachineGuidanceSpeech(first.voiceEvent), /^Interval 1\. Resistance 11\. Hold 70 RPM\.$/);
  const firstKey = getMachineGuidanceVoiceKey(first.voiceEvent);
  assert.equal(firstKey, getMachineGuidanceVoiceKey(first.voiceEvent));
  const second = updateMachineGuidanceRuntime({ ...input, phaseElapsedSeconds: 1, workoutElapsedSeconds: 721 }, storage);
  assert.equal(second?.voiceEvent, null);
  let snapshot = getMachineUsageSnapshot("session-1");
  assert.equal(snapshot?.machineId, "proform-smart-power-10");
  assert.equal(snapshot?.profileVersion, 1);
  assert.equal(snapshot?.guidanceTrace.length, 1);
  const warmup = updateMachineGuidanceRuntime({
    ...input,
    phaseKind: "warmup",
    phaseId: "warmup",
    phaseDisplayName: "Warm-Up",
    phaseDurationSeconds: 600,
    workoutElapsedSeconds: 10,
    intervalIndex: undefined,
  }, storage);
  assert.ok(warmup?.voiceEvent);
  snapshot = getMachineUsageSnapshot("session-1");
  assert.equal(snapshot?.guidanceTrace.length, 2);
});

test("runtime uses only the bounded recent HR window", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  resetMachineGuidanceRuntime("session-2");
  recordMachineHeartRateSample("session-2", 1, 190);
  for (let elapsed = 31; elapsed <= 45; elapsed++) recordMachineHeartRateSample("session-2", elapsed, 150);
  const update = updateMachineGuidanceRuntime({
    sessionId: "session-2",
    activity: "bike",
    phaseKind: "work",
    phaseId: "work:1",
    phaseDisplayName: "hard",
    phaseElapsedSeconds: 45,
    phaseDurationSeconds: 60,
    workoutElapsedSeconds: 45,
    intervalIndex: 1,
    targetHeartRateMin: 160,
    targetHeartRateMax: 170,
  }, storage);
  assert.equal(update?.guidance.resistance, 11);
  const next = updateMachineGuidanceRuntime({
    sessionId: "session-2",
    activity: "bike",
    phaseKind: "work",
    phaseId: "work:2",
    phaseDisplayName: "hard",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 60,
    workoutElapsedSeconds: 120,
    intervalIndex: 2,
    targetHeartRateMin: 160,
    targetHeartRateMax: 170,
  }, storage);
  assert.equal(next?.guidance.resistance, 12);
});

test("SISU payload omits local-only machine metadata", () => {
  const payload = buildSisuWorkoutPayload({
    external_session_id: "session-3",
    day: "Monday",
    intent: "vo2_primer",
    machine_id: "proform-smart-power-10",
    machine_profile_version: 1,
    machine_guidance_trace: [{ elapsedSeconds: 0, resistance: 11, cadenceRpm: 70, reason: "start" }],
  });
  assert.deepEqual(payload, {
    external_session_id: "session-3",
    day: "Monday",
    intent: "vo2_primer",
  });
});

test("workout history receives machine identity, profile version, and change-only trace", () => {
  const summary = { external_session_id: "session-4" };
  const trace = [{ elapsedSeconds: 0, resistance: 11, cadenceRpm: 70, estimatedWatts: 134, reason: "start" }];
  applyMachineUsageToSummary(summary, {
    machineId: "proform-smart-power-10",
    profileVersion: 1,
    guidanceTrace: trace,
  });
  assert.equal(summary.machine_id, "proform-smart-power-10");
  assert.equal(summary.machine_profile_version, 1);
  assert.deepEqual(summary.machine_guidance_trace, trace);
});

test("workout definitions use activities and structured interval kinds", async () => {
  const data = JSON.parse(await readFile(new URL("../data.json", import.meta.url), "utf8"));
  const serialized = JSON.stringify(data);
  assert.equal(serialized.includes('"machine"'), false);
  assert.equal(serialized.includes("Bike or Elliptical"), false);
  assert.deepEqual(data.weekly_plan[0].activities, ["bike"]);
  assert.equal(data.weekly_plan[0].main_set.intervals[0].kind, "work");
  assert.equal(data.weekly_plan[0].main_set.intervals[1].kind, "recovery");
});
