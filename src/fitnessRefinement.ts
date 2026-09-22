import {
  FITNESS_STATE_SCHEMA_VERSION_V2,
  type BikeWattsProvenance,
  type FitnessMetric,
  type FitnessMetricQuality,
  type FitnessState,
  type PassiveAerobicIntensityId,
  type PassiveAerobicTrend,
  type WorkoutPhaseResponse,
  type WorkoutSummary,
} from "./types.js";
import {
  FITNESS_STATE_STORAGE_KEY,
  readFitnessState,
  storeFitnessState,
  type WritableFitnessStateStorage,
} from "./fitnessState.js";
import { loadAthleteProfile } from "./profile.js";
import { parseWorkoutResponse } from "./workoutResponse.js";

export const FITNESS_REFINEMENT_ALGORITHM_V1 = {
  id: "fitness-refinement-v1",
  version: 1,
  minimumMeasuredSessions: 4,
  minimumCalibratedSessions: 5,
  minimumDistinctDates: 4,
  minimumPhaseDurationSec: 8 * 60,
  minimumSessionCompletionFraction: 0.8,
  minimumSessionHrCoverage: 0.75,
  minimumSessionFreshBikeCoverage: 0.75,
  minimumPhaseCompletionFraction: 0.9,
  minimumPhaseHrCoverage: 0.8,
  minimumMeasuredWattsCoverage: 0.8,
  minimumCalibratedWattsCoverage: 0.9,
  minimumCadenceCoverage: 0.75,
  comparableHrBandBpm: 10,
  recentWindowSessions: 4,
  declineCorroborationSessions: 3,
  declineThresholdFraction: 0.02,
  maximumImprovementFractionPerSession: 0.015,
  maximumDeclineFractionPerSession: 0.0075,
} as const;

/** Current writer alias. Historical readers must use FITNESS_REFINEMENT_ALGORITHM_V1. */
export const FITNESS_REFINEMENT_ALGORITHM = FITNESS_REFINEMENT_ALGORITHM_V1;

export type PassiveFitnessRejectionReason =
  | "invalid_summary"
  | "invalid_response"
  | "ownership_mismatch"
  | "activity_not_bike"
  | "cancelled"
  | "low_completion"
  | "low_session_hr_coverage"
  | "low_fresh_workload_coverage"
  | "unsupported_phase_semantics"
  | "phase_too_short"
  | "low_phase_completion"
  | "low_phase_hr_coverage"
  | "unsupported_workload_provenance"
  | "low_phase_workload_coverage"
  | "implausible_hr"
  | "implausible_watts"
  | "unstable_hr"
  | "unstable_workload"
  | "missing_or_unstable_cadence"
  | "no_qualified_phase"
  | "not_after_formal_anchor";

export interface PassiveFitnessObservation {
  athleteId: string;
  sessionId: string;
  workoutDate: string;
  observedAt: string;
  intensityId: PassiveAerobicIntensityId;
  heartRateBpm: number;
  watts: number;
  workloadSource: BikeWattsProvenance;
  phaseCount: number;
  completedDurationSec: number;
}

export type PassiveFitnessQualification =
  | {
      qualified: true;
      sessionId: string;
      observations: PassiveFitnessObservation[];
      phaseRejectionReasons: PassiveFitnessRejectionReason[];
    }
  | {
      qualified: false;
      sessionId?: string;
      rejectionReasons: PassiveFitnessRejectionReason[];
    };

export interface PassiveFitnessRefinementDiagnostics {
  algorithm: { id: string; version: number };
  athleteId: string;
  qualifiedSessionCount: number;
  rejectedSessionCount: number;
  rejectionReasonCounts: Partial<Record<PassiveFitnessRejectionReason, number>>;
  evidenceSessionIds: string[];
  evidenceRange?: { earliest: string; latest: string };
  workloadSourceMix: BikeWattsProvenance[];
  formalAnchor?: { observedAt: string; sessionId?: string };
  previousProjectionWatts?: number;
  candidateProjectionWatts?: number;
  guardrailLimitedProjectionWatts?: number;
  finalProjectionWatts?: number;
  selectedIntensityId?: PassiveAerobicIntensityId;
  status: "eligible" | "insufficient_evidence";
}

