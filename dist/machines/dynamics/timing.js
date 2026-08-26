import { integerMedian } from "../hrQuality.js";
export const MIN_TRUSTED_DELAY_SAMPLES = 5;
export const MAX_DELAY_MAD_SECONDS = 10;
export const DEFAULT_MEDIUM_INITIAL_SECONDS = 60;
export const DEFAULT_LONG_INITIAL_SECONDS = 90;
export const DEFAULT_LONG_COOLDOWN_SECONDS = 60;
export const MEDIUM_DELAY_PADDING_SECONDS = 15;
export const LONG_INITIAL_PADDING_SECONDS = 20;
export const COOLDOWN_PADDING_SECONDS = 15;
export const MAX_MEDIUM_INITIAL_SECONDS = 90;
export const MAX_LONG_INITIAL_SECONDS = 120;
export const MAX_LONG_COOLDOWN_SECONDS = 90;
export const MEDIUM_EVALUATION_TAIL_SECONDS = 10;
function finiteDelaySamples(samples) {
    return samples.filter((value) => Number.isInteger(value) && Number.isFinite(value));
}
export function delayMedianAbsoluteDeviation(samples) {
    const values = finiteDelaySamples(samples);
    const median = integerMedian(values);
    if (median === undefined)
        return undefined;
    const deviations = values.map((value) => Math.abs(value - median));
    return integerMedian(deviations);
}
export function trustedDelayMedian(samples) {
    const values = finiteDelaySamples(samples);
    if (values.length < MIN_TRUSTED_DELAY_SAMPLES)
        return undefined;
    const median = integerMedian(values);
    if (median === undefined)
        return undefined;
    const mad = delayMedianAbsoluteDeviation(values);
    if (mad === undefined || mad > MAX_DELAY_MAD_SECONDS)
        return undefined;
    return median;
}
function laterOnly(value, floor, cap) {
    return Math.min(cap, Math.max(floor, value));
}
export function deriveMediumInitialEvaluationSeconds(trustedMedian, phaseDurationSeconds) {
    if (trustedMedian === undefined)
        return DEFAULT_MEDIUM_INITIAL_SECONDS;
    const candidate = laterOnly(trustedMedian + MEDIUM_DELAY_PADDING_SECONDS, DEFAULT_MEDIUM_INITIAL_SECONDS, MAX_MEDIUM_INITIAL_SECONDS);
    const latestUseful = phaseDurationSeconds - MEDIUM_EVALUATION_TAIL_SECONDS;
    if (latestUseful < DEFAULT_MEDIUM_INITIAL_SECONDS)
        return DEFAULT_MEDIUM_INITIAL_SECONDS;
    return Math.min(candidate, latestUseful);
}
export function deriveLongInitialEvaluationSeconds(trustedMedian) {
    if (trustedMedian === undefined)
        return DEFAULT_LONG_INITIAL_SECONDS;
    return laterOnly(trustedMedian + LONG_INITIAL_PADDING_SECONDS, DEFAULT_LONG_INITIAL_SECONDS, MAX_LONG_INITIAL_SECONDS);
}
export function deriveLongCooldownSeconds(trustedMedian) {
    if (trustedMedian === undefined)
        return DEFAULT_LONG_COOLDOWN_SECONDS;
    return laterOnly(trustedMedian + COOLDOWN_PADDING_SECONDS, DEFAULT_LONG_COOLDOWN_SECONDS, MAX_LONG_COOLDOWN_SECONDS);
}
export function derivePersonalizedMachineTiming(entry, phaseDurationSeconds) {
    if (!entry || phaseDurationSeconds <= 75)
        return undefined;
    const workStartMedian = trustedDelayMedian(entry.workStartDelays);
    const timing = {};
    if (phaseDurationSeconds <= 150) {
        const initial = deriveMediumInitialEvaluationSeconds(workStartMedian, phaseDurationSeconds);
        if (initial > DEFAULT_MEDIUM_INITIAL_SECONDS)
            timing.initialEvaluationSeconds = initial;
    }
    else {
        const initial = deriveLongInitialEvaluationSeconds(workStartMedian);
        if (initial > DEFAULT_LONG_INITIAL_SECONDS)
            timing.initialEvaluationSeconds = initial;
        const increase = deriveLongCooldownSeconds(trustedDelayMedian(entry.increaseDelays));
        if (increase > DEFAULT_LONG_COOLDOWN_SECONDS)
            timing.increaseCooldownSeconds = increase;
        const decrease = deriveLongCooldownSeconds(trustedDelayMedian(entry.decreaseDelays));
        if (decrease > DEFAULT_LONG_COOLDOWN_SECONDS)
            timing.decreaseCooldownSeconds = decrease;
    }
    return timing.initialEvaluationSeconds !== undefined ||
        timing.increaseCooldownSeconds !== undefined ||
        timing.decreaseCooldownSeconds !== undefined
        ? timing
        : undefined;
}
export function hasActiveTimingPersonalization(entry, durationClass) {
    if (durationClass === "short")
        return false;
    const representativeDuration = durationClass === "medium" ? 120 : 240;
    return derivePersonalizedMachineTiming(entry, representativeDuration) !== undefined;
}
