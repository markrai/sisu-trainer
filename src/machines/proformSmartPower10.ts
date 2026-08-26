import { qualifiedHrMedian } from "./hrQuality.js";
import type {
  CompletedShortWorkPhase,
  MachineAdapter,
  MachineGuidance,
  MachineGuidanceContext,
  MachineGuidanceResult,
  MachineGuidanceState,
} from "./types.js";

export const estimatedWattsAt70Rpm: Readonly<Partial<Record<number, number>>> = Object.freeze({
  1: 66,
  2: 69,
  3: 70,
  4: 78,
  5: 82,
  6: 86,
  7: 97,
  8: 108,
  9: 114,
  10: 123,
  11: 134,
  12: 147,
  13: 156,
  14: 180,
  15: 201,
});

export function getEstimatedWattsAt70Rpm(resistance: number): number | undefined {
  return estimatedWattsAt70Rpm[resistance];
}

export function clampAutomaticResistance(resistance: number): number {
  return Math.max(1, Math.min(15, Math.round(resistance)));
}

function rollingMedian(
  context: Pick<MachineGuidanceContext, "recentHeartRates">
): number | undefined {
  return qualifiedHrMedian(context.recentHeartRates);
}

function startingWorkResistance(durationSeconds: number): number {
  if (durationSeconds <= 75) return 11;
  if (durationSeconds <= 150) return 10;
  return 8;
}

function workStartResistance(context: MachineGuidanceContext): { resistance: number; learned: boolean } {
  const fallback = startingWorkResistance(context.phaseDurationSeconds);
  const learned = context.learnedStartingResistance;
  if (learned === undefined || !Number.isFinite(learned)) return { resistance: fallback, learned: false };
  return { resistance: clampAutomaticResistance(learned), learned: true };
}

function actionForResistance(previous: number | undefined, next: number, phaseChanged: boolean): MachineGuidance["action"] {
  if (phaseChanged || previous === undefined) return "set";
  if (next > previous) return "increase";
  if (next < previous) return "decrease";
  return "hold";
}

function recommendation(
  resistance: number,
  cadenceRpm: number,
  action: MachineGuidance["action"],
  reason: string,
  includeEstimatedWatts: boolean
): MachineGuidance {
  const guidance: MachineGuidance = {
    machineId: "proform-smart-power-10",
    resistance: clampAutomaticResistance(resistance),
    cadenceRpm,
    action,
    reason,
  };
  if (includeEstimatedWatts && cadenceRpm === 70) {
    guidance.estimatedWatts = getEstimatedWattsAt70Rpm(guidance.resistance as number);
  }
  return guidance;
}

export function finalizeProFormShortWork(
  completed: CompletedShortWorkPhase,
  state: MachineGuidanceState
): MachineGuidanceState {
  if (completed.phaseDurationSeconds > 75 || state.shortIntervalEvaluated) return state;
  const adapted = adaptWorkResistance(
    {
      recentHeartRates: completed.recentHeartRates,
      targetHeartRateMin: completed.targetHeartRateMin,
      targetHeartRateMax: completed.targetHeartRateMax,
    },
    completed.resistance
  );
  return {
    ...state,
    shortIntervalEvaluated: true,
    nextWorkResistance: adapted.evaluated ? adapted.resistance : completed.resistance,
  };
}

function adaptWorkResistance(
  context: Pick<MachineGuidanceContext, "recentHeartRates" | "targetHeartRateMin" | "targetHeartRateMax">,
  currentResistance: number
): {
  resistance: number;
  median?: number;
  evaluated: boolean;
} {
  const median = rollingMedian(context);
  const min = context.targetHeartRateMin;
  const max = context.targetHeartRateMax;
  if (median === undefined || min === undefined || max === undefined) {
    return { resistance: currentResistance, median, evaluated: false };
  }
  if (median >= max + 3) {
    return { resistance: clampAutomaticResistance(currentResistance - 1), median, evaluated: true };
  }
  const requiredDeficit = currentResistance >= 13 ? 5 : 3;
  if (median <= min - requiredDeficit && currentResistance < 15) {
    return { resistance: clampAutomaticResistance(currentResistance + 1), median, evaluated: true };
  }
  return { resistance: currentResistance, median, evaluated: true };
}