export interface PassiveFitnessRebuildResult {
  state: FitnessState | null;
  diagnostics: PassiveFitnessRefinementDiagnostics;
}

export interface EffectiveFitnessProjection {
  authoritativeVo2Max?: FitnessState["vo2Max"];
  authoritativeHrWorkloadCalibration?: FitnessState["hrWorkloadCalibration"];
  passiveAerobicTrend?: FitnessState["passiveAerobicTrend"];
}

export type PersistedPassiveRefinementResult =
  | "refined"
  | "unchanged"
  | "insufficient_evidence"
  | "persistence_failed";

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Phase D selection is deliberately non-prescriptive: formal measurements stay
 * authoritative and the ordinary-workout trend is a separate supplemental view.
 */
export function selectEffectiveFitnessProjection(state: FitnessState | null): EffectiveFitnessProjection {
  if (!state) return {};
  return {
    ...(state.vo2Max?.source === "formal_assessment" ? { authoritativeVo2Max: state.vo2Max } : {}),
    ...(state.hrWorkloadCalibration?.source === "formal_assessment"
      ? { authoritativeHrWorkloadCalibration: state.hrWorkloadCalibration }
      : {}),
    ...(state.passiveAerobicTrend?.source === "workout_observation"
      ? { passiveAerobicTrend: state.passiveAerobicTrend }
      : {}),
  };
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function phaseReason(phase: WorkoutPhaseResponse): PassiveFitnessRejectionReason | null {
  const policy = FITNESS_REFINEMENT_ALGORITHM_V1;
  if (
    phase.kind !== "work" ||
    (phase.intensityId !== "aerobic_base" && phase.intensityId !== "threshold")
  ) return "unsupported_phase_semantics";
  if (phase.plannedDurationSec < policy.minimumPhaseDurationSec) return "phase_too_short";
  if (phase.completedDurationSec / phase.plannedDurationSec < policy.minimumPhaseCompletionFraction) {
    return "low_phase_completion";
  }
  if (!phase.hr || phase.hr.coverageRatio < policy.minimumPhaseHrCoverage) return "low_phase_hr_coverage";
  if (!phase.watts || phase.watts.provenance === "mixed") return "unsupported_workload_provenance";
  const minimumWattsCoverage = phase.watts.provenance === "measured_watts"
    ? policy.minimumMeasuredWattsCoverage
    : policy.minimumCalibratedWattsCoverage;
  if (phase.watts.coverageRatio < minimumWattsCoverage) return "low_phase_workload_coverage";
  if (phase.hr.median < 80 || phase.hr.median > 200) return "implausible_hr";
  if (phase.watts.median < 30 || phase.watts.median > 600) return "implausible_watts";
  if (phase.hr.max - phase.hr.min > 45 || Math.abs(phase.hr.end - phase.hr.median) > 20) {
    return "unstable_hr";
  }
  if ((phase.watts.max - phase.watts.min) / phase.watts.mean > 0.35) return "unstable_workload";
  if (
    !phase.cadenceRpm ||
    phase.cadenceRpm.coverageRatio < policy.minimumCadenceCoverage ||
    phase.cadenceRpm.mean < 45 ||
    phase.cadenceRpm.mean > 120 ||
    phase.cadenceRpm.max - phase.cadenceRpm.min > 25
  ) return "missing_or_unstable_cadence";
  return null;
}

/** Pure Phase D gate. It uses only frozen summary/response evidence and the expected owner. */
export function qualifyWorkoutResponseForPassiveFitness(
  summary: unknown,
  athleteId: string
): PassiveFitnessQualification {
  if (!isObject(summary) || typeof summary.external_session_id !== "string" || !isIsoTimestamp(summary.endedAt)) {
    return { qualified: false, rejectionReasons: ["invalid_summary"] };
  }
  const sessionId = summary.external_session_id;
  const response = parseWorkoutResponse(summary.workout_response);
  if (!response) return { qualified: false, sessionId, rejectionReasons: ["invalid_response"] };
  if (
    summary.athlete_id !== athleteId ||
    response.athleteId !== athleteId ||
    response.sessionId !== sessionId
  ) return { qualified: false, sessionId, rejectionReasons: ["ownership_mismatch"] };
  if (summary.activity !== "bike") return { qualified: false, sessionId, rejectionReasons: ["activity_not_bike"] };
  if (response.completion.cancelled || summary.cancelled === true) {
    return { qualified: false, sessionId, rejectionReasons: ["cancelled"] };
  }
  if (response.completion.completionFraction < FITNESS_REFINEMENT_ALGORITHM_V1.minimumSessionCompletionFraction) {
    return { qualified: false, sessionId, rejectionReasons: ["low_completion"] };
  }
  if (response.evidence.hr.coverageRatio < FITNESS_REFINEMENT_ALGORITHM_V1.minimumSessionHrCoverage) {
    return { qualified: false, sessionId, rejectionReasons: ["low_session_hr_coverage"] };
  }
  if (response.evidence.bike.freshRowCoverageRatio < FITNESS_REFINEMENT_ALGORITHM_V1.minimumSessionFreshBikeCoverage) {
    return { qualified: false, sessionId, rejectionReasons: ["low_fresh_workload_coverage"] };
  }

  const phaseRejectionReasons: PassiveFitnessRejectionReason[] = [];
  const accepted = new Map<PassiveAerobicIntensityId, WorkoutPhaseResponse[]>();
  for (const phase of response.phases) {
    const reason = phaseReason(phase);
    if (reason) {
      phaseRejectionReasons.push(reason);
      continue;
    }
    const intensity = phase.intensityId as PassiveAerobicIntensityId;
    const phases = accepted.get(intensity) ?? [];
    phases.push(phase);
    accepted.set(intensity, phases);
  }
  if (accepted.size === 0) {
    return {
      qualified: false,
      sessionId,
      rejectionReasons: unique([...phaseRejectionReasons, "no_qualified_phase"]),
    };
  }

  const observations: PassiveFitnessObservation[] = [];
  for (const [intensityId, phases] of accepted) {
    const completedDurationSec = phases.reduce((sum, phase) => sum + phase.completedDurationSec, 0);
    const weighted = (selector: (phase: WorkoutPhaseResponse) => number) =>
      phases.reduce((sum, phase) => sum + selector(phase) * phase.completedDurationSec, 0) / completedDurationSec;
    const sources = unique(phases.map((phase) => phase.watts!.provenance));
    if (sources.length !== 1 || sources[0] === "mixed") continue;
    observations.push({
      athleteId,
      sessionId,
      workoutDate: (summary.endedAt as string).slice(0, 10),
      observedAt: summary.endedAt as string,
      intensityId,
      heartRateBpm: round(weighted((phase) => phase.hr!.median)),
      watts: round(weighted((phase) => phase.watts!.median)),
      workloadSource: sources[0] as BikeWattsProvenance,
      phaseCount: phases.length,
      completedDurationSec,
    });
  }
  if (observations.length === 0) {
    return { qualified: false, sessionId, rejectionReasons: ["unsupported_workload_provenance"] };
  }
  return { qualified: true, sessionId, observations, phaseRejectionReasons: unique(phaseRejectionReasons) };
}

function latestFormalAnchor(state: FitnessState | null): { observedAt: string; sessionId?: string } | undefined {
  if (!state) return undefined;
  const formal = ([state.vo2Max, state.predictedMaxWatts, state.hrWorkloadCalibration] as Array<
    FitnessMetric<unknown> | undefined
  >)
    .filter((metric): metric is FitnessMetric<unknown> => metric?.source === "formal_assessment")
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
  return formal
    ? { observedAt: formal.observedAt, ...(formal.evidenceSessionIds?.[0] ? { sessionId: formal.evidenceSessionIds[0] } : {}) }
    : undefined;
}

function formalOnlyState(state: FitnessState | null): FitnessState | null {
  if (!state) return null;
  const formal = {
    ...(state.vo2Max?.source === "formal_assessment" ? { vo2Max: state.vo2Max } : {}),
    ...(state.predictedMaxWatts?.source === "formal_assessment" ? { predictedMaxWatts: state.predictedMaxWatts } : {}),
    ...(state.hrWorkloadCalibration?.source === "formal_assessment"
      ? { hrWorkloadCalibration: state.hrWorkloadCalibration }
      : {}),
  };
  if (Object.keys(formal).length === 0) return null;
  return { schemaVersion: state.schemaVersion, athleteId: state.athleteId, ...formal, updatedAt: state.updatedAt };
}

function comparableCluster(observations: readonly PassiveFitnessObservation[]): PassiveFitnessObservation[] {
  const byHr = [...observations].sort(
    (a, b) => a.heartRateBpm - b.heartRateBpm || Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.sessionId.localeCompare(b.sessionId)
  );
  let best: PassiveFitnessObservation[] = [];
  for (let start = 0; start < byHr.length; start += 1) {
    let end = start;
    while (
      end + 1 < byHr.length &&
      byHr[end + 1].heartRateBpm - byHr[start].heartRateBpm <= FITNESS_REFINEMENT_ALGORITHM_V1.comparableHrBandBpm
    ) end += 1;
    const candidate = byHr.slice(start, end + 1);
    if (candidate.length > best.length) best = candidate;
  }
  return best.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.sessionId.localeCompare(b.sessionId));
}

