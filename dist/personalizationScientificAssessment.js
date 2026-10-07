/**
 * E4A scientific assessment — pure, versioned, no authority.
 *
 * E4A evaluates hardened E1/E2 threshold (and future aerobic-base) transfer
 * evidence and derives a per-subject scientific state with explicit reason
 * codes and named gate results. It is the first E4 slice:
 *
 * ```text
 * E3 evidence
 *     ↓
 * E4A policy
 *     ↓
 * scientific state + reasons + gates
 * ```
 *
 * E4A scientific assessment ≠ product authorization ≠ runtime authority.
 * E4B (explicit product + athlete authorization) and E4C (session-start
 * runtime compatibility) do not exist. This module has no knowledge of any
 * authorization record.
 *
 * Purity contract: the core evaluator is deterministic, reads no storage,
 * samples no clock (caller-supplied ISO strings are parsed, never read from
 * a live time source), reads no global profile, touches no machine runtime,
 * imports no control code, mutates no FitnessState, and never recomputes
 * E1/E2 values. `evaluatedAt` is supplied by the caller. E4A output is
 * derived and runtime-only: no
 * store, no workout-summary field, no FitnessState field, no export field.
 *
 * Controller-circularity caveat:
 *
 * ```text
 * E1 candidate: calibration inverse at the legacy HR region.
 * E2/E3 observed settled watts: measured while the legacy HR controller was
 * actively seeking that same HR region.
 * ```
 *
 * Current candidate-vs-observed agreement is therefore transfer evidence,
 * not independent proof of prescription quality. In particular the assessor
 * never treats HR-in-band occupancy, inside-candidate agreement, or perfect
 * closed-loop error as success: without truly independent open-loop evidence
 * and trustworthy actuation-mode evidence, `eligible` is unreachable under the
 * production policy. E2 v3 held-workload forward-response evidence (forward HR
 * prediction error at held observed resistance) removes HR-band conditioning
 * but not controller selection of the held resistance, so it is surfaced
 * descriptively in the digest and never satisfies the open-loop gate.
 *
 * Modality semantics: the current E1 threshold candidate is athlete-relative
 * workload associated with the prescribed legacy threshold HR region. It is
 * not a personal physiological threshold (no FTP / lactate / ventilatory
 * threshold evidence exists). The subject modality is named accordingly:
 * `legacy_hr_region_workload`.
 *
 * E3/E4A layering:
 *
 * ```text
 * E3 longitudinal evidence = read-only analysis
 * E4A                      = scientific policy assessment over comparable evidence
 * ```
 *
 * E4A does not import E3 or any other module: the only permitted consumer is
 * the read-only developer diagnostics projection, which imports E4A (never
 * the reverse). E4A therefore independently verifies identity at its own
 * trust boundary instead of trusting upstream grouping. The E4A evidence
 * builder below applies the full cohort key over frozen E2 fields:
 * athlete × evidence session IDs × estimator id/version × protocol id/version
 * × formal observedAt × calibration workload provenance × observed-power
 * provenance × machine ID × machine profile version × legacy HR band.
 * Sessions with incomplete identity are excluded with counts (fail closed);
 * they are never pooled into an "unavailable" cohort. Sessions carrying more
 * than one characterized threshold/aerobic-base phase for the subject
 * intensity are excluded rather than silently reduced to one phase.
 */
export const SCIENTIFIC_ASSESSMENT_SCHEMA_VERSION_V1 = 1;
export const SCIENTIFIC_ASSESSMENT_ASSESSOR_ID_V1 = "personalization-scientific-assessor";
export const SCIENTIFIC_ASSESSMENT_ASSESSOR_VERSION_V1 = 1;
export const SCIENTIFIC_ASSESSMENT_POLICY_ID_V1 = "e4a-scientific-assessment-policy";
export const SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V1 = 1;
export const SCIENTIFIC_ASSESSMENT_STATES = [
    "not_applicable",
    "collecting",
    "eligible",
    "contradicted",
    "stale",
    "superseded",
];
const REASON_ORDER = [
    "identity_incomplete_calibration",
    "identity_incomplete_machine",
    "unsupported_modality",
    "candidate_unavailable",
    "candidate_outside_domain",
    "insufficient_independent_sessions",
    "insufficient_calendar_spread",
    "edge_domain_only",
    "controller_saturation_dominant",
    "persistent_signed_bias_positive",
    "persistent_signed_bias_negative",
    "variance_exceeds_policy",
    "open_loop_evidence_unavailable",
    "actuation_mode_unknown",
    "evidence_stale",
    "calibration_superseded",
];
/**
 * Production policy `e4a-scientific-assessment-policy@1`. Its type pins the
 * literal id/version and both evidence dimensions to
 * `required_but_unavailable`, so `eligible` is unreachable under it even for
 * a caller that supplies synthetic future-complete session evidence.
 */
