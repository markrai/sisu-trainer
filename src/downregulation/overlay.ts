/**
 * Downregulation overlay: tap-to-stop, play icon (1s fade), and session stats panel.
 * Keeps UI and behavior in one place so the main index stays clean.
 */

import type { DownregulationSessionStats } from "./sessionStats.js";

const PLAY_ICON_DURATION_MS = 1000;
const FADE_DURATION_MS = 400;

let playIconWrap: HTMLElement | null = null;
let statsPanel: HTMLElement | null = null;
let statsContent: HTMLElement | null = null;
let doneButton: HTMLElement | null = null;
let tapHandler: ((e: MouseEvent | TouchEvent) => void) | null = null;
let onDismissCallback: (() => void) | null = null;
let startClickHandler: ((e: MouseEvent | TouchEvent) => void) | null = null;

function ensureElements(container: HTMLElement): void {
  if (playIconWrap) return;
  playIconWrap = container.querySelector("#downregulationPlayIconWrap") as HTMLElement | null;
  statsPanel = container.querySelector("#downregulationStatsPanel") as HTMLElement | null;
  statsContent = container.querySelector("#downregulationStatsContent") as HTMLElement | null;
  doneButton = container.querySelector("#downregulationStatsDone") as HTMLElement | null;
  if (!playIconWrap) {
    playIconWrap = document.createElement("div");
    playIconWrap.id = "downregulationPlayIconWrap";
    playIconWrap.className = "downregulation-play-wrap";
    playIconWrap.setAttribute("aria-hidden", "true");
    playIconWrap.innerHTML = '<span class="downregulation-play-icon" aria-hidden="true"></span>';
    container.appendChild(playIconWrap);
  }
  if (!statsPanel) {
    statsPanel = document.createElement("div");
    statsPanel.id = "downregulationStatsPanel";
    statsPanel.className = "downregulation-stats-panel";
    statsPanel.setAttribute("aria-live", "polite");
    statsPanel.innerHTML = `
      <h3 class="downregulation-stats-title">Session summary</h3>
      <div id="downregulationStatsContent" class="downregulation-stats-content"></div>
      <button type="button" id="downregulationStatsDone" class="button downregulation-stats-done">Done</button>
    `;
    statsContent = statsPanel.querySelector("#downregulationStatsContent");
    doneButton = statsPanel.querySelector("#downregulationStatsDone");
    container.appendChild(statsPanel);
  } else {
    statsContent = statsPanel.querySelector("#downregulationStatsContent");
    doneButton = statsPanel.querySelector("#downregulationStatsDone");
  }
}

/**
 * Show the play icon as "tap to start" — stays visible until the user taps it. On tap, hides the icon and calls onTapToStart (workout begins).
 */
export function showPlayIconForStart(container: HTMLElement, onTapToStart: () => void): void {
  ensureElements(container);
  if (!playIconWrap) return;
  playIconWrap.classList.remove("downregulation-play-wrap--fade");
  playIconWrap.classList.add("downregulation-play-wrap--clickable");
  playIconWrap.style.display = "flex";
  playIconWrap.style.opacity = "1";
  playIconWrap.style.visibility = "visible";
  const handler = (e: MouseEvent | TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    playIconWrap?.classList.remove("downregulation-play-wrap--clickable");
    playIconWrap?.removeEventListener("click", handler);
    playIconWrap?.removeEventListener("touchend", handler);
    startClickHandler = null;
    hidePlayIcon();
    onTapToStart();
  };
  startClickHandler = handler;
  playIconWrap.addEventListener("click", handler);
  playIconWrap.addEventListener("touchend", handler, { passive: false });
}

/**
 * Hide the play icon (e.g. after user tapped to start the workout).
 */
export function hidePlayIcon(): void {
  if (playIconWrap) {
    playIconWrap.style.display = "none";
    playIconWrap.classList.remove("downregulation-play-wrap--clickable", "downregulation-play-wrap--fade");
  }
}

/**
 * Show the white play icon in the center for 1s, then fade out. Calls onComplete when done.
 */
export function showPlayIcon(container: HTMLElement, onComplete: () => void): void {
  ensureElements(container);
  if (!playIconWrap) {
    onComplete();
    return;
  }
  playIconWrap.style.display = "flex";
  playIconWrap.style.opacity = "1";
  playIconWrap.classList.remove("downregulation-play-wrap--fade");
  const fadeStart = PLAY_ICON_DURATION_MS - FADE_DURATION_MS;
  const fadeTimer = window.setTimeout(() => {
    playIconWrap?.classList.add("downregulation-play-wrap--fade");
  }, fadeStart);
  const endTimer = window.setTimeout(() => {
    window.clearTimeout(fadeTimer);
    if (playIconWrap) {
      playIconWrap.style.display = "none";
      playIconWrap.classList.remove("downregulation-play-wrap--fade");
    }
    onComplete();
  }, PLAY_ICON_DURATION_MS);
}

/**
 * Show the stats panel with the given stats. Done button calls onDismiss.
 */
export function showStats(container: HTMLElement, stats: DownregulationSessionStats, onDismiss: () => void): void {
  ensureElements(container);
  onDismissCallback = onDismiss;
  if (statsContent) {
    statsContent.innerHTML = stats.summaryLines.map((line) => `<p class="downregulation-stats-line">${escapeHtml(line)}</p>`).join("");
  }
  if (statsPanel) {
    statsPanel.style.display = "block";
    statsPanel.setAttribute("aria-hidden", "false");
  }
  if (doneButton && !(doneButton as any).__downregDoneBound) {
    (doneButton as any).__downregDoneBound = true;
    let dismissScheduled = false;
    const runDismiss = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (dismissScheduled) return;
      dismissScheduled = true;
      const cb = onDismissCallback;
      onDismissCallback = null;
      hideStats();
      if (cb) {
        requestAnimationFrame(() => {
          cb();
          dismissScheduled = false;
        });
      } else {
        dismissScheduled = false;
      }
    };
    doneButton.addEventListener("click", runDismiss);
    doneButton.addEventListener("touchend", runDismiss, { passive: false });
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

/**
 * Hide the stats panel (e.g. when leaving the view).
 */
export function hideStats(): void {
  if (statsPanel) {
    statsPanel.style.display = "none";
    statsPanel.setAttribute("aria-hidden", "true");
  }
  if (statsContent) statsContent.innerHTML = "";
  onDismissCallback = null;
}

/**
 * Bind tap/click on the container. When fired: calls onTap(). Use onTap to end session, show play icon, then show stats and pass onDismiss.
 * Ignores taps on the stats panel (e.g. Done button) or play icon so they don't re-trigger the session-end flow.
 */
export function bindTap(container: HTMLElement, onTap: () => void): void {
  unbindTap(container);
  const handler = (e: MouseEvent | TouchEvent) => {
    const target = e.target as Node;
    if (statsPanel?.contains(target) || playIconWrap?.contains(target)) return;
    e.preventDefault();
    onTap();
  };
  tapHandler = handler;
  container.addEventListener("click", handler, { passive: false });
  container.addEventListener("touchend", handler, { passive: false });
}

/**
 * Unbind tap handler and hide overlays.
 */
export function unbindTap(container: HTMLElement): void {
  if (tapHandler) {
    container.removeEventListener("click", tapHandler);
    container.removeEventListener("touchend", tapHandler);
    tapHandler = null;
  }
  if (startClickHandler && playIconWrap) {
    playIconWrap.removeEventListener("click", startClickHandler);
    playIconWrap.removeEventListener("touchend", startClickHandler);
    startClickHandler = null;
  }
  hideStats();
  hidePlayIcon();
}
