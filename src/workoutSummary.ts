import { calculateZoneMinutes, determinePrimaryZone } from "./zoneCalculator.js";
import {
  flushOrdinaryBikeTelemetryWrites,
  getHrSamples,
  getOrdinaryBikeTelemetrySamples,
  storeWorkoutSummary,
} from "./workoutStorage.js";
import { formatISO8601UTC } from "./utils/dateTime.js";
import { Activity, WorkoutSummary } from "./types.js";
import { getMachineUsageSnapshot, type MachineUsageSnapshot } from "./machines/runtime.js";
import { getSession, totalPausedDurationSec } from "./sessionStore.js";
import { getPlan, getWorkoutMetadata, getHrTargets } from "./workoutData.js";
import { getActiveWorkoutActivity } from "./workoutActivity.js";
import { learnFromCompletedWorkout } from "./machines/learning/index.js";
import { learnShadowPredictionsFromCompletedWorkout } from "./machines/prediction/index.js";
import { learnHrDynamicsFromCompletedWorkout } from "./machines/dynamics/index.js";
import { actualElapsedSeconds, adjustedBlockLengths } from "./workoutLogic.js";
import { attachVo2Evidence, buildVo2Evidence } from "./vo2Evidence.js";
import { buildVo2ProtocolEvidence, isVo2WorkoutSelector } from "./vo2Protocol.js";
import { assessVo2, type Vo2ProfileInputs } from "./vo2Estimator.js";
import { readExplicitVo2ProfileInputs } from "./profile.js";
import { getBikeTelemetrySamples } from "./bikeTelemetryTrace.js";
import { resolveWorkoutPrescription } from "./workoutPrescription.js";
import { promoteVo2SummaryToStoredFitnessState } from "./fitnessState.js";
import { generateUUID } from "./utils/uuid.js";
import { deriveWorkoutResponse } from "./workoutResponse.js";

export function buildHrTrace(hrSamples: any[]) {
  if (!hrSamples || hrSamples.length === 0) {
    return { sampling_interval_seconds: 60, samples: [] };
  }
  const sorted = [...hrSamples].sort((a, b) => a.timestamp_sec - b.timestamp_sec);
  const downsampled: Array<{ t: number; hr: number }> = [];
  const interval = 60;

  for (let t = 0; t <= sorted[sorted.length - 1].timestamp_sec; t += interval) {
    let closestSample = null;
    let minDiff = Infinity;
    for (const sample of sorted) {
      const diff = Math.abs(sample.timestamp_sec - t);
      if (diff < minDiff) {
        minDiff = diff;
        closestSample = sample;
      }
    }
    if (closestSample && closestSample.hr && closestSample.hr > 0) {
      downsampled.push({ t, hr: closestSample.hr });
    }
  }
  return { sampling_interval_seconds: 60, samples: downsampled };
}

export function determineStressProfile(primaryZone: number): "low" | "moderate" | "high" {
  if (primaryZone === 1 || primaryZone === 2) return "low";
  if (primaryZone === 3) return "moderate";
  return "high";
}

export function applyMachineUsageToSummary(
  summary: WorkoutSummary,
  machineUsage: MachineUsageSnapshot | null
): WorkoutSummary {
  if (!machineUsage) return summary;
  summary.machine_id = machineUsage.machineId;
  summary.machine_profile_version = machineUsage.profileVersion;
  summary.machine_guidance_trace = machineUsage.guidanceTrace;
  if (machineUsage.decisionAudit && machineUsage.decisionAudit.length > 0) {
    summary.machine_decision_audit = machineUsage.decisionAudit;
  }
  return summary;
}

export function applyWorkoutActivityToSummary(
  summary: WorkoutSummary,
  activity: Activity | undefined
): WorkoutSummary {
  if (!activity) return summary;
  summary.activity = activity;
  return summary;
}