function projectionQuality(
  observations: readonly PassiveFitnessObservation[],
  madWatts: number,
  baselineWatts: number
): Exclude<FitnessMetricQuality, "unverified"> {
  const allMeasured = observations.every((observation) => observation.workloadSource === "measured_watts");
  if (allMeasured && observations.length >= 8 && madWatts / baselineWatts <= 0.05) return "high";
  if (allMeasured && observations.length >= 6 && madWatts / baselineWatts <= 0.1) return "moderate";
  return "low";
}

function countReason(
  counts: Partial<Record<PassiveFitnessRejectionReason, number>>,
  reason: PassiveFitnessRejectionReason
): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

/**
 * Rebuild from the entire immutable evidence set. Sorting, de-duplication and
 * evidence-watermark timestamps make callback order and duplicate replay inert.
 */
export function rebuildPassiveFitnessProjection(input: {
  athleteId: string;
  currentState: FitnessState | null;
  workoutSummaries: readonly unknown[];
}): PassiveFitnessRebuildResult {
  const formalState = formalOnlyState(input.currentState);
  const anchor = latestFormalAnchor(formalState);
  const reasonCounts: Partial<Record<PassiveFitnessRejectionReason, number>> = {};
  const qualifications = input.workoutSummaries.map((summary) => ({
    summary,
    qualification: qualifyWorkoutResponseForPassiveFitness(summary, input.athleteId),
  }));
  const rejectedSessions = new Set<string>();
  const bySession = new Map<string, PassiveFitnessObservation[]>();
  for (const { qualification } of qualifications) {
    if (qualification.qualified === false) {
      rejectedSessions.add(qualification.sessionId ?? `invalid-${rejectedSessions.size}`);
      qualification.rejectionReasons.forEach((reason) => countReason(reasonCounts, reason));
      continue;
    }
    if (anchor && qualification.observations.every((observation) => Date.parse(observation.observedAt) <= Date.parse(anchor.observedAt))) {
      rejectedSessions.add(qualification.sessionId);
      countReason(reasonCounts, "not_after_formal_anchor");
      continue;
    }
    const observations = qualification.observations.filter(
      (observation) => !anchor || Date.parse(observation.observedAt) > Date.parse(anchor.observedAt)
    );
    if (!bySession.has(qualification.sessionId) && observations.length > 0) {
      bySession.set(qualification.sessionId, observations);
    }
  }

  const all = [...bySession.values()].flat();
  const intensities: PassiveAerobicIntensityId[] = ["aerobic_base", "threshold"];
  const candidates = intensities.map((intensityId) => comparableCluster(all.filter((item) => item.intensityId === intensityId)));
  const selected = candidates.sort((a, b) =>
    b.length - a.length ||
    ((b[b.length - 1]?.observedAt ?? "").localeCompare(a[a.length - 1]?.observedAt ?? "")) ||
    ((a[0]?.intensityId ?? "").localeCompare(b[0]?.intensityId ?? ""))
  )[0] ?? [];
  const sources = unique(selected.map((observation) => observation.workloadSource)).sort();
  const distinctDates = unique(selected.map((observation) => observation.workoutDate));
  const minimumSessions = sources.includes("calibrated_watts")
    ? FITNESS_REFINEMENT_ALGORITHM_V1.minimumCalibratedSessions
    : FITNESS_REFINEMENT_ALGORITHM_V1.minimumMeasuredSessions;
  const priorProjection = input.currentState?.passiveAerobicTrend?.value.projectedComparableWorkloadWatts;
  const baseDiagnostics: PassiveFitnessRefinementDiagnostics = {
    algorithm: { id: FITNESS_REFINEMENT_ALGORITHM_V1.id, version: FITNESS_REFINEMENT_ALGORITHM_V1.version },
    athleteId: input.athleteId,
    qualifiedSessionCount: bySession.size,
    rejectedSessionCount: rejectedSessions.size,
    rejectionReasonCounts: reasonCounts,
    evidenceSessionIds: selected.map((observation) => observation.sessionId),
    workloadSourceMix: sources,
    ...(anchor ? { formalAnchor: anchor } : {}),
    ...(priorProjection !== undefined ? { previousProjectionWatts: priorProjection } : {}),
    ...(selected[0]
      ? { evidenceRange: { earliest: selected[0].observedAt, latest: selected[selected.length - 1].observedAt } }
      : {}),
    ...(selected[0] ? { selectedIntensityId: selected[0].intensityId } : {}),
    status: "insufficient_evidence",
  };
  if (selected.length < minimumSessions || distinctDates.length < FITNESS_REFINEMENT_ALGORITHM_V1.minimumDistinctDates) {
    return { state: formalState, diagnostics: baseDiagnostics };
  }

  const firstWindow = selected.slice(0, minimumSessions);
  const baselineWatts = median(firstWindow.map((observation) => observation.watts));
  let guardedWatts = baselineWatts;
  let latestCandidate = baselineWatts;
  for (let index = minimumSessions; index < selected.length; index += 1) {
    const throughCurrent = selected.slice(0, index + 1);
    const recent = throughCurrent.slice(-FITNESS_REFINEMENT_ALGORITHM_V1.recentWindowSessions);
    latestCandidate = median(recent.map((observation) => observation.watts));
    if (latestCandidate > guardedWatts) {
      guardedWatts += Math.min(
        latestCandidate - guardedWatts,
        guardedWatts * FITNESS_REFINEMENT_ALGORITHM_V1.maximumImprovementFractionPerSession
      );
      continue;
    }
    const corroborating = throughCurrent
      .slice(-FITNESS_REFINEMENT_ALGORITHM_V1.declineCorroborationSessions)
      .every((observation) => observation.watts < guardedWatts * (1 - FITNESS_REFINEMENT_ALGORITHM_V1.declineThresholdFraction));
    if (corroborating) {
      guardedWatts -= Math.min(
        guardedWatts - latestCandidate,
        guardedWatts * FITNESS_REFINEMENT_ALGORITHM_V1.maximumDeclineFractionPerSession
      );
    }
  }

  const watts = selected.map((observation) => observation.watts);
  const hrs = selected.map((observation) => observation.heartRateBpm);
  const referenceHr = median(hrs);
  const madWatts = median(watts.map((wattsValue) => Math.abs(wattsValue - median(watts))));
  const earliest = selected[0].observedAt;
  const latest = selected[selected.length - 1].observedAt;
  const value: PassiveAerobicTrend = {
    metric: "workload_at_comparable_hr",
    intensityId: selected[0].intensityId,
    referenceHeartRateBpm: round(referenceHr),
    projectedComparableWorkloadWatts: round(guardedWatts),
    baselineComparableWorkloadWatts: round(baselineWatts),
    changeFromBaselinePercent: round(((guardedWatts - baselineWatts) / baselineWatts) * 100),
    qualifiedSessionCount: selected.length,
    observationCount: selected.length,
    distinctWorkoutDateCount: distinctDates.length,
    workloadSourceClasses: sources,
    earliestEvidenceAt: earliest,
    latestEvidenceAt: latest,
    observedMinWatts: Math.min(...watts),
    observedMaxWatts: Math.max(...watts),
    observedMinHeartRateBpm: Math.min(...hrs),
    observedMaxHeartRateBpm: Math.max(...hrs),
    medianAbsoluteDeviationWatts: round(madWatts),
    comparisonBandBpm: FITNESS_REFINEMENT_ALGORITHM_V1.comparableHrBandBpm,
    ...(anchor ? { formalAnchorObservedAt: anchor.observedAt } : {}),
    ...(anchor?.sessionId ? { formalAnchorSessionId: anchor.sessionId } : {}),
  };
  const passiveAerobicTrend: FitnessMetric<PassiveAerobicTrend> = {
    value,
    source: "workout_observation",
    quality: projectionQuality(selected, madWatts, baselineWatts),
    observedAt: latest,
    updatedAt: latest,
    algorithm: { id: FITNESS_REFINEMENT_ALGORITHM_V1.id, version: FITNESS_REFINEMENT_ALGORITHM_V1.version },
    evidenceSessionIds: selected.map((observation) => observation.sessionId),
  };
  const state: FitnessState = {
    schemaVersion: FITNESS_STATE_SCHEMA_VERSION_V2,
    athleteId: input.athleteId,
    ...(formalState?.vo2Max ? { vo2Max: formalState.vo2Max } : {}),
    ...(formalState?.predictedMaxWatts ? { predictedMaxWatts: formalState.predictedMaxWatts } : {}),
    ...(formalState?.hrWorkloadCalibration ? { hrWorkloadCalibration: formalState.hrWorkloadCalibration } : {}),
    passiveAerobicTrend,
    updatedAt: [formalState?.updatedAt, latest].filter((value): value is string => !!value).sort().slice(-1)[0],
  };
  return {
    state,
    diagnostics: {
      ...baseDiagnostics,
      candidateProjectionWatts: round(latestCandidate),
      guardrailLimitedProjectionWatts: round(guardedWatts),
      finalProjectionWatts: round(guardedWatts),
      status: "eligible",
    },
  };
}

