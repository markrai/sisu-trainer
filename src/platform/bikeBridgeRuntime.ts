import {
  defaultBikeBridgeStorage,
  loadBikeBridgeSettings,
  parseBikeBridgeBaseUrl,
  saveBikeBridgeSettings,
  type BikeBridgeSettings,
  type BikeBridgeStorage,
} from "./bikeBridgeConfig.js";
import {
  BIKE_BRIDGE_REQUEST_TIMEOUT_MS,
  createBikeBridgeClient,
  createDefaultBikeBridgeTransport,
  isBikeBridgeClientOk,
  isBikeBridgeUrlOk,
  toBridgeHeartRateBpm,
  toBridgeResistanceLevel,
  type BikeBridgeClient,
  type BikeBridgeHttpTransport,
  type BikeTelemetry,
  type BridgeStatus,
} from "./bikeBridgeClient.js";
import { getCurrentBpm } from "../hrMonitor.js";

export const BIKE_BRIDGE_POLL_INTERVAL_MS = 1000;

export type BikeBridgeReadiness =
  | "not_configured"
  | "unreachable"
  | "reachable_disconnected"
  | "reachable_not_initialized"
  | "telemetry_ready"
  | "control_ready"
  | "invalid_response";

export type BikeBridgeLastCommandOutcome =
  | "accepted"
  | "failed"
  | "unavailable"
  | "timeout"
  | "unknown";

export interface BikeBridgeViewState {
  readiness: BikeBridgeReadiness;
  configuredUrl: string;
  automaticControlEnabled: boolean;
  controlAvailable: boolean;
  desiredResistance?: number;
  commandedResistance?: number;
  requestedResistance: number | null;
  observedResistance: number | null;
  rpm: number | null;
  watts: number | null;
  telemetryStale: boolean;
  lastError: string | null;
  lastCommandOutcome: BikeBridgeLastCommandOutcome | null;
}

export interface BikeBridgeGuidanceInput {
  desiredResistance?: number;
  recommendationChanged: boolean;
  workoutActive: boolean;
  paused: boolean;
}

export interface BikeBridgeSessionOptions {
  storage?: BikeBridgeStorage;
  transport?: BikeBridgeHttpTransport;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  /** Override live BPM source (defaults to hrMonitor.getCurrentBpm). */
  getCurrentBpm?: () => number | null;
}

export interface BikeBridgeSession {
  start(): void;
  stop(): void;
  isPolling(): boolean;
  getViewState(): BikeBridgeViewState;
  subscribe(listener: () => void): () => void;
  configure(settings: Partial<BikeBridgeSettings> & { baseUrl?: string }): { ok: boolean; error?: string };
  onGuidance(input: BikeBridgeGuidanceInput): void;
  postedResistanceBodies(): string[];
}

function classifyReadiness(
  configured: boolean,
  status: BridgeStatus | null,
  pollKind: "ok" | "timeout" | "unreachable" | "http_error" | "malformed" | "not_configured" | null
): BikeBridgeReadiness {
  if (!configured) return "not_configured";
  if (pollKind === null) return "not_configured";
  if (pollKind === "malformed") return "invalid_response";
  if (!status) return "unreachable";
  if (!status.connected) return "reachable_disconnected";
  if (!status.initialized) return "reachable_not_initialized";
  if (status.resistanceControlAvailable) return "control_ready";
  return "telemetry_ready";
}

function formatMetric(value: number | null | undefined): number | null {
  return value === undefined ? null : value;
}

