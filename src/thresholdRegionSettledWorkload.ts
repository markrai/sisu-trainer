/**
 * Threshold adapter over the generic steady-state settled-workload engine.
 *
 * Preserves Threshold schema / provenance / failure-code identities.
 * Segmentation, settling, coverage, occupancy, MAD, cadence, and actuation
 * provenance live in `steadyStateSettledWorkload.ts` — do not reimplement here.
 *
 * Scientific claim (unchanged): descriptive ordinary-workout mechanical
 * workload while the legacy HR controller has settled in the Threshold HR
 * region. Design / shadow-only — not E1, not Phase D, not FTP, not control.
 */

import {
  collectControllerResistanceTransitions,
  collectControllerTimeline,
  createSteadyStateSettledWorkloadPolicyV1,
  evaluateSteadyStateSettledWorkloadContract,
  observationsAreContinuousForPolicy,
  segmentControllerHeldResistance,
  steadyStateSettledPolicyIsProductionReady,
  type ControllerHeldWindow,
  type ControllerResistanceTransition,
  type ControllerTimelineMark,
  type NonAcceptedActuationOutcome,
  type SteadyStateContractInputV1,
  type SteadyStateContractResultV1,
  type SteadyStateSettledFailureCode,
  type SteadyStateSettledWorkloadObservationV1,
  type SteadyStateSettledWorkloadPolicyV1,
  type SteadyStateWindowEvaluationV1,
} from "./steadyStateSettledWorkload.js";
import { steadyStateEvidenceEnabledForIntensity } from "./personalizationCapability.js";

export {
  collectControllerResistanceTransitions,
  collectControllerTimeline,
  observationsAreContinuousForPolicy,
  segmentControllerHeldResistance,
};
export type {
  ControllerHeldWindow,
  ControllerResistanceTransition,
  ControllerTimelineMark,
  NonAcceptedActuationOutcome,
};

/** Evidence observation schema identity (Threshold-named; unshipped design contract). */
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

/** Provenance label for the Threshold scientific claim. */
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

export type ThresholdRegionSettledWorkloadPolicyV1 = SteadyStateSettledWorkloadPolicyV1 & {
  id: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1;
  version: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1;
};

/**
 * Threshold steady-state configuration: semantic identity + Threshold-named
 * contract identity over shared science defaults.
 */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1: ThresholdRegionSettledWorkloadPolicyV1 =
  createSteadyStateSettledWorkloadPolicyV1({
    id: THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1,
    version: THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1,
    semanticIdentity: {
      archetype: "steady_state",
      workoutIntent: "threshold",
      intensityId: "threshold",
    },
    contractIdentity: {
      schemaId: THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1,
      schemaVersion: THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1,
      provenance: THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1,
    },
  }) as ThresholdRegionSettledWorkloadPolicyV1;

export type ThresholdRegionSettledWorkloadObservationV1 = SteadyStateSettledWorkloadObservationV1 & {
  schemaId: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1;
  schemaVersion: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1;
  provenance: typeof THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1;
  workoutIntent: "threshold";
  intensityId: "threshold";
  archetype: "steady_state";
};

export type ThresholdRegionWindowEvaluationV1 = Omit<
  SteadyStateWindowEvaluationV1,
  "resolvedGateFailures"
> & {
  resolvedGateFailures: ThresholdRegionSettledFailureCode[];
};

export type ThresholdRegionContractInputV1 = Omit<SteadyStateContractInputV1, "policy"> & {
  policy?: ThresholdRegionSettledWorkloadPolicyV1 | SteadyStateSettledWorkloadPolicyV1;
};

export type ThresholdRegionContractResultV1 = Omit<
  SteadyStateContractResultV1,
  "policy" | "identityFailures" | "observation" | "windows" | "acceptedWindow"
> & {
  policy: ThresholdRegionSettledWorkloadPolicyV1 | SteadyStateSettledWorkloadPolicyV1;
  identityFailures: ThresholdRegionSettledFailureCode[];
  windows: ThresholdRegionWindowEvaluationV1[];
  acceptedWindow: ThresholdRegionWindowEvaluationV1 | null;
  observation: ThresholdRegionSettledWorkloadObservationV1 | null;
};

function mapFailureCode(code: SteadyStateSettledFailureCode): ThresholdRegionSettledFailureCode {
  if (code === "intent_mismatch") return "intent_not_threshold";
  if (code === "intensity_mismatch") return "intensity_not_threshold";
  return code as ThresholdRegionSettledFailureCode;
}

function mapWindow(window: SteadyStateWindowEvaluationV1): ThresholdRegionWindowEvaluationV1 {
  return {
    ...window,
    resolvedGateFailures: window.resolvedGateFailures.map(mapFailureCode),
  };
}

/**
 * Pure Threshold contract evaluator. Delegates to the generic steady-state
 * engine with Threshold semantic/contract identity. Does not persist, advise,
 * or control. Capability table must list Threshold evidence as enabled.
 */
export function evaluateThresholdRegionSettledWorkloadContract(
  input: ThresholdRegionContractInputV1
): ThresholdRegionContractResultV1 {
  if (!steadyStateEvidenceEnabledForIntensity("threshold")) {
    return {
      policy: input.policy ?? THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1,
      policyProductionReady: false,
      unresolvedPolicyFields: [],
      identityFailures: ["intensity_not_threshold"],
      windows: [],
      acceptedWindow: null,
      observation: null,
    };
  }

  const policy = input.policy ?? THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1;
  const result = evaluateSteadyStateSettledWorkloadContract({
    ...input,
    policy,
  });

  return {
    policy: result.policy,
    policyProductionReady: result.policyProductionReady,
    unresolvedPolicyFields: result.unresolvedPolicyFields,
    identityFailures: result.identityFailures.map(mapFailureCode),
    windows: result.windows.map(mapWindow),
    acceptedWindow: result.acceptedWindow ? mapWindow(result.acceptedWindow) : null,
    observation: result.observation as ThresholdRegionSettledWorkloadObservationV1 | null,
  };
}

export function thresholdRegionSettledPolicyIsProductionReady(
  policy: ThresholdRegionSettledWorkloadPolicyV1 | SteadyStateSettledWorkloadPolicyV1 =
    THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1
): boolean {
  return steadyStateSettledPolicyIsProductionReady(policy);
}
