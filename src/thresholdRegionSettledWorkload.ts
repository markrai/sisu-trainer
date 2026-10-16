/**
 * Threshold-region settled-workload evidence contract (design / shadow-only).
 *
 * Scientific claim: descriptive ordinary-workout mechanical workload observed
 * while the legacy HR controller has settled in the prescribed Threshold HR
 * region. This is NOT formal VO₂ calibration inversion (E1), NOT Phase D
 * whole-phase refinement, NOT FTP/lactate/ventilatory threshold, and NOT
 * runtime control authority.
 *
 * Continuity model (fail-closed join):
 * - Controller/load continuity: same commanded (else desired) resistance held
 *   over an elapsed interval. Telemetry row gaps do NOT split the hold.
 * - Observed-resistance consistency: any present observedResistance that
 *   disagrees with the held controller resistance rejects/splits that span.
 * - Telemetry evidence: independent HR / measured-watt / cadence coverage and
 *   freshness over the post-settling elapsed seconds of that hold.
 *
 * Reuses existing primitives:
 * - `settledActiveSeconds` with E2 held-workload settling (120 s)
 * - coverage ratios aligned with E2 / Phase D measured-watt paths
 * - E2 `minQualifyingSeconds` as joint HR+measured-watt sample count
 * - `canonicalMedian` / `medianAbsoluteDeviation` for robust central tendency
 *
 * Does NOT hard-code resistance level, wattage, athlete, or machine table.
 */

import type { OrdinaryBikeTelemetrySample } from "./types.js";
import type {
  MachineDecisionAuditEntry,
  MachineEvaluationAuditEntry,
} from "./machines/audit/types.js";
import {
  observationsAreContinuous,
  settledActiveSeconds,
  type ObservationContinuityPolicy,
} from "./workloadForwardResponse.js";
import { canonicalMedian } from "./stats.js";
import { medianAbsoluteDeviation } from "./performedLoad.js";
import { PHASE_E2_HELD_WORKLOAD_POLICY_V1 } from "./personalizedPrescriptionCharacterization.js";
import { FITNESS_REFINEMENT_ALGORITHM_V2 } from "./fitnessRefinement.js";

/** Evidence observation schema identity. */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1 =
  "threshold-region-settled-workload-observation" as const;
export const THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1 = 1 as const;

/** Evidence admission policy identity. */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1 =
  "threshold-region-settled-workload-policy" as const;
export const THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1 = 1 as const;

/**
 * Future shadow-advice resolver identity. Distinct from
 * `personalized-prescription-resolver` (E1 formal-calibration inversion).
 */
export const THRESHOLD_REGION_ORDINARY_WORKOUT_SHADOW_RESOLVER_ID_V1 =
  "threshold-region-ordinary-workout-shadow-resolver" as const;
export const THRESHOLD_REGION_ORDINARY_WORKOUT_SHADOW_RESOLVER_VERSION_V1 = 1 as const;

/** Provenance label for the scientific claim. */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1 =
  "ordinary_workout_settled_threshold_region" as const;

export type ThresholdRegionSettledFailureCode =
  | "athlete_mismatch"
  | "activity_not_bike"
  | "intent_not_threshold"
  | "intensity_not_threshold"
  | "missing_machine_provenance"
  | "pre_formal_anchor"
  | "invalid_session_or_anchor_timestamp"
  | "missing_numeric_hr_target"
  | "no_stable_resistance_window"
  | "insufficient_post_settling_duration"
  | "insufficient_hr_coverage"
  | "insufficient_measured_watt_coverage"
  | "insufficient_cadence_coverage"
  | "non_measured_watt_provenance"
  | "missing_target_hold_corroboration"
  | "insufficient_in_band_occupancy"
  | "unstable_measured_workload"
  | "policy_threshold_unresolved"
  | "no_qualifying_window";

/**
 * Policy values. Numbers copied from existing versioned policies are marked
 * in comments. `null` means UNRESOLVED — production emission must fail closed
 * until owners supply an explicit value.
 */
