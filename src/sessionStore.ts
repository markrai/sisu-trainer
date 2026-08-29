import type { Activity, HrTargetsForDay, PlanBlock } from "./types.js";
import { isActivity } from "./workoutActivity.js";
import { isValidVo2ProtocolRuntime, parseVo2ProtocolRuntime, type Vo2ProtocolRuntime } from "./vo2Protocol.js";

const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

export interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Minimum phase-planning input captured at workout start for evidence replay. */
export interface PhasePlanSnapshot {
  blocks: PlanBlock;
  hrTargets: HrTargetsForDay | null;
}

export interface SessionData {
  startTime: string | null;
  sessionId: string | null;
  sessionStart: string | null;
  summaryEmitted: string | null;
  paused: boolean;
  pausedElapsed: number;
  /** Cumulative completed pause seconds (excludes an open pause). */
  pausedDurationSec: number;
  /** Wall-clock ms when the current pause began, if paused. */
  pauseWallStart: number | null;
  earlyCooldownElapsed: number | null;
  activity?: Activity;
  /** Blocks + HR targets frozen at workout start for phase evidence replay. */
  phasePlan: PhasePlanSnapshot | null;
  vo2ProtocolRuntime: Vo2ProtocolRuntime | null;
}

function storageOrBrowser(storage?: SessionStorage): SessionStorage {
  return storage ?? localStorage;
}

function parseStoredActivity(raw: string | null): Activity | undefined {
  return isActivity(raw) ? raw : undefined;
}

function earlyCooldownKey(day: string): string {
  return "early_cooldown_elapsed_" + day;
}

function pausedDurationKey(day: string): string {
  return "paused_duration_" + day;
}

function pauseWallStartKey(day: string): string {
  return "pause_wall_start_" + day;
}

function phasePlanKey(day: string): string {
  return "phase_plan_" + day;
}

function vo2ProtocolRuntimeKey(day: string): string {
  return "vo2_protocol_runtime_" + day;
}

function legacyVo2ProtocolPlanKey(day: string): string {
  return "vo2_protocol_plan_" + day;
}

