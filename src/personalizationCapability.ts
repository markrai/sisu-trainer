/**
 * Central personalization capability / phase-archetype seam.
 *
 * Workouts are declarative consumers. Personalization sits above named
 * workout selectors and routes evidence through reusable archetypes
 * (`steady_state`, `interval`, `recovery`).
 *
 * Declaring an archetype does NOT enable an algorithm. The generic
 * steady-state engine is a pure configurable algorithm and does not consult
 * this table. Product evidence is enabled only through capability-authorized
 * adapters/routers with `completedWorkoutEvidence: true` — currently
 * Threshold → steady_state only. Exercising the kernel under a synthetic
 * policy does not activate product evidence for that intensity.
 */

import type { PhaseIntensityId } from "./types.js";

export type PersonalizationPhaseArchetype = "steady_state" | "interval" | "recovery";

export type PersonalizationWorkoutIntent =
  | "aerobic_base"
  | "aerobic_volume"
  | "threshold"
  | "vo2_short"
  | "vo2_long"
  | "recovery"
  | string;

export interface PersonalizationCapabilityV1 {
  activity: "bike";
  /** Primary intensity region this capability addresses. */
  intensityId: PhaseIntensityId | "recovery";
  archetype: PersonalizationPhaseArchetype;
  /** E1 / shadow prescription path may consider this intensity. */
  shadowPrescription: boolean;
  /**
   * Whether the completed-workout settled-workload evidence engine may emit
   * observations for this capability. False = architecture declared only.
   */
  completedWorkoutEvidence: boolean;
  notes?: string;
}

/**
 * Source of truth for intensity → archetype mapping.
 * Evidence algorithms are enabled only where `completedWorkoutEvidence` is true.
 */
export const PERSONALIZATION_CAPABILITIES_V1: readonly PersonalizationCapabilityV1[] = [
  {
    activity: "bike",
    intensityId: "aerobic_base",
    archetype: "steady_state",
    shadowPrescription: true,
    completedWorkoutEvidence: false,
    notes: "Future steady_state consumer; not enabled this slice.",
  },
  {
    activity: "bike",
    intensityId: "threshold",
    archetype: "steady_state",
    shadowPrescription: true,
    completedWorkoutEvidence: true,
    notes: "First steady_state configuration (Threshold adapter).",
  },
  {
    activity: "bike",
    intensityId: "vo2_short",
    archetype: "interval",
    shadowPrescription: false,
    completedWorkoutEvidence: false,
  },
  {
    activity: "bike",
    intensityId: "vo2_long",
    archetype: "interval",
    shadowPrescription: false,
    completedWorkoutEvidence: false,
  },
  {
    activity: "bike",
    intensityId: "recovery",
    archetype: "recovery",
    shadowPrescription: false,
    completedWorkoutEvidence: false,
  },
] as const;

export function personalizationCapabilityForIntensity(
  intensityId: string
): PersonalizationCapabilityV1 | undefined {
  return PERSONALIZATION_CAPABILITIES_V1.find((row) => row.intensityId === intensityId);
}

export function steadyStateEvidenceEnabledForIntensity(intensityId: string): boolean {
  const row = personalizationCapabilityForIntensity(intensityId);
  return row?.archetype === "steady_state" && row.completedWorkoutEvidence === true;
}

/**
 * UNRESOLVED product decision: whether multiple workout intents that share the
 * same intensityId + steady_state archetype (e.g. aerobic_base intent vs
 * aerobic_volume intent both carrying intensityId=aerobic_base) should share
 * one evidence lineage. Generic compatibility currently includes both
 * workoutIntent and intensityId so they remain distinguishable until decided.
 */
export const CROSS_INTENT_SAME_INTENSITY_EVIDENCE_SHARING_V1 = "unresolved" as const;
