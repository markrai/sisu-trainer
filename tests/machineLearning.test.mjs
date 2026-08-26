import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCompletedWorkoutLearning,
  applyConservativeUpdate,
  deriveLearningCandidate,
  getLearnedStartingResistance,
  LEARNING_STORAGE_KEY,
  learningKey,
  listLearnedStarts,
  loadLearnedStore,
  lookupLearnedWorkStart,
  putLearnedStart,
  resetLearnedGuidanceForMachine,
  workDurationClass,
} from "../dist/machines/learning/index.js";
import { EQUIPMENT_STORAGE_KEY, setSelectedMachine } from "../dist/machines/selection.js";
import {
  recordMachineHeartRateSample,
  resetMachineGuidanceRuntime,
  updateMachineGuidanceRuntime,
} from "../dist/machines/runtime.js";

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

function qualifyingHr(windows, bpm = 165) {
  const samples = [];
  for (const window of windows) {
    const start = Math.floor(window.start);
    for (let elapsed = start; elapsed < start + 8; elapsed++) {
      samples.push({ elapsedSeconds: elapsed, bpm });
    }
  }
  return samples;
}

function workPhase(resistance, index, extras = {}) {
  const work = extras.work ?? 60;
  const recovery = extras.recovery ?? 60;
  const elapsed = (extras.workStart ?? 0) + index * (work + recovery);
  return {
    elapsedSeconds: elapsed,
    resistance,
    cadenceRpm: 70,
    estimatedWatts: 134,
    phaseKind: "work",
    phaseId: `work:${index + 1}`,
    intervalIndex: index + 1,
    phaseDurationSeconds: work,
    phaseElapsedSeconds: 0,
    targetHeartRateMin: extras.targetMin ?? 160,
    targetHeartRateMax: extras.targetMax ?? 170,
    reason: "work",
  };
}

function recoveryPhase(index, extras = {}) {
  const work = extras.work ?? 60;
  const recovery = extras.recovery ?? 60;
  const elapsed = (extras.workStart ?? 0) + work + index * (work + recovery);
  return {
    elapsedSeconds: elapsed,
    resistance: 2,
    cadenceRpm: 63,
    phaseKind: "recovery",
    phaseId: `recovery:${index + 1}`,
    phaseDurationSeconds: recovery,
    phaseElapsedSeconds: 0,
    targetHeartRateMin: 120,
    targetHeartRateMax: 135,
    reason: "recovery",
  };
}

function intervalTrace(workResistances, extras = {}) {
  const trace = [];
  workResistances.forEach((resistance, index) => {
    trace.push(workPhase(resistance, index, extras));
    if (index < workResistances.length - 1) trace.push(recoveryPhase(index, extras));
  });
  return trace;
}

function bikeSummary(overrides = {}) {
  return {
    external_session_id: "learn-1",
    startedAt: "2026-08-26T12:00:00.000Z",
    endedAt: "2026-08-26T12:40:00.000Z",
    category: "cardio",
    intent: "vo2_primer",
    duration_minutes: 40,
    primary_zone: 4,
    stress_profile: "high",
    zone_minutes: { z1: 5, z2: 5, z3: 5, z4: 20, z5: 5 },
    hr_trace: { sampling_interval_seconds: 60, samples: [] },
    activity: "bike",
    machine_id: "proform-smart-power-10",
    machine_profile_version: 1,
    machine_guidance_trace: intervalTrace([11, 12, 12, 12, 12, 12]),
    ...overrides,
  };
}

const vo2ShortKey = {
  machineId: "proform-smart-power-10",
  machineProfileVersion: 1,
  activity: "bike",
  intent: "vo2_primer",
  durationClass: "short",
};

test("learned store starts empty and round-trips", () => {
  const storage = memoryStorage();
  assert.deepEqual(loadLearnedStore(storage), { version: 1, entries: {} });
  putLearnedStart(vo2ShortKey, { resistance: 12, sampleCount: 1, updatedAt: "2026-08-26T12:00:00.000Z" }, storage);
  const loaded = loadLearnedStore(storage);
  assert.equal(loaded.version, 1);
  assert.equal(loaded.entries[learningKey(vo2ShortKey)].resistance, 12);
  assert.equal(JSON.parse(storage.getItem(LEARNING_STORAGE_KEY)).version, 1);
});

test("malformed learned JSON and invalid entries are discarded", () => {
  assert.deepEqual(loadLearnedStore(memoryStorage({ [LEARNING_STORAGE_KEY]: "{not json" })), { version: 1, entries: {} });
  const storage = memoryStorage({
    [LEARNING_STORAGE_KEY]: JSON.stringify({
      version: 1,
      entries: {
        "unknown-bike|1|bike|vo2_primer|short": { resistance: 12, sampleCount: 1, updatedAt: "t" },
        "proform-smart-power-10|1|bike|vo2_primer|short": { resistance: 16, sampleCount: 1, updatedAt: "t" },
        "proform-smart-power-10|1|bike|vo2_primer|short-bad": { resistance: 12, sampleCount: 1, updatedAt: "t" },
        "proform-smart-power-10|1|bike|vo2_primer|short": { resistance: 0, sampleCount: 1, updatedAt: "t" },
        [learningKey(vo2ShortKey)]: { resistance: 12, sampleCount: 2, updatedAt: "2026-08-26T12:00:00.000Z" },
      },
    }),
  });
  const loaded = loadLearnedStore(storage);
  assert.deepEqual(Object.keys(loaded.entries), [learningKey(vo2ShortKey)]);
  assert.equal(loaded.entries[learningKey(vo2ShortKey)].resistance, 12);
});

