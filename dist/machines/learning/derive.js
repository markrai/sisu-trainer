import { clampAutomaticResistance } from "../proformSmartPower10.js";
import { getMachineDefinition } from "../registry.js";
import { isLearningIntent, workDurationClass, } from "./types.js";
export function integerMedian(values) {
    if (values.length === 0)
        return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)];
}
function validDistinctHr(samples) {
    const byElapsed = new Map();
    for (const sample of samples) {
        if (!Number.isFinite(sample.bpm) || sample.bpm <= 0)
            continue;
        if (!Number.isFinite(sample.elapsedSeconds))
            continue;
        byElapsed.set(sample.elapsedSeconds, sample.bpm);
    }
    return [...byElapsed.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([elapsedSeconds, bpm]) => ({ elapsedSeconds, bpm }));
}
export function rollingHrMedian(samples) {
    const distinct = validDistinctHr(samples);
    if (distinct.length < 5)
        return undefined;
    const span = distinct[distinct.length - 1].elapsedSeconds - distinct[0].elapsedSeconds;
    if (span < 4)
        return undefined;
    const values = distinct.map((sample) => sample.bpm).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
}
function collectWorkPhases(trace) {
    var _a, _b, _c;
    const grouped = new Map();
    for (const entry of trace) {
        if (entry.phaseKind !== "work" || !entry.phaseId)
            continue;
        if (!Number.isFinite(entry.phaseDurationSeconds) || entry.phaseDurationSeconds <= 0)
            continue;
        if (!Number.isInteger(entry.resistance))
            continue;
        const list = (_a = grouped.get(entry.phaseId)) !== null && _a !== void 0 ? _a : [];
        list.push(entry);
        grouped.set(entry.phaseId, list);
    }
    const phases = [];
    for (const [phaseId, entries] of grouped) {
        const ordered = [...entries].sort((a, b) => a.elapsedSeconds - b.elapsedSeconds);
        const first = ordered[0];
        const durationSeconds = first.phaseDurationSeconds;
        const phaseElapsed = Number.isFinite(first.phaseElapsedSeconds) ? first.phaseElapsedSeconds : 0;
        const startElapsed = first.elapsedSeconds - phaseElapsed;
        phases.push({
            phaseId,
            durationClass: workDurationClass(durationSeconds),
            durationSeconds,
            startElapsed,
            endElapsed: startElapsed + durationSeconds,
            entries: ordered,
            finalResistance: ordered[ordered.length - 1].resistance,
            targetHeartRateMin: (_b = ordered[ordered.length - 1].targetHeartRateMin) !== null && _b !== void 0 ? _b : first.targetHeartRateMin,
            targetHeartRateMax: (_c = ordered[ordered.length - 1].targetHeartRateMax) !== null && _c !== void 0 ? _c : first.targetHeartRateMax,
        });
    }
    return phases.sort((a, b) => a.startElapsed - b.startElapsed);
}
function lastHalf(items) {
    return items.slice(Math.floor(items.length / 2));
}
function samplesInWindows(samples, windows) {
    return samples.filter((sample) => windows.some((window) => sample.elapsedSeconds >= window.start && sample.elapsedSeconds < window.end));
}
function resistanceAtTime(phase, elapsedSeconds) {
    var _a;
    let active;
    for (const entry of phase.entries) {
        const at = phase.startElapsed + ((_a = entry.phaseElapsedSeconds) !== null && _a !== void 0 ? _a : Math.max(0, entry.elapsedSeconds - phase.startElapsed));
        if (at <= elapsedSeconds)
            active = entry.resistance;
        else
            break;
    }
    return active;
}
function longBlockCandidate(phase) {
    var _a;
    const thirdStart = phase.startElapsed + phase.durationSeconds * (2 / 3);
    const windows = [{ start: thirdStart, end: phase.endElapsed }];
    const resistances = [];
    const begin = Math.floor(thirdStart);
    const finish = Math.max(begin + 1, Math.floor(phase.endElapsed));
    for (let elapsed = begin; elapsed < finish; elapsed++) {
        const resistance = resistanceAtTime(phase, elapsed);
        if (resistance !== undefined)
            resistances.push(resistance);
    }
    if (resistances.length === 0) {
        const fallback = (_a = resistanceAtTime(phase, thirdStart)) !== null && _a !== void 0 ? _a : phase.finalResistance;
        if (fallback !== undefined)
            resistances.push(fallback);
    }
    return { resistance: integerMedian(resistances), windows };
}
function repeatedIntervalCandidate(phases) {
    const late = lastHalf(phases);
    return {
        resistance: integerMedian(late.map((phase) => phase.finalResistance)),
        windows: late.map((phase) => ({ start: phase.startElapsed, end: phase.endElapsed })),
        targets: late.map((phase) => ({ min: phase.targetHeartRateMin, max: phase.targetHeartRateMax })),
    };
}
export function hrResponseQualifies(samples, windows, targetMin, targetMax) {
    if (targetMin === undefined || targetMax === undefined)
        return false;
    const median = rollingHrMedian(samplesInWindows(samples, windows));
    if (median === undefined)
        return false;
    return median >= targetMin - 3 && median <= targetMax + 3;
}
export function deriveLearningCandidate(summary, hrSamples) {
    var _a;
    if (summary.cancelled)
        return undefined;
    if (summary.activity !== "bike")
        return undefined;
    if (summary.machine_id !== "proform-smart-power-10")
        return undefined;
    const machine = getMachineDefinition(summary.machine_id);
    if (!machine || summary.machine_profile_version !== machine.profileVersion)
        return undefined;
    if (!isLearningIntent(summary.intent))
        return undefined;
    const phases = collectWorkPhases((_a = summary.machine_guidance_trace) !== null && _a !== void 0 ? _a : []);
    if (phases.length === 0)
        return undefined;
    const classes = new Set(phases.map((phase) => phase.durationClass));
    if (classes.size !== 1)
        return undefined;
    const durationClass = phases[0].durationClass;
    const derived = durationClass === "long" && phases.length === 1
        ? longBlockCandidate(phases[0])
        : repeatedIntervalCandidate(phases);
    if (derived.resistance === undefined)
        return undefined;
    const targetMin = durationClass === "long"
        ? phases[0].targetHeartRateMin
        : lastHalf(phases).every((phase) => phase.targetHeartRateMin !== undefined)
            ? Math.min(...lastHalf(phases).map((phase) => phase.targetHeartRateMin))
            : undefined;
    const targetMax = durationClass === "long"
        ? phases[0].targetHeartRateMax
        : lastHalf(phases).every((phase) => phase.targetHeartRateMax !== undefined)
            ? Math.max(...lastHalf(phases).map((phase) => phase.targetHeartRateMax))
            : undefined;
    if (!hrResponseQualifies(hrSamples, derived.windows, targetMin, targetMax))
        return undefined;
    return {
        key: {
            machineId: "proform-smart-power-10",
            machineProfileVersion: machine.profileVersion,
            activity: "bike",
            intent: summary.intent,
            durationClass,
        },
        resistance: clampAutomaticResistance(derived.resistance),
    };
}