function warmupGuidance(
  context: MachineGuidanceContext,
  state: MachineGuidanceState,
  phaseChanged: boolean
): MachineGuidanceResult {
  const fraction = context.phaseDurationSeconds > 0
    ? Math.max(0, Math.min(1, context.phaseElapsedSeconds / context.phaseDurationSeconds))
    : 0;
  const target = fraction < 1 / 3
    ? { resistance: 3, cadence: 60, reason: "Progressive warm-up, first third" }
    : fraction < 2 / 3
      ? { resistance: 5, cadence: 65, reason: "Progressive warm-up, middle third" }
      : { resistance: 6, cadence: 70, reason: "Progressive warm-up, final third" };
  const action = actionForResistance(state.currentResistance, target.resistance, phaseChanged);
  const nextState = {
    ...state,
    currentResistance: target.resistance,
    currentCadenceRpm: target.cadence,
  };
  return {
    guidance: recommendation(target.resistance, target.cadence, action, target.reason, target.cadence === 70),
    state: nextState,
  };
}

function recoveryGuidance(
  context: MachineGuidanceContext,
  state: MachineGuidanceState,
  phaseChanged: boolean,
  cooldown: boolean
): MachineGuidanceResult {
  let resistance = phaseChanged ? 2 : state.currentResistance ?? 2;
  let reason = cooldown ? "Conservative cooldown" : "Easy recovery";
  if (!cooldown && context.phaseElapsedSeconds >= 30) {
    const median = rollingMedian(context);
    if (median !== undefined && context.targetHeartRateMax !== undefined && median >= context.targetHeartRateMax + 3) {
      const reduced = clampAutomaticResistance(resistance - 1);
      if (reduced < resistance) {
        resistance = reduced;
        reason = `Recovery heart rate remains high at ${Math.round(median)} bpm`;
      }
    }
  }
  const action = actionForResistance(state.currentResistance, resistance, phaseChanged);
  const nextState = {
    ...state,
    currentResistance: resistance,
    currentCadenceRpm: 63,
    nextWorkResistance: state.nextWorkResistance,
  };
  return {
    guidance: recommendation(resistance, 63, action, reason, false),
    state: nextState,
  };
}