export const E4A_SCIENTIFIC_ASSESSMENT_POLICY_V1 = Object.freeze({
    id: SCIENTIFIC_ASSESSMENT_POLICY_ID_V1,
    version: SCIENTIFIC_ASSESSMENT_POLICY_VERSION_V1,
    minIndependentSessions: 4,
    minDistinctDates: 4,
    minCalendarSpanDays: 14,
    characterizationMinInteriorSessions: 1,
    characterizationMaxMedianAbsoluteBiasWatts: 10,
    characterizationMaxSettledWattsCv: 0.15,
    characterizationMaxSaturationIncidence: 0.5,
    openLoopEvidence: "required_but_unavailable",
    actuationModeEvidence: "required_but_unavailable",
    staleness: "not_configured",
});
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.trim() !== "";
}
function isIsoDateTime(value) {
    if (typeof value !== "string" || value === "")
        return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed);
}
function sortedMedian(values) {
    const finite = values.filter(isFiniteNumber).sort((a, b) => a - b);
    if (finite.length === 0)
        return null;
    const middle = Math.floor(finite.length / 2);
    return finite.length % 2 === 0
        ? (finite[middle - 1] + finite[middle]) / 2
        : finite[middle];
}
function coefficientOfVariation(values) {
    const finite = values.filter(isFiniteNumber);
    if (finite.length < 2)
        return null;
    const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
    if (mean === 0)
        return null;
    const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length;
    return Math.sqrt(variance) / Math.abs(mean);
}
function calibrationEquals(left, right) {
    if (left.estimatorId !== right.estimatorId || left.estimatorVersion !== right.estimatorVersion)
        return false;
    if (left.protocolId !== right.protocolId || left.protocolVersion !== right.protocolVersion)
        return false;
    if (left.observedAt !== right.observedAt || left.workloadProvenance !== right.workloadProvenance)
        return false;
    // Evidence session IDs identify the calibration instance as a set: order
    // must not turn the same calibration into a false supersession.
    const leftIds = normalizedSessionIds(left.evidenceSessionIds);
    const rightIds = normalizedSessionIds(right.evidenceSessionIds);
    if (leftIds.length !== rightIds.length)
        return false;
    return leftIds.every((id, index) => id === rightIds[index]);
}
function normalizedSessionIds(ids) {
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}
function calibrationIdentityValid(identity) {
    if (!isRecord(identity))
        return false;
    if (!Array.isArray(identity.evidenceSessionIds) || identity.evidenceSessionIds.length === 0)
        return false;
    if (!identity.evidenceSessionIds.every(isNonEmptyString))
        return false;
    if (!isNonEmptyString(identity.estimatorId) || !Number.isInteger(identity.estimatorVersion))
        return false;
    if (!isNonEmptyString(identity.protocolId) || !Number.isInteger(identity.protocolVersion))
        return false;
    if (!isIsoDateTime(identity.observedAt))
        return false;
    return identity.workloadProvenance === "measured_watts" ||
        identity.workloadProvenance === "calibrated_at_verified_cadence";
}
function sessionMatchesSubject(session, subject) {
    var _a, _b;
    if (session.athleteId !== subject.athleteId)
        return false;
    if (session.activity !== subject.activity || session.phaseKind !== subject.phaseKind)
        return false;
    if (session.intensityId !== subject.intensityId)
        return false;
    if (!calibrationEquals(session.calibration, subject.calibration))
        return false;
    if (session.machineId !== subject.machineId)
        return false;
    if (session.machineProfileVersion !== subject.machineProfileVersion)
        return false;
    if (session.observedPowerProvenance !== subject.observedPowerProvenance)
        return false;
    if (((_a = session.legacyHrBand) === null || _a === void 0 ? void 0 : _a.minBpm) !== subject.legacyHrBand.minBpm)
        return false;
    if (((_b = session.legacyHrBand) === null || _b === void 0 ? void 0 : _b.maxBpm) !== subject.legacyHrBand.maxBpm)
        return false;
    return true;
}
/** Relative tolerance matching the strict E2 reader's derived-value check. */
function nearlyEqual(a, b) {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}
/**
 * Semantic validation of one frozen evidence row. Fails closed on values that
 * are structurally impossible, not merely non-finite; nothing is clamped.
 * The exact E2 comparison invariants (signed = observed − midpoint,
 * absolute = |signed|, normalized = absolute / width) are checked with the
 * same relative tolerance the strict E2 reader uses, so persisted rounding
 * noise never rejects real evidence.
 */
function sessionEvidenceValid(session) {
    if (!isNonEmptyString(session.workoutSessionId) || utcDateKey(session.createdAt) === null)
        return false;
    if (!isFiniteNumber(session.candidateWidthWatts) || session.candidateWidthWatts <= 0)
        return false;
    if (!isFiniteNumber(session.candidateMidpointWatts) || session.candidateMidpointWatts <= 0)
        return false;
    if (!isFiniteNumber(session.observedSettledWatts) || session.observedSettledWatts < 0)
        return false;
    if (!isFiniteNumber(session.signedDifferenceWatts))
        return false;
    if (!isFiniteNumber(session.absoluteDifferenceWatts) || session.absoluteDifferenceWatts < 0)
        return false;
    if (!nearlyEqual(session.signedDifferenceWatts, session.observedSettledWatts - session.candidateMidpointWatts))
        return false;
    if (!nearlyEqual(session.absoluteDifferenceWatts, Math.abs(session.signedDifferenceWatts)))
        return false;
    if (session.widthNormalizedAbsoluteError !== null &&
        (!isFiniteNumber(session.widthNormalizedAbsoluteError) ||
            !nearlyEqual(session.widthNormalizedAbsoluteError, session.absoluteDifferenceWatts / session.candidateWidthWatts)))
        return false;
    if (!isFiniteNumber(session.saturationRatio) ||
        session.saturationRatio < 0 || session.saturationRatio > 1)
        return false;
    if (!isRecord(session.legacyHrBand) ||
        !isFiniteNumber(session.legacyHrBand.minBpm) || !isFiniteNumber(session.legacyHrBand.maxBpm) ||
        session.legacyHrBand.minBpm <= 0 || session.legacyHrBand.maxBpm < session.legacyHrBand.minBpm)
        return false;
    // Chronology: a workout cannot precede the formal calibration it was
    // prescribed from, and a derived assessment age cannot be negative.
    if (session.assessmentAgeDays !== null &&
        (!isFiniteNumber(session.assessmentAgeDays) || session.assessmentAgeDays < 0))
        return false;
    if (isRecord(session.calibration) && isIsoDateTime(session.calibration.observedAt) &&
        Date.parse(session.createdAt) < Date.parse(session.calibration.observedAt))
        return false;
    if (session.openLoop !== null && (!isRecord(session.openLoop) ||
        !Number.isInteger(session.openLoop.stableResistanceWindowCount) ||
        session.openLoop.stableResistanceWindowCount < 0))
        return false;
    return session.domainBucket === "interior" || session.domainBucket === "edge";
}
function heldWorkloadForwardSessionValid(value) {
    return isRecord(value) && isNonEmptyString(value.workoutSessionId) &&
        Number.isInteger(value.qualifyingWindowCount) && value.qualifyingWindowCount >= 1 &&
        Number.isInteger(value.qualifyingDurationSec) && value.qualifyingDurationSec >= 1 &&
        isFiniteNumber(value.medianSignedErrorBpm) &&
        isFiniteNumber(value.medianAbsoluteErrorBpm) && value.medianAbsoluteErrorBpm >= 0;
}
/** One entry per workout; malformed or duplicated entries are dropped (fail closed). */
function heldWorkloadForwardDigest(entries, comparable) {
    var _a;
    if (!comparable || !Array.isArray(entries))
        return { count: 0, signed: null, absolute: null };
    const ids = new Map();
    for (const entry of entries) {
        if (isRecord(entry) && isNonEmptyString(entry.workoutSessionId)) {
            ids.set(entry.workoutSessionId, ((_a = ids.get(entry.workoutSessionId)) !== null && _a !== void 0 ? _a : 0) + 1);
        }
    }
    const valid = entries.filter((entry) => heldWorkloadForwardSessionValid(entry) && ids.get(entry.workoutSessionId) === 1);
    const signed = sortedMedian(valid.map((entry) => entry.medianSignedErrorBpm));
    const absolute = sortedMedian(valid.map((entry) => entry.medianAbsoluteErrorBpm));
    return {
        count: valid.length,
        signed: signed === null ? null : Math.round(signed * 10) / 10,
        absolute: absolute === null ? null : Math.round(absolute * 10) / 10,
    };
}
function orderReasons(reasons) {
    const rank = new Map(REASON_ORDER.map((reason, index) => [reason, index]));
    return [...new Set(reasons)].sort((a, b) => { var _a, _b; return ((_a = rank.get(a)) !== null && _a !== void 0 ? _a : 0) - ((_b = rank.get(b)) !== null && _b !== void 0 ? _b : 0); });
}
function utcDateKey(createdAt) {
    if (!isIsoDateTime(createdAt))
        return null;
    if (!/^\d{4}-\d{2}-\d{2}/.test(createdAt))
        return null;
    return createdAt.slice(0, 10);
}
function daysBetween(fromIso, toIso) {
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    if (!Number.isFinite(from) || !Number.isFinite(to))
        return null;
    return (to - from) / (24 * 60 * 60 * 1000);
}
function createAccumulator() {
    const gates = [];
    const reasons = [];
    return {
        gates,
        reasons,
        push(id, status, reasonCode, measured) {
            const gate = { id, status };
            if (reasonCode !== undefined && status === "fail")
                gate.reasonCode = reasonCode;
            if (measured !== undefined)
                gate.measured = measured;
            gates.push(gate);
            if (status === "fail" && reasonCode !== undefined)
                reasons.push(reasonCode);
        },
    };
}
/**
 * Pure scientific assessor. Deterministic in (evidence, subject, policy,
 * evaluatedAt); no storage, clock, profile, machine, UI, or control access.
 * Never recomputes E1/E2 values — it only gates frozen evidence.
 *
 * E4A evaluates E1; it never modifies E1. There is no candidate correction,
 * bias compensation, adaptive offset, or learned watt target here. A
 * corrected workload would be a future separate modality with its own shadow
 * and authorization path.
 */
