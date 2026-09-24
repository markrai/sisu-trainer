import { aggregatePersonalizedPrescriptionCharacterizations, personalizedPrescriptionDiagnosticRows, } from "./personalizedPrescriptionCharacterization.js";
export const PERSONALIZATION_DIAGNOSTIC_EXCLUSIONS = [
    "phase_too_short",
    "missing_telemetry",
    "insufficient_hr_coverage",
    "insufficient_power_coverage",
    "insufficient_joint_coverage",
    "insufficient_settled_in_band_evidence",
    "unsupported_power_provenance",
    "phase_evidence_unavailable",
];
export const EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS = {
    workoutIntent: "all",
    intensity: "all",
    calibrationProvenance: "all",
    observedPowerProvenance: "all",
    assessmentQuality: "all",
    domainBucket: "all",
};
function phaseDimensions(record, phase) {
    var _a, _b, _c, _d, _e;
    return {
        workoutIntent: record.workoutIntent,
        intensity: (_a = phase.intensityId) !== null && _a !== void 0 ? _a : "unspecified",
        calibrationProvenance: (_b = record.calibrationWorkloadProvenance) !== null && _b !== void 0 ? _b : "unavailable",
        observedPowerProvenance: phase.observedPowerProvenance,
        assessmentQuality: (_c = record.formalAssessmentQuality) !== null && _c !== void 0 ? _c : "unavailable",
        domainBucket: (_e = (_d = phase.candidateDomainMargins) === null || _d === void 0 ? void 0 : _d.bucket) !== null && _e !== void 0 ? _e : "not_applicable",
    };
}
function phaseMatchesFilters(record, phase, filters) {
    const dimensions = phaseDimensions(record, phase);
    return (filters.workoutIntent === "all" || filters.workoutIntent === dimensions.workoutIntent) &&
        (filters.intensity === "all" || filters.intensity === dimensions.intensity) &&
        (filters.calibrationProvenance === "all" || filters.calibrationProvenance === dimensions.calibrationProvenance) &&
        (filters.observedPowerProvenance === "all" || filters.observedPowerProvenance === dimensions.observedPowerProvenance) &&
        (filters.assessmentQuality === "all" || filters.assessmentQuality === dimensions.assessmentQuality) &&
        (filters.domainBucket === "all" || filters.domainBucket === dimensions.domainBucket);
}
function options(values) {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
export function personalizationDiagnosticsFilterOptions(records) {
    const dimensions = records.flatMap((record) => record.phases.map((phase) => phaseDimensions(record, phase)));
    return {
        workoutIntent: options(dimensions.map((value) => value.workoutIntent)),
        intensity: options(dimensions.map((value) => value.intensity)),
        calibrationProvenance: options(dimensions.map((value) => value.calibrationProvenance)),
        observedPowerProvenance: options(dimensions.map((value) => value.observedPowerProvenance)),
        assessmentQuality: options(dimensions.map((value) => value.assessmentQuality)),
        domainBucket: options(dimensions.map((value) => value.domainBucket)),
    };
}
/**
 * Consumes only getAllWorkoutSummaries() output, after its strict E1/E2 readers.
 * This function deliberately contains no parser and never reads IndexedDB itself.
 */
export function extractTrustedPersonalizationCharacterizations(history, currentAthleteId) {
    return history.flatMap(({ summary }) => {
        const evaluation = summary.shadow_prescription_evaluation;
        const record = summary.shadow_prescription_characterization;
        if (!evaluation || !record || summary.athlete_id !== currentAthleteId)
            return [];
        if (record.athleteId !== currentAthleteId || evaluation.athleteId !== currentAthleteId)
            return [];
        if (record.workoutSessionId !== summary.external_session_id)
            return [];
        if (record.workoutSelector !== summary.day || evaluation.workoutSelector !== summary.day)
            return [];
        if (record.activity !== summary.activity)
            return [];
        return [record];
    });
}
export function extractTrustedPersonalizationAssessmentContexts(history, currentAthleteId) {
    const contexts = {};
    for (const { summary } of history) {
        const evaluation = summary.shadow_prescription_evaluation;
        const record = summary.shadow_prescription_characterization;
        if (!evaluation || !record || summary.athlete_id !== currentAthleteId ||
            record.athleteId !== currentAthleteId || evaluation.athleteId !== currentAthleteId ||
            record.workoutSessionId !== summary.external_session_id ||
            record.workoutSelector !== summary.day || evaluation.workoutSelector !== summary.day ||
            record.activity !== summary.activity || evaluation.activity !== summary.activity)
            continue;
        const evidence = evaluation.fitnessEvidenceSnapshot;
        if (!evidence || evidence.calibration.points.length === 0)
            continue;
        const heartRates = evidence.calibration.points.map((point) => point.heartRateBpm);
        contexts[record.workoutSessionId] = {
            observedAt: evidence.metricObservedAt,
            quality: evidence.quality,
            calibrationProvenance: evidence.calibration.workloadProvenance,
            observedMinHeartRateBpm: Math.min(...heartRates),
            observedMaxHeartRateBpm: Math.max(...heartRates),
            observedMinWatts: evidence.calibration.observedMinWatts,
            observedMaxWatts: evidence.calibration.observedMaxWatts,
            ...(evidence.fitnessStateSchemaVersion !== undefined
                ? { fitnessStateSchemaVersion: evidence.fitnessStateSchemaVersion } : {}),
            ...(evidence.algorithm ? { algorithm: { ...evidence.algorithm } } : {}),
            ...(evidence.calibration.protocol ? { protocol: { ...evidence.calibration.protocol } } : {}),
            ...(evidence.evidenceSessionIds ? { evidenceSessionIds: [...evidence.evidenceSessionIds] } : {}),
        };
    }
    return contexts;
}
/** Existing local workout metadata only; no device or identifier is synthesized. */
export function extractTrustedPersonalizationWorkoutContexts(history, currentAthleteId) {
    var _a, _b, _c, _d, _e, _f;
    const contexts = {};
    for (const { summary } of history) {
        const evaluation = summary.shadow_prescription_evaluation;
        const record = summary.shadow_prescription_characterization;
        if (!evaluation || !record || summary.athlete_id !== currentAthleteId ||
            record.athleteId !== currentAthleteId || evaluation.athleteId !== currentAthleteId ||
            record.workoutSessionId !== summary.external_session_id ||
            record.workoutSelector !== summary.day || evaluation.workoutSelector !== summary.day ||
            record.activity !== summary.activity || evaluation.activity !== summary.activity)
            continue;
        contexts[record.workoutSessionId] = {
            appVersion: (_a = summary.app_version) !== null && _a !== void 0 ? _a : null,
            machineId: (_b = summary.machine_id) !== null && _b !== void 0 ? _b : null,
            machineProfileVersion: (_c = summary.machine_profile_version) !== null && _c !== void 0 ? _c : null,
            activePrescriptionSchemaVersion: (_e = (_d = summary.resolved_prescription) === null || _d === void 0 ? void 0 : _d.schemaVersion) !== null && _e !== void 0 ? _e : null,
            shadowSchemaVersion: (_f = evaluation.schemaVersion) !== null && _f !== void 0 ? _f : null,
            characterizationSchemaVersion: record.schemaVersion,
        };
    }
    return contexts;
}
function exclusionCountsFor(records) {
    return Object.fromEntries(PERSONALIZATION_DIAGNOSTIC_EXCLUSIONS.map((reason) => [
        reason,
        records.reduce((count, record) => count + record.phases.filter((phase) => phase.exclusionReason === reason).length, 0),
    ]));
}
/** All-record evidence readiness counts. Filters never affect this summary. */
export function summarizePersonalizationEvidenceCollection(records) {
    const candidates = records.flatMap((record) => record.phases.map((phase) => ({ record, phase })))
        .filter(({ phase }) => phase.shadowOutcome === "candidate");
    const saturationDeterminate = candidates.filter(({ phase }) => phase.controllerContext.available);
    const saturated = saturationDeterminate.filter(({ phase }) => phase.controllerContext.anyBoundarySaturationSeconds > 0);
    return {
        completedWorkoutsWithE2: new Set(records.map((record) => record.workoutSessionId)).size,
        candidatePhases: candidates.length,
        evaluableCandidatePhases: candidates.filter(({ phase }) => phase.characterizationOutcome === "characterized").length,
        measuredToMeasuredObservations: candidates.filter(({ record, phase }) => record.calibrationWorkloadProvenance === "measured_watts" &&
            phase.observedPowerProvenance === "measured_watts").length,
        cadenceCalibratedObservations: candidates.filter(({ record, phase }) => record.calibrationWorkloadProvenance === "calibrated_at_verified_cadence" ||
            phase.observedPowerProvenance === "calibrated_watts").length,
        aerobicBaseCandidatePhases: candidates.filter(({ record }) => record.workoutIntent === "aerobic_base").length,
        aerobicVolumeCandidatePhases: candidates.filter(({ record }) => record.workoutIntent === "aerobic_volume").length,
        interiorCandidatePhases: candidates.filter(({ phase }) => { var _a; return ((_a = phase.candidateDomainMargins) === null || _a === void 0 ? void 0 : _a.bucket) === "interior"; }).length,
        edgeCandidatePhases: candidates.filter(({ phase }) => { var _a; return ((_a = phase.candidateDomainMargins) === null || _a === void 0 ? void 0 : _a.bucket) === "edge"; }).length,
        saturatedCandidatePhases: saturated.length,
        saturationDeterminateCandidatePhases: saturationDeterminate.length,
        ...(saturationDeterminate.length > 0 ? { saturationIncidence: saturated.length / saturationDeterminate.length } : {}),
        exclusionCounts: exclusionCountsFor(records),
    };
}
export function filterPersonalizationCharacterizations(records, filters) {
    return records.flatMap((record) => {
        const phases = record.phases.filter((phase) => phaseMatchesFilters(record, phase, filters));
        return phases.length > 0 ? [{ ...record, phases: [...phases] }] : [];
    });
}
export function buildPersonalizationDiagnosticsModel(records, filters = EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS, assessmentContexts = {}, workoutContexts = {}) {
    const normalizedFilters = { ...EMPTY_PERSONALIZATION_DIAGNOSTICS_FILTERS, ...filters };
    const filtered = filterPersonalizationCharacterizations(records, normalizedFilters);
    const baseRows = personalizedPrescriptionDiagnosticRows(filtered);
    let rowIndex = 0;
    const rows = filtered.flatMap((record) => record.phases.map((phase) => {
        var _a, _b, _c, _d, _e, _f;
        const base = baseRows[rowIndex];
        const row = {
            ...base,
            index: rowIndex,
            date: record.createdAt,
            workout: record.workoutIntent,
            assessmentDomain: (_b = (_a = phase.candidateDomainMargins) === null || _a === void 0 ? void 0 : _a.bucket) !== null && _b !== void 0 ? _b : "not_applicable",
            agreement: (_d = (_c = phase.comparison) === null || _c === void 0 ? void 0 : _c.agreement) !== null && _d !== void 0 ? _d : "not_available",
            assessmentContext: (_e = assessmentContexts[record.workoutSessionId]) !== null && _e !== void 0 ? _e : null,
            workoutContext: (_f = workoutContexts[record.workoutSessionId]) !== null && _f !== void 0 ? _f : null,
            record,
            phaseRecord: phase,
        };
        rowIndex += 1;
        return row;
    }));
    const exclusionCounts = exclusionCountsFor(filtered);
    return {
        filters: normalizedFilters,
        filterOptions: personalizationDiagnosticsFilterOptions(records),
        sourceRecordCount: records.length,
        records: filtered,
        aggregate: aggregatePersonalizedPrescriptionCharacterizations(filtered),
        rows,
        exclusionCounts,
        evidenceCollectionSummary: summarizePersonalizationEvidenceCollection(records),
    };
}
/** Stable local export. It includes immutable E2 records, never profile data or raw HR traces. */
export function createPersonalizationDiagnosticsExport(model) {
    return {
        schemaVersion: 1,
        filters: { ...model.filters },
        aggregate: model.aggregate,
        diagnosticRows: model.rows.map(({ record: _record, phaseRecord: _phaseRecord, ...row }) => row),
        characterizationRecords: [...model.records]
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.workoutSessionId.localeCompare(b.workoutSessionId))
            .map((record) => ({ ...record, phases: [...record.phases] })),
    };
}
export function personalizationDiagnosticsExportJson(model) {
    return `${JSON.stringify(createPersonalizationDiagnosticsExport(model), null, 2)}\n`;
}
const LABELS = {
    measured_watts: "Measured watts",
    calibrated_at_verified_cadence: "Cadence-calibrated watts",
    calibrated_watts: "Calibrated watts",
    mixed: "Mixed",
    unavailable: "Unavailable",
    unspecified: "Unspecified",
    not_applicable: "Not applicable",
    aerobic_base: "Aerobic base",
    aerobic_volume: "Aerobic volume",
    inside_candidate: "Inside candidate",
    below_candidate: "Below candidate",
    above_candidate: "Above candidate",
    not_available: "Not available",
    characterized: "Characterized",
    insufficient_evidence: "Insufficient evidence",
    not_candidate: "No candidate",
    unsupported_observed_provenance: "Unsupported observed provenance",
    telemetry_unavailable: "Telemetry unavailable",
    phase_too_short: "Phase too short",
    missing_telemetry: "Missing telemetry",
    insufficient_hr_coverage: "Insufficient HR coverage",
    insufficient_power_coverage: "Insufficient power coverage",
    insufficient_joint_coverage: "Insufficient joint coverage",
    insufficient_settled_in_band_evidence: "Insufficient settled in-target evidence",
    unsupported_power_provenance: "Unsupported or mixed power source",
    phase_evidence_unavailable: "Phase evidence unavailable",
    edge: "Edge",
    interior: "Interior",
    high: "High",
    moderate: "Moderate",
    low: "Low",
    unverified: "Unverified",
};
export function personalizationDiagnosticLabel(value) {
    var _a;
    return (_a = LABELS[value]) !== null && _a !== void 0 ? _a : value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => {
        var _a;
        return (_a = ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        })[character]) !== null && _a !== void 0 ? _a : character;
    });
}
function percent(value) {
    return value === undefined ? "n/a" : `${Math.round(value * 100)}%`;
}
function metric(value, count, suffix) {
    return `<strong>${value === undefined ? "n/a" : `${Math.round(value * 10) / 10}${suffix}`}</strong><span>n = ${count} phases</span>`;
}
function optionMarkup(values, selected) {
    return [`<option value="all"${selected === "all" ? " selected" : ""}>All</option>`, ...values.map((value) => `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(personalizationDiagnosticLabel(value))}</option>`)].join("");
}
/** Responsive developer presentation only; every number comes from E2 helpers or frozen fields. */
export function personalizationDiagnosticsHtml(model) {
    if (model.sourceRecordCount === 0) {
        return `<div class="personalization-diagnostics-empty"><strong>No personalization characterization data yet.</strong><span>Complete a qualifying bike workout after a formal VO₂ assessment to begin collecting shadow validation data.</span></div>`;
    }
    const aggregate = model.aggregate;
    const evidence = model.evidenceCollectionSummary;
    const filters = model.filters;
    const filterOptions = model.filterOptions;
    const filtersHtml = [
        ["personalizationIntentFilter", "Workout intent", "workoutIntent", filterOptions.workoutIntent],
        ["personalizationIntensityFilter", "Intensity", "intensity", filterOptions.intensity],
        ["personalizationCalibrationFilter", "Formal calibration", "calibrationProvenance", filterOptions.calibrationProvenance],
        ["personalizationObservedPowerFilter", "Observed power", "observedPowerProvenance", filterOptions.observedPowerProvenance],
        ["personalizationQualityFilter", "Assessment quality", "assessmentQuality", filterOptions.assessmentQuality],
        ["personalizationDomainFilter", "Assessment domain", "domainBucket", filterOptions.domainBucket],
    ].map(([id, label, key, values]) => `<label><span>${label}</span><select id="${id}" class="modal-input personalization-filter" onchange="applyPersonalizationDiagnosticsFilters()">${optionMarkup(values, filters[key])}</select></label>`).join("");
    const cohortHtml = aggregate.groups.map((group) => `<article class="personalization-cohort">
    <h4>${escapeHtml(personalizationDiagnosticLabel(group.workoutIntent))} · ${escapeHtml(personalizationDiagnosticLabel(group.intensityId))}</h4>
    <div class="personalization-cohort-tags"><span>${escapeHtml(personalizationDiagnosticLabel(group.calibrationWorkloadProvenance))}</span><span>${escapeHtml(personalizationDiagnosticLabel(group.observedPowerProvenance))} observed</span><span>${escapeHtml(personalizationDiagnosticLabel(group.formalAssessmentQuality))} quality</span><span>${escapeHtml(personalizationDiagnosticLabel(group.candidateDomainMarginBucket))} domain</span></div>
    <div class="personalization-metric-grid">
      <div><label>Median signed difference</label>${metric(group.signedDifferenceWatts.median, group.signedDifferenceWatts.count, " W")}</div>
      <div><label>Median absolute difference</label>${metric(group.absoluteDifferenceWatts.median, group.absoluteDifferenceWatts.count, " W")}</div>
      <div><label>Observed median inside candidate</label><strong>${group.observedMedianInsideCandidate.count} / ${group.observedMedianInsideCandidate.total}${group.observedMedianInsideCandidate.proportion === undefined ? "" : ` · ${percent(group.observedMedianInsideCandidate.proportion)}`}</strong><span>n = ${group.observedMedianInsideCandidate.total} phases</span></div>
      <div><label>Median HR coverage</label>${metric(group.hrCoverageRatio.median === undefined ? undefined : group.hrCoverageRatio.median * 100, group.hrCoverageRatio.count, "%")}</div>
      <div><label>Median power coverage</label>${metric(group.powerCoverageRatio.median === undefined ? undefined : group.powerCoverageRatio.median * 100, group.powerCoverageRatio.count, "%")}</div>
      <div><label>Median joint coverage</label>${metric(group.jointCoverageRatio.median === undefined ? undefined : group.jointCoverageRatio.median * 100, group.jointCoverageRatio.count, "%")}</div>
      <div><label>Controller saturation incidence</label><strong>${group.controllerSaturationIncidence.count} / ${group.controllerSaturationIncidence.total}${group.controllerSaturationIncidence.proportion === undefined ? "" : ` · ${percent(group.controllerSaturationIncidence.proportion)}`}</strong><span>n = ${group.controllerSaturationIncidence.total} candidate phases</span></div>
    </div>
  </article>`).join("");
    const exclusions = PERSONALIZATION_DIAGNOSTIC_EXCLUSIONS.map((reason) => `<div><span>${escapeHtml(personalizationDiagnosticLabel(reason))}</span><strong>${model.exclusionCounts[reason]}</strong></div>`).join("");
    const allEvidenceExclusions = PERSONALIZATION_DIAGNOSTIC_EXCLUSIONS.map((reason) => `<div><span>${escapeHtml(personalizationDiagnosticLabel(reason))}</span><strong>${evidence.exclusionCounts[reason]}</strong></div>`).join("");
    const rows = model.rows.map((row) => `<tr>
    <td>${escapeHtml(new Date(row.date).toLocaleDateString())}</td><td>${escapeHtml(row.workout)}</td><td>${escapeHtml(row.phase)}</td>
    <td>${escapeHtml(row.legacyHeartRate)}</td><td>${escapeHtml(row.candidateWatts)}</td><td>${row.observedInBandWatts === null ? "n/a" : `${Math.round(row.observedInBandWatts)} W`}</td><td>${row.deltaWatts === null ? "n/a" : `${row.deltaWatts > 0 ? "+" : ""}${Math.round(row.deltaWatts)} W`}</td>
    <td>${percent(row.hrCoveragePercent / 100)}</td><td>${percent(row.powerCoveragePercent / 100)}</td><td>${row.hrInsideTargetPercent === null ? "n/a" : percent(row.hrInsideTargetPercent / 100)}</td><td>${percent(row.saturationPercent / 100)}</td>
    <td>${escapeHtml(personalizationDiagnosticLabel(row.calibrationProvenance))}</td><td>${escapeHtml(personalizationDiagnosticLabel(row.observedPowerProvenance))}</td><td>${escapeHtml(personalizationDiagnosticLabel(row.outcome))}</td><td>${escapeHtml(personalizationDiagnosticLabel(row.exclusion))}</td>
    <td><button type="button" class="button secondary personalization-detail-button" onclick="openPersonalizationDiagnostic(${row.index})">Inspect</button></td>
  </tr>`).join("");
    return `<section class="personalization-evidence-summary"><h4>All persisted E2 evidence</h4>
    <div class="personalization-count-grid">
      <div><strong>${evidence.completedWorkoutsWithE2}</strong><span>Completed workouts with E2</span></div>
      <div><strong>${evidence.candidatePhases}</strong><span>Candidate phases</span></div>
      <div><strong>${evidence.evaluableCandidatePhases}</strong><span>Evaluable candidate phases</span></div>
      <div><strong>${evidence.measuredToMeasuredObservations}</strong><span>Measured → measured observations</span></div>
      <div><strong>${evidence.cadenceCalibratedObservations}</strong><span>Any cadence-calibrated observations</span></div>
      <div><strong>${evidence.aerobicBaseCandidatePhases}</strong><span>Aerobic-base candidate phases</span></div>
      <div><strong>${evidence.aerobicVolumeCandidatePhases}</strong><span>Aerobic-volume candidate phases</span></div>
      <div><strong>${evidence.interiorCandidatePhases}</strong><span>Interior candidate phases</span></div>
      <div><strong>${evidence.edgeCandidatePhases}</strong><span>Edge candidate phases</span></div>
      <div><strong>${evidence.saturatedCandidatePhases} / ${evidence.saturationDeterminateCandidatePhases}${evidence.saturationIncidence === undefined ? "" : ` · ${percent(evidence.saturationIncidence)}`}</strong><span>Saturated / saturation-determinate candidates</span></div>
    </div>
    <div class="personalization-exclusions"><h4>Exclusions in all persisted evidence</h4>${allEvidenceExclusions}</div>
  </section>
    <div class="personalization-filter-grid">${filtersHtml}</div>
    <div class="personalization-count-grid"><div><strong>${aggregate.workoutCount}</strong><span>Completed workouts with E2 data</span></div><div><strong>${aggregate.candidatePhases}</strong><span>Candidate phases</span></div><div><strong>${aggregate.evaluableCandidatePhases}</strong><span>Evaluable candidate phases</span></div><div><strong>${aggregate.fallbackPhases}</strong><span>Fallback phases</span></div></div>
    ${aggregate.groups.length > 0 ? `<div class="personalization-cohorts">${cohortHtml}</div>` : `<div class="personalization-diagnostics-empty"><strong>No phases match these filters.</strong><span>Change a filter to inspect another cohort.</span></div>`}
    <div class="personalization-exclusions"><h4>Exclusions in visible cohort</h4>${exclusions}</div>
    <div class="personalization-table-scroll" tabindex="0"><table class="personalization-table"><thead><tr><th>Date</th><th>Workout</th><th>Phase</th><th>Legacy HR</th><th>Candidate watts</th><th>Observed in-band</th><th>Difference</th><th>HR coverage</th><th>Power coverage</th><th>HR in target</th><th>Saturation</th><th>Formal calibration</th><th>Observed power</th><th>Outcome</th><th>Exclusion</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div id="personalizationDiagnosticDetail" class="personalization-diagnostic-detail" hidden></div>`;
}
function detailRow(label, value) {
    return `<div><dt>${escapeHtml(label)}</dt><dd>${value === undefined ? "n/a" : escapeHtml(value)}</dd></div>`;
}
export function personalizationDiagnosticDetailHtml(row) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    const phase = row.phaseRecord;
    const record = row.record;
    const coverage = phase.evidenceCoverage;
    const heartRate = phase.observedHeartRate;
    const power = phase.observedPower;
    const stable = phase.stableInBandWorkload;
    const comparison = phase.comparison;
    const controller = phase.controllerContext;
    const assessment = row.assessmentContext;
    const workout = row.workoutContext;
    const signed = (value, suffix) => value === undefined ? "n/a" : `${value > 0 ? "+" : ""}${Math.round(value * 10) / 10}${suffix}`;
    return `<div class="personalization-detail-heading"><div><h4>${escapeHtml(row.workout)} · ${escapeHtml(row.phase)}</h4><span>${escapeHtml(new Date(row.date).toLocaleString())}</span></div><button type="button" class="button secondary" onclick="closePersonalizationDiagnostic()">Close</button></div>
    <section><h5>Frozen evidence provenance</h5><dl>${detailRow("App version", (_a = workout === null || workout === void 0 ? void 0 : workout.appVersion) !== null && _a !== void 0 ? _a : "unavailable")}${detailRow("Machine", (_b = workout === null || workout === void 0 ? void 0 : workout.machineId) !== null && _b !== void 0 ? _b : "unavailable")}${detailRow("Machine profile version", (_c = workout === null || workout === void 0 ? void 0 : workout.machineProfileVersion) !== null && _c !== void 0 ? _c : "unavailable")}${detailRow("Active / E1 / E2 schema", workout ? `${(_d = workout.activePrescriptionSchemaVersion) !== null && _d !== void 0 ? _d : "n/a"} / ${(_e = workout.shadowSchemaVersion) !== null && _e !== void 0 ? _e : "n/a"} / ${workout.characterizationSchemaVersion}` : "n/a")}${detailRow("Assessment evidence sessions", (_g = (_f = assessment === null || assessment === void 0 ? void 0 : assessment.evidenceSessionIds) === null || _f === void 0 ? void 0 : _f.join(", ")) !== null && _g !== void 0 ? _g : "n/a")}${detailRow("Assessment algorithm", (assessment === null || assessment === void 0 ? void 0 : assessment.algorithm) ? `${assessment.algorithm.id}@${assessment.algorithm.version}` : "n/a")}${detailRow("Assessment protocol", (assessment === null || assessment === void 0 ? void 0 : assessment.protocol) ? `${assessment.protocol.id}@${assessment.protocol.version}` : "n/a")}</dl></section>
    <section><h5>Frozen assessment context</h5><dl>${detailRow("Assessment date", assessment ? new Date(assessment.observedAt).toLocaleDateString() : "n/a")}${detailRow("Assessment quality", personalizationDiagnosticLabel((_j = (_h = assessment === null || assessment === void 0 ? void 0 : assessment.quality) !== null && _h !== void 0 ? _h : record.formalAssessmentQuality) !== null && _j !== void 0 ? _j : "unavailable"))}${detailRow("Calibration provenance", personalizationDiagnosticLabel((_l = (_k = assessment === null || assessment === void 0 ? void 0 : assessment.calibrationProvenance) !== null && _k !== void 0 ? _k : record.calibrationWorkloadProvenance) !== null && _l !== void 0 ? _l : "unavailable"))}${detailRow("Calibration HR range", assessment ? `${assessment.observedMinHeartRateBpm}–${assessment.observedMaxHeartRateBpm} bpm` : "n/a")}${detailRow("Calibration watt range", assessment ? `${assessment.observedMinWatts}–${assessment.observedMaxWatts} W` : "n/a")}${detailRow("Candidate watts", row.candidateWatts)}${detailRow("Assessment domain", personalizationDiagnosticLabel(row.assessmentDomain))}${detailRow("Domain HR margins", phase.candidateDomainMargins ? `${phase.candidateDomainMargins.heartRateToLowerBoundaryBpm} / ${phase.candidateDomainMargins.heartRateToUpperBoundaryBpm} bpm` : "n/a")}${detailRow("Domain watt margins", phase.candidateDomainMargins ? `${phase.candidateDomainMargins.wattsToLowerBoundary} / ${phase.candidateDomainMargins.wattsToUpperBoundary} W` : "n/a")}</dl></section>
    <section><h5>Workout observation</h5><dl>${detailRow("Planned / observed duration", `${coverage.plannedDurationSec} / ${coverage.observedDurationSec} sec`)}${detailRow("HR / power / joint coverage", `${percent(coverage.hrCoverageRatio)} / ${percent(coverage.powerCoverageRatio)} / ${percent(coverage.jointCoverageRatio)}`)}${detailRow("HR median / min / max", heartRate ? `${heartRate.medianBpm} / ${heartRate.minBpm} / ${heartRate.maxBpm} bpm` : "n/a")}${detailRow("HR seconds below / inside / above", heartRate ? `${heartRate.belowBandSeconds} / ${heartRate.insideBandSeconds} / ${heartRate.aboveBandSeconds}` : "n/a")}${detailRow("Power median / IQR / min / max", power ? `${power.medianWatts} / ${power.q1Watts}–${power.q3Watts} / ${power.minWatts}–${power.maxWatts} W` : "n/a")}${detailRow("Power seconds below / inside / above candidate", power ? `${power.belowCandidateSeconds} / ${power.insideCandidateSeconds} / ${power.aboveCandidateSeconds}` : "n/a")}${detailRow("Settled in-band samples", stable === null || stable === void 0 ? void 0 : stable.sampleCount)}${detailRow("Settled median / IQR", stable ? `${stable.medianWatts} W / ${stable.q1Watts}–${stable.q3Watts} W` : "n/a")}${detailRow("Late vs early HR", signed(heartRate === null || heartRate === void 0 ? void 0 : heartRate.heartRateChangeLateVsEarlyBpm, " bpm"))}${detailRow("Controller saturation", `${percent(controller.saturationRatio)} · lower ${controller.lowerBoundaryDecisionCount}, upper ${controller.upperBoundaryDecisionCount} decisions`)}</dl></section>
    <section><h5>Comparison</h5><dl>${detailRow("Candidate midpoint", comparison ? `${comparison.candidateMidpointWatts} W` : "n/a")}${detailRow("Observed settled median", comparison ? `${comparison.observedInBandMedianWatts} W` : "n/a")}${detailRow("Signed / absolute difference", comparison ? `${signed(comparison.signedDifferenceWatts, " W")} / ${comparison.absoluteDifferenceWatts} W` : "n/a")}${detailRow("Percentage difference", comparison ? signed(comparison.signedDifferencePercent, "%") : "n/a")}${detailRow("Candidate contains observed median", comparison ? (comparison.candidateContainsObservedMedian ? "Yes" : "No") : "n/a")}${detailRow("Observed IQR overlap", comparison ? `${comparison.candidateObservedOverlapWatts} W · ${percent(comparison.candidateObservedOverlapRatio)}` : "n/a")}${detailRow("Descriptive agreement", personalizationDiagnosticLabel(row.agreement))}${detailRow("Outcome", personalizationDiagnosticLabel(row.outcome))}${detailRow("Exclusion", personalizationDiagnosticLabel(row.exclusion))}</dl></section>`;
}