test("reset removes ProForm learned values without changing equipment selection", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  putLearnedStart(vo2ShortKey, { resistance: 12, sampleCount: 1, updatedAt: "t" }, storage);
  putLearnedStart(
    { ...vo2ShortKey, intent: "threshold", durationClass: "long" },
    { resistance: 9, sampleCount: 1, updatedAt: "t" },
    storage
  );
  resetLearnedGuidanceForMachine("proform-smart-power-10", storage);
  assert.deepEqual(loadLearnedStore(storage).entries, {});
  assert.equal(JSON.parse(storage.getItem(EQUIPMENT_STORAGE_KEY)).bike, "proform-smart-power-10");
});

test("learning keys keep intent and duration class separate", () => {
  assert.equal(workDurationClass(75), "short");
  assert.equal(workDurationClass(76), "medium");
  assert.equal(workDurationClass(150), "medium");
  assert.equal(workDurationClass(151), "long");
  const keys = [
    learningKey(vo2ShortKey),
    learningKey({ ...vo2ShortKey, intent: "threshold", durationClass: "long" }),
    learningKey({ ...vo2ShortKey, intent: "vo2_priority", durationClass: "long" }),
    learningKey({ ...vo2ShortKey, intent: "vo2_priority", durationClass: "medium" }),
    learningKey({ ...vo2ShortKey, machineProfileVersion: 2 }),
  ];
  assert.equal(new Set(keys).size, 5);
});

test("settled short intervals learn the later work median", () => {
  const trace = intervalTrace([11, 12, 12, 12, 12, 12]);
  const summary = bikeSummary({ machine_guidance_trace: trace });
  const candidate = deriveLearningCandidate(summary, qualifyingHr([{ start: 360, end: 420 }, { start: 480, end: 540 }, { start: 600, end: 660 }]));
  assert.equal(candidate?.resistance, 12);
  assert.equal(candidate?.key.durationClass, "short");
  assert.equal(candidate?.key.intent, "vo2_primer");
});

test("oscillating short intervals learn the settled later median", () => {
  const summary = bikeSummary({ machine_guidance_trace: intervalTrace([11, 12, 13, 12, 12, 12]) });
  const candidate = deriveLearningCandidate(
    summary,
    qualifyingHr([{ start: 360, end: 420 }, { start: 480, end: 540 }, { start: 600, end: 660 }])
  );
  assert.equal(candidate?.resistance, 12);
});

test("high HR does not update learned state", () => {
  const storage = memoryStorage();
  const summary = bikeSummary();
  const result = applyCompletedWorkoutLearning(
    summary,
    qualifyingHr([{ start: 360, end: 420 }, { start: 480, end: 540 }, { start: 600, end: 660 }], 180),
    storage
  );
  assert.equal(result, undefined);
  assert.equal(getLearnedStartingResistance(vo2ShortKey, storage), undefined);
});

test("missing HR does not update learned state", () => {
  const storage = memoryStorage();
  assert.equal(applyCompletedWorkoutLearning(bikeSummary(), [], storage), undefined);
  assert.equal(getLearnedStartingResistance(vo2ShortKey, storage), undefined);
});

test("cancelled workouts do not train learned guidance", () => {
  const storage = memoryStorage();
  const summary = bikeSummary({ cancelled: true });
  const result = applyCompletedWorkoutLearning(
    summary,
    qualifyingHr([{ start: 360, end: 420 }, { start: 480, end: 540 }, { start: 600, end: 660 }]),
    storage
  );
  assert.equal(result, undefined);
});

test("wrong machine or profile version does not train learned guidance", () => {
  const storage = memoryStorage();
  const hr = qualifyingHr([{ start: 360, end: 420 }, { start: 480, end: 540 }, { start: 600, end: 660 }]);
  assert.equal(applyCompletedWorkoutLearning(bikeSummary({ machine_id: "other-bike" }), hr, storage), undefined);
  assert.equal(applyCompletedWorkoutLearning(bikeSummary({ machine_profile_version: 2 }), hr, storage), undefined);
  assert.equal(getLearnedStartingResistance(vo2ShortKey, storage), undefined);
});

test("conservative updates move at most one resistance level", () => {
  assert.equal(applyConservativeUpdate({ resistance: 11, sampleCount: 1, updatedAt: "a" }, 13, "b").resistance, 12);
  assert.equal(applyConservativeUpdate({ resistance: 12, sampleCount: 2, updatedAt: "a" }, 9, "b").resistance, 11);
  const held = applyConservativeUpdate({ resistance: 12, sampleCount: 2, updatedAt: "a" }, 12, "b");
  assert.equal(held.resistance, 12);
  assert.equal(held.sampleCount, 3);
  const first = applyConservativeUpdate(undefined, 12, "b");
  assert.equal(first.resistance, 12);
  assert.equal(first.sampleCount, 1);
});