export function createBikeBridgeSession(options: BikeBridgeSessionOptions = {}): BikeBridgeSession {
  const storage = options.storage ?? defaultBikeBridgeStorage();
  const timeoutMs = options.requestTimeoutMs ?? BIKE_BRIDGE_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? BIKE_BRIDGE_POLL_INTERVAL_MS;
  const readBpm = options.getCurrentBpm ?? getCurrentBpm;
  const postedBodies: string[] = [];
  const baseTransport = options.transport ?? createDefaultBikeBridgeTransport();
  const transport: BikeBridgeHttpTransport = {
    async request(request) {
      if (
        request.method === "POST" &&
        request.jsonBody !== undefined &&
        typeof request.url === "string" &&
        request.url.includes("/api/v1/resistance")
      ) {
        postedBodies.push(JSON.stringify(request.jsonBody));
      }
      return baseTransport.request(request);
    },
  };
  const client: BikeBridgeClient = createBikeBridgeClient(
    () => loadBikeBridgeSettings(storage).baseUrl,
    transport,
    timeoutMs
  );

  let timer: ReturnType<typeof setInterval> | undefined;
  let pollInFlight = false;
  let sendInFlight = false;
  let pendingLevel: number | undefined;
  let lastAccepted: number | undefined;
  let holdFailedLevel: number | undefined;
  let needsReconcile = false;
  let desiredResistance: number | undefined;
  let commandedResistance: number | undefined;
  let workoutActive = false;
  let paused = false;
  let lastStatus: BridgeStatus | null = null;
  let lastTelemetry: BikeTelemetry | null = null;
  let telemetryStale = false;
  let lastError: string | null = null;
  let lastPollKind: "ok" | "timeout" | "unreachable" | "http_error" | "malformed" | "not_configured" | null = null;
  let lastCommandOutcome: BikeBridgeLastCommandOutcome | null = null;
  let previousControlAvailable = false;
  const listeners = new Set<() => void>();

  function notify(): void {
    listeners.forEach((listener) => listener());
  }

  function settings(): BikeBridgeSettings {
    return loadBikeBridgeSettings(storage);
  }

  function configured(): boolean {
    return parseBikeBridgeBaseUrl(settings().baseUrl).ok;
  }

  function controlAvailable(): boolean {
    return lastStatus?.resistanceControlAvailable === true;
  }

  function canCommand(): boolean {
    return (
      configured() &&
      settings().automaticControlEnabled &&
      workoutActive &&
      !paused &&
      controlAvailable()
    );
  }

  function requestedForView(): number | null {
    if (lastStatus && lastStatus.resistance.requested !== null) return lastStatus.resistance.requested;
    if (lastCommandOutcome === "accepted" && lastAccepted !== undefined) return lastAccepted;
    return lastStatus?.resistance.requested ?? null;
  }

  function viewState(): BikeBridgeViewState {
    const current = settings();
    const readiness = classifyReadiness(configured(), lastStatus, lastPollKind);
    return {
      readiness,
      configuredUrl: current.baseUrl,
      automaticControlEnabled: current.automaticControlEnabled,
      controlAvailable: controlAvailable(),
      desiredResistance,
      commandedResistance,
      requestedResistance: requestedForView(),
      observedResistance: formatMetric(lastTelemetry?.resistance.value),
      rpm: formatMetric(lastTelemetry?.rpm.value),
      watts: formatMetric(lastTelemetry?.watts.value),
      telemetryStale,
      lastError,
      lastCommandOutcome,
    };
  }

  function scheduleSend(level: number | undefined, force = false): void {
    const target = level === undefined ? undefined : toBridgeResistanceLevel(level);
    if (target === undefined || !canCommand()) return;
    if (!force && lastAccepted === target) return;
    if (!force && holdFailedLevel === target) return;
    if (sendInFlight) {
      pendingLevel = target;
      return;
    }
    void sendTarget(target);
  }

  async function sendTarget(target: number): Promise<void> {
    if (sendInFlight) {
      pendingLevel = target;
      return;
    }
    sendInFlight = true;
    pendingLevel = undefined;
    commandedResistance = target;
    try {
      const result = await client.setResistance(target);
      if (isBikeBridgeClientOk(result)) {
        lastAccepted = result.value.requested;
        holdFailedLevel = undefined;
        lastCommandOutcome = "accepted";
        lastError = null;
        if (lastStatus) {
          lastStatus = {
            ...lastStatus,
            resistance: {
              ...lastStatus.resistance,
              requested: result.value.requested,
            },
          };
        }
      } else if (result.kind === "timeout") {
        lastCommandOutcome = "timeout";
        lastError = "resistance command timed out";
        holdFailedLevel = target;
      } else if (result.status === 503 || result.kind === "unreachable") {
        lastCommandOutcome = "unavailable";
        lastError = result.message;
        holdFailedLevel = target;
      } else {
        lastCommandOutcome = "failed";
        lastError = result.message;
        holdFailedLevel = target;
      }
    } finally {
      sendInFlight = false;
      notify();
      if (pendingLevel !== undefined) {
        const next = pendingLevel;
        pendingLevel = undefined;
        scheduleSend(next, false);
      }
    }
  }

  async function mirrorHeartRate(): Promise<void> {
    // Presentation-only: never touches lastError, resistance, guidance, or poll kind.
    if (!configured()) return;
    const raw = readBpm();
    if (raw === null || raw === undefined) return;
    const bpm = toBridgeHeartRateBpm(raw);
    if (bpm === undefined) return;
    try {
      await client.postHeartRate(bpm);
    } catch {
      // ignore
    }
  }

  async function tick(): Promise<void> {
    if (pollInFlight) return;
    if (!configured()) {
      lastPollKind = "not_configured";
      lastStatus = null;
      notify();
      return;
    }
    pollInFlight = true;
    try {
      const previousKind = lastPollKind;
      const statusResult = await client.getStatus();
      if (isBikeBridgeClientOk(statusResult)) {
        lastStatus = statusResult.value;
        lastPollKind = "ok";
        if (statusResult.value.resistanceControlAvailable && lastCommandOutcome === "accepted") {
          lastError = null;
        }
      } else {
        lastPollKind = statusResult.kind === "not_configured" ? "not_configured" : statusResult.kind;
        lastStatus = null;
        lastError = statusResult.message;
      }

      const telemetryResult = await client.getTelemetry();
      if (isBikeBridgeClientOk(telemetryResult)) {
        lastTelemetry = telemetryResult.value;
        telemetryStale = false;
      } else if (lastTelemetry) {
        telemetryStale = true;
        if (!isBikeBridgeClientOk(statusResult)) lastError = telemetryResult.message;
      } else {
        telemetryStale = true;
        if (!isBikeBridgeClientOk(statusResult)) lastError = telemetryResult.message;
      }

      const available = controlAvailable();
      if (isBikeBridgeClientOk(statusResult) && available) {
        const recoveredFromLoss =
          previousKind === "unreachable" ||
          previousKind === "timeout" ||
          previousKind === "http_error" ||
          previousKind === "malformed";
        const controlAppeared = !previousControlAvailable && previousKind === "ok";
        const target = desiredResistance === undefined ? undefined : toBridgeResistanceLevel(desiredResistance);
        if ((recoveredFromLoss || controlAppeared) && target !== undefined && lastAccepted !== target) {
          needsReconcile = true;
        }
      }
      previousControlAvailable = available;
      if (needsReconcile && canCommand()) {
        needsReconcile = false;
        holdFailedLevel = undefined;
        scheduleSend(desiredResistance, true);
      }
    } finally {
      pollInFlight = false;
      void mirrorHeartRate();
      notify();
    }
  }

  return {
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void tick();
      }, pollIntervalMs);
      void tick();
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    isPolling() {
      return timer !== undefined;
    },
    getViewState() {
      return viewState();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    configure(partial) {
      const current = settings();
      let baseUrl = current.baseUrl;
      if (partial.baseUrl !== undefined) {
        const trimmed = partial.baseUrl.trim();
        if (!trimmed) {
          saveBikeBridgeSettings(
            {
              baseUrl: "",
              automaticControlEnabled:
                partial.automaticControlEnabled !== undefined
                  ? partial.automaticControlEnabled
                  : current.automaticControlEnabled,
            },
            storage
          );
          lastStatus = null;
          lastTelemetry = null;
          lastPollKind = "not_configured";
          lastError = null;
          notify();
          return { ok: true };
        }
        const parsed = parseBikeBridgeBaseUrl(partial.baseUrl);
        if (!isBikeBridgeUrlOk(parsed)) return { ok: false, error: parsed.error };
        baseUrl = parsed.normalized;
      }
      const nextEnabled =
        partial.automaticControlEnabled !== undefined
          ? partial.automaticControlEnabled
          : current.automaticControlEnabled;
      const enabledChanged = nextEnabled !== current.automaticControlEnabled;
      if (baseUrl !== current.baseUrl) {
        lastStatus = null;
        lastTelemetry = null;
        lastAccepted = undefined;
        holdFailedLevel = undefined;
        telemetryStale = false;
        lastPollKind = null;
        lastError = null;
      }
      saveBikeBridgeSettings(
        {
          baseUrl,
          automaticControlEnabled: nextEnabled,
        },
        storage
      );
      if (enabledChanged && !nextEnabled) pendingLevel = undefined;
      if (enabledChanged && nextEnabled) {
        holdFailedLevel = undefined;
        needsReconcile = true;
        scheduleSend(desiredResistance, true);
      }
      notify();
      return { ok: true };
    },
    onGuidance(input) {
      const wasActive = workoutActive;
      const wasPaused = paused;
      workoutActive = input.workoutActive;
      paused = input.paused;
      desiredResistance = input.desiredResistance;
      if (!input.workoutActive) {
        pendingLevel = undefined;
        lastAccepted = undefined;
        holdFailedLevel = undefined;
        needsReconcile = false;
        commandedResistance = undefined;
        notify();
        return;
      }
      if (!wasActive) {
        lastAccepted = undefined;
        holdFailedLevel = undefined;
        needsReconcile = true;
      }
      if (input.paused) {
        pendingLevel = undefined;
        notify();
        return;
      }
      if (wasPaused) {
        holdFailedLevel = undefined;
        needsReconcile = false;
        scheduleSend(input.desiredResistance, true);
        notify();
        return;
      }
      if (input.recommendationChanged) {
        holdFailedLevel = undefined;
        needsReconcile = false;
        scheduleSend(input.desiredResistance, true);
      } else if (needsReconcile) {
        holdFailedLevel = undefined;
        needsReconcile = false;
        scheduleSend(input.desiredResistance, true);
      }
      notify();
    },
    postedResistanceBodies() {
      return [...postedBodies];
    },
  };
}

let appSession: BikeBridgeSession | undefined;

export function getBikeBridgeSession(): BikeBridgeSession {
  if (!appSession) appSession = createBikeBridgeSession();
  return appSession;
}

export function startBikeBridgeRuntime(): void {
  getBikeBridgeSession().start();
}

export function formatBikeBridgeNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : String(value);
}

export function formatBikeBridgeReadiness(readiness: BikeBridgeReadiness): string {
  switch (readiness) {
    case "not_configured":
      return "Not configured";
    case "unreachable":
      return "Unreachable";
    case "reachable_disconnected":
      return "Bike disconnected";
    case "reachable_not_initialized":
      return "Bike not initialized";
    case "telemetry_ready":
      return "Connected";
    case "control_ready":
      return "Connected";
    case "invalid_response":
      return "Invalid response";
    default:
      return "Unreachable";
  }
}

export function formatBikeBridgeControl(state: Pick<BikeBridgeViewState, "automaticControlEnabled" | "controlAvailable">): string {
  if (!state.automaticControlEnabled) return "Disabled";
  return state.controlAvailable ? "Ready" : "Unavailable";
}
