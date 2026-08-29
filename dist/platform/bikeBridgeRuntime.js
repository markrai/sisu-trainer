import { defaultBikeBridgeStorage, loadBikeBridgeSettings, parseBikeBridgeBaseUrl, saveBikeBridgeSettings, } from "./bikeBridgeConfig.js";
import { BIKE_BRIDGE_REQUEST_TIMEOUT_MS, createBikeBridgeClient, createDefaultBikeBridgeTransport, isBikeBridgeClientOk, isBikeBridgeUrlOk, toBridgeResistanceLevel, } from "./bikeBridgeClient.js";
export const BIKE_BRIDGE_POLL_INTERVAL_MS = 1000;
function classifyReadiness(configured, status, pollKind) {
    if (!configured)
        return "not_configured";
    if (pollKind === null)
        return "not_configured";
    if (pollKind === "malformed")
        return "invalid_response";
    if (!status)
        return "unreachable";
    if (!status.connected)
        return "reachable_disconnected";
    if (!status.initialized)
        return "reachable_not_initialized";
    if (status.resistanceControlAvailable)
        return "control_ready";
    return "telemetry_ready";
}
function formatMetric(value) {
    return value === undefined ? null : value;
}
export function createBikeBridgeSession(options = {}) {
    var _a, _b, _c, _d;
    const storage = (_a = options.storage) !== null && _a !== void 0 ? _a : defaultBikeBridgeStorage();
    const timeoutMs = (_b = options.requestTimeoutMs) !== null && _b !== void 0 ? _b : BIKE_BRIDGE_REQUEST_TIMEOUT_MS;
    const pollIntervalMs = (_c = options.pollIntervalMs) !== null && _c !== void 0 ? _c : BIKE_BRIDGE_POLL_INTERVAL_MS;
    const postedBodies = [];
    const baseTransport = (_d = options.transport) !== null && _d !== void 0 ? _d : createDefaultBikeBridgeTransport();
    const transport = {
        async request(request) {
            if (request.method === "POST" && request.jsonBody !== undefined) {
                postedBodies.push(JSON.stringify(request.jsonBody));
            }
            return baseTransport.request(request);
        },
    };
    const client = createBikeBridgeClient(() => loadBikeBridgeSettings(storage).baseUrl, transport, timeoutMs);
    let timer;
    let pollInFlight = false;
    let sendInFlight = false;
    let pendingLevel;
    let lastAccepted;
    let holdFailedLevel;
    let needsReconcile = false;
    let desiredResistance;
    let commandedResistance;
    let workoutActive = false;
    let paused = false;
    let lastStatus = null;
    let lastTelemetry = null;
    let telemetryStale = false;
    let lastError = null;
    let lastPollKind = null;
    let lastCommandOutcome = null;
    let previousControlAvailable = false;
    const listeners = new Set();
    function notify() {
        listeners.forEach((listener) => listener());
    }
    function settings() {
        return loadBikeBridgeSettings(storage);
    }
    function configured() {
        return parseBikeBridgeBaseUrl(settings().baseUrl).ok;
    }
    function controlAvailable() {
        return (lastStatus === null || lastStatus === void 0 ? void 0 : lastStatus.resistanceControlAvailable) === true;
    }
    function canCommand() {
        return (configured() &&
            settings().automaticControlEnabled &&
            workoutActive &&
            !paused &&
            controlAvailable());
    }
    function requestedForView() {
        var _a;
        if (lastStatus && lastStatus.resistance.requested !== null)
            return lastStatus.resistance.requested;
        if (lastCommandOutcome === "accepted" && lastAccepted !== undefined)
            return lastAccepted;
        return (_a = lastStatus === null || lastStatus === void 0 ? void 0 : lastStatus.resistance.requested) !== null && _a !== void 0 ? _a : null;
    }
    function viewState() {
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
            observedResistance: formatMetric(lastTelemetry === null || lastTelemetry === void 0 ? void 0 : lastTelemetry.resistance.value),
            rpm: formatMetric(lastTelemetry === null || lastTelemetry === void 0 ? void 0 : lastTelemetry.rpm.value),
            watts: formatMetric(lastTelemetry === null || lastTelemetry === void 0 ? void 0 : lastTelemetry.watts.value),
            telemetryStale,
            lastError,
            lastCommandOutcome,
        };
    }
    function scheduleSend(level, force = false) {
        const target = level === undefined ? undefined : toBridgeResistanceLevel(level);
        if (target === undefined || !canCommand())
            return;
        if (!force && lastAccepted === target)
            return;
        if (!force && holdFailedLevel === target)
            return;
        if (sendInFlight) {
            pendingLevel = target;
            return;
        }
        void sendTarget(target);
    }
    async function sendTarget(target) {
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
            }
            else if (result.kind === "timeout") {
                lastCommandOutcome = "timeout";
                lastError = "resistance command timed out";
                holdFailedLevel = target;
            }
            else if (result.status === 503 || result.kind === "unreachable") {
                lastCommandOutcome = "unavailable";
                lastError = result.message;
                holdFailedLevel = target;
            }
            else {
                lastCommandOutcome = "failed";
                lastError = result.message;
                holdFailedLevel = target;
            }
        }
        finally {
            sendInFlight = false;
            notify();
            if (pendingLevel !== undefined) {
                const next = pendingLevel;
                pendingLevel = undefined;
                scheduleSend(next, false);
            }
        }
    }
    async function tick() {
        if (pollInFlight)
            return;
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
            }
            else {
                lastPollKind = statusResult.kind === "not_configured" ? "not_configured" : statusResult.kind;
                lastStatus = null;
                lastError = statusResult.message;
            }
            const telemetryResult = await client.getTelemetry();
            if (isBikeBridgeClientOk(telemetryResult)) {
                lastTelemetry = telemetryResult.value;
                telemetryStale = false;
            }
            else if (lastTelemetry) {
                telemetryStale = true;
                if (!isBikeBridgeClientOk(statusResult))
                    lastError = telemetryResult.message;
            }
            else {
                telemetryStale = true;
                if (!isBikeBridgeClientOk(statusResult))
                    lastError = telemetryResult.message;
            }
            const available = controlAvailable();
            if (isBikeBridgeClientOk(statusResult) && available) {
                const recoveredFromLoss = previousKind === "unreachable" ||
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
        }
        finally {
            pollInFlight = false;
            notify();
        }
    }
    return {
        start() {
            if (timer !== undefined)
                return;
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
                    saveBikeBridgeSettings({
                        baseUrl: "",
                        automaticControlEnabled: partial.automaticControlEnabled !== undefined
                            ? partial.automaticControlEnabled
                            : current.automaticControlEnabled,
                    }, storage);
                    lastStatus = null;
                    lastTelemetry = null;
                    lastPollKind = "not_configured";
                    lastError = null;
                    notify();
                    return { ok: true };
                }
                const parsed = parseBikeBridgeBaseUrl(partial.baseUrl);
                if (!isBikeBridgeUrlOk(parsed))
                    return { ok: false, error: parsed.error };
                baseUrl = parsed.normalized;
            }
            const nextEnabled = partial.automaticControlEnabled !== undefined
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
            saveBikeBridgeSettings({
                baseUrl,
                automaticControlEnabled: nextEnabled,
            }, storage);
            if (enabledChanged && !nextEnabled)
                pendingLevel = undefined;
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
            }
            else if (needsReconcile) {
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
let appSession;
export function getBikeBridgeSession() {
    if (!appSession)
        appSession = createBikeBridgeSession();
    return appSession;
}
export function startBikeBridgeRuntime() {
    getBikeBridgeSession().start();
}
export function formatBikeBridgeNumber(value) {
    return value === null || value === undefined ? "-" : String(value);
}
export function formatBikeBridgeReadiness(readiness) {
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
export function formatBikeBridgeControl(state) {
    if (!state.automaticControlEnabled)
        return "Disabled";
    return state.controlAvailable ? "Ready" : "Unavailable";
}
