export const WORKOUT_PRESCRIPTION_SCHEMA_VERSION = 1;
/** Permanent identity for the Phase A resolver; keep readable after newer resolvers ship. */
export const LEGACY_HR_TARGET_RESOLVER_ID = "legacy-hr-target-resolver";
export const LEGACY_HR_TARGET_RESOLVER_VERSION = 1;
/** Resolver used for new resolutions in this build. */
export const WORKOUT_PRESCRIPTION_RESOLVER_ID = LEGACY_HR_TARGET_RESOLVER_ID;
export const WORKOUT_PRESCRIPTION_RESOLVER_VERSION = LEGACY_HR_TARGET_RESOLVER_VERSION;
/** Permanent historical schema identities. Readers must not key old data to current aliases. */
export const ATHLETE_PROFILE_SCHEMA_VERSION_V1 = 1;
export const FITNESS_STATE_SCHEMA_VERSION_V1 = 1;
export const ATHLETE_PROFILE_SCHEMA_VERSION = ATHLETE_PROFILE_SCHEMA_VERSION_V1;
export const FITNESS_STATE_SCHEMA_VERSION = FITNESS_STATE_SCHEMA_VERSION_V1;
/** Local evidence for the VO2 estimator. Not itself a VO2 result. */
export const VO2_EVIDENCE_SCHEMA_VERSION_V1 = 1;
export const VO2_ASSESSMENT_SCHEMA_VERSION_V1 = 1;
export const VO2_EVIDENCE_SCHEMA_VERSION = VO2_EVIDENCE_SCHEMA_VERSION_V1;
export const VO2_ASSESSMENT_SCHEMA_VERSION = VO2_ASSESSMENT_SCHEMA_VERSION_V1;
/** Permanent historical identity for the v1 protocol; keep readable after newer protocols ship. */
export const LEGACY_VO2_PROTOCOL_ID = "bike-submax-70rpm";
export const LEGACY_VO2_PROTOCOL_VERSION = 1;
/** Protocol identity used for new formal assessments in this build. */
export const VO2_PROTOCOL_ID = LEGACY_VO2_PROTOCOL_ID;
export const VO2_PROTOCOL_VERSION = LEGACY_VO2_PROTOCOL_VERSION;
