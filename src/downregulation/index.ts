/**
 * Downregulation view entry: start/stop WebGL particle view and wire HR input.
 * - On start: init renderer, start loop, subscribe to hrMonitor onBpm, or simulate HR if none.
 * - On stop: stop loop, dispose renderer, reset hrController; callback no-op when not running.
 */

import { onBpm, getCurrentBpm } from "../hrMonitor.js";
import { setCurrentHR, reset as resetHrController } from "./hrController.js";
import { initRenderer, startRenderLoop, stopRenderLoop, disposeRenderer, resize } from "./renderer.js";

let container: HTMLElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let running = false;
let simulateIntervalId: ReturnType<typeof setInterval> | null = null;
let resizeHandler: (() => void) | null = null;

function onBpmCallback(bpm: number): void {
  if (running) setCurrentHR(bpm);
}

/**
 * Start the Downregulation view: show container/canvas, init WebGL, start render loop,
 * subscribe to live BPM (or simulate HR if no monitor connected).
 * Idempotent: if already running for this container, no-op.
 */
export function startDownregulationView(containerEl: HTMLElement, canvasEl: HTMLCanvasElement): void {
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
  startRenderLoop(canvasEl);
}

/**
 * Stop the Downregulation view: stop loop, dispose renderer, clear HR subscription effect, reset HR controller.
 */
export function stopDownregulationView(): void {
  running = false;
  if (simulateIntervalId != null) {
    clearInterval(simulateIntervalId);
    simulateIntervalId = null;
  }
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