test("first qualifying workout stores the candidate directly, later ones step by one", () => {
  const storage = memoryStorage();
  const hr = qualifyingHr([{ start: 360, end: 420 }, { start: 480, end: 540 }, { start: 600, end: 660 }]);
  const first = applyCompletedWorkoutLearning(bikeSummary(), hr, storage, "2026-08-26T12:00:00.000Z");
  assert.equal(first?.resistance, 12);
  assert.equal(first?.sampleCount, 1);
  const jumped = applyCompletedWorkoutLearning(
    bikeSummary({ machine_guidance_trace: intervalTrace([13, 13, 13, 14, 14, 14]) }),
    qualifyingHr([{ start: 360, end: 420 }, { start: 480, end: 540 }, { start: 600, end: 660 }]),
    storage,
    "2026-08-26T13:00:00.000Z"
  );
  assert.equal(jumped?.resistance, 13);
  assert.equal(jumped?.sampleCount, 2);
});

test("learned short start is used once, then the controller can move away", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  putLearnedStart(vo2ShortKey, { resistance: 12, sampleCount: 1, updatedAt: "t" }, storage);
  resetMachineGuidanceRuntime("session-learned");
  const base = {
    sessionId: "session-learned",
    activity: "bike",
    phaseKind: "work",
    phaseId: "work:1",
    phaseDisplayName: "hard",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 60,
    workoutElapsedSeconds: 0,
    intervalIndex: 1,
    targetHeartRateMin: 160,
    targetHeartRateMax: 170,
    intent: "vo2_primer",
  };
  const first = updateMachineGuidanceRuntime(base, storage);
  assert.equal(first?.guidance.resistance, 12);
  assert.match(first?.guidance.reason, /Learned starting resistance/i);
  for (let elapsed = 44; elapsed <= 59; elapsed++) recordMachineHeartRateSample("session-learned", elapsed, 150);
  updateMachineGuidanceRuntime({ ...base, phaseElapsedSeconds: 59, workoutElapsedSeconds: 59 }, storage);
  updateMachineGuidanceRuntime({
    ...base,
    phaseKind: "recovery",
    phaseId: "recovery:1",
    phaseDisplayName: "easy",
    workoutElapsedSeconds: 60,
    targetHeartRateMin: 120,
    targetHeartRateMax: 135,
  }, storage);
  const second = updateMachineGuidanceRuntime({
    ...base,
    phaseId: "work:2",
    intervalIndex: 2,
    workoutElapsedSeconds: 120,
  }, storage);
  assert.equal(second?.guidance.resistance, 13);
});

test("without learned data short work still starts at R11", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  resetMachineGuidanceRuntime("session-default");
  const first = updateMachineGuidanceRuntime({
    sessionId: "session-default",
    activity: "bike",
    phaseKind: "work",
    phaseId: "work:1",
    phaseDisplayName: "hard",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 60,
    workoutElapsedSeconds: 0,
    intervalIndex: 1,
    targetHeartRateMin: 160,
    targetHeartRateMax: 170,
    intent: "vo2_primer",
  }, storage);
  assert.equal(first?.guidance.resistance, 11);
});

test("learned vo2 short values do not change threshold long starts", () => {
  const storage = memoryStorage();
  setSelectedMachine("bike", "proform-smart-power-10", storage);
  putLearnedStart(vo2ShortKey, { resistance: 12, sampleCount: 1, updatedAt: "t" }, storage);
  putLearnedStart(
    { ...vo2ShortKey, machineProfileVersion: 2 },
    { resistance: 14, sampleCount: 1, updatedAt: "t" },
    storage
  );
  resetMachineGuidanceRuntime("session-threshold");
  const long = updateMachineGuidanceRuntime({
    sessionId: "session-threshold",
    activity: "bike",
    phaseKind: "work",
    phaseId: "sustain",
    phaseDisplayName: "Workout",
    phaseElapsedSeconds: 0,
    phaseDurationSeconds: 1200,
    workoutElapsedSeconds: 600,
    targetHeartRateMin: 155,
    targetHeartRateMax: 162,
    intent: "threshold",
  }, storage);
  assert.equal(long?.guidance.resistance, 8);
  assert.equal(lookupLearnedWorkStart({
    machineId: "proform-smart-power-10",
    machineProfileVersion: 1,
    activity: "bike",
    intent: "vo2_primer",
    durationSeconds: 60,
  }, storage), 12);
  assert.equal(lookupLearnedWorkStart({
    machineId: "proform-smart-power-10",
    machineProfileVersion: 1,
    activity: "bike",
    intent: "vo2_primer",
    durationSeconds: 60,
  }, storage) !== 14, true);
  assert.equal(listLearnedStarts("proform-smart-power-10", storage).some((entry) => entry.machineProfileVersion === 2), true);
});