export function assessPersonalizedWorkloadEvidence(evidence, subject, policy, evaluatedAt) {
    var _a, _b, _c, _d, _e;
    const acc = createAccumulator();
    const subjectIdentityOk = isNonEmptyString(subject.athleteId) &&
        subject.activity === "bike" &&
        subject.phaseKind === "work" &&
        (subject.intensityId === "threshold" || subject.intensityId === "aerobic_base") &&
        subject.modality === "legacy_hr_region_workload" &&
        subject.phaseStructureClass === null;
    const calibrationOk = calibrationIdentityValid(subject.calibration);
    const subjectSessionIds = isRecord(subject.calibration) &&
        Array.isArray(subject.calibration.evidenceSessionIds)
        ? subject.calibration.evidenceSessionIds
        : [];
    const athleteOk = isNonEmptyString(subject.athleteId);
    const machineOk = isNonEmptyString(subject.machineId) && Number.isInteger(subject.machineProfileVersion);
    const bandOk = isRecord(subject.legacyHrBand) &&
        isFiniteNumber(subject.legacyHrBand.minBpm) &&
        isFiniteNumber(subject.legacyHrBand.maxBpm) &&
        subject.legacyHrBand.minBpm > 0 &&
        subject.legacyHrBand.maxBpm >= subject.legacyHrBand.minBpm;
    const observedProvenanceOk = subject.observedPowerProvenance === "measured_watts" ||
        subject.observedPowerProvenance === "calibrated_watts";
    if (!subjectIdentityOk) {
        acc.push("identity", "fail", !athleteOk || !calibrationOk
            ? "identity_incomplete_calibration"
            : !machineOk
                ? "identity_incomplete_machine"
                : "unsupported_modality");
    }
    else if (!athleteOk || !calibrationOk) {
        acc.push("identity", "fail", "identity_incomplete_calibration");
    }
    else if (!machineOk) {
        acc.push("identity", "fail", "identity_incomplete_machine");
    }
    else {
        acc.push("identity", "pass");
    }
    const identityPass = acc.gates[acc.gates.length - 1].status === "pass";
    // Candidate availability is judged only for a valid subject; an invalid
    // subject already reports its identity reason without piling on.
    if (!identityPass) {
        acc.push("candidate_availability", "not_applicable");
    }
    else if (!bandOk || !observedProvenanceOk || evidence.candidateStatus === "unavailable") {
        acc.push("candidate_availability", "fail", "candidate_unavailable", {
            candidateStatus: evidence.candidateStatus,
        });
    }
    else if (evidence.candidateStatus === "outside_domain") {
        acc.push("candidate_availability", "fail", "candidate_outside_domain", {
            candidateStatus: evidence.candidateStatus,
        });
    }
    else if (evidence.candidateStatus === "available") {
        acc.push("candidate_availability", "pass", undefined, { candidateStatus: evidence.candidateStatus });
    }
    else {
        // Unknown status values fail closed rather than reading as available.
        acc.push("candidate_availability", "fail", "candidate_unavailable", {
            candidateStatus: String(evidence.candidateStatus),
        });
    }
    const candidatePass = acc.gates[acc.gates.length - 1].status === "pass";
    // Hardened cohort isolation inside the assessor itself: only sessions
    // matching every subject identity dimension participate. Cross-cohort
    // sessions are ignored and counted, never pooled. A subject whose own
    // identity is incomplete matches nothing (fail closed).
    // Sessions are then put in canonical ID order so every derived value,
    // including floating-point sums, is independent of input order.
    const subjectComparable = identityPass && bandOk;
    let ignoredCrossCohortSessions = 0;
    let ignoredInvalidSessions = 0;
    const cohortSessions = [...((_a = evidence.sessions) !== null && _a !== void 0 ? _a : [])].filter((session) => {
        if (!subjectComparable || !sessionMatchesSubject(session, subject)) {
            ignoredCrossCohortSessions += 1;
            return false;
        }
        return true;
    });
    const idCounts = new Map();
    for (const session of cohortSessions) {
        idCounts.set(session.workoutSessionId, ((_b = idCounts.get(session.workoutSessionId)) !== null && _b !== void 0 ? _b : 0) + 1);
    }
    // Malformed evidence (unparseable timestamp, non-finite measurement,
    // unknown domain bucket) and duplicated workout session IDs cannot count as
    // independent sessions; every copy is excluded rather than picking one.
    const sessions = cohortSessions.filter((session) => {
        if (sessionEvidenceValid(session) && idCounts.get(session.workoutSessionId) === 1)
            return true;
        ignoredInvalidSessions += 1;
        return false;
    }).sort((a, b) => a.workoutSessionId.localeCompare(b.workoutSessionId));
    if (!identityPass || !candidatePass) {
        acc.push("provenance", "not_applicable");
    }
    else {
        acc.push("provenance", "pass", undefined, {
            calibrationProvenance: subject.calibration.workloadProvenance,
            observedProvenance: subject.observedPowerProvenance,
        });
    }
    const evaluable = identityPass && candidatePass;
    const dateKeys = new Map();
    for (const session of sessions) {
        const key = utcDateKey(session.createdAt);
        if (key !== null)
            dateKeys.set(key, ((_c = dateKeys.get(key)) !== null && _c !== void 0 ? _c : 0) + 1);
    }
    const distinctDateCount = dateKeys.size;
    const orderedTimes = sessions
        .map((session) => Date.parse(session.createdAt))
        .filter((time) => Number.isFinite(time))
        .sort((a, b) => a - b);
    const calendarSpanDays = orderedTimes.length === 0
        ? null
        : (orderedTimes[orderedTimes.length - 1] - orderedTimes[0]) / (24 * 60 * 60 * 1000);
    const interiorCount = sessions.filter((session) => session.domainBucket === "interior").length;
    const saturatedCount = sessions.filter((session) => session.saturationRatio > 0).length;
    const saturationIncidence = sessions.length === 0 ? null : saturatedCount / sessions.length;
    const signedValues = sessions.map((session) => session.signedDifferenceWatts);
    const absoluteValues = sessions.map((session) => session.absoluteDifferenceWatts);
    const widthValues = sessions.map((session) => session.candidateWidthWatts);
    const medianSigned = sortedMedian(signedValues);
    const medianAbsolute = sortedMedian(absoluteValues);
    const medianWidth = sortedMedian(widthValues);
    const settledCv = coefficientOfVariation(sessions.map((session) => session.observedSettledWatts));
    // Pure timestamp arithmetic only, parsed from caller-supplied ISO strings.
    // The evaluator never samples the clock; timestamps arrive as arguments.
    const evaluatedAtMs = Date.parse(evaluatedAt);
    const newestAgeDays = orderedTimes.length === 0 || !Number.isFinite(evaluatedAtMs)
        ? null
        : (evaluatedAtMs - orderedTimes[orderedTimes.length - 1]) / (24 * 60 * 60 * 1000);
    if (!evaluable) {
        acc.push("independent_session_volume", "not_applicable");
    }
    else if (sessions.length < policy.minIndependentSessions) {
        acc.push("independent_session_volume", "fail", "insufficient_independent_sessions", {
            sessionCount: sessions.length,
            required: policy.minIndependentSessions,
        });
    }
    else {
        acc.push("independent_session_volume", "pass", undefined, {
            sessionCount: sessions.length,
            required: policy.minIndependentSessions,
        });
    }
    const volumePass = acc.gates[acc.gates.length - 1].status === "pass";
    if (!evaluable) {
        acc.push("calendar_spread", "not_applicable");
    }
    else if (distinctDateCount < policy.minDistinctDates ||
        calendarSpanDays === null || calendarSpanDays < policy.minCalendarSpanDays) {
        acc.push("calendar_spread", "fail", "insufficient_calendar_spread", {
            distinctDates: distinctDateCount,
            requiredDates: policy.minDistinctDates,
            spanDays: calendarSpanDays,
            requiredSpanDays: policy.minCalendarSpanDays,
        });
    }
    else {
        acc.push("calendar_spread", "pass", undefined, {
            distinctDates: distinctDateCount,
            requiredDates: policy.minDistinctDates,
            spanDays: calendarSpanDays === null ? null : Math.round(calendarSpanDays * 10) / 10,
            requiredSpanDays: policy.minCalendarSpanDays,
        });
    }
    const spreadPass = acc.gates[acc.gates.length - 1].status === "pass";
    if (!evaluable) {
        acc.push("domain_support", "not_applicable");
    }
    else if (interiorCount < policy.characterizationMinInteriorSessions) {
        acc.push("domain_support", "fail", "edge_domain_only", {
            interiorSessions: interiorCount,
            requiredInterior: policy.characterizationMinInteriorSessions,
        });
    }
    else {
        acc.push("domain_support", "pass", undefined, {
            interiorSessions: interiorCount,
            requiredInterior: policy.characterizationMinInteriorSessions,
        });
    }
    const domainPass = acc.gates[acc.gates.length - 1].status === "pass";
    // Descriptive precision dimension: candidate width is evidence, reported
    // but never gated. Width depends on the HR band and calibration slope that
    // E1 controls, so it cannot be a success criterion on its own.
    if (!evaluable || sessions.length === 0) {
        acc.push("candidate_precision", "not_applicable");
    }
    else {
        acc.push("candidate_precision", "pass", undefined, {
            medianCandidateWidthWatts: medianWidth,
        });
    }
    // Signed bias and repeatability are evidence, not verdicts, until an
    // explicit policy gate evaluates them — and only on adequate, informative
    // evidence (volume + spread + domain + saturation all pass). HR-in-band
    // occupancy and inside-candidate agreement are never consulted anywhere in
    // this module: they measure closed-loop controller performance, not
    // candidate quality.
    const informative = volumePass && spreadPass && domainPass;
    if (!evaluable || sessions.length === 0) {
        acc.push("signed_bias", "not_applicable");
        acc.push("repeatability", "not_applicable");
    }
    else {
        if (medianSigned === null ||
            Math.abs(medianSigned) <= policy.characterizationMaxMedianAbsoluteBiasWatts) {
            acc.push("signed_bias", "pass", undefined, {
                medianSignedDifferenceWatts: medianSigned,
                maxAbsoluteBiasWatts: policy.characterizationMaxMedianAbsoluteBiasWatts,
            });
        }
        else if (medianSigned > 0) {
            acc.push("signed_bias", "fail", "persistent_signed_bias_positive", {
                medianSignedDifferenceWatts: Math.round(medianSigned * 10) / 10,
                maxAbsoluteBiasWatts: policy.characterizationMaxMedianAbsoluteBiasWatts,
            });
        }
        else {
            acc.push("signed_bias", "fail", "persistent_signed_bias_negative", {
                medianSignedDifferenceWatts: Math.round(medianSigned * 10) / 10,
                maxAbsoluteBiasWatts: policy.characterizationMaxMedianAbsoluteBiasWatts,
            });
        }
        if (settledCv === null || settledCv <= policy.characterizationMaxSettledWattsCv) {
            acc.push("repeatability", "pass", undefined, {
                settledWattsCv: settledCv,
                maxCv: policy.characterizationMaxSettledWattsCv,
            });
        }
        else {
            acc.push("repeatability", "fail", "variance_exceeds_policy", {
                settledWattsCv: Math.round(settledCv * 1000) / 1000,
                maxCv: policy.characterizationMaxSettledWattsCv,
            });
        }
    }
    const biasFail = acc.gates[acc.gates.length - 2].status === "fail";
    const varianceFail = acc.gates[acc.gates.length - 1].status === "fail";
    if (!evaluable) {
        acc.push("controller_saturation", "not_applicable");
    }
    else if (saturationIncidence !== null &&
        saturationIncidence > policy.characterizationMaxSaturationIncidence) {
        acc.push("controller_saturation", "fail", "controller_saturation_dominant", {
            saturationIncidence: Math.round(saturationIncidence * 1000) / 1000,
            maxIncidence: policy.characterizationMaxSaturationIncidence,
        });
    }
    else {
        acc.push("controller_saturation", "pass", undefined, {
            saturationIncidence,
            maxIncidence: policy.characterizationMaxSaturationIncidence,
        });
    }
    const saturationPass = acc.gates[acc.gates.length - 1].status === "pass";
    // Open-loop and actuation-mode gates make the current evidence gap visible
    // instead of letting closed-loop agreement pass as validation. Under a
    // policy that declares the dimension `required_but_unavailable` (the
    // production policy) the gate fails whatever the sessions carry; otherwise
    // it passes only when every session carries future open-loop evidence.
    if (!evaluable || sessions.length === 0) {
        acc.push("open_loop_evidence", "not_applicable");
        acc.push("actuation_mode_evidence", "not_applicable");
    }
    else {
        const openLoopSessions = sessions.filter((session) => session.openLoop !== null &&
            isFiniteNumber(session.openLoop.stableResistanceWindowCount) &&
            session.openLoop.stableResistanceWindowCount >= 1).length;
        if (policy.openLoopEvidence === "required" && openLoopSessions === sessions.length) {
            acc.push("open_loop_evidence", "pass", undefined, {
                sessionsWithOpenLoop: openLoopSessions,
                sessionCount: sessions.length,
            });
        }
        else {
            acc.push("open_loop_evidence", "fail", "open_loop_evidence_unavailable", {
                policy: policy.openLoopEvidence,
                sessionsWithOpenLoop: openLoopSessions,
                sessionCount: sessions.length,
            });
        }
        const knownModeSessions = sessions.filter((session) => session.actuationMode === "automatic" || session.actuationMode === "manual").length;
        if (policy.actuationModeEvidence === "required" && knownModeSessions === sessions.length) {
            acc.push("actuation_mode_evidence", "pass", undefined, {
                sessionsWithKnownMode: knownModeSessions,
                sessionCount: sessions.length,
            });
        }
        else {
            acc.push("actuation_mode_evidence", "fail", "actuation_mode_unknown", {
                policy: policy.actuationModeEvidence,
                sessionsWithKnownMode: knownModeSessions,
                sessionCount: sessions.length,
            });
        }
    }
    const openLoopPass = acc.gates[acc.gates.length - 2].status === "pass";
    const actuationPass = acc.gates[acc.gates.length - 1].status === "pass";
    if (!evaluable || sessions.length === 0 || policy.staleness === "not_configured") {
        acc.push("recency", "unavailable", undefined, { newestSessionAgeDays: newestAgeDays });
    }
    else if (newestAgeDays === null || newestAgeDays < 0) {
        // Caller-supplied `evaluatedAt` is not parseable, or precedes the newest
        // evidence (impossible chronology), so recency cannot be trusted.
        // Reported `unavailable` (blocks `eligible` when configured) rather than
        // treating negative age as fresh or inventing `stale` from a bad input.
        acc.push("recency", "unavailable", undefined, { newestSessionAgeDays: newestAgeDays });
    }
    else if (newestAgeDays > policy.staleness.maxDaysSinceNewestSession) {
        acc.push("recency", "fail", "evidence_stale", {
            newestSessionAgeDays: newestAgeDays,
            maxDaysSinceNewestSession: policy.staleness.maxDaysSinceNewestSession,
        });
    }
    else {
        acc.push("recency", "pass", undefined, {
            newestSessionAgeDays: newestAgeDays === null ? null : Math.round(newestAgeDays * 10) / 10,
            maxDaysSinceNewestSession: policy.staleness.maxDaysSinceNewestSession,
        });
    }
    const recencyFail = acc.gates[acc.gates.length - 1].status === "fail";
    const recencyUndetermined = policy.staleness !== "not_configured" &&
        acc.gates[acc.gates.length - 1].status === "unavailable";
    if (!identityPass) {
        acc.push("supersession", "not_applicable");
    }
    else if (evidence.currentCalibration === null) {
        // Type seam: without a caller-supplied trustworthy current-calibration
        // identity, supersession cannot be evaluated and stays unreachable.
        acc.push("supersession", "unavailable");
    }
    else if (!calibrationIdentityValid(evidence.currentCalibration) ||
        !calibrationEquals(evidence.currentCalibration, subject.calibration)) {
        acc.push("supersession", "fail", "calibration_superseded");
    }
    else {
        acc.push("supersession", "pass");
    }
    const superseded = acc.gates[acc.gates.length - 1].status === "fail";
    const supersessionPass = acc.gates[acc.gates.length - 1].status === "pass";
    // State precedence:
    //   not_applicable -> superseded -> stale -> collecting (inadequate
    //   evidence) -> contradicted -> collecting (required dimension
    //   unavailable) -> eligible.
    // `stale` requires previously adequate evidence (volume + spread pass);
    // otherwise thin old evidence is `collecting`. `contradicted` requires
    // adequate, informative evidence (volume + spread + domain + saturation
    // pass) but deliberately not open-loop / actuation-mode / currency
    // evidence: disagreement on closed-loop evidence is still disagreement,
    // whereas agreement on it is never proof. Those dimensions, a configured
    // but undeterminable recency, and an unknown current calibration only
    // block `eligible`.
    let state;
    if (!identityPass || !candidatePass) {
        state = "not_applicable";
    }
    else if (superseded) {
        state = "superseded";
    }
    else if (recencyFail && volumePass && spreadPass) {
        state = "stale";
    }
    else if (!informative || !saturationPass || recencyFail) {
        state = "collecting";
    }
    else if (biasFail || varianceFail) {
        state = "contradicted";
    }
    else if (!openLoopPass || !actuationPass || recencyUndetermined || !supersessionPass) {
        state = "collecting";
    }
    else {
        state = "eligible";
    }
    const heldForward = heldWorkloadForwardDigest(evidence.heldWorkloadForwardSessions, subjectComparable);
    return {
        schemaVersion: SCIENTIFIC_ASSESSMENT_SCHEMA_VERSION_V1,
        assessor: {
            id: SCIENTIFIC_ASSESSMENT_ASSESSOR_ID_V1,
            version: SCIENTIFIC_ASSESSMENT_ASSESSOR_VERSION_V1,
        },
        policy: { id: policy.id, version: policy.version },
        subject: {
            ...subject,
            calibration: {
                ...subject.calibration,
                evidenceSessionIds: [...subjectSessionIds],
            },
            legacyHrBand: { ...subject.legacyHrBand },
        },
        mode: "scientific_assessment",
        runtimeAuthority: false,
        state,
        reasonCodes: orderReasons(acc.reasons),
        gates: acc.gates,
        evidenceDigest: {
            sessionCount: sessions.length,
            distinctDateCount,
            calendarSpanDays: calendarSpanDays === null ? null : Math.round(calendarSpanDays * 10) / 10,
            sessionIds: sessions.map((session) => session.workoutSessionId).sort((a, b) => a.localeCompare(b)),
            interiorSessionCount: interiorCount,
            saturationIncidence: saturationIncidence === null
                ? null
                : Math.round(saturationIncidence * 1000) / 1000,
            medianSignedDifferenceWatts: medianSigned === null ? null : Math.round(medianSigned * 10) / 10,
            medianAbsoluteDifferenceWatts: medianAbsolute === null
                ? null
                : Math.round(medianAbsolute * 10) / 10,
            medianCandidateWidthWatts: medianWidth === null ? null : Math.round(medianWidth * 10) / 10,
            observedSettledWattsCv: settledCv === null ? null : Math.round(settledCv * 10000) / 10000,
            newestSessionAgeDays: newestAgeDays === null ? null : Math.round(newestAgeDays * 10) / 10,
            calibrationInstanceId: normalizedSessionIds(subjectSessionIds).join(","),
            excludedIncompleteIdentitySessions: (_d = evidence.excludedIncompleteIdentitySessions) !== null && _d !== void 0 ? _d : 0,
            excludedMultiPhaseSessions: (_e = evidence.excludedMultiPhaseSessions) !== null && _e !== void 0 ? _e : 0,
            ignoredCrossCohortSessions,
            ignoredInvalidSessions,
            heldWorkloadForwardSessionCount: heldForward.count,
            medianHeldWorkloadForwardSignedErrorBpm: heldForward.signed,
            medianHeldWorkloadForwardAbsoluteErrorBpm: heldForward.absolute,
        },
        evaluatedAt,
    };
}
/** Subject key for display, e.g. `threshold.legacy_hr_region_workload`. */
export function scientificSubjectKey(subject) {
    return `${subject.intensityId}.${subject.modality}`;
}
/** Frozen E1 outcome as persisted on the E2 phase: a valid candidate band exists. */
function phaseHasFrozenCandidate(phase) {
    return phase.shadowOutcome === "candidate" &&
        isRecord(phase.candidatePower) &&
        isFiniteNumber(phase.candidatePower.minWatts) &&
        isFiniteNumber(phase.candidatePower.maxWatts) &&
        phase.candidatePower.maxWatts >= phase.candidatePower.minWatts;
}
function phaseIsOutsideDomainFallback(phase) {
    return phase.shadowOutcome === "fallback" &&
        (phase.fallbackReason === "outside_observed_hr_range" ||
            phase.fallbackReason === "outside_observed_workload_range");
}
function sessionIdentityFrom(record, assessment, workout) {
    var _a, _b, _c, _d, _e, _f, _g;
    const sessionIds = (_b = (_a = assessment === null || assessment === void 0 ? void 0 : assessment.evidenceSessionIds) === null || _a === void 0 ? void 0 : _a.filter(isNonEmptyString)) !== null && _b !== void 0 ? _b : [];
    const uniqueSorted = [...new Set(sessionIds)].sort((a, b) => a.localeCompare(b));
    if (uniqueSorted.length === 0)
        return null;
    if (!isIsoDateTime(assessment === null || assessment === void 0 ? void 0 : assessment.observedAt))
        return null;
    if (!isNonEmptyString((_c = assessment === null || assessment === void 0 ? void 0 : assessment.algorithm) === null || _c === void 0 ? void 0 : _c.id))
        return null;
    if (!Number.isInteger((_d = assessment === null || assessment === void 0 ? void 0 : assessment.algorithm) === null || _d === void 0 ? void 0 : _d.version))
        return null;
    if (!isNonEmptyString((_e = assessment === null || assessment === void 0 ? void 0 : assessment.protocol) === null || _e === void 0 ? void 0 : _e.id))
        return null;
    if (!Number.isInteger((_f = assessment === null || assessment === void 0 ? void 0 : assessment.protocol) === null || _f === void 0 ? void 0 : _f.version))
        return null;
    const provenance = (_g = record.calibrationWorkloadProvenance) !== null && _g !== void 0 ? _g : assessment === null || assessment === void 0 ? void 0 : assessment.calibrationProvenance;
    if (provenance !== "measured_watts" && provenance !== "calibrated_at_verified_cadence")
        return null;
    if (!isNonEmptyString(workout === null || workout === void 0 ? void 0 : workout.machineId))
        return null;
    if (!Number.isInteger(workout === null || workout === void 0 ? void 0 : workout.machineProfileVersion))
        return null;
    return {
        evidenceSessionIds: uniqueSorted,
        estimatorId: assessment.algorithm.id,
        estimatorVersion: assessment.algorithm.version,
        protocolId: assessment.protocol.id,
        protocolVersion: assessment.protocol.version,
        observedAt: assessment.observedAt,
        workloadProvenance: provenance,
    };
}
/**
 * Pure hardened cohort builder: selects exactly the sessions belonging to
 * `subject` from frozen E2 evidence. Incomplete-identity records are
 * excluded with counts (fail closed, never pooled). Records with more than
 * one characterized phase for the subject intensity are excluded rather than
 * reduced. Incomplete-identity records cannot be attributed to a cohort, so
 * that count is athlete-wide; records from another calibration instance or
 * machine contribute nothing (not even fallback status). Open-loop and actuation-mode seams are `null` / `"unknown"`
 * because no E2 record carries either: E2 v3 held-workload forward-response
 * evidence is surfaced descriptively in `heldWorkloadForwardSessions`, never as
 * open-loop evidence.
 */