export interface ThresholdRegionSettledWorkloadPolicyV1 {
  id: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1;
  version: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1;
  /**
   * Active seconds after a held-resistance window begins before samples may
   * contribute. Reused from E2 held-workload (steady-state HR lag).
   */
  settlingSeconds: number;
  /**
   * Retained from E2 held-workload for identity/compatibility. Not used to
   * split controller hold intervals (telemetry gaps are evidence coverage,
   * not load discontinuity). Exposed via `observationsAreContinuousForPolicy`
   * for callers that still need the E2 continuity primitive.
   */
  maxObservationGapSec: number;
  /** Reused from E2 held-workload continuity (see maxObservationGapSec). */
  maxWallClockExcessSec: number;
  /**
   * Minimum count of post-settling seconds that jointly have usable HR and
   * fresh measured watts. Matches E2 held-workload `minQualifyingSeconds`
   * (characterization) — a sample count, not merely elapsed wall/active span.
   * Advice-grade elapsed duration remains UNRESOLVED (`minAdviceGradeDurationSec`).
   */
  minQualifyingSeconds: number;
  /** Reused from E2 characterization / Phase D phase HR coverage. */
  minHrCoverageRatio: number;
  /** Reused from E2 / Phase D measured-watt coverage. */
  minMeasuredWattsCoverageRatio: number;
  /** Reused from Phase D cadence coverage. */
  minCadenceCoverageRatio: number;
  /**
   * Require ≥1 machine audit evaluation with decision=hold and
   * decisionReason=within_target_policy that matches the candidate window's
   * held resistance (and work-phase / HR-target semantics).
   */
  requireTargetHoldCorroboration: boolean;
  /** UNRESOLVED: minimum fraction of post-settling HR seconds inside target band. */
  minInBandFraction: number | null;
  /** UNRESOLVED: maximum MAD(watts) / median(watts) in the settled window. */
  maxMeasuredWattsMadRatio: number | null;
  /** UNRESOLVED: advice-grade elapsed post-settling duration beyond characterization floor. */
  minAdviceGradeDurationSec: number | null;
}

/** Design-default policy: resolved gates only; unresolved fields stay null. */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1: ThresholdRegionSettledWorkloadPolicyV1 = {
  id: THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1,
  version: THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1,
  settlingSeconds: PHASE_E2_HELD_WORKLOAD_POLICY_V1.settlingSeconds,
  maxObservationGapSec: PHASE_E2_HELD_WORKLOAD_POLICY_V1.maxObservationGapSec,
  maxWallClockExcessSec: PHASE_E2_HELD_WORKLOAD_POLICY_V1.maxWallClockExcessSec,
  minQualifyingSeconds: PHASE_E2_HELD_WORKLOAD_POLICY_V1.minQualifyingSeconds,
  minHrCoverageRatio: 0.8,
  minMeasuredWattsCoverageRatio: FITNESS_REFINEMENT_ALGORITHM_V2.minimumMeasuredWattsCoverage,
  minCadenceCoverageRatio: FITNESS_REFINEMENT_ALGORITHM_V2.minimumCadenceCoverage,
  requireTargetHoldCorroboration: true,
  minInBandFraction: null,
  maxMeasuredWattsMadRatio: null,
  minAdviceGradeDurationSec: null,
};

export interface ThresholdRegionSettledWorkloadObservationV1 {
  schemaId: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1;
  schemaVersion: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1;
  provenance: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1;
  athleteId: string;
  sessionId: string;
  machineId: string;
  machineProfileVersion: number;
  workoutIntent: "threshold";
  intensityId: "threshold";
  targetHrMin: number;
  targetHrMax: number;
  windowStartSec: number;
  windowEndSecExclusive: number;
  settledFromSec: number;
  /** Joint HR+measured-watt qualifying sample count in the settled window. */
  qualifyingDurationSec: number;
  /** Elapsed post-settling active seconds (settledFrom..last inclusive). */
  postSettlingDurationSec: number;
  observedResistance: number;
  hrMedian: number;
  hrInBandFraction: number;
  hrCoverageRatio: number;
  measuredWattsMedian: number;
  measuredWattsMad: number;
  measuredWattsSampleCount: number;
  measuredWattsCoverageRatio: number;
  cadenceMedian: number;
  cadenceCoverageRatio: number;
  controllerSettledProvenance: "controller_held_resistance_plus_target_hold_audit";
  formalAnchorObservedAt: string;
  quality: "unverified";
  /** Always false at this design stage. */
  eligibleForPrescription: false;
  interpretation: "descriptive_observation_only";
}

