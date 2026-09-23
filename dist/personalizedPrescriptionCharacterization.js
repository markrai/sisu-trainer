import { PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V1, PERSONALIZED_PRESCRIPTION_CHARACTERIZER_ID_V1, PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V1, PERSONALIZED_PRESCRIPTION_EVALUATION_SCHEMA_VERSION_V1, PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1, PERSONALIZED_PRESCRIPTION_RESOLVER_VERSION_V1, } from "./types.js";
import { parseOrdinaryBikeTelemetrySample } from "./ordinaryWorkoutTelemetry.js";
import { parsePersonalizedPrescriptionEvaluation } from "./personalizedPrescription.js";
import { parseWorkoutResponse } from "./workoutResponse.js";
/** Provisional evidence-quality policy only. These values never authorize control. */
export const PHASE_E2_CHARACTERIZATION_POLICY_V1 = {
    id: "e2-characterization-policy",
    version: 1,
    minObservedPhaseDurationSec: 60,
    minHrCoverageRatio: 0.8,
    minPowerCoverageRatio: 0.8,
    minJointCoverageRatio: 0.75,
    settlingSeconds: 30,
    minSettledInBandSeconds: 15,
    heartRateChangeWindowSeconds: 60,
    minHeartRateChangeWindowSamples: 30,
    domainEdgeFraction: 0.1,
};
const OWNER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const MAX_PHASES = 100;
function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function containsNonFiniteNumber(value) {
    if (typeof value === "number")
        return !Number.isFinite(value);
    if (Array.isArray(value))
        return value.some(containsNonFiniteNumber);
    if (isObject(value))
        return Object.values(value).some(containsNonFiniteNumber);
    return false;
}
function finite(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function nonNegative(value) {
    return finite(value) && value >= 0;
}
function ratioValue(value) {
    return finite(value) && value >= 0 && value <= 1;
}
function iso(value) {
    if (typeof value !== "string" || value === "")
        return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function ratio(count, duration) {
    return duration > 0 ? Math.max(0, Math.min(1, count / duration)) : 0;
}
function nearlyEqual(a, b) {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}
function sorted(values) {
    return [...values].sort((a, b) => a - b);
}
function quantile(values, probability) {
    const ordered = sorted(values);
    if (ordered.length === 1)
        return ordered[0];
    const position = (ordered.length - 1) * probability;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const fraction = position - lower;
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction;
}
function median(values) {
    return quantile(values, 0.5);
}
function policyValid(value) {
    if (!isObject(value) || value.id !== "e2-characterization-policy" || value.version !== 1)
        return false;
    return Number.isInteger(value.minObservedPhaseDurationSec) && value.minObservedPhaseDurationSec > 0 &&
        ratioValue(value.minHrCoverageRatio) && ratioValue(value.minPowerCoverageRatio) &&
        ratioValue(value.minJointCoverageRatio) && Number.isInteger(value.settlingSeconds) &&
        value.settlingSeconds >= 0 && Number.isInteger(value.minSettledInBandSeconds) &&
        value.minSettledInBandSeconds > 0 && Number.isInteger(value.heartRateChangeWindowSeconds) &&
        value.heartRateChangeWindowSeconds > 0 && Number.isInteger(value.minHeartRateChangeWindowSamples) &&
        value.minHeartRateChangeWindowSamples > 0 && ratioValue(value.domainEdgeFraction);
}
function phaseMatches(shadow, response) {
    if (shadow.phaseId !== response.phaseId || shadow.kind !== response.kind)
        return false;
    if (shadow.intensityId !== response.intensityId || shadow.intervalIndex !== response.intervalIndex)
        return false;
    if (shadow.activeStartSec !== undefined && shadow.activeStartSec !== response.activeStartSec)
        return false;
    if (shadow.activeEndSec !== undefined && shadow.activeEndSec !== response.activeEndSec)
        return false;
    return true;
}
function responseForPhase(shadow, response) {
    const matches = response.phases.filter((phase) => phaseMatches(shadow, phase));
    return matches.length === 1 ? matches[0] : undefined;
}
function resistanceCoverage(samples, selector) {
    const values = samples.map(selector).filter((value) => finite(value));
    return {
        coveredSeconds: values.length,
        lowerBoundSeconds: values.filter((value) => value === 1).length,
        upperBoundSeconds: values.filter((value) => value === 15).length,
    };
}
function controllerContext(samples, audit, observedDurationSec) {
    var _a;
    const observed = resistanceCoverage(samples, (sample) => { var _a; return (_a = sample.observedResistance) === null || _a === void 0 ? void 0 : _a.value; });
    const desired = resistanceCoverage(samples, (sample) => sample.desiredResistance);
    const commanded = resistanceCoverage(samples, (sample) => sample.commandedResistance);
    const saturatedSeconds = new Set();
    for (const sample of samples) {
        const values = [(_a = sample.observedResistance) === null || _a === void 0 ? void 0 : _a.value, sample.desiredResistance, sample.commandedResistance];
        if (values.some((value) => value === 1 || value === 15))
            saturatedSeconds.add(sample.activeSec);
    }
    return {
        available: observed.coveredSeconds + desired.coveredSeconds + commanded.coveredSeconds > 0 || audit.length > 0,
        observed,
        desired,
        commanded,
        anyBoundarySaturationSeconds: saturatedSeconds.size,
        saturationRatio: ratio(saturatedSeconds.size, observedDurationSec),
        lowerBoundaryDecisionCount: audit.filter((entry) => entry.kind === "evaluation" && entry.constraint === "r1_floor").length,
        upperBoundaryDecisionCount: audit.filter((entry) => entry.kind === "evaluation" && entry.constraint === "r15_cap").length,
    };
}
function resistanceChangeSeconds(samples) {
    var _a;
    const changes = new Set();
    let previousObserved;
    let previousDesired;
    let previousCommanded;
    for (const sample of [...samples].sort((a, b) => a.activeSec - b.activeSec)) {
        const values = [(_a = sample.observedResistance) === null || _a === void 0 ? void 0 : _a.value, sample.desiredResistance, sample.commandedResistance];
        const previous = [previousObserved, previousDesired, previousCommanded];
        if (values.some((value, index) => value !== undefined && previous[index] !== undefined && value !== previous[index])) {
            changes.add(sample.activeSec);
        }
        if (values[0] !== undefined)
            previousObserved = values[0];
        if (values[1] !== undefined)
            previousDesired = values[1];
        if (values[2] !== undefined)
            previousCommanded = values[2];
    }
    return [...changes];
}
function isSettled(second, phaseStart, changes, settlingSeconds) {
    if (second < phaseStart + settlingSeconds)
        return false;
    return !changes.some((change) => second >= change && second < change + settlingSeconds);
}
function observedPowerProvenance(samples) {
    const sources = new Set(samples.flatMap((sample) => sample.watts ? [sample.watts.source] : []));
    if (sources.size === 0)
        return "unavailable";
    if (sources.size > 1)
        return "mixed";
    return [...sources][0];
}
function exclusionFor(coverage, provenance, settledCount, policy) {
    if (coverage.observedDurationSec < policy.minObservedPhaseDurationSec)
        return "phase_too_short";
    if (coverage.hrCoveredSeconds === 0 && coverage.powerCoveredSeconds === 0)
        return "missing_telemetry";
    if (coverage.hrCoverageRatio < policy.minHrCoverageRatio)
        return "insufficient_hr_coverage";
    if (coverage.powerCoverageRatio < policy.minPowerCoverageRatio)
        return "insufficient_power_coverage";
    if (coverage.jointCoverageRatio < policy.minJointCoverageRatio)
        return "insufficient_joint_coverage";
    if (provenance === "mixed")
        return "unsupported_power_provenance";
    if (provenance === "unavailable")
        return "insufficient_power_coverage";
    if (settledCount < policy.minSettledInBandSeconds)
        return "insufficient_settled_in_band_evidence";
    return undefined;
}
function compareCandidate(minCandidate, maxCandidate, stableValues) {
    const candidateMidpointWatts = (minCandidate + maxCandidate) / 2;
    const observedInBandMedianWatts = median(stableValues);
    const signedDifferenceWatts = observedInBandMedianWatts - candidateMidpointWatts;
    const observedQ1 = quantile(stableValues, 0.25);
    const observedQ3 = quantile(stableValues, 0.75);
    const overlap = Math.max(0, Math.min(maxCandidate, observedQ3) - Math.max(minCandidate, observedQ1));
    const observedBandWidth = observedQ3 - observedQ1;
    return {
        candidateMidpointWatts,
        observedInBandMedianWatts,
        signedDifferenceWatts,
        absoluteDifferenceWatts: Math.abs(signedDifferenceWatts),
        signedDifferencePercent: candidateMidpointWatts > 0
            ? signedDifferenceWatts / candidateMidpointWatts
            : 0,
        candidateContainsObservedMedian: observedInBandMedianWatts >= minCandidate && observedInBandMedianWatts <= maxCandidate,
        candidateObservedOverlapWatts: overlap,
        candidateObservedOverlapRatio: observedBandWidth > 0
            ? overlap / observedBandWidth
            : observedInBandMedianWatts >= minCandidate && observedInBandMedianWatts <= maxCandidate ? 1 : 0,
        agreement: observedInBandMedianWatts < minCandidate
            ? "below_candidate"
            : observedInBandMedianWatts > maxCandidate
                ? "above_candidate"
                : "inside_candidate",
    };
}
function characterizePhase(shadow, response, evaluation, hrBySecond, bikeBySecond, audit, policy) {
    var _a, _b, _c, _d;
    const start = (_a = response === null || response === void 0 ? void 0 : response.activeStartSec) !== null && _a !== void 0 ? _a : shadow.activeStartSec;
    const end = (_b = response === null || response === void 0 ? void 0 : response.activeEndSec) !== null && _b !== void 0 ? _b : shadow.activeEndSec;
    const plannedDurationSec = (_c = response === null || response === void 0 ? void 0 : response.plannedDurationSec) !== null && _c !== void 0 ? _c : (start !== undefined && end !== undefined ? Math.max(0, end - start) : 0);
    const observedDurationSec = (_d = response === null || response === void 0 ? void 0 : response.completedDurationSec) !== null && _d !== void 0 ? _d : 0;
    const completedEnd = start === undefined ? undefined : start + observedDurationSec;
    const hrEntries = start === undefined || completedEnd === undefined ? [] : [...hrBySecond.entries()]
        .filter(([second]) => second >= start && second < completedEnd)
        .sort(([a], [b]) => a - b);
    const bike = start === undefined || completedEnd === undefined ? [] : [...bikeBySecond.values()]
        .filter((sample) => sample.activeSec >= start && sample.activeSec < completedEnd)
        .sort((a, b) => a.activeSec - b.activeSec);
    const powerSamples = bike.filter((sample) => sample.watts !== undefined);
    const joint = powerSamples.filter((sample) => hrBySecond.has(sample.activeSec));
    const coverage = {
        plannedDurationSec,
        observedDurationSec,
        hrCoveredSeconds: hrEntries.length,
        powerCoveredSeconds: powerSamples.length,
        jointCoveredSeconds: joint.length,
        hrCoverageRatio: ratio(hrEntries.length, observedDurationSec),
        powerCoverageRatio: ratio(powerSamples.length, observedDurationSec),
        jointCoverageRatio: ratio(joint.length, observedDurationSec),
    };
    const phaseAudit = start === undefined || completedEnd === undefined ? [] : audit.filter((entry) => entry.phaseId === shadow.phaseId && entry.intervalIndex === shadow.intervalIndex &&
        entry.elapsedSeconds >= start && entry.elapsedSeconds < completedEnd);
    const controller = controllerContext(bike, phaseAudit, observedDurationSec);
    const base = {
        phaseId: shadow.phaseId,
        kind: shadow.kind,
        ...(shadow.intensityId ? { intensityId: shadow.intensityId } : {}),
        ...(shadow.detailName ? { detailName: shadow.detailName } : {}),
        ...(shadow.intervalIndex !== undefined ? { intervalIndex: shadow.intervalIndex } : {}),
        ...(start !== undefined ? { activeStartSec: start } : {}),
        ...(end !== undefined ? { activeEndSec: end } : {}),
        shadowOutcome: shadow.outcome,
        ...(shadow.fallbackReason ? { fallbackReason: shadow.fallbackReason } : {}),
        ...(shadow.activeHeartRate ? { legacyHeartRate: { ...shadow.activeHeartRate } } : {}),
        ...(shadow.candidatePower ? { candidatePower: { ...shadow.candidatePower } } : {}),
        evidenceCoverage: coverage,
        observedPowerProvenance: observedPowerProvenance(powerSamples),
        controllerContext: controller,
        characterizationOutcome: shadow.outcome === "candidate" ? "insufficient_evidence" : "not_candidate",
    };
    if (shadow.outcome !== "candidate" || !shadow.candidatePower || !shadow.activeHeartRate ||
        shadow.activeHeartRate.min === undefined || shadow.activeHeartRate.max === undefined)
        return base;
    if (!response) {
        return { ...base, exclusionReason: "phase_evidence_unavailable" };
    }
    const hrValues = hrEntries.map(([, value]) => value);
    if (hrValues.length > 0) {
        const below = hrValues.filter((value) => value < shadow.activeHeartRate.min).length;
        const inside = hrValues.filter((value) => value >= shadow.activeHeartRate.min && value <= shadow.activeHeartRate.max).length;
        const above = hrValues.length - below - inside;
        base.observedHeartRate = {
            sampleCount: hrValues.length,
            meanBpm: hrValues.reduce((sum, value) => sum + value, 0) / hrValues.length,
            medianBpm: median(hrValues),
            minBpm: Math.min(...hrValues),
            maxBpm: Math.max(...hrValues),
            belowBandSeconds: below,
            insideBandSeconds: inside,
            aboveBandSeconds: above,
            insideBandRatio: inside / hrValues.length,
        };
    }
    const provenance = observedPowerProvenance(powerSamples);
    const powerValues = powerSamples.map((sample) => sample.watts.value);
    if (powerValues.length > 0 && provenance !== "mixed" && provenance !== "unavailable") {
        const below = powerValues.filter((value) => value < shadow.candidatePower.minWatts).length;
        const inside = powerValues.filter((value) => value >= shadow.candidatePower.minWatts && value <= shadow.candidatePower.maxWatts).length;
        const above = powerValues.length - below - inside;
        base.observedPower = {
            provenance,
            sampleCount: powerValues.length,
            medianWatts: median(powerValues),
            q1Watts: quantile(powerValues, 0.25),
            q3Watts: quantile(powerValues, 0.75),
            minWatts: Math.min(...powerValues),
            maxWatts: Math.max(...powerValues),
            belowCandidateSeconds: below,
            insideCandidateSeconds: inside,
            aboveCandidateSeconds: above,
            insideCandidateRatio: inside / powerValues.length,
        };
    }
    const changes = resistanceChangeSeconds(bike);
    const stableJoint = start === undefined ? [] : joint.filter((sample) => {
        const hr = hrBySecond.get(sample.activeSec);
        return isSettled(sample.activeSec, start, changes, policy.settlingSeconds) &&
            hr >= shadow.activeHeartRate.min && hr <= shadow.activeHeartRate.max;
    });
    const stableValues = stableJoint.map((sample) => sample.watts.value);
    if (start !== undefined && completedEnd !== undefined && base.observedHeartRate &&
        observedDurationSec >= policy.settlingSeconds + 2 * policy.heartRateChangeWindowSeconds) {
        const settledHr = hrEntries.filter(([second]) => isSettled(second, start, changes, policy.settlingSeconds));
        const firstWindowStart = start + policy.settlingSeconds;
        const early = settledHr.filter(([second]) => second >= firstWindowStart && second < firstWindowStart + policy.heartRateChangeWindowSeconds).map(([, value]) => value);
        const late = settledHr.filter(([second]) => second >= completedEnd - policy.heartRateChangeWindowSeconds && second < completedEnd).map(([, value]) => value);
        if (early.length >= policy.minHeartRateChangeWindowSamples &&
            late.length >= policy.minHeartRateChangeWindowSamples) {
            base.observedHeartRate.earlyWindowMedianBpm = median(early);
            base.observedHeartRate.lateWindowMedianBpm = median(late);
            base.observedHeartRate.heartRateChangeLateVsEarlyBpm = median(late) - median(early);
        }
    }
    const fitness = evaluation.fitnessEvidenceSnapshot;
    if (fitness) {
        const observedHrs = fitness.calibration.points.map((point) => point.heartRateBpm);
        const hrMin = Math.min(...observedHrs);
        const hrMax = Math.max(...observedHrs);
        const hrLower = shadow.activeHeartRate.min - hrMin;
        const hrUpper = hrMax - shadow.activeHeartRate.max;
        const wattsLower = shadow.candidatePower.minWatts - fitness.calibration.observedMinWatts;
        const wattsUpper = fitness.calibration.observedMaxWatts - shadow.candidatePower.maxWatts;
        const hrSpan = hrMax - hrMin;
        const wattsSpan = fitness.calibration.observedMaxWatts - fitness.calibration.observedMinWatts;
        const edge = (hrSpan > 0 && Math.min(hrLower, hrUpper) / hrSpan <= policy.domainEdgeFraction) ||
            (wattsSpan > 0 && Math.min(wattsLower, wattsUpper) / wattsSpan <= policy.domainEdgeFraction);
        base.candidateDomainMargins = {
            heartRateToLowerBoundaryBpm: hrLower,
            heartRateToUpperBoundaryBpm: hrUpper,
            wattsToLowerBoundary: wattsLower,
            wattsToUpperBoundary: wattsUpper,
            bucket: edge ? "edge" : "interior",
        };
    }
    const exclusion = exclusionFor(coverage, provenance, stableValues.length, policy);
    if (exclusion) {
        base.exclusionReason = exclusion;
        base.characterizationOutcome = exclusion === "missing_telemetry"
            ? "telemetry_unavailable"
            : exclusion === "unsupported_power_provenance"
                ? "unsupported_observed_provenance"
                : "insufficient_evidence";
        return base;
    }
    base.stableInBandWorkload = {
        sampleCount: stableValues.length,
        medianWatts: median(stableValues),
        q1Watts: quantile(stableValues, 0.25),
        q3Watts: quantile(stableValues, 0.75),
        minWatts: Math.min(...stableValues),
        maxWatts: Math.max(...stableValues),
    };
    base.comparison = compareCandidate(shadow.candidatePower.minWatts, shadow.candidatePower.maxWatts, stableValues);
    base.characterizationOutcome = "characterized";
    return base;
}
/** Pure E2 reducer. All current-state and time inputs are supplied explicitly. */
export function characterizePersonalizedPrescription(input) {
    var _a;
    const shadow = parsePersonalizedPrescriptionEvaluation(input.shadowEvaluation);
    const response = parseWorkoutResponse(input.workoutResponse);
    if (!shadow || !response || !policyValid(input.policy) || !iso(input.createdAt))
        return null;
    if (!OWNER_ID_PATTERN.test(input.summary.external_session_id) || !input.summary.athlete_id ||
        shadow.athleteId !== input.summary.athlete_id || response.athleteId !== input.summary.athlete_id ||
        response.sessionId !== input.summary.external_session_id || shadow.workoutSelector !== input.summary.day ||
        shadow.workoutIntent !== input.summary.intent || shadow.activity !== input.summary.activity)
        return null;
    const hrBySecond = new Map();
    for (const sample of input.hrSamples) {
        if (sample.session_id === response.sessionId && Number.isInteger(sample.timestamp_sec) &&
            sample.timestamp_sec >= 0 && finite(sample.hr) && sample.hr >= 30 && sample.hr <= 250) {
            hrBySecond.set(sample.timestamp_sec, sample.hr);
        }
    }
    const bikeBySecond = new Map();
    const sourceIds = new Set();
    for (const raw of input.bikeSamples) {
        const sample = parseOrdinaryBikeTelemetrySample(raw);
        if (!sample || sample.athleteId !== response.athleteId || sample.sessionId !== response.sessionId ||
            bikeBySecond.has(sample.activeSec) || (sample.sourceSampleId && sourceIds.has(sample.sourceSampleId)))
            continue;
        bikeBySecond.set(sample.activeSec, sample);
        if (sample.sourceSampleId)
            sourceIds.add(sample.sourceSampleId);
    }
    const audit = (_a = input.machineDecisionAudit) !== null && _a !== void 0 ? _a : [];
    const phases = shadow.phases.map((phase) => characterizePhase(phase, responseForPhase(phase, response), shadow, hrBySecond, bikeBySecond, audit, input.policy));
    return {
        schemaVersion: PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V1,
        characterizer: {
            id: PERSONALIZED_PRESCRIPTION_CHARACTERIZER_ID_V1,
            version: PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V1,
        },
        mode: "diagnostic",
        activationEligible: false,
        sourceShadow: {
            resolverId: PERSONALIZED_PRESCRIPTION_RESOLVER_ID_V1,
            resolverVersion: PERSONALIZED_PRESCRIPTION_RESOLVER_VERSION_V1,
            shadowSchemaVersion: PERSONALIZED_PRESCRIPTION_EVALUATION_SCHEMA_VERSION_V1,
            resolvedAt: shadow.resolvedAt,
        },
        athleteId: shadow.athleteId,
        workoutSessionId: response.sessionId,
        workoutSelector: shadow.workoutSelector,
        workoutIntent: shadow.workoutIntent,
        activity: shadow.activity,
        ...(shadow.fitnessEvidenceSnapshot ? {
            formalAssessmentQuality: shadow.fitnessEvidenceSnapshot.quality,
            calibrationWorkloadProvenance: shadow.fitnessEvidenceSnapshot.calibration.workloadProvenance,
        } : {}),
        policy: { ...input.policy },
        phases,
        createdAt: input.createdAt,
    };
}
const OUTCOMES = new Set(["characterized", "insufficient_evidence", "not_candidate",
    "unsupported_observed_provenance", "telemetry_unavailable"]);
const EXCLUSIONS = new Set(["phase_too_short", "missing_telemetry", "insufficient_hr_coverage",
    "insufficient_power_coverage", "insufficient_joint_coverage", "insufficient_settled_in_band_evidence",
    "unsupported_power_provenance", "phase_evidence_unavailable"]);
function phaseLinkMatches(value, shadow) {
    if (value.phaseId !== shadow.phaseId || value.kind !== shadow.kind || value.intensityId !== shadow.intensityId ||
        value.intervalIndex !== shadow.intervalIndex || value.shadowOutcome !== shadow.outcome)
        return false;
    if (shadow.activeStartSec !== undefined && value.activeStartSec !== shadow.activeStartSec)
        return false;
    if (shadow.activeEndSec !== undefined && value.activeEndSec !== shadow.activeEndSec)
        return false;
    if (JSON.stringify(value.legacyHeartRate) !== JSON.stringify(shadow.activeHeartRate))
        return false;
    if (JSON.stringify(value.candidatePower) !== JSON.stringify(shadow.candidatePower))
        return false;
    if (value.fallbackReason !== shadow.fallbackReason)
        return false;
    return true;
}
function parsedPhase(value, shadow) {
    if (!isObject(value) || !phaseLinkMatches(value, shadow) || !isObject(value.evidenceCoverage) ||
        !isObject(value.controllerContext) || !OUTCOMES.has(value.characterizationOutcome))
        return null;
    if (value.observedPowerProvenance !== "measured_watts" && value.observedPowerProvenance !== "calibrated_watts" &&
        value.observedPowerProvenance !== "mixed" && value.observedPowerProvenance !== "unavailable")
        return null;
    const coverage = value.evidenceCoverage;
    const coverageCounts = [coverage.plannedDurationSec, coverage.observedDurationSec, coverage.hrCoveredSeconds,
        coverage.powerCoveredSeconds, coverage.jointCoveredSeconds];
    if (!coverageCounts.every(nonNegative) || !ratioValue(coverage.hrCoverageRatio) ||
        !ratioValue(coverage.powerCoverageRatio) || !ratioValue(coverage.jointCoverageRatio) ||
        !nearlyEqual(coverage.hrCoverageRatio, ratio(coverage.hrCoveredSeconds, coverage.observedDurationSec)) ||
        !nearlyEqual(coverage.powerCoverageRatio, ratio(coverage.powerCoveredSeconds, coverage.observedDurationSec)) ||
        !nearlyEqual(coverage.jointCoverageRatio, ratio(coverage.jointCoveredSeconds, coverage.observedDurationSec)))
        return null;
    if (value.exclusionReason !== undefined && !EXCLUSIONS.has(value.exclusionReason))
        return null;
    if (shadow.outcome === "fallback" && (value.characterizationOutcome !== "not_candidate" || value.comparison !== undefined))
        return null;
    if (shadow.outcome === "candidate" && value.characterizationOutcome === "not_candidate")
        return null;
    const controller = value.controllerContext;
    if (typeof controller.available !== "boolean" || !nonNegative(controller.anyBoundarySaturationSeconds) ||
        !ratioValue(controller.saturationRatio) || !nonNegative(controller.lowerBoundaryDecisionCount) ||
        !nonNegative(controller.upperBoundaryDecisionCount))
        return null;
    for (const key of ["observed", "desired", "commanded"]) {
        const item = controller[key];
        if (!isObject(item) || !nonNegative(item.coveredSeconds) || !nonNegative(item.lowerBoundSeconds) ||
            !nonNegative(item.upperBoundSeconds))
            return null;
    }
    if (value.characterizationOutcome === "characterized") {
        if (!isObject(value.stableInBandWorkload) || !isObject(value.comparison) || value.exclusionReason !== undefined)
            return null;
        const comparison = value.comparison;
        const candidate = shadow.candidatePower;
        const midpoint = (candidate.minWatts + candidate.maxWatts) / 2;
        if (![comparison.candidateMidpointWatts, comparison.observedInBandMedianWatts,
            comparison.signedDifferenceWatts, comparison.absoluteDifferenceWatts, comparison.signedDifferencePercent,
            comparison.candidateObservedOverlapWatts, comparison.candidateObservedOverlapRatio].every(finite) ||
            typeof comparison.candidateContainsObservedMedian !== "boolean" ||
            !nearlyEqual(comparison.candidateMidpointWatts, midpoint) ||
            !nearlyEqual(comparison.signedDifferenceWatts, comparison.observedInBandMedianWatts - midpoint) ||
            comparison.candidateContainsObservedMedian !==
                (comparison.observedInBandMedianWatts >= candidate.minWatts &&
                    comparison.observedInBandMedianWatts <= candidate.maxWatts))
            return null;
    }
    else if (value.comparison !== undefined || value.stableInBandWorkload !== undefined)
        return null;
    return value;
}
/** Strict historical E2 reader with an immutable structural link to the trusted E1 record. */
export function parsePersonalizedPrescriptionCharacterization(value, shadowValue, expected) {
    var _a, _b;
    const shadow = parsePersonalizedPrescriptionEvaluation(shadowValue);
    if (!shadow || !isObject(value) ||
        containsNonFiniteNumber(value) ||
        value.schemaVersion !== PERSONALIZED_PRESCRIPTION_CHARACTERIZATION_SCHEMA_VERSION_V1 ||
        !isObject(value.characterizer) || value.characterizer.id !== PERSONALIZED_PRESCRIPTION_CHARACTERIZER_ID_V1 ||
        value.characterizer.version !== PERSONALIZED_PRESCRIPTION_CHARACTERIZER_VERSION_V1 ||
        value.mode !== "diagnostic" || value.activationEligible !== false || !isObject(value.sourceShadow) ||
        value.sourceShadow.resolverId !== shadow.resolver.id ||
        value.sourceShadow.resolverVersion !== shadow.resolver.version ||
        value.sourceShadow.shadowSchemaVersion !== shadow.schemaVersion ||
        value.sourceShadow.resolvedAt !== shadow.resolvedAt || value.athleteId !== shadow.athleteId ||
        value.workoutSelector !== shadow.workoutSelector || value.workoutIntent !== shadow.workoutIntent ||
        value.activity !== shadow.activity || !OWNER_ID_PATTERN.test(value.workoutSessionId) ||
        !policyValid(value.policy) || !iso(value.createdAt) || !Array.isArray(value.phases) ||
        value.phases.length !== shadow.phases.length || value.phases.length > MAX_PHASES)
        return null;
    const expectedQuality = (_a = shadow.fitnessEvidenceSnapshot) === null || _a === void 0 ? void 0 : _a.quality;
    const expectedProvenance = (_b = shadow.fitnessEvidenceSnapshot) === null || _b === void 0 ? void 0 : _b.calibration.workloadProvenance;
    if (value.formalAssessmentQuality !== expectedQuality ||
        value.calibrationWorkloadProvenance !== expectedProvenance)
        return null;
    if (expected && (expected.athleteId !== undefined && value.athleteId !== expected.athleteId ||
        expected.sessionId !== undefined && value.workoutSessionId !== expected.sessionId ||
        expected.workoutSelector !== undefined && value.workoutSelector !== expected.workoutSelector ||
        expected.activity !== undefined && value.activity !== expected.activity))
        return null;
    const phases = [];
    const expectedResponse = (expected === null || expected === void 0 ? void 0 : expected.workoutResponse) === undefined
        ? null
        : parseWorkoutResponse(expected.workoutResponse);
    if ((expected === null || expected === void 0 ? void 0 : expected.workoutResponse) !== undefined && !expectedResponse)
        return null;
    for (let index = 0; index < shadow.phases.length; index += 1) {
        const phase = parsedPhase(value.phases[index], shadow.phases[index]);
        if (!phase)
            return null;
        if (expectedResponse) {
            const responsePhase = responseForPhase(shadow.phases[index], expectedResponse);
            if (!responsePhase || phase.activeStartSec !== responsePhase.activeStartSec ||
                phase.activeEndSec !== responsePhase.activeEndSec ||
                phase.evidenceCoverage.plannedDurationSec !== responsePhase.plannedDurationSec ||
                phase.evidenceCoverage.observedDurationSec !== responsePhase.completedDurationSec)
                return null;
        }
        phases.push(phase);
    }
    return {
        ...value,
        sourceShadow: { ...value.sourceShadow },
        policy: { ...value.policy },
        phases,
    };
}
function metric(values) {
    return values.length > 0 ? { count: values.length, median: median(values) } : { count: 0 };
}
/** Pure, order-independent cohort report. Measured and calibrated sources are never pooled. */
export function aggregatePersonalizedPrescriptionCharacterizations(records) {
    var _a, _b, _c, _d, _e, _f;
    const groups = new Map();
    let phaseCount = 0;
    let candidates = 0;
    let fallbacks = 0;
    let evaluable = 0;
    for (const record of records) {
        for (const phase of record.phases) {
            phaseCount += 1;
            if (phase.shadowOutcome === "candidate")
                candidates += 1;
            else
                fallbacks += 1;
            if (phase.characterizationOutcome === "characterized")
                evaluable += 1;
            const parts = [record.workoutIntent, (_a = phase.intensityId) !== null && _a !== void 0 ? _a : "unspecified", (_b = record.calibrationWorkloadProvenance) !== null && _b !== void 0 ? _b : "unavailable", phase.observedPowerProvenance, (_c = record.formalAssessmentQuality) !== null && _c !== void 0 ? _c : "unavailable", (_e = (_d = phase.candidateDomainMargins) === null || _d === void 0 ? void 0 : _d.bucket) !== null && _e !== void 0 ? _e : "not_applicable"];
            const key = JSON.stringify(parts);
            const group = (_f = groups.get(key)) !== null && _f !== void 0 ? _f : { sessions: new Set(), phases: [], record };
            group.sessions.add(record.workoutSessionId);
            group.phases.push(phase);
            groups.set(key, group);
        }
    }
    const output = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => {
        var _a, _b, _c, _d, _e, _f;
        const first = group.phases[0];
        const exclusions = {};
        for (const phase of group.phases)
            if (phase.exclusionReason) {
                exclusions[phase.exclusionReason] = ((_a = exclusions[phase.exclusionReason]) !== null && _a !== void 0 ? _a : 0) + 1;
            }
        const characterized = group.phases.filter((phase) => phase.characterizationOutcome === "characterized");
        const insideTotal = characterized.filter((phase) => phase.comparison).length;
        const insideCount = characterized.filter((phase) => { var _a; return (_a = phase.comparison) === null || _a === void 0 ? void 0 : _a.candidateContainsObservedMedian; }).length;
        const saturationTotal = group.phases.filter((phase) => phase.shadowOutcome === "candidate").length;
        const saturationCount = group.phases.filter((phase) => phase.shadowOutcome === "candidate" && phase.controllerContext.anyBoundarySaturationSeconds > 0).length;
        return {
            workoutIntent: group.record.workoutIntent,
            intensityId: (_b = first.intensityId) !== null && _b !== void 0 ? _b : "unspecified",
            calibrationWorkloadProvenance: (_c = group.record.calibrationWorkloadProvenance) !== null && _c !== void 0 ? _c : "unavailable",
            observedPowerProvenance: first.observedPowerProvenance,
            formalAssessmentQuality: (_d = group.record.formalAssessmentQuality) !== null && _d !== void 0 ? _d : "unavailable",
            candidateDomainMarginBucket: (_f = (_e = first.candidateDomainMargins) === null || _e === void 0 ? void 0 : _e.bucket) !== null && _f !== void 0 ? _f : "not_applicable",
            completedWorkouts: group.sessions.size,
            phaseCount: group.phases.length,
            candidatePhases: group.phases.filter((phase) => phase.shadowOutcome === "candidate").length,
            fallbackPhases: group.phases.filter((phase) => phase.shadowOutcome === "fallback").length,
            evaluableCandidatePhases: characterized.length,
            exclusionCounts: Object.fromEntries(Object.entries(exclusions).sort(([a], [b]) => a.localeCompare(b))),
            signedDifferenceWatts: metric(characterized.flatMap((phase) => phase.comparison ? [phase.comparison.signedDifferenceWatts] : [])),
            absoluteDifferenceWatts: metric(characterized.flatMap((phase) => phase.comparison ? [phase.comparison.absoluteDifferenceWatts] : [])),
            observedMedianInsideCandidate: { count: insideCount, total: insideTotal,
                ...(insideTotal > 0 ? { proportion: insideCount / insideTotal } : {}) },
            heartRateInsideBandRatio: metric(group.phases.flatMap((phase) => phase.observedHeartRate ? [phase.observedHeartRate.insideBandRatio] : [])),
            hrCoverageRatio: metric(group.phases.map((phase) => phase.evidenceCoverage.hrCoverageRatio)),
            powerCoverageRatio: metric(group.phases.map((phase) => phase.evidenceCoverage.powerCoverageRatio)),
            jointCoverageRatio: metric(group.phases.map((phase) => phase.evidenceCoverage.jointCoverageRatio)),
            controllerSaturationIncidence: { count: saturationCount, total: saturationTotal,
                ...(saturationTotal > 0 ? { proportion: saturationCount / saturationTotal } : {}) },
        };
    });
    return {
        schemaVersion: 1,
        workoutCount: new Set(records.map((record) => record.workoutSessionId)).size,
        phaseCount,
        candidatePhases: candidates,
        fallbackPhases: fallbacks,
        evaluableCandidatePhases: evaluable,
        groups: output,
    };
}
/** Small developer-facing table/JSON surface; no athlete UI consumes this. */
export function personalizedPrescriptionDiagnosticRows(records) {
    return records.flatMap((record) => record.phases.map((phase) => {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        return ({
            workout: `${record.workoutSelector} (${record.workoutSessionId})`,
            phase: (_a = phase.detailName) !== null && _a !== void 0 ? _a : `${phase.kind}${phase.intervalIndex ? ` ${phase.intervalIndex}` : ""}`,
            legacyHeartRate: ((_b = phase.legacyHeartRate) === null || _b === void 0 ? void 0 : _b.min) !== undefined && phase.legacyHeartRate.max !== undefined
                ? `${phase.legacyHeartRate.min}-${phase.legacyHeartRate.max} bpm` : "n/a",
            candidateWatts: phase.candidatePower
                ? `${phase.candidatePower.minWatts}-${phase.candidatePower.maxWatts} W` : "n/a",
            observedInBandWatts: (_d = (_c = phase.stableInBandWorkload) === null || _c === void 0 ? void 0 : _c.medianWatts) !== null && _d !== void 0 ? _d : null,
            deltaWatts: (_f = (_e = phase.comparison) === null || _e === void 0 ? void 0 : _e.signedDifferenceWatts) !== null && _f !== void 0 ? _f : null,
            hrCoveragePercent: phase.evidenceCoverage.hrCoverageRatio * 100,
            powerCoveragePercent: phase.evidenceCoverage.powerCoverageRatio * 100,
            hrInsideTargetPercent: phase.observedHeartRate ? phase.observedHeartRate.insideBandRatio * 100 : null,
            saturationPercent: phase.controllerContext.saturationRatio * 100,
            calibrationProvenance: (_g = record.calibrationWorkloadProvenance) !== null && _g !== void 0 ? _g : "unavailable",
            observedPowerProvenance: phase.observedPowerProvenance,
            outcome: phase.characterizationOutcome,
            exclusion: (_h = phase.exclusionReason) !== null && _h !== void 0 ? _h : "none",
        });
    }));
}
