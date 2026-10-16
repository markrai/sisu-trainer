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
import { collectControllerResistanceTransitions, collectControllerTimeline, createSteadyStateSettledWorkloadPolicyV1, evaluateSteadyStateSettledWorkloadContract, observationsAreContinuousForPolicy, segmentControllerHeldResistance, steadyStateSettledPolicyIsProductionReady, } from "./steadyStateSettledWorkload.js";
import { steadyStateEvidenceEnabledForIntensity } from "./personalizationCapability.js";
export { collectControllerResistanceTransitions, collectControllerTimeline, observationsAreContinuousForPolicy, segmentControllerHeldResistance, };
/** Evidence observation schema identity (Threshold-named; unshipped design contract). */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_ID_V1 = "threshold-region-settled-workload-observation";
export const THRESHOLD_REGION_SETTLED_WORKLOAD_SCHEMA_VERSION_V1 = 1;
/** Evidence admission policy identity. */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_ID_V1 = "threshold-region-settled-workload-policy";
export const THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_VERSION_V1 = 1;
/**
 * Future shadow-advice resolver identity. Distinct from
 * `personalized-prescription-resolver` (E1 formal-calibration inversion).
 */
export const THRESHOLD_REGION_ORDINARY_WORKOUT_SHADOW_RESOLVER_ID_V1 = "threshold-region-ordinary-workout-shadow-resolver";
export const THRESHOLD_REGION_ORDINARY_WORKOUT_SHADOW_RESOLVER_VERSION_V1 = 1;
/** Provenance label for the Threshold scientific claim. */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_PROVENANCE_V1 = "ordinary_workout_settled_threshold_region";
/**
 * Threshold steady-state configuration: semantic identity + Threshold-named
 * contract identity over shared science defaults.
 */
export const THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1 = createSteadyStateSettledWorkloadPolicyV1({
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
});
function mapFailureCode(code) {
    if (code === "intent_mismatch")
        return "intent_not_threshold";
    if (code === "intensity_mismatch")
        return "intensity_not_threshold";
    return code;
}
function mapWindow(window) {
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
export function evaluateThresholdRegionSettledWorkloadContract(input) {
    var _a, _b;
    if (!steadyStateEvidenceEnabledForIntensity("threshold")) {
        return {
            policy: (_a = input.policy) !== null && _a !== void 0 ? _a : THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1,
            policyProductionReady: false,
            unresolvedPolicyFields: [],
            identityFailures: ["intensity_not_threshold"],
            windows: [],
            acceptedWindow: null,
            observation: null,
        };
    }
    const policy = (_b = input.policy) !== null && _b !== void 0 ? _b : THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1;
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
        observation: result.observation,
    };
}
export function thresholdRegionSettledPolicyIsProductionReady(policy = THRESHOLD_REGION_SETTLED_WORKLOAD_POLICY_V1) {
    return steadyStateSettledPolicyIsProductionReady(policy);
}