export interface ThresholdRegionWindowEvaluationV1 {
  observedResistance: number;
  windowStartSec: number;
  windowEndSecExclusive: number;
  settledFromSec: number;
  /** Elapsed post-settling active seconds (denominator for coverage ratios). */
  postSettlingDurationSec: number;
  /** Joint HR + fresh measured-watt seconds in the settled window. */
  qualifyingSampleCount: number;
  hrSampleCount: number;
  hrCoverageRatio: number;
  hrMedian: number | null;
  hrInBandFraction: number | null;
  measuredWattsSampleCount: number;
  measuredWattsCoverageRatio: number;
  measuredWattsMedian: number | null;
  measuredWattsMad: number | null;
  measuredWattsMadRatio: number | null;
  cadenceSampleCount: number;
  cadenceCoverageRatio: number;
  cadenceMedian: number | null;
  hasTargetHoldCorroboration: boolean;
  matchingHoldAuditElapsedSeconds: number[];
  resolvedGateFailures: ThresholdRegionSettledFailureCode[];
  unresolvedPolicyFields: Array<keyof ThresholdRegionSettledWorkloadPolicyV1>;
  acceptsUnderResolvedGates: boolean;
}

export interface ThresholdRegionContractInputV1 {
  expectedAthleteId: string;
  sessionId: string;
  athleteId: string;
  activity: string;
  intent: string;
  intensityId: string;
  machineId?: string;
  machineProfileVersion?: number;
  formalAnchorObservedAt: string;
  sessionEndedAt: string;
  workActiveStartSec: number;
  workActiveEndSecExclusive: number;
  targetHrMin: number;
  targetHrMax: number;
  hrByActiveSec: ReadonlyMap<number, number>;
  bikeSamples: readonly OrdinaryBikeTelemetrySample[];
  machineDecisionAudit?: readonly MachineDecisionAuditEntry[];
  policy?: ThresholdRegionSettledWorkloadPolicyV1;
}

export interface ThresholdRegionContractResultV1 {
  policy: ThresholdRegionSettledWorkloadPolicyV1;
  policyProductionReady: boolean;
  unresolvedPolicyFields: Array<keyof ThresholdRegionSettledWorkloadPolicyV1>;
  identityFailures: ThresholdRegionSettledFailureCode[];
  windows: ThresholdRegionWindowEvaluationV1[];
  /** Best resolved-gate-accepting window, if any. */
  acceptedWindow: ThresholdRegionWindowEvaluationV1 | null;
  /**
   * Single-session descriptive observation draft when a resolved-gate window
   * exists AND production policy is complete. Otherwise null — one session
   * may still be inspected via `acceptedWindow` for design/fixture use.
   */
  observation: ThresholdRegionSettledWorkloadObservationV1 | null;
}

interface ControllerHeldWindow {
  resistance: number;
  startSec: number;
  endSecInclusive: number;
}

function isEvaluation(entry: MachineDecisionAuditEntry): entry is MachineEvaluationAuditEntry {
  return entry.kind === "evaluation";
}

function continuityPolicy(policy: ThresholdRegionSettledWorkloadPolicyV1): ObservationContinuityPolicy {
  return {
    maxObservationGapSec: policy.maxObservationGapSec,
    maxWallClockExcessSec: policy.maxWallClockExcessSec,
  };
}