function workGuidance(
  context: MachineGuidanceContext,
  state: MachineGuidanceState,
  phaseChanged: boolean
): MachineGuidanceResult {
  const start = workStartResistance(context);
  const usingLearnedStart = phaseChanged && state.nextWorkResistance === undefined && start.learned;
  let resistance = phaseChanged
    ? state.nextWorkResistance ?? start.resistance
    : state.currentResistance ?? state.nextWorkResistance ?? start.resistance;
  let action = actionForResistance(state.currentResistance, resistance, phaseChanged);
  let reason = usingLearnedStart
    ? "Learned starting resistance from prior workouts"
    : "Conservative work-phase starting recommendation";
  const nextState: MachineGuidanceState = {
    ...state,
    currentResistance: resistance,
    currentCadenceRpm: 70,
    nextWorkResistance: context.phaseDurationSeconds <= 75 && state.shortIntervalEvaluated
      ? state.nextWorkResistance ?? resistance
      : resistance,
  };

  if (context.phaseDurationSeconds <= 75) {
    if (!nextState.shortIntervalEvaluated && context.phaseElapsedSeconds >= Math.max(0, context.phaseDurationSeconds - 1)) {
      const adapted = adaptWorkResistance(context, resistance);
      if (adapted.evaluated) {
        nextState.shortIntervalEvaluated = true;
        nextState.nextWorkResistance = adapted.resistance;
        if (adapted.resistance > resistance) reason = "Hold this repetition; increase the next repetition after the final heart-rate response";
        else if (adapted.resistance < resistance) reason = "Hold this repetition; reduce the next repetition after the final heart-rate response";
        else reason = "Hold this repetition; final heart-rate response supports the current resistance";
      } else {
        reason = usingLearnedStart
          ? "Learned starting resistance from prior workouts"
          : "Short interval resistance is held for the full repetition";
      }
    } else {
      reason = usingLearnedStart
        ? "Learned starting resistance from prior workouts"
        : "Short interval resistance is held for the full repetition";
    }
  } else if (context.phaseDurationSeconds <= 150) {
    if (!nextState.mediumIntervalEvaluated && context.phaseElapsedSeconds >= 60) {
      const adapted = adaptWorkResistance(context, resistance);
      if (adapted.evaluated) {
        nextState.mediumIntervalEvaluated = true;
        resistance = adapted.resistance;
        action = actionForResistance(nextState.currentResistance, resistance, false);
        nextState.currentResistance = resistance;
        nextState.nextWorkResistance = resistance;
        reason = action === "hold"
          ? "Heart-rate response supports the current resistance"
          : `Adjusted after ${Math.round(adapted.median as number)} bpm rolling heart rate`;
      } else {
        reason = usingLearnedStart
          ? "Learned starting resistance from prior workouts"
          : "Waiting 60 seconds for heart-rate response";
      }
    } else if (!nextState.mediumIntervalEvaluated) {
      reason = usingLearnedStart
        ? "Learned starting resistance from prior workouts"
        : "Waiting 60 seconds for heart-rate response";
    } else {
      reason = "Medium interval adjustment limit reached";
    }
  } else {
    const lastEvaluation = nextState.lastEvaluationPhaseElapsedSeconds;
    const canEvaluate = context.phaseElapsedSeconds >= 90 &&
      (lastEvaluation === undefined || context.phaseElapsedSeconds - lastEvaluation >= 60);
    if (canEvaluate) {
      const adapted = adaptWorkResistance(context, resistance);
      if (adapted.evaluated) {
        nextState.lastEvaluationPhaseElapsedSeconds = context.phaseElapsedSeconds;
        resistance = adapted.resistance;
        action = actionForResistance(nextState.currentResistance, resistance, false);
        nextState.currentResistance = resistance;
        nextState.nextWorkResistance = resistance;
        reason = action === "hold"
          ? "Rolling heart rate is within the target range"
          : `Adjusted after ${Math.round(adapted.median as number)} bpm rolling heart rate`;
      } else {
        reason = usingLearnedStart
          ? "Learned starting resistance from prior workouts"
          : "Waiting 90 seconds for heart-rate stabilization";
      }
    } else if (context.phaseElapsedSeconds < 90) {
      reason = usingLearnedStart
        ? "Learned starting resistance from prior workouts"
        : "Waiting 90 seconds for heart-rate stabilization";
    } else {
      reason = "Holding during the 60-second adjustment cooldown";
    }
  }

  return {
    guidance: recommendation(resistance, 70, action, reason, true),
    state: nextState,
  };
}

export function getProFormSmartPower10Guidance(
  context: MachineGuidanceContext,
  state: MachineGuidanceState
): MachineGuidanceResult {
  const finalizedState = context.completedShortWork
    ? finalizeProFormShortWork(context.completedShortWork, state)
    : state;
  const phaseChanged = finalizedState.currentPhaseId !== context.phaseId;
  const phaseState: MachineGuidanceState = phaseChanged
    ? {
        ...finalizedState,
        currentPhaseId: context.phaseId,
        currentPhaseKind: context.phaseKind,
        lastEvaluationPhaseElapsedSeconds: undefined,
        shortIntervalEvaluated: false,
        mediumIntervalEvaluated: false,
      }
    : finalizedState;
  if (context.phaseKind === "warmup") return warmupGuidance(context, phaseState, phaseChanged);
  if (context.phaseKind === "work") return workGuidance(context, phaseState, phaseChanged);
  if (context.phaseKind === "recovery") return recoveryGuidance(context, phaseState, phaseChanged, false);
  return recoveryGuidance(context, phaseState, phaseChanged, true);
}

export const proformSmartPower10Adapter: MachineAdapter = {
  definition: {
    id: "proform-smart-power-10",
    name: "ProForm SMART Power 10.0",
    activity: "bike",
    profileVersion: 1,
  },
  getGuidance: getProFormSmartPower10Guidance,
};
