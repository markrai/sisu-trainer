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

let container: HTMLElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let running = false;
let simulateIntervalId: ReturnType<typeof setInterval> | null = null;
let hrDisplayIntervalId: ReturnType<typeof setInterval> | null = null;
let resizeHandler: (() => void) | null = null;

function onBpmCallback(bpm: number): void {
  if (running) setCurrentHR(bpm);
}

export interface DownregulationViewOptions {
  /** Called when user dismisses the session stats (Done). Use to exit view and e.g. return to workout list. */
  onDismiss?: () => void;
}

/**
 * Start the Downregulation view: show container/canvas, init WebGL, start render loop,
 * subscribe to live BPM (or simulate HR if no monitor connected), start session tracking, bind tap-to-stop.
 * Idempotent: if already running for this container, no-op.
 */
export function startDownregulationView(
  containerEl: HTMLElement,
  canvasEl: HTMLCanvasElement,
  options?: DownregulationViewOptions
): void {
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
  if (currentBpm != null && currentBpm > 0) setCurrentHR(currentBpm);

  const hasLiveHr = currentBpm != null && currentBpm > 0;
  if (!hasLiveHr) {
    const simStart = Date.now() / 1000;
    simulateIntervalId = setInterval(() => {
      if (!running) return;
      const t = Date.now() / 1000 - simStart;
      const simulated = 70 + 5 * Math.sin(t * 0.5);
      setCurrentHR(Math.round(simulated));
    }, 500);
  }

  resizeHandler = () => {
    if (canvas) resize(canvas);
  };
  window.addEventListener("resize", resizeHandler);

  const hrEl = containerEl.querySelector("#downregulationHrDisplay") as HTMLElement | null;
  if (hrEl) {
    const updateHrDisplay = () => {
      if (!running || !hrEl) return;
      const bpm = getSmoothedHR();
      hrEl.textContent = bpm != null ? `${Math.round(bpm)} bpm` : "—";
    };
    updateHrDisplay();
    hrDisplayIntervalId = setInterval(updateHrDisplay, 1000);
  }

  const onDismiss = options?.onDismiss ?? (() => {});
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
export function stopDownregulationView(): void {
  running = false;
  cancelSession();
  if (container) unbindTap(container);
  hideStats();
  if (simulateIntervalId != null) {
    clearInterval(simulateIntervalId);
    simulateIntervalId = null;
  }
  if (hrDisplayIntervalId != null) {
    clearInterval(hrDisplayIntervalId);
    hrDisplayIntervalId = null;
  }
  const hrEl = container?.querySelector("#downregulationHrDisplay") as HTMLElement | null;
  if (hrEl) hrEl.textContent = "";
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
