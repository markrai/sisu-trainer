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
 * - Controller/load continuity: authoritative resistance-transition timeline
 *   from accepted actuation events (preferred) and/or machine decision audit,
 *   with telemetry commanded/desired as fallback only when no transitions are
 *   known. Telemetry row gaps do NOT split a hold; known controller transitions
 *   DO, even inside a telemetry gap.
 * - Observed-resistance consistency: only fresh observedResistance may
 *   contradict the held controller resistance (producer/parser: metrics exist
 *   only on fresh rows).
 * - Telemetry evidence: independent HR / fresh measured-watt / fresh measured
 *   cadence coverage over the post-settling elapsed seconds of that hold.
 *
 * Reuses existing primitives:
 * - `settledActiveSeconds` with E2 held-workload settling (120 s)
 * - coverage ratios aligned with E2 / Phase D measured-watt paths
 * - E2 `minQualifyingSeconds` as joint HR+measured-watt sample count
 * - `canonicalMedian` / `medianAbsoluteDeviation` for robust central tendency
 *
 * Does NOT hard-code resistance level, wattage, athlete, or machine table.
 */

import type {
  OrdinaryBikeTelemetrySample,
  ResistanceActuationEventV1,
} from "./types.js";
import type {
  MachineDecisionAuditEntry,
  MachineEvaluationAuditEntry,
  MachineWorkPhaseStartedAuditEntry,
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
  | "incomplete_actuation_provenance"
  | "ambiguous_actuation_provenance"
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
   * Advice-grade elapsed duration is `minAdviceGradeDurationSec` (separate gate).
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
  /**
   * Minimum fraction of post-settling **valid HR samples** inside the legacy
   * target band (`inBandCount / hrSampleCount`). Denominator is HR evidence,
   * not elapsed seconds or joint watt seconds.
   */
  minInBandFraction: number | null;
  /**
   * Maximum MAD(measured watts) / median(measured watts) in the settled
   * window. Fail-closed when median ≤ 0 or MAD/ratio is non-finite.
   */
  maxMeasuredWattsMadRatio: number | null;
  /**
   * Minimum elapsed post-settling active seconds for advice-grade admission.
   * Distinct from `minQualifyingSeconds` (joint sample count). Effective
   * minimum hold ≈ settlingSeconds + this value.
   */
  minAdviceGradeDurationSec: number | null;
}

/**
 * Single-session admission policy (v1 scientific thresholds resolved).
 * Completeness here means observation emission is structurally allowed; it
 * does NOT enable the shadow resolver, UI advice, or active control.
 */
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
  /** Strong majority of measured HR inside the product control band. */
  minInBandFraction: 0.9,
  /**
   * Aligns with fitness-refinement moderate MAD/baseline quality (≤0.10);
   * rejects unstable workload without Phase D span sensitivity to outliers.
   */
  maxMeasuredWattsMadRatio: 0.1,
  /**
   * Two minutes of post-settling elapsed evidence after the 120 s settling
   * floor (effective hold ≈ 4 min). Distinct from the 30-sample joint floor.
   */
  minAdviceGradeDurationSec: 120,
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
  /** Controller-held resistance for the window (commanded/desired timeline). */
  heldResistance: number;
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
  /** Controller-held resistance for this candidate window. */
  heldResistance: number;
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
  /**
   * Explicit Bike Bridge resistance commands from
   * `execution_provenance.actuation.events`. Preferred controller-transition
   * source when present. Absent on some historical summaries.
   */
  resistanceActuationEvents?: readonly ResistanceActuationEventV1[];
  /**
   * From `execution_provenance.actuation.coverage`. Distinct from provenance
   * absence: incomplete capture fail-closes; absent provenance allows
   * audit/telemetry fallback.
   */
  actuationCoverage?: "complete" | "incomplete";
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

export interface ControllerHeldWindow {
  resistance: number;
  startSec: number;
  endSecInclusive: number;
  /** True when an uncertain actuation boundary forced this window's start or end. */
  boundedByAmbiguousActuation?: boolean;
}

