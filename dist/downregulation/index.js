/**
 * Downregulation view entry: start/stop WebGL particle view and wire HR input.
 * - On start: init renderer, start loop, subscribe to hrMonitor onBpm, start session tracking, bind tap-to-stop.
 * - On tap: end session, show play icon (1s fade), then show stats; on Done call onDismiss (e.g. exit to list).
 * - On stop: stop loop, dispose renderer, reset hrController, unbind tap.
 */
import { onBpm, getCurrentBpm } from "../hrMonitor.js";
import { setCurrentHR, reset as resetHrController, getSmoothedHR } from "./hrController.js";
import { initRenderer, startRenderLoop, stopRenderLoop, disposeRenderer, resize } from "./renderer.js";
import { startSession, endSession, cancelSession } from "./sessionStats.js";
import { showPlayIconForStart, showStats, hideStats, bindTap, unbindTap } from "./overlay.js";
import { generateUUID, emitWorkoutSummary } from "../workoutSummary.js";
import { startSession as startStorageSession, markSummaryEmitted } from "../sessionStore.js";
import { storeHrSample } from "../workoutStorage.js";
import { generateDownregulationSummary } from "./workoutSummary.js";
let container = null;
let canvas = null;
let running = false;
let hrDisplayIntervalId = null;
let resizeHandler = null;
/** Set when user taps play to start; cleared when session ends or view stops. Used for HR sample storage and summary generation. */
let downregulationSessionId = null;
let downregulationSessionStartTime = null;
function onBpmCallback(bpm) {
    if (running)
        setCurrentHR(bpm);
    if (running && downregulationSessionId != null && downregulationSessionStartTime != null) {
        const elapsedSec = Math.floor((Date.now() - downregulationSessionStartTime) / 1000);
        storeHrSample(downregulationSessionId, elapsedSec, bpm).catch((err) => console.error("[Downregulation] Error storing HR sample:", err));
    }
}
/**
 * Start the Downregulation view: show container/canvas, init WebGL, start render loop,
 * subscribe to live BPM (or simulate HR if no monitor connected), start session tracking, bind tap-to-stop.
 * Idempotent: if already running for this container, no-op.
 */
export function startDownregulationView(containerEl, canvasEl, options) {
    var _a;
    console.log("[Downregulation] startDownregulationView called");
    if (running && container === containerEl) {
        console.log("[Downregulation] Already running, skipping");
        return;
    }
    container = containerEl;
    canvas = canvasEl;
    running = true;
    resetHrController();
    console.log("[Downregulation] Initializing WebGL2 renderer...");
    if (!initRenderer(canvasEl)) {
        console.error("[Downregulation] Failed to initialize renderer");
        running = false;
        return;
    }
    console.log("[Downregulation] Renderer initialized successfully");
    onBpm(onBpmCallback);
    const currentBpm = getCurrentBpm();
    if (currentBpm != null && currentBpm > 0)
        setCurrentHR(currentBpm);
    // No simulated HR: only use real strap data. Without a strap, display shows "—" and coherence stays low.
    resizeHandler = () => {
        if (canvas)
            resize(canvas);
    };
    window.addEventListener("resize", resizeHandler);
    const hrEl = containerEl.querySelector("#downregulationHrDisplay");
    if (hrEl) {
        const updateHrDisplay = () => {
            if (!running || !hrEl)
                return;
            // Only show HR if there's actually a live monitor connected
            const liveBpm = getCurrentBpm();
            if (liveBpm == null || liveBpm <= 0) {
                hrEl.textContent = "—";
                return;
            }
            const bpm = getSmoothedHR();
            hrEl.textContent = bpm != null ? `${Math.round(bpm)} bpm` : "—";
        };
        updateHrDisplay();
        hrDisplayIntervalId = setInterval(updateHrDisplay, 1000);
    }
    const onDismiss = (_a = options === null || options === void 0 ? void 0 : options.onDismiss) !== null && _a !== void 0 ? _a : (() => { });
    startRenderLoop(canvasEl);
    /** Start a new session and bind tap-to-end; when user taps Done on the summary, we show play again. */
    function startSessionAndBindTap() {
        const sessionId = generateUUID();
        startStorageSession("Downregulation", Date.now(), sessionId);
        downregulationSessionId = sessionId;
        downregulationSessionStartTime = Date.now();
        startSession();
        bindTap(containerEl, async () => {
            const stats = endSession();
            const sid = downregulationSessionId;
            const start = downregulationSessionStartTime;
            downregulationSessionId = null;
            downregulationSessionStartTime = null;
            if (sid != null && start != null) {
                try {
                    const summary = await generateDownregulationSummary(sid, start, Date.now(), stats);
                    await emitWorkoutSummary(summary);
                    markSummaryEmitted("Downregulation");
                }
                catch (err) {
                    console.error("[Downregulation] Failed to save workout summary:", err);
                }
            }
            showStats(containerEl, stats, () => {
                showPlayIconForStart(containerEl, startSessionAndBindTap);
            });
        });
    }
    showPlayIconForStart(containerEl, startSessionAndBindTap);
}
/**
 * Stop the Downregulation view: stop loop, dispose renderer, clear HR subscription effect, unbind tap, reset HR controller.
 */
export function stopDownregulationView() {
    running = false;
    downregulationSessionId = null;
    downregulationSessionStartTime = null;
    cancelSession();
    if (container)
        unbindTap(container);
    hideStats();
    if (hrDisplayIntervalId != null) {
        clearInterval(hrDisplayIntervalId);
        hrDisplayIntervalId = null;
    }
    const hrEl = container === null || container === void 0 ? void 0 : container.querySelector("#downregulationHrDisplay");
    if (hrEl)
        hrEl.textContent = "";
    if (resizeHandler) {
        window.removeEventListener("resize", resizeHandler);
        resizeHandler = null;
    }
    stopRenderLoop();
    disposeRenderer();
    resetHrController();
    container = null;
    canvas = null;
}
