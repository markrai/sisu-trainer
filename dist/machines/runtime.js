import { createMachineGuidanceState, getMachineGuidance, isSameMachineRecommendation } from "./guidance.js";
import { getMachineDefinition } from "./registry.js";
import { getSelectedMachineId } from "./selection.js";
function newRuntimeState(sessionId) {
    return {
        sessionId,
        guidanceState: createMachineGuidanceState(),
        recentHeartRates: [],
        trace: [],
    };
}
let runtime = newRuntimeState(null);
export function resetMachineGuidanceRuntime(sessionId = null) {
    runtime = newRuntimeState(sessionId);
}
function ensureSession(sessionId) {
    if (runtime.sessionId !== sessionId)
        resetMachineGuidanceRuntime(sessionId);
}
export function recordMachineHeartRateSample(sessionId, elapsedSeconds, bpm) {
    if (!sessionId || !Number.isFinite(bpm) || bpm <= 0)
        return;
    ensureSession(sessionId);
    runtime.recentHeartRates.push({ elapsedSeconds, bpm });
    const cutoff = elapsedSeconds - 15;
    runtime.recentHeartRates = runtime.recentHeartRates
        .filter((sample) => sample.elapsedSeconds >= cutoff)
        .slice(-32);
}
export function appendMachineGuidanceTrace(trace, elapsedSeconds, guidance, previous) {
    if (isSameMachineRecommendation(previous, guidance))
        return [...trace];
    if (guidance.resistance === undefined || guidance.cadenceRpm === undefined)
        return [...trace];
    const entry = {
        elapsedSeconds,
        resistance: guidance.resistance,
        cadenceRpm: guidance.cadenceRpm,
        reason: guidance.reason,
    };
    if (guidance.estimatedWatts !== undefined)
        entry.estimatedWatts = guidance.estimatedWatts;
    return [...trace, entry];
}
export function updateMachineGuidanceRuntime(input, storage) {
    ensureSession(input.sessionId);
    runtime.recentHeartRates = runtime.recentHeartRates.filter((sample) => sample.elapsedSeconds >= input.workoutElapsedSeconds - 15 &&
        sample.elapsedSeconds <= input.workoutElapsedSeconds);
    const machineId = getSelectedMachineId(input.activity, storage);
    if (!machineId)
        return null;
    const machine = getMachineDefinition(machineId);
    if (!machine || machine.activity !== input.activity)
        return null;
    if (runtime.machineId !== machineId) {
        runtime.machineId = machineId;
        runtime.guidanceState = createMachineGuidanceState();
        runtime.previousGuidance = undefined;
        runtime.trace = [];
        runtime.lastPhaseId = undefined;
    }
    const phaseChanged = runtime.lastPhaseId !== input.phaseId;
    const result = getMachineGuidance({
        machineId,
        activity: input.activity,
        phaseKind: input.phaseKind,
        phaseId: input.phaseId,
        phaseElapsedSeconds: input.phaseElapsedSeconds,
        phaseDurationSeconds: input.phaseDurationSeconds,
        workoutElapsedSeconds: input.workoutElapsedSeconds,
        intervalIndex: input.intervalIndex,
        heartRateBpm: input.heartRateBpm,
        targetHeartRateMin: input.targetHeartRateMin,
        targetHeartRateMax: input.targetHeartRateMax,
        recentHeartRates: runtime.recentHeartRates,
        previousGuidance: runtime.previousGuidance,
    }, runtime.guidanceState);
    if (!result)
        return null;
    const previous = runtime.previousGuidance;
    const recommendationChanged = !isSameMachineRecommendation(previous, result.guidance);
    runtime.trace = appendMachineGuidanceTrace(runtime.trace, input.workoutElapsedSeconds, result.guidance, previous);
    runtime.guidanceState = result.state;
    runtime.previousGuidance = result.guidance;
    runtime.lastPhaseId = input.phaseId;
    const voiceEvent = phaseChanged || recommendationChanged
        ? {
            machineId,
            phaseId: input.phaseId,
            phaseKind: input.phaseKind,
            phaseDisplayName: input.phaseDisplayName,
            intervalIndex: input.intervalIndex,
            phaseChanged,
            recommendationChanged,
            guidance: result.guidance,
        }
        : null;
    return {
        machine,
        guidance: result.guidance,
        recommendationChanged,
        phaseChanged,
        voiceEvent,
    };
}
export function getMachineUsageSnapshot(sessionId) {
    if (runtime.sessionId !== sessionId || !runtime.machineId)
        return null;
    const machine = getMachineDefinition(runtime.machineId);
    if (!machine)
        return null;
    return {
        machineId: machine.id,
        profileVersion: machine.profileVersion,
        guidanceTrace: runtime.trace.map((entry) => ({ ...entry })),
    };
}