function validateSummary(summary: WorkoutSummary) {
  const errors: string[] = [];
  const totalSeconds = Math.floor((new Date(summary.endedAt).getTime() - new Date(summary.startedAt).getTime()) / 1000);
  const expectedDuration = Math.round(totalSeconds / 60);
  if (summary.duration_minutes !== expectedDuration) {
    errors.push(`duration_minutes mismatch: expected ${expectedDuration}, got ${summary.duration_minutes}`);
  }
  const zoneSum =
    summary.zone_minutes.z1 +
    summary.zone_minutes.z2 +
    summary.zone_minutes.z3 +
    summary.zone_minutes.z4 +
    summary.zone_minutes.z5;
  if (zoneSum !== summary.duration_minutes) {
    errors.push(`zone_minutes sum (${zoneSum}) does not equal duration_minutes (${summary.duration_minutes})`);
  }
  const primaryZoneKey = `z${summary.primary_zone}` as keyof typeof summary.zone_minutes;
  if (summary.zone_minutes[primaryZoneKey] <= 0) {
    errors.push(`primary_zone ${summary.primary_zone} has zero or negative minutes in zone_minutes`);
  }
  if (new Date(summary.startedAt) >= new Date(summary.endedAt)) {
    errors.push(`startedAt (${summary.startedAt}) must be before endedAt (${summary.endedAt})`);
  }
  const MAX_DURATION_MINUTES = 1440;
  if (summary.duration_minutes > MAX_DURATION_MINUTES) {
    errors.push(`Duration ${summary.duration_minutes} exceeds maximum ${MAX_DURATION_MINUTES} minutes`);
  }
  try {
    JSON.stringify(summary);
  } catch (e: any) {
    errors.push(`Invalid JSON: ${e.message}`);
  }
  if (errors.length > 0) console.error("Workout summary validation errors:", errors);
}