function parseEarlyCooldownElapsed(raw: string | null): number | null {
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function parseNonNegativeInt(raw: string | null): number {
  const value = parseInt(raw || "0", 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseOptionalWallMs(raw: string | null): number | null {
  if (raw == null || raw === "") return null;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parsePhasePlan(raw: string | null): PhasePlanSnapshot | null {
  if (raw == null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw);
    const warm = Number(parsed?.blocks?.warm);
    const sustain = Number(parsed?.blocks?.sustain);
    const cool = Number(parsed?.blocks?.cool);
    if (![warm, sustain, cool].every((n) => Number.isFinite(n) && n >= 0)) return null;
    return {
      blocks: { warm, sustain, cool },
      hrTargets: parsed?.hrTargets && typeof parsed.hrTargets === "object" ? parsed.hrTargets : null,
    };
  } catch {
    return null;
  }
}

/** Total paused seconds including an open pause through `now`. */
export function totalPausedDurationSec(
  session: Pick<SessionData, "paused" | "pausedDurationSec" | "pauseWallStart">,
  now = Date.now()
): number {
  let total = session.pausedDurationSec;
  if (session.paused && session.pauseWallStart != null) {
    total += Math.max(0, Math.floor((now - session.pauseWallStart) / 1000));
  }
  return total;
}

export function getEarlyCooldownElapsed(day: string, storage?: SessionStorage): number | null {
  return parseEarlyCooldownElapsed(storageOrBrowser(storage).getItem(earlyCooldownKey(day)));
}

export function setEarlyCooldownElapsed(day: string, elapsedSec: number, storage?: SessionStorage): void {
  if (getEarlyCooldownElapsed(day, storage) != null) return;
  if (!Number.isFinite(elapsedSec) || elapsedSec < 0) return;
  storageOrBrowser(storage).setItem(earlyCooldownKey(day), String(Math.floor(elapsedSec)));
}

export function getSession(day: string, storage?: SessionStorage): SessionData {
  const store = storageOrBrowser(storage);
  return {
    startTime: store.getItem("start_" + day),
    sessionId: store.getItem("session_id_" + day),
    sessionStart: store.getItem("session_start_" + day),
    summaryEmitted: store.getItem("summary_emitted_" + day),
    paused: store.getItem("paused_" + day) === "true",
    pausedElapsed: parseInt(store.getItem("paused_elapsed_" + day) || "0", 10),
    pausedDurationSec: parseNonNegativeInt(store.getItem(pausedDurationKey(day))),
    pauseWallStart: parseOptionalWallMs(store.getItem(pauseWallStartKey(day))),
    earlyCooldownElapsed: parseEarlyCooldownElapsed(store.getItem(earlyCooldownKey(day))),
    activity: parseStoredActivity(store.getItem("activity_" + day)),
    phasePlan: parsePhasePlan(store.getItem(phasePlanKey(day))),
    vo2ProtocolRuntime: parseVo2ProtocolRuntime(
      (() => {
        const raw = store.getItem(vo2ProtocolRuntimeKey(day));
        if (!raw) return null;
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })()
    ),
  };
}

export function startSession(
  day: string,
  startTime: number,
  sessionId?: string | null,
  activity?: Activity,
  storage?: SessionStorage,
  phasePlan?: PhasePlanSnapshot | null
): void {
  const store = storageOrBrowser(storage);
  store.removeItem(earlyCooldownKey(day));
  store.removeItem(pausedDurationKey(day));
  store.removeItem(pauseWallStartKey(day));
  store.removeItem("paused_" + day);
  store.removeItem("paused_elapsed_" + day);
  store.removeItem(phasePlanKey(day));
  store.removeItem(legacyVo2ProtocolPlanKey(day));
  store.removeItem(vo2ProtocolRuntimeKey(day));
  store.setItem("start_" + day, String(startTime));
  if (sessionId != null) {
    store.setItem("session_id_" + day, sessionId);
    store.setItem("session_start_" + day, String(startTime));
    store.setItem("summary_emitted_" + day, "false");
  }
  if (activity) store.setItem("activity_" + day, activity);
  else store.removeItem("activity_" + day);
  if (phasePlan?.blocks) {
    store.setItem(
      phasePlanKey(day),
      JSON.stringify({
        blocks: phasePlan.blocks,
        hrTargets: phasePlan.hrTargets ?? null,
      })
    );
  }
}

export function pauseSession(
  day: string,
  elapsedSec: number,
  storage?: SessionStorage,
  now = Date.now()
): void {
  const store = storageOrBrowser(storage);
  store.setItem("paused_" + day, "true");
  store.setItem("paused_elapsed_" + day, String(elapsedSec));
  if (store.getItem(pauseWallStartKey(day)) == null) {
    store.setItem(pauseWallStartKey(day), String(now));
  }
}

export function resumeSession(day: string, storage?: SessionStorage, now = Date.now()): void {
  const store = storageOrBrowser(storage);
  const pausedElapsed = parseInt(store.getItem("paused_elapsed_" + day) || "0", 10);
  const pauseWallStart = parseOptionalWallMs(store.getItem(pauseWallStartKey(day)));
  if (pauseWallStart != null) {
    const add = Math.max(0, Math.floor((now - pauseWallStart) / 1000));
    const prev = parseNonNegativeInt(store.getItem(pausedDurationKey(day)));
    store.setItem(pausedDurationKey(day), String(prev + add));
  }
  const newStart = now - pausedElapsed * 1000;
  store.setItem("start_" + day, String(newStart));
  store.removeItem("paused_" + day);
  store.removeItem("paused_elapsed_" + day);
  store.removeItem(pauseWallStartKey(day));
}

export function clearSession(day: string, storage?: SessionStorage): void {
  const store = storageOrBrowser(storage);
  store.removeItem("start_" + day);
  store.removeItem("session_id_" + day);
  store.removeItem("session_start_" + day);
  store.removeItem("summary_emitted_" + day);
  store.removeItem("paused_" + day);
  store.removeItem("paused_elapsed_" + day);
  store.removeItem(pausedDurationKey(day));
  store.removeItem(pauseWallStartKey(day));
  store.removeItem(earlyCooldownKey(day));
  store.removeItem("activity_" + day);
  store.removeItem(phasePlanKey(day));
  store.removeItem(legacyVo2ProtocolPlanKey(day));
  store.removeItem(vo2ProtocolRuntimeKey(day));
}

export function persistVo2ProtocolRuntime(
  day: string,
  runtime: Vo2ProtocolRuntime,
  storage?: SessionStorage
): void {
  if (!isValidVo2ProtocolRuntime(runtime)) return;
  storageOrBrowser(storage).setItem(vo2ProtocolRuntimeKey(day), JSON.stringify(runtime));
}

export function markSummaryEmitted(day: string): void {
  localStorage.setItem("summary_emitted_" + day, "true");
}

export function isSessionStale(day: string): boolean {
  const sessionStart = localStorage.getItem("session_start_" + day);
  if (!sessionStart) return true;
  const sessionAge = Date.now() - parseInt(sessionStart);
  return sessionAge > MAX_SESSION_AGE_MS;
}