export function buildSubjectEvidence(input) {
    var _a, _b, _c, _d, _e, _f;
    const sessions = [];
    const heldWorkloadForwardSessions = [];
    let excludedIncompleteIdentitySessions = 0;
    let excludedMultiPhaseSessions = 0;
    let candidateSeen = false;
    let outsideDomainSeen = false;
    const subject = input.subject;
    for (const record of input.records) {
        if (record.athleteId !== subject.athleteId)
            continue;
        if (record.activity !== "bike")
            continue;
        const assessment = input.assessmentContexts[record.workoutSessionId];
        const workout = input.workoutContexts[record.workoutSessionId];
        const identity = sessionIdentityFrom(record, assessment, workout);
        if (identity === null) {
            // Cannot be attributed to any cohort, so it is counted athlete-wide.
            excludedIncompleteIdentitySessions += 1;
            continue;
        }
        // Record-level cohort isolation: another calibration instance or machine
        // contributes nothing to this subject, not even fallback or exclusion
        // counts.
        if (!calibrationEquals(identity, subject.calibration) ||
            workout.machineId !== subject.machineId ||
            workout.machineProfileVersion !== subject.machineProfileVersion)
            continue;
        const subjectPhases = record.phases.filter((phase) => phase.kind === "work" && phase.intensityId === subject.intensityId);
        // Candidate existence comes from the frozen E1 outcome on the subject's
        // own legacy HR band, independent of whether E2 characterized the phase
        // (or whether the session is later excluded as evidence).
        for (const phase of subjectPhases) {
            if (((_a = phase.legacyHeartRate) === null || _a === void 0 ? void 0 : _a.min) !== subject.legacyHrBand.minBpm ||
                ((_b = phase.legacyHeartRate) === null || _b === void 0 ? void 0 : _b.max) !== subject.legacyHrBand.maxBpm)
                continue;
            if (phaseHasFrozenCandidate(phase))
                candidateSeen = true;
            else if (phaseIsOutsideDomainFallback(phase))
                outsideDomainSeen = true;
        }
        // Every characterized phase counts toward the multi-phase rule, complete
        // or not, so an incomplete sibling cannot silently reduce a session to
        // one phase.
        const characterized = subjectPhases.filter((phase) => phase.characterizationOutcome === "characterized");
        if (characterized.length > 1) {
            excludedMultiPhaseSessions += 1;
            continue;
        }
        // Held-workload forward visibility is selected independently of
        // closed-loop characterization and HR-band success, but never bypasses the
        // structural ambiguity rules: a multi-phase-excluded workout contributes
        // nothing, and a workout with more than one relevant subject phase (same
        // band, frozen candidate, same observed provenance) contributes nothing.
        // One workout is one observation, however many windows it held.
        const relevantPhases = subjectPhases.filter((phase) => {
            var _a, _b;
            return ((_a = phase.legacyHeartRate) === null || _a === void 0 ? void 0 : _a.min) === subject.legacyHrBand.minBpm &&
                ((_b = phase.legacyHeartRate) === null || _b === void 0 ? void 0 : _b.max) === subject.legacyHrBand.maxBpm &&
                phaseHasFrozenCandidate(phase) &&
                phase.observedPowerProvenance === subject.observedPowerProvenance;
        });
        if (relevantPhases.length === 1 &&
            ((_c = relevantPhases[0].heldWorkloadForwardResponse) === null || _c === void 0 ? void 0 : _c.outcome) === "characterized") {
            const held = relevantPhases[0].heldWorkloadForwardResponse;
            if (held.stableResistance && held.forwardHeartRate) {
                heldWorkloadForwardSessions.push({
                    workoutSessionId: record.workoutSessionId,
                    qualifyingWindowCount: held.stableResistance.qualifyingWindowCount,
                    qualifyingDurationSec: held.stableResistance.qualifyingDurationSec,
                    medianSignedErrorBpm: held.forwardHeartRate.signedErrorBpm.median,
                    medianAbsoluteErrorBpm: held.forwardHeartRate.absoluteErrorBpm.median,
                });
            }
        }
        // Uncharacterized phases (E1 fallback or insufficient E2 evidence) never
        // become evidence; they only grounded the candidate status above.
        if (characterized.length === 0)
            continue;
        if (characterized[0].candidatePower === undefined ||
            characterized[0].comparison === undefined ||
            ((_d = characterized[0].legacyHeartRate) === null || _d === void 0 ? void 0 : _d.min) === undefined ||
            ((_e = characterized[0].legacyHeartRate) === null || _e === void 0 ? void 0 : _e.max) === undefined) {
            excludedIncompleteIdentitySessions += 1;
            continue;
        }
        const phase = characterized[0];
        if (phase.observedPowerProvenance !== "measured_watts" &&
            phase.observedPowerProvenance !== "calibrated_watts") {
            excludedIncompleteIdentitySessions += 1;
            continue;
        }
        const width = phase.candidatePower.maxWatts - phase.candidatePower.minWatts;
        const normalized = width > 0 ? phase.comparison.absoluteDifferenceWatts / width : null;
        sessions.push({
            workoutSessionId: record.workoutSessionId,
            createdAt: record.createdAt,
            athleteId: record.athleteId,
            activity: record.activity,
            phaseKind: phase.kind,
            intensityId: phase.intensityId,
            calibration: identity,
            machineId: workout.machineId,
            machineProfileVersion: workout.machineProfileVersion,
            observedPowerProvenance: phase.observedPowerProvenance,
            legacyHrBand: { minBpm: phase.legacyHeartRate.min, maxBpm: phase.legacyHeartRate.max },
            candidateWidthWatts: width,
            candidateMidpointWatts: phase.comparison.candidateMidpointWatts,
            observedSettledWatts: phase.comparison.observedInBandMedianWatts,
            signedDifferenceWatts: phase.comparison.signedDifferenceWatts,
            absoluteDifferenceWatts: phase.comparison.absoluteDifferenceWatts,
            widthNormalizedAbsoluteError: normalized,
            saturationRatio: phase.controllerContext.saturationRatio,
            domainBucket: ((_f = phase.candidateDomainMargins) === null || _f === void 0 ? void 0 : _f.bucket) === "interior" ? "interior" : "edge",
            assessmentAgeDays: null,
            openLoop: null,
            actuationMode: "unknown",
        });
    }
    // Sessions matching the subject cohort exactly. Assessment age is derived
    // here (workout createdAt minus frozen formal observedAt); it remains
    // evidence in the digest, never a verdict on its own.
    const matched = sessions.filter((session) => sessionMatchesSubject(session, subject));
    for (const session of matched) {
        const age = daysBetween(session.calibration.observedAt, session.createdAt);
        session.assessmentAgeDays = age === null ? null : Math.round(age);
    }
    return {
        athleteId: input.subject.athleteId,
        candidateStatus: candidateSeen
            ? "available"
            : outsideDomainSeen
                ? "outside_domain"
                : "unavailable",
        sessions: matched,
        currentCalibration: input.currentCalibration,
        excludedIncompleteIdentitySessions,
        excludedMultiPhaseSessions,
        heldWorkloadForwardSessions,
    };
}
/**
 * Discovers distinct hardened subject cohorts present in frozen E2 evidence
 * for the assessable intensities (`threshold`, `aerobic_base`) without
 * hard-coding the reducer to Thursday. Each distinct full-identity cohort
 * becomes one assessed subject. A subject is discovered from any phase whose
 * frozen E1 outcome is a candidate, so a valid subject that is still
 * collecting E2 evidence (no characterized session yet) is assessed as
 * `collecting` rather than hidden. Cohorts with incomplete identity
 * (including an observed-power provenance that is not measured/calibrated)
 * never become subjects. Phase-structure class stays `null` (see subject docs).
 */