async function generateWorkoutSummary(
  sessionId: string,
  startedAt: number,
  endedAt: number,
  day: string,
  options?: { cancelled?: boolean; vo2Profile?: Vo2ProfileInputs }
): Promise<WorkoutSummary> {
  const durationMs = endedAt - startedAt;
  const durationMinutesCheck = Math.round(durationMs / (1000 * 60));
  const MAX_DURATION_MINUTES = 1440;
  if (durationMinutesCheck > MAX_DURATION_MINUTES) {
    throw new Error(
      `Workout duration ${durationMinutesCheck} minutes exceeds maximum of ${MAX_DURATION_MINUTES} minutes. This likely indicates a stale workout session. Started: ${new Date(
        startedAt
      ).toISOString()}, Ended: ${new Date(endedAt).toISOString()}`
    );
  }

  const hrSamples = await getHrSamples(sessionId);
  const zoneMinutes = calculateZoneMinutes(hrSamples);
  const primaryZone = determinePrimaryZone(zoneMinutes);
  const stressProfile = determineStressProfile(primaryZone);
  const hrTrace = buildHrTrace(hrSamples);

  const totalSeconds = Math.floor((endedAt - startedAt) / 1000);
  const durationMinutes = Math.round(totalSeconds / 60);

  let intent = "unknown";
  if (typeof (window as any).getWorkoutMetadata === "function") {
    const metadata = (window as any).getWorkoutMetadata();
    if (metadata && metadata[day]) {
      intent = metadata[day].intent || metadata[day].type || "unknown";
    }
  }

  const summary: WorkoutSummary = {
    external_session_id: sessionId,
    startedAt: formatISO8601UTC(startedAt),
    endedAt: formatISO8601UTC(endedAt),
    category: "cardio",
    intent,
    duration_minutes: durationMinutes,
    primary_zone: primaryZone,
    stress_profile: stressProfile,
    zone_minutes: zoneMinutes,
    hr_trace: hrTrace,
    day,
    cancelled: options?.cancelled,
  };

  applyMachineUsageToSummary(summary, getMachineUsageSnapshot(sessionId));
  const session = getSession(day);
  if (session.athleteId) summary.athlete_id = session.athleteId;
  if (session.athleteFitnessSnapshot) {
    summary.athlete_fitness_snapshot = { ...session.athleteFitnessSnapshot };
  }
  const allowed = getWorkoutMetadata()[day]?.activities ?? [];
  applyWorkoutActivityToSummary(summary, getActiveWorkoutActivity(allowed, session.activity));

  const base = getPlan()[day];
  const liveBlocks = base ? adjustedBlockLengths(base, null) : null;
  const phasePlan = session.phasePlan;
  const blocks = phasePlan?.blocks ?? liveBlocks;
  const rawPrescriptionTime = Number(session.sessionStart ?? session.startTime ?? startedAt);
  const resolvedPrescription = blocks
    ? phasePlan?.resolvedPrescription ?? resolveWorkoutPrescription({
        workoutSelector: day,
        blocks,
        hrTargets: phasePlan ? phasePlan.hrTargets : getHrTargets()[day] ?? null,
        resolvedAt: Number.isFinite(rawPrescriptionTime) && rawPrescriptionTime > 0
          ? new Date(rawPrescriptionTime).toISOString()
          : formatISO8601UTC(startedAt),
      })
    : undefined;
  if (resolvedPrescription) summary.resolved_prescription = resolvedPrescription;
  const activeDurationSec = actualElapsedSeconds(
    session.startTime,
    session.paused,
    session.pausedElapsed,
    endedAt
  );
  attachVo2Evidence(
    summary,
    buildVo2Evidence({
      day,
      activity: summary.activity,
      intent: summary.intent,
      blocks,
      hrTargets: phasePlan ? phasePlan.hrTargets : getHrTargets()[day] ?? null,
      resolvedPrescription,
      activeDurationSec,
      pausedDurationSec: totalPausedDurationSec(session, endedAt),
      earlyCooldownElapsed: session.earlyCooldownElapsed,
      cancelled: options?.cancelled,
      hrSamples,
      machineId: summary.machine_id,
      machineProfileVersion: summary.machine_profile_version,
      machineGuidanceTraceEntryCount: summary.machine_guidance_trace?.length,
      vo2Protocol: session.vo2ProtocolRuntime,
      protocol: session.vo2ProtocolRuntime
        ? buildVo2ProtocolEvidence(
            session.vo2ProtocolRuntime,
            session.sessionId || sessionId ? getBikeTelemetrySamples(session.sessionId || sessionId) : []
          )
        : undefined,
    })
  );

  if (isVo2WorkoutSelector(day)) {
    const profile = options?.vo2Profile ?? readExplicitVo2ProfileInputs();
    summary.vo2_assessment = assessVo2(summary.vo2_evidence, profile);
  } else if (
    session.activity === "bike" &&
    session.athleteId &&
    phasePlan?.resolvedPrescription
  ) {
    try {
      await flushOrdinaryBikeTelemetryWrites(sessionId);
      const bikeSamples = await getOrdinaryBikeTelemetrySamples(sessionId);
      const response = deriveWorkoutResponse({
        athleteId: session.athleteId,
        sessionId,
        blocks: phasePlan.blocks,
        resolvedPrescription: phasePlan.resolvedPrescription,
        completedActiveSec: activeDurationSec,
        cancelled: options?.cancelled === true,
        earlyCooldownElapsed: session.earlyCooldownElapsed,
        hrSamples,
        bikeSamples,
      });
      if (response) summary.workout_response = response;
    } catch (error) {
      console.error("Error deriving ordinary workout response:", error);
    }
  }

  validateSummary(summary);
  const zoneSum =
    summary.zone_minutes.z1 +
    summary.zone_minutes.z2 +
    summary.zone_minutes.z3 +
    summary.zone_minutes.z4 +
    summary.zone_minutes.z5;
  if (zoneSum !== summary.duration_minutes) {
    const diff = summary.duration_minutes - zoneSum;
    const primaryZoneKey = `z${summary.primary_zone}` as keyof typeof summary.zone_minutes;
    summary.zone_minutes[primaryZoneKey] = Math.max(0, summary.zone_minutes[primaryZoneKey] + diff);
  }

  return summary;
}

async function emitWorkoutSummary(summary: WorkoutSummary) {
  const saved = await storeWorkoutSummary(summary);
  if (saved && summary.vo2_assessment) {
    try {
      promoteVo2SummaryToStoredFitnessState(summary);
    } catch (error) {
      console.error("Error promoting VO2 assessment to fitness state:", error);
    }
  }
  await learnFromCompletedWorkout(summary);
  await learnShadowPredictionsFromCompletedWorkout(summary);
  await learnHrDynamicsFromCompletedWorkout(summary);
}

export function registerSummaryGlobals() {
  (window as any).generateUUID = generateUUID;
  (window as any).generateWorkoutSummary = generateWorkoutSummary;
  (window as any).emitWorkoutSummary = emitWorkoutSummary;
}

export { generateUUID, generateWorkoutSummary, emitWorkoutSummary };
