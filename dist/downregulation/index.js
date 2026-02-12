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
let container = null;
let canvas = null;
let running = false;
let hrDisplayIntervalId = null;
let resizeHandler = null;
function onBpmCallback(bpm) {
    if (running)
        setCurrentHR(bpm);
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
    // Start with play icon visible; workout begins only after user taps it
    showPlayIconForStart(containerEl, () => {
        startSession();
        bindTap(containerEl, () => {
            const stats = endSession();
            showStats(containerEl, stats, () => {
                onDismiss();
            });
        });
    });
}
/**
 * Stop the Downregulation view: stop loop, dispose renderer, clear HR subscription effect, unbind tap, reset HR controller.
 */
export function stopDownregulationView() {
    running = false;
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