export function discoverDiagnosticSubjects(records, assessmentContexts, workoutContexts, athleteId) {
    var _a, _b;
    const seen = new Map();
    const intensities = ["threshold", "aerobic_base"];
    for (const record of records) {
        if (record.athleteId !== athleteId || record.activity !== "bike")
            continue;
        const assessment = assessmentContexts[record.workoutSessionId];
        const workout = workoutContexts[record.workoutSessionId];
        const identity = sessionIdentityFrom(record, assessment, workout);
        if (identity === null)
            continue;
        for (const phase of record.phases) {
            if (phase.kind !== "work" || !phaseHasFrozenCandidate(phase))
                continue;
            if (phase.intensityId !== intensities[0] && phase.intensityId !== intensities[1])
                continue;
            if (((_a = phase.legacyHeartRate) === null || _a === void 0 ? void 0 : _a.min) === undefined || ((_b = phase.legacyHeartRate) === null || _b === void 0 ? void 0 : _b.max) === undefined)
                continue;
            if (phase.observedPowerProvenance !== "measured_watts" &&
                phase.observedPowerProvenance !== "calibrated_watts")
                continue;
            if (!isNonEmptyString(workout === null || workout === void 0 ? void 0 : workout.machineId))
                continue;
            if (!Number.isInteger(workout === null || workout === void 0 ? void 0 : workout.machineProfileVersion))
                continue;
            const subject = {
                athleteId,
                activity: "bike",
                phaseKind: "work",
                intensityId: phase.intensityId,
                modality: "legacy_hr_region_workload",
                phaseStructureClass: null,
                calibration: identity,
                machineId: workout.machineId,
                machineProfileVersion: workout.machineProfileVersion,
                observedPowerProvenance: phase.observedPowerProvenance,
                legacyHrBand: { minBpm: phase.legacyHeartRate.min, maxBpm: phase.legacyHeartRate.max },
            };
            const key = JSON.stringify([
                subject.intensityId,
                subject.calibration.evidenceSessionIds,
                subject.calibration.estimatorId,
                subject.calibration.estimatorVersion,
                subject.calibration.protocolId,
                subject.calibration.protocolVersion,
                subject.calibration.observedAt,
                subject.calibration.workloadProvenance,
                subject.machineId,
                subject.machineProfileVersion,
                subject.observedPowerProvenance,
                subject.legacyHrBand.minBpm,
                subject.legacyHrBand.maxBpm,
            ]);
            if (!seen.has(key))
                seen.set(key, subject);
        }
    }
    // Sorted by the full cohort key so output order never depends on record
    // order, even for subjects that differ only in estimator, protocol,
    // provenance, or machine-profile version.
    return [...seen.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, subject]) => subject);
}