function unresolvedFields(
  policy: ThresholdRegionSettledWorkloadPolicyV1
): Array<keyof ThresholdRegionSettledWorkloadPolicyV1> {
  const fields: Array<keyof ThresholdRegionSettledWorkloadPolicyV1> = [];
  if (policy.minInBandFraction === null) fields.push("minInBandFraction");
  if (policy.maxMeasuredWattsMadRatio === null) fields.push("maxMeasuredWattsMadRatio");
  if (policy.minAdviceGradeDurationSec === null) fields.push("minAdviceGradeDurationSec");
  return fields;
}

function controllerResistance(sample: OrdinaryBikeTelemetrySample): number | undefined {
  if (typeof sample.commandedResistance === "number" && Number.isFinite(sample.commandedResistance)) {
    return sample.commandedResistance;
  }
  if (typeof sample.desiredResistance === "number" && Number.isFinite(sample.desiredResistance)) {
    return sample.desiredResistance;
  }
  return undefined;
}

/**
 * Build held-load windows from controller resistance continuity.
 * Telemetry gaps do not split a hold. Contradictory observedResistance does.
 */
export function segmentControllerHeldResistance(
  samples: readonly OrdinaryBikeTelemetrySample[],
  workStart: number,
  workEndExclusive: number
): ControllerHeldWindow[] {
  const ordered = samples
    .filter((sample) => sample.activeSec >= workStart && sample.activeSec < workEndExclusive)
    .slice()
    .sort((a, b) => a.activeSec - b.activeSec);

  type Run = {
    resistance: number;
    samples: OrdinaryBikeTelemetrySample[];
  };
  const controllerRuns: Run[] = [];
  let current: Run | undefined;
  for (const sample of ordered) {
    const held = controllerResistance(sample);
    if (held === undefined) {
      current = undefined;
      continue;
    }
    if (!current || current.resistance !== held) {
      current = { resistance: held, samples: [] };
      controllerRuns.push(current);
    }
    current.samples.push(sample);
  }

  const windows: ControllerHeldWindow[] = [];
  for (const run of controllerRuns) {
    let subStart: number | undefined;
    let subEnd: number | undefined;
    const flush = () => {
      if (subStart === undefined || subEnd === undefined) return;
      windows.push({
        resistance: run.resistance,
        startSec: subStart,
        endSecInclusive: subEnd,
      });
      subStart = undefined;
      subEnd = undefined;
    };
    for (const sample of run.samples) {
      const observed = sample.observedResistance?.value;
      const contradicts =
        typeof observed === "number" && Number.isFinite(observed) && observed !== run.resistance;
      if (contradicts) {
        flush();
        continue;
      }
      if (subStart === undefined) subStart = sample.activeSec;
      subEnd = sample.activeSec;
    }
    flush();
  }
  return windows;
}

/**
 * Qualifying target-hold audits for a candidate window.
 * Semantically required matches (fail-closed):
 * - decision=hold + decisionReason=within_target_policy
 * - resistanceBefore === resistanceAfter === window held resistance
 * - phaseKind=work (Threshold contract evaluates the work phase)
 * - targetHeartRateMin/Max match the window target when present on the audit
 * - elapsed second lies in the post-settling span
 *
 * phaseId is not required: work-phase Threshold plans may use different ids
 * (e.g. sustain); phaseKind already scopes to work.
 */
function matchingTargetHoldAudits(
  audit: readonly MachineDecisionAuditEntry[] | undefined,
  heldResistance: number,
  settledFromSec: number,
  windowEndSecInclusive: number,
  targetHrMin: number,
  targetHrMax: number
): MachineEvaluationAuditEntry[] {
  if (!audit) return [];
  const matches: MachineEvaluationAuditEntry[] = [];
  for (const entry of audit) {
    if (!isEvaluation(entry)) continue;
    if (entry.decision !== "hold") continue;
    if (entry.decisionReason !== "within_target_policy") continue;
    if (entry.phaseKind !== "work") continue;
    if (entry.resistanceBefore !== heldResistance) continue;
    if (entry.resistanceAfter !== heldResistance) continue;
    if (entry.elapsedSeconds < settledFromSec || entry.elapsedSeconds > windowEndSecInclusive) {
      continue;
    }
    if (
      entry.targetHeartRateMin !== undefined &&
      entry.targetHeartRateMin !== targetHrMin
    ) {
      continue;
    }
    if (
      entry.targetHeartRateMax !== undefined &&
      entry.targetHeartRateMax !== targetHrMax
    ) {
      continue;
    }
    matches.push(entry);
  }
  return matches;
}