/** A known controller resistance level beginning at activeSec (inclusive). */
export interface ControllerResistanceTransition {
  activeSec: number;
  resistance: number;
}

/**
 * Controller timeline mark. Known marks establish held resistance; uncertain
 * marks are hard boundaries that must not be bridged by audit or telemetry.
 */
export type ControllerTimelineMark =
  | { kind: "known"; activeSec: number; resistance: number }
  | { kind: "uncertain"; activeSec: number; reason: "non_accepted_actuation" };

export type NonAcceptedActuationOutcome = "failed" | "unavailable" | "timeout" | "pending";

function isNonAcceptedActuationOutcome(
  outcome: ResistanceActuationEventV1["outcome"]
): outcome is NonAcceptedActuationOutcome {
  return (
    outcome === "failed" ||
    outcome === "unavailable" ||
    outcome === "timeout" ||
    outcome === "pending"
  );
}

function isEvaluation(entry: MachineDecisionAuditEntry): entry is MachineEvaluationAuditEntry {
  return entry.kind === "evaluation";
}

function isWorkPhaseStarted(
  entry: MachineDecisionAuditEntry
): entry is MachineWorkPhaseStartedAuditEntry {
  return entry.kind === "work_phase_started";
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

function isFreshMeasuredCadence(sample: OrdinaryBikeTelemetrySample | undefined): boolean {
  return (
    !!sample &&
    sample.availability === "fresh" &&
    sample.cadenceRpm?.source === "measured" &&
    typeof sample.cadenceRpm.value === "number" &&
    Number.isFinite(sample.cadenceRpm.value)
  );
}

/**
 * Fresh observed resistance may contradict held load. Stale/unavailable rows
 * never carry observedResistance under the ordinary telemetry producer/parser;
 * if malformed data presents them, they are ignored (rule B).
 */
function freshObservedResistance(sample: OrdinaryBikeTelemetrySample): number | undefined {
  if (sample.availability !== "fresh") return undefined;
  const value = sample.observedResistance?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Collect the controller timeline inside the work phase.
 *
 * Preference order:
 * 1. Actuation events at a second (any outcome) own that second:
 *    - last event by ascending `commandId` decides the mark
 *    - accepted → known resistance
 *    - failed | unavailable | timeout | pending → uncertain
 *      (physical effect not established; matches PhaseActuationMode "unknown")
 * 2. Audit fills only seconds with no actuation event of any outcome, and
 *    only while not awaiting accepted re-establishment after uncertainty
 * 3. Telemetry commanded/desired only when the timeline is empty (caller)
 *
 * Same-second: numeric resistance never decides provenance precedence.
 * Uncertain marks are hard boundaries; later accepted actuation may
 * re-establish a known hold (Option C). Audit/telemetry must not.
 */
export function collectControllerTimeline(args: {
  workActiveStartSec: number;
  workActiveEndSecExclusive: number;
  machineDecisionAudit?: readonly MachineDecisionAuditEntry[];
  resistanceActuationEvents?: readonly ResistanceActuationEventV1[];
}): ControllerTimelineMark[] {
  const { workActiveStartSec, workActiveEndSecExclusive } = args;

  // Per-second final actuation mark after processing events in commandId order.
  type ActuationSecState =
    | { kind: "known"; resistance: number }
    | { kind: "uncertain" };
  const actuationBySec = new Map<number, ActuationSecState>();
  if (args.resistanceActuationEvents) {
    const inWork = args.resistanceActuationEvents
      .filter(
        (event) =>
          event.activeSec >= workActiveStartSec && event.activeSec < workActiveEndSecExclusive
      )
      .slice()
      .sort((a, b) => a.commandId - b.commandId);
    for (const event of inWork) {
      if (event.outcome === "accepted") {
        actuationBySec.set(event.activeSec, {
          kind: "known",
          resistance: event.requestedResistance,
        });
      } else if (isNonAcceptedActuationOutcome(event.outcome)) {
        actuationBySec.set(event.activeSec, { kind: "uncertain" });
      }
    }
  }

  const auditBySec = new Map<number, number>();
  if (args.machineDecisionAudit) {
    for (const entry of args.machineDecisionAudit) {
      let activeSec: number | undefined;
      let resistance: number | undefined;
      if (isWorkPhaseStarted(entry)) {
        activeSec = entry.elapsedSeconds;
        resistance = entry.resistance;
      } else if (isEvaluation(entry)) {
        if (entry.resistanceBefore === entry.resistanceAfter) continue;
        activeSec = entry.elapsedSeconds;
        resistance = entry.resistanceAfter;
      } else {
        continue;
      }
      if (
        activeSec === undefined ||
        resistance === undefined ||
        activeSec < workActiveStartSec ||
        activeSec >= workActiveEndSecExclusive
      ) {
        continue;
      }
      // Any actuation event (accepted or not) owns the second — audit cannot fill.
      if (actuationBySec.has(activeSec)) continue;
      auditBySec.set(activeSec, resistance);
    }
  }

  const seconds = [...new Set([...actuationBySec.keys(), ...auditBySec.keys()])].sort(
    (a, b) => a - b
  );
  const marks: ControllerTimelineMark[] = [];
  let lastKnownResistance: number | undefined;
  // After non-accepted actuation, only a later accepted actuation may re-establish
  // known held state. Audit must not override unresolved physical ambiguity.
  let awaitAcceptedReestablishment = false;
  for (const activeSec of seconds) {
    const actuation = actuationBySec.get(activeSec);
    if (actuation?.kind === "uncertain") {
      marks.push({ kind: "uncertain", activeSec, reason: "non_accepted_actuation" });
      lastKnownResistance = undefined;
      awaitAcceptedReestablishment = true;
      continue;
    }
    if (actuation?.kind === "known") {
      awaitAcceptedReestablishment = false;
      if (lastKnownResistance === actuation.resistance) continue;
      marks.push({ kind: "known", activeSec, resistance: actuation.resistance });
      lastKnownResistance = actuation.resistance;
      continue;
    }
    // Audit-only second: allowed only when not awaiting accepted re-establishment.
    if (awaitAcceptedReestablishment) continue;
    const resistance = auditBySec.get(activeSec) as number;
    if (lastKnownResistance === resistance) continue;
    marks.push({ kind: "known", activeSec, resistance });
    lastKnownResistance = resistance;
  }
  return marks;
}

/** Known transitions only (uncertain marks omitted). */
export function collectControllerResistanceTransitions(args: {
  workActiveStartSec: number;
  workActiveEndSecExclusive: number;
  machineDecisionAudit?: readonly MachineDecisionAuditEntry[];
  resistanceActuationEvents?: readonly ResistanceActuationEventV1[];
}): ControllerResistanceTransition[] {
  return collectControllerTimeline(args)
    .filter((mark): mark is Extract<ControllerTimelineMark, { kind: "known" }> => mark.kind === "known")
    .map((mark) => ({ activeSec: mark.activeSec, resistance: mark.resistance }));
}

function seedHeldResistanceBeforeFirstTransition(
  samples: readonly OrdinaryBikeTelemetrySample[],
  workStart: number,
  firstTransitionSec: number
): number | undefined {
  const ordered = samples
    .filter((sample) => sample.activeSec >= workStart && sample.activeSec < firstTransitionSec)
    .slice()
    .sort((a, b) => a.activeSec - b.activeSec);
  for (const sample of ordered) {
    const held = controllerResistance(sample);
    if (held !== undefined) return held;
  }
  return undefined;
}

/**
 * Build held intervals from a timeline of known + uncertain marks.
 * Uncertain marks end the prior hold and prevent bridging until a later known.
 */
function intervalsFromTimeline(
  marks: readonly ControllerTimelineMark[],
  workStart: number,
  workEndExclusive: number,
  samples: readonly OrdinaryBikeTelemetrySample[]
): ControllerHeldWindow[] {
  const known = marks.filter(
    (mark): mark is Extract<ControllerTimelineMark, { kind: "known" }> => mark.kind === "known"
  );
  if (known.length === 0 && marks.every((m) => m.kind === "uncertain")) return [];
  if (marks.length === 0) return [];

  // Seed initial known resistance before the first mark when telemetry shows it
  // and the first mark is not uncertain at workStart.
  const timeline: ControllerTimelineMark[] = [...marks];
  const first = timeline[0];
  if (first && first.activeSec > workStart && first.kind === "known") {
    const seed = seedHeldResistanceBeforeFirstTransition(samples, workStart, first.activeSec);
    if (seed !== undefined && seed !== first.resistance) {
      timeline.unshift({ kind: "known", activeSec: workStart, resistance: seed });
    } else if (seed !== undefined && seed === first.resistance) {
      timeline[0] = { kind: "known", activeSec: workStart, resistance: seed };
    }
  } else if (first && first.activeSec > workStart && first.kind === "uncertain") {
    const seed = seedHeldResistanceBeforeFirstTransition(samples, workStart, first.activeSec);
    if (seed !== undefined) {
      timeline.unshift({ kind: "known", activeSec: workStart, resistance: seed });
    }
  }

  const windows: ControllerHeldWindow[] = [];
  for (let i = 0; i < timeline.length; i++) {
    const mark = timeline[i];
    if (mark.kind !== "known") continue;
    const start = Math.max(mark.activeSec, workStart);
    let endExclusive = workEndExclusive;
    let boundedByAmbiguous = false;
    for (let j = i + 1; j < timeline.length; j++) {
      const next = timeline[j];
      if (next.activeSec >= workEndExclusive) break;
      if (next.kind === "uncertain") {
        endExclusive = Math.min(next.activeSec, workEndExclusive);
        boundedByAmbiguous = true;
        break;
      }
      // Next known mark ends this hold (resistance change or same-R collapsed already).
      endExclusive = Math.min(next.activeSec, workEndExclusive);
      break;
    }
    if (endExclusive <= start) continue;
    windows.push({
      resistance: mark.resistance,
      startSec: start,
      endSecInclusive: endExclusive - 1,
      ...(boundedByAmbiguous ? { boundedByAmbiguousActuation: true } : {}),
    });
  }
  return windows;
}

function intervalsFromTelemetryControllerState(
  samples: readonly OrdinaryBikeTelemetrySample[],
  workStart: number,
  workEndExclusive: number
): ControllerHeldWindow[] {
  const ordered = samples
    .filter((sample) => sample.activeSec >= workStart && sample.activeSec < workEndExclusive)
    .slice()
    .sort((a, b) => a.activeSec - b.activeSec);

  type Run = { resistance: number; samples: OrdinaryBikeTelemetrySample[] };
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

  return controllerRuns.map((run) => ({
    resistance: run.resistance,
    startSec: run.samples[0].activeSec,
    endSecInclusive: run.samples[run.samples.length - 1].activeSec,
  }));
}

/**
 * Split/trim held intervals so fresh observedResistance contradictions cannot
 * remain inside a candidate window. Stale/unavailable observed values ignored.
 */
function trimByFreshObservedResistance(
  intervals: readonly ControllerHeldWindow[],
  samples: readonly OrdinaryBikeTelemetrySample[]
): ControllerHeldWindow[] {
  const ordered = samples.slice().sort((a, b) => a.activeSec - b.activeSec);
  const out: ControllerHeldWindow[] = [];

  for (const interval of intervals) {
    const inSpan = ordered.filter(
      (sample) => sample.activeSec >= interval.startSec && sample.activeSec <= interval.endSecInclusive
    );

    let subStart: number | undefined;
    let subEnd: number | undefined;
    const flush = () => {
      if (subStart === undefined || subEnd === undefined) return;
      out.push({
        resistance: interval.resistance,
        startSec: subStart,
        endSecInclusive: subEnd,
        ...(interval.boundedByAmbiguousActuation
          ? { boundedByAmbiguousActuation: true }
          : {}),
      });
      subStart = undefined;
      subEnd = undefined;
    };

    // Walk every elapsed second of the controller interval; missing telemetry is
    // not a contradiction. Fresh contradictory observed resistance ends the subspan.
    let second = interval.startSec;
    while (second <= interval.endSecInclusive) {
      const sample = inSpan.find((row) => row.activeSec === second);
      const observed = sample ? freshObservedResistance(sample) : undefined;
      const contradicts = observed !== undefined && observed !== interval.resistance;
      if (contradicts) {
        flush();
        second += 1;
        continue;
      }
      if (subStart === undefined) {
        // Prefer starting at first non-contradictory evidence second when the
        // interval opens on a contradictory sample that was just skipped; for
        // seconds with no sample, still allow controller-hold start.
        subStart = second;
      }
      subEnd = second;
      second += 1;
    }
    flush();
  }

  // Refine starts: if the first second(s) had no fresh corroborating observed
  // resistance and the first fresh observation disagrees, already handled.
  // If controller interval starts at a commanded transition second that has a
  // fresh contradictory observation, that second was skipped above — good.
  // Collapse: when subspans are adjacent with same resistance, keep separate
  // only when contradiction created the hole (already separate).
  return out;
}

/**
 * Build held-load windows.
 *
 * If the controller timeline has any known or uncertain mark, intervals come
 * only from that timeline. Uncertain marks close the current hold; telemetry
 * must not re-establish known state afterward — only later accepted actuation
 * may. Telemetry commanded/desired fallback applies only when the timeline is
 * empty (no actuation provenance marks and no audit transitions).
 *
 * Telemetry gaps do not split holds. Fresh observedResistance contradictions
 * trim/split. Stale rows do not.
 */
export function segmentControllerHeldResistance(
  samples: readonly OrdinaryBikeTelemetrySample[],
  workStart: number,
  workEndExclusive: number,
  options?: {
    machineDecisionAudit?: readonly MachineDecisionAuditEntry[];
    resistanceActuationEvents?: readonly ResistanceActuationEventV1[];
  }
): ControllerHeldWindow[] {
  const timeline = collectControllerTimeline({
    workActiveStartSec: workStart,
    workActiveEndSecExclusive: workEndExclusive,
    machineDecisionAudit: options?.machineDecisionAudit,
    resistanceActuationEvents: options?.resistanceActuationEvents,
  });

  const baseIntervals =
    timeline.length > 0
      ? intervalsFromTimeline(timeline, workStart, workEndExclusive, samples)
      : intervalsFromTelemetryControllerState(samples, workStart, workEndExclusive);

  return trimByFreshObservedResistance(baseIntervals, samples);
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

  // Provenance present but incomplete ≠ provenance absent.
  if (input.actuationCoverage === "incomplete") {
    identityFailures.push("incomplete_actuation_provenance");
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

  const timeline = collectControllerTimeline({
    workActiveStartSec: input.workActiveStartSec,
    workActiveEndSecExclusive: input.workActiveEndSecExclusive,
    machineDecisionAudit: input.machineDecisionAudit,
    resistanceActuationEvents: input.resistanceActuationEvents,
  });
  const hasUncertainActuation = timeline.some((mark) => mark.kind === "uncertain");

  const heldWindows = segmentControllerHeldResistance(
    input.bikeSamples,
    input.workActiveStartSec,
    input.workActiveEndSecExclusive,
    {
      machineDecisionAudit: input.machineDecisionAudit,
      resistanceActuationEvents: input.resistanceActuationEvents,
    }
  );
  if (heldWindows.length === 0) {
    const code: ThresholdRegionSettledFailureCode = hasUncertainActuation
      ? "ambiguous_actuation_provenance"
      : "no_stable_resistance_window";
    return { ...empty, identityFailures: [...identityFailures, code] };
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
      const hasFreshCadence = isFreshMeasuredCadence(bike);

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
      if (hasFreshCadence) {
        cadences.push(bike!.cadenceRpm!.value);
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
      heldResistance: segment.resistance,
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
      heldResistance: acceptedWindow.heldResistance,
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
