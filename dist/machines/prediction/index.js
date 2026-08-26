import { getHrSamples } from "../../workoutStorage.js";
import { loadDynamicsStore } from "../dynamics/storage.js";
import { deriveShadowResistancePredictions } from "./derive.js";
import { persistShadowPredictions, } from "./storage.js";
export { MAX_SHADOW_DOSE_MAD_BPM, MAX_SHADOW_RESISTANCE, MAX_SHADOW_SUGGESTED_LEVELS, MIN_SHADOW_DIRECTION_CONSISTENCY, MIN_SHADOW_DOSE_SAMPLES, MIN_SHADOW_RESISTANCE, SHADOW_PREDICTION_LIMIT, SHADOW_PREDICTION_STORAGE_KEY, SHADOW_PREDICTION_STORE_VERSION, } from "./types.js";
export { deriveShadowResistancePredictions, } from "./derive.js";
export { directionMatched, predictedHrDeltaForActualStep, shadowDecreaseSuggestion, shadowIncreaseSuggestion, trustedDirectionalHrPerLevelEstimate, } from "./estimate.js";
export { appendBoundedPredictions, emptyShadowPredictionStore, getShadowPredictionEntry, listShadowPredictions, loadShadowPredictionStore, persistShadowPredictions, resetShadowPredictionsForMachine, saveShadowPredictionStore, sanitizeShadowPredictionStore, } from "./storage.js";
export function applyCompletedWorkoutShadowPredictions(summary, hrSamples, storage, updatedAt = new Date().toISOString()) {
    const preWorkoutDynamics = loadDynamicsStore(storage);
    const predictions = deriveShadowResistancePredictions(summary, hrSamples, preWorkoutDynamics.entries);
    if (predictions.length === 0)
        return [];
    return persistShadowPredictions(predictions, storage, updatedAt);
}
export function learnShadowPredictionsFromSamples(summary, hrSamples, storage, updatedAt = new Date().toISOString()) {
    try {
        return applyCompletedWorkoutShadowPredictions(summary, hrSamples, storage, updatedAt);
    }
    catch (error) {
        console.error("Machine shadow-resistance prediction failed:", error);
        return [];
    }
}
export async function learnShadowPredictionsFromCompletedWorkout(summary, storage) {
    if (summary.cancelled)
        return [];
    try {
        const samples = await getHrSamples(summary.external_session_id);
        return learnShadowPredictionsFromSamples(summary, samples.map((sample) => ({ elapsedSeconds: sample.timestamp_sec, bpm: sample.hr })), storage);
    }
    catch (error) {
        console.error("Machine shadow-resistance prediction failed:", error);
        return [];
    }
}