/**
 * Pure contract evaluator. Does not persist, does not advise, does not control.
 */
export function evaluateThresholdRegionSettledWorkloadContract(
  input: ThresholdRegionContractInputV1
): ThresholdRegionContractResultV1 {
  const policy = input.policy ?? THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1;
  const unresolved = unresolvedFields(policy);
  const identityFailures: ThresholdRegionSettledFailureCode[] = [];

  if (input.athleteId !== input.expectedAthleteId) identityFailures.push("athlete_mismatch");
  if (input.activity !== "bike") identityFailures.push("activity_not_bike");
  if (input.intent !== "threshold") identityFailures.push("intent_not_threshold");
  if (input.intensityId !== "threshold") identityFailures.push("intensity_not_threshold");
  if (
    typeof input.machineId !== "string" ||
    input.machineId.trim() === "" ||
    !Number.isInteger(input.machineProfileVersion) ||
    (input.machineProfileVersion as number) <= 0
  ) {
    identityFailures.push("missing_machine_provenance");
  }

  const sessionEndedMs = Date.parse(input.sessionEndedAt);
  const formalAnchorMs = Date.parse(input.formalAnchorObservedAt);
  if (!Number.isFinite(sessionEndedMs) || !Number.isFinite(formalAnchorMs)) {
    identityFailures.push("invalid_session_or_anchor_timestamp");
  } else if (sessionEndedMs <= formalAnchorMs) {
    identityFailures.push("pre_formal_anchor");
  }

  if (
    !Number.isFinite(input.targetHrMin) ||
    !Number.isFinite(input.targetHrMax) ||
    input.targetHrMin > input.targetHrMax
  ) {
    identityFailures.push("missing_numeric_hr_target");
  }

  const empty: ThresholdRegionContractResultV1 = {
    policy,
    policyProductionReady: unresolved.length === 0,
    unresolvedPolicyFields: unresolved,
    identityFailures,
    windows: [],
    acceptedWindow: null,
    observation: null,
  };
  if (identityFailures.length > 0) return empty;

  const heldWindows = segmentControllerHeldResistance(
    input.bikeSamples,
    input.workActiveStartSec,
    input.workActiveEndSecExclusive
  );
  if (heldWindows.length === 0) {
    return { ...empty, identityFailures: [...identityFailures, "no_stable_resistance_window"] };
  }

  const bikeBySec = new Map(input.bikeSamples.map((sample) => [sample.activeSec, sample]));
  const windows: ThresholdRegionWindowEvaluationV1[] = [];

  for (const segment of heldWindows) {
    const first = segment.startSec;
    const last = segment.endSecInclusive;
    const settledFrom = first + policy.settlingSeconds;
    const settledSeconds = settledActiveSeconds(first, last, policy.settlingSeconds);
    const postSettlingDurationSec = settledSeconds.length;

    let hrSampleCount = 0;
    let inBandCount = 0;
    let qualifyingSampleCount = 0;
    const hrs: number[] = [];
    const watts: number[] = [];
    const cadences: number[] = [];

    for (const second of settledSeconds) {
      const bpm = input.hrByActiveSec.get(second);
      const bike = bikeBySec.get(second);
      const hasHr = typeof bpm === "number" && Number.isFinite(bpm);
      const hasMeasuredWatts =
        !!bike &&
        bike.availability === "fresh" &&
        bike.watts?.source === "measured_watts" &&
        typeof bike.watts.value === "number" &&
        Number.isFinite(bike.watts.value);

      if (hasHr) {
        hrSampleCount += 1;
        hrs.push(bpm as number);
        if ((bpm as number) >= input.targetHrMin && (bpm as number) <= input.targetHrMax) {
          inBandCount += 1;
        }
      }
      if (hasMeasuredWatts) {
        watts.push(bike!.watts!.value);
      }
      if (bike?.cadenceRpm && typeof bike.cadenceRpm.value === "number") {
        cadences.push(bike.cadenceRpm.value);
      }
      if (hasHr && hasMeasuredWatts) qualifyingSampleCount += 1;
    }

    const matchingHolds = matchingTargetHoldAudits(
      input.machineDecisionAudit,
      segment.resistance,
      settledFrom,
      last,
      input.targetHrMin,
      input.targetHrMax
    );
    const hasHold = matchingHolds.length > 0;

    const hrCoverageRatio = postSettlingDurationSec > 0 ? hrSampleCount / postSettlingDurationSec : 0;
    const measuredWattsCoverageRatio =
      postSettlingDurationSec > 0 ? watts.length / postSettlingDurationSec : 0;
    const cadenceCoverageRatio =
      postSettlingDurationSec > 0 ? cadences.length / postSettlingDurationSec : 0;
    const hrMedian = canonicalMedian(hrs) ?? null;
    const measuredWattsMedian = canonicalMedian(watts) ?? null;
    const measuredWattsMad = medianAbsoluteDeviation(watts) ?? null;
    const measuredWattsMadRatio =
      measuredWattsMedian != null && measuredWattsMedian > 0 && measuredWattsMad != null
        ? measuredWattsMad / measuredWattsMedian
        : null;
    const cadenceMedian = canonicalMedian(cadences) ?? null;
    const hrInBandFraction = hrSampleCount > 0 ? inBandCount / hrSampleCount : null;

    const resolvedGateFailures: ThresholdRegionSettledFailureCode[] = [];
    if (qualifyingSampleCount < policy.minQualifyingSeconds) {
      resolvedGateFailures.push("insufficient_post_settling_duration");
    }
    if (hrCoverageRatio < policy.minHrCoverageRatio) resolvedGateFailures.push("insufficient_hr_coverage");
    if (watts.length === 0) resolvedGateFailures.push("non_measured_watt_provenance");
    else if (measuredWattsCoverageRatio < policy.minMeasuredWattsCoverageRatio) {
      resolvedGateFailures.push("insufficient_measured_watt_coverage");
    }
    if (cadenceCoverageRatio < policy.minCadenceCoverageRatio) {
      resolvedGateFailures.push("insufficient_cadence_coverage");
    }
    if (policy.requireTargetHoldCorroboration && !hasHold) {
      resolvedGateFailures.push("missing_target_hold_corroboration");
    }

    // Unresolved gates: record only; do not invent thresholds.
    if (policy.minInBandFraction !== null) {
      if (hrInBandFraction == null || hrInBandFraction < policy.minInBandFraction) {
        resolvedGateFailures.push("insufficient_in_band_occupancy");
      }
    }
    if (policy.maxMeasuredWattsMadRatio !== null) {
      if (measuredWattsMadRatio == null || measuredWattsMadRatio > policy.maxMeasuredWattsMadRatio) {
        resolvedGateFailures.push("unstable_measured_workload");
      }
    }
    if (policy.minAdviceGradeDurationSec !== null) {
      if (postSettlingDurationSec < policy.minAdviceGradeDurationSec) {
        resolvedGateFailures.push("insufficient_post_settling_duration");
      }
    }

    windows.push({
      observedResistance: segment.resistance,
      windowStartSec: first,
      windowEndSecExclusive: last + 1,
      settledFromSec: settledFrom,
      postSettlingDurationSec,
      qualifyingSampleCount,
      hrSampleCount,
      hrCoverageRatio,
      hrMedian,
      hrInBandFraction,
      measuredWattsSampleCount: watts.length,
      measuredWattsCoverageRatio,
      measuredWattsMedian,
      measuredWattsMad,
      measuredWattsMadRatio,
      cadenceSampleCount: cadences.length,
      cadenceCoverageRatio,
      cadenceMedian,
      hasTargetHoldCorroboration: hasHold,
      matchingHoldAuditElapsedSeconds: matchingHolds.map((entry) => entry.elapsedSeconds),
      resolvedGateFailures,
      unresolvedPolicyFields: unresolved,
      acceptsUnderResolvedGates: resolvedGateFailures.length === 0,
    });
  }

  const acceptedWindow =
    windows
      .filter((window) => window.acceptsUnderResolvedGates)
      .sort((a, b) => b.qualifyingSampleCount - a.qualifyingSampleCount ||
        b.postSettlingDurationSec - a.postSettlingDurationSec)[0] ?? null;

  let observation: ThresholdRegionSettledWorkloadObservationV1 | null = null;
  if (
    acceptedWindow &&
    unresolved.length === 0 &&
    acceptedWindow.hrMedian != null &&
    acceptedWindow.hrInBandFraction != null &&
    acceptedWindow.measuredWattsMedian != null &&
    acceptedWindow.measuredWattsMad != null &&
    acceptedWindow.cadenceMedian != null
  ) {
    observation = {
      schemaId: THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1,
      schemaVersion: THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1,
      provenance: THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1,
      athleteId: input.athleteId,
      sessionId: input.sessionId,
      machineId: input.machineId as string,
      machineProfileVersion: input.machineProfileVersion as number,
      workoutIntent: "threshold",
      intensityId: "threshold",
      targetHrMin: input.targetHrMin,
      targetHrMax: input.targetHrMax,
      windowStartSec: acceptedWindow.windowStartSec,
      windowEndSecExclusive: acceptedWindow.windowEndSecExclusive,
      settledFromSec: acceptedWindow.settledFromSec,
      qualifyingDurationSec: acceptedWindow.qualifyingSampleCount,
      postSettlingDurationSec: acceptedWindow.postSettlingDurationSec,
      observedResistance: acceptedWindow.observedResistance,
      hrMedian: acceptedWindow.hrMedian,
      hrInBandFraction: acceptedWindow.hrInBandFraction,
      hrCoverageRatio: acceptedWindow.hrCoverageRatio,
      measuredWattsMedian: acceptedWindow.measuredWattsMedian,
      measuredWattsMad: acceptedWindow.measuredWattsMad,
      measuredWattsSampleCount: acceptedWindow.measuredWattsSampleCount,
      measuredWattsCoverageRatio: acceptedWindow.measuredWattsCoverageRatio,
      cadenceMedian: acceptedWindow.cadenceMedian,
      cadenceCoverageRatio: acceptedWindow.cadenceCoverageRatio,
      controllerSettledProvenance: "controller_held_resistance_plus_target_hold_audit",
      formalAnchorObservedAt: input.formalAnchorObservedAt,
      quality: "unverified",
      eligibleForPrescription: false,
      interpretation: "descriptive_observation_only",
    };
  }

  return {
    policy,
    policyProductionReady: unresolved.length === 0,
    unresolvedPolicyFields: unresolved,
    identityFailures,
    windows,
    acceptedWindow,
    observation,
  };
}

/** True when unresolved policy fields are absent (production emission allowed structurally). */
export function thresholdRegionSettledPolicyIsProductionReady(
  policy: ThresholdRegionSettledWorkloadPolicyV1 = THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1
): boolean {
  return unresolvedFields(policy).length === 0;
}

export function observationsAreContinuousForPolicy(
  previous: { activeSec: number; observedAt: string },
  next: { activeSec: number; observedAt: string },
  policy: ThresholdRegionSettledWorkloadPolicyV1 = THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1
): boolean {
  return observationsAreContinuous(previous, next, continuityPolicy(policy));
}