/** Persistence wrapper; callers must save/delete immutable history first. */
export function rebuildStoredPassiveFitnessProjection(
  summaries: readonly WorkoutSummary[],
  storage?: WritableFitnessStateStorage
): PersistedPassiveRefinementResult {
  const store = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  if (!store) return "persistence_failed";
  const athlete = loadAthleteProfile(store);
  const currentState = readFitnessState(athlete.athleteId, store);
  if (store.getItem(FITNESS_STATE_STORAGE_KEY) !== null && !currentState) {
    return "persistence_failed";
  }
  const rebuilt = rebuildPassiveFitnessProjection({
    athleteId: athlete.athleteId,
    currentState,
    workoutSummaries: summaries,
  });
  if (!rebuilt.state) {
    if (!currentState?.passiveAerobicTrend) return "insufficient_evidence";
    if (typeof store.removeItem !== "function") return "persistence_failed";
    try {
      store.removeItem(FITNESS_STATE_STORAGE_KEY);
      return "refined";
    } catch {
      return "persistence_failed";
    }
  }
  if (JSON.stringify(rebuilt.state) === JSON.stringify(currentState)) {
    return rebuilt.diagnostics.status === "eligible" ? "unchanged" : "insufficient_evidence";
  }
  return storeFitnessState(rebuilt.state, store) ? "refined" : "persistence_failed";
}
