
import {
  adjustedBlockLengths,
  formatTime,
  getPhase,
  getPausedElapsed,
  getStartTime,
  isPaused,
  pauseWorkout,
  restartWorkout,
  resumeWorkout,
  startWorkout,
  todayName,
  hrTargetText,
  updateRing,
} from "./workoutLogic.js";
import { getPlan, getWorkoutMetadata } from "./workoutData.js";
import { getAllWorkoutSummaries, deleteWorkoutSummary } from "./workoutStorage.js";
import { sendWorkoutToSisu } from "./sisuSync.js";
import { getSession, clearSession, markSummaryEmitted } from "./sessionStore.js";

let selectedDay: string | null = null;
let liveBpm: number | null = null;
let lastBpmUpdateTime: number | null = null;
const BPM_TIMEOUT_MS = 3000;
let showElapsedInRing = false;

let heartPulseTargetBpm: number | null = null;
let heartPulseRafId: number | null = null;
const HEART_PULSE_SCALE = 1.15;

function heartPulseLoop() {
  heartPulseRafId = null;
  const heartIcon = document.getElementById("heartIcon");
  if (!heartIcon || heartPulseTargetBpm === null) {
    if (heartIcon) heartIcon.style.setProperty("transform", "scale(1)", "important");
    return;
  }
  const durationSec = 60 / heartPulseTargetBpm;
  const phase = ((Date.now() / 1000) % durationSec) / durationSec;
  const scale = 1 + (HEART_PULSE_SCALE - 1) * Math.sin(phase * Math.PI);
  heartIcon.style.setProperty("transform", `scale(${scale})`, "important");
  heartPulseRafId = requestAnimationFrame(heartPulseLoop);
}

function getShowElapsed() {
  return showElapsedInRing;
}

(window as any).liveBpm = liveBpm;
(window as any).lastBpmUpdateTime = lastBpmUpdateTime;

let phaseDisplayEl: HTMLElement | null = null;
let settingsModalEscHandler: ((e: KeyboardEvent) => void) | null = null;
function getSelectedDay() {
  return selectedDay || todayName();
}

function setSelectedDay(day: string) {
  selectedDay = day;
}

function ensureWorkoutDayDropdown() {
  const select = document.getElementById("workoutDaySelect") as HTMLSelectElement | null;
  if (!select) return;
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const plan = typeof getPlan === "function" ? getPlan() : {};
  const metadata = typeof getWorkoutMetadata === "function" ? getWorkoutMetadata() : {};
  if (select.options.length === 0) {
    days.forEach((day) => {
      const opt = document.createElement("option");
      opt.value = day;
      const meta = (metadata as any)[day];
      opt.textContent = meta && meta.type ? day + ": " + meta.type : day;
      select.appendChild(opt);
    });
    select.addEventListener("change", function () {
      selectedDay = this.value;
      updateDisplay();
    });
  }
  const current = getSelectedDay();
  if (select.value !== current) select.value = current;
}

function connectHr() {
  if (typeof (window as any).initiateHrConnection === "function") {
    (window as any).initiateHrConnection();
  }
}

function updateHrMonitorLabel() {
  const labelEl = document.getElementById("hrMonitorLabel");
  const batteryEl = document.getElementById("hrMonitorBattery");
  const name = (window as any).hrDeviceName as string | null | undefined;
  const battery = (window as any).hrBatteryPercent as number | null | undefined;
  if (labelEl) {
    if (name) {
      labelEl.textContent = name + " connected";
      labelEl.style.color = "#22c55e";
      labelEl.style.opacity = "1";
    } else {
      labelEl.textContent = "Heart Rate Monitor";
      labelEl.style.color = "";
      labelEl.style.opacity = "0.7";
    }
  }
  if (batteryEl) {
    if (typeof battery === "number" && battery >= 0 && battery <= 100) {
      batteryEl.classList.add("battery-pill");
      (batteryEl as HTMLElement).style.setProperty("--battery-pct", String(battery));
      const state = battery <= 15 ? "low" : battery <= 35 ? "med" : "good";
      batteryEl.setAttribute("data-battery-state", state);
      batteryEl.style.display = "";
      // Ensure a single child span for percentage so pill order is: dot, bar, text
      let pctSpan = batteryEl.querySelector(".battery-pill-pct");
      if (!pctSpan) {
        pctSpan = document.createElement("span");
        pctSpan.className = "battery-pill-pct";
        batteryEl.appendChild(pctSpan);
      }
      pctSpan.textContent = battery + "%";
    } else {
      batteryEl.textContent = "";
      batteryEl.style.display = "none";
      batteryEl.classList.remove("battery-pill");
      batteryEl.removeAttribute("data-battery-state");
      (batteryEl as HTMLElement).style.removeProperty("--battery-pct");
    }
  }
}

function updateHrDisplay(hr: number | null) {
  const hrNowEl = document.getElementById("hrNow");
  if (hrNowEl) {
    if (hr && hr > 0) {
      hrNowEl.textContent = hr.toString();
    } else {
      hrNowEl.textContent = "";
    }
  }
}
const PHASE_STYLE_MAP: Record<string, { stroke: string; background: string; text: string }> = {
  "Warm-Up": { stroke: "#ffad5c", background: "rgba(255,173,92,0.18)", text: "#ffe9cc" },
  Sustain: { stroke: "#3d7cff", background: "rgba(61,124,255,0.18)", text: "#dbe5ff" },
  "Cool-Down": { stroke: "#eab308", background: "rgba(234,179,8,0.18)", text: "#fef9c3" },
  Rest: { stroke: "#888", background: "#1c1c1c", text: "#fff" },
  idle: { stroke: "#3d7cff", background: "#232323", text: "#fff" },
  completed: { stroke: "#fff", background: "rgba(255,255,255,0.2)", text: "#fff" },
};
const COMPLETED_LIGHT_MODE = { stroke: "#000", background: "rgba(0,0,0,0.08)", text: "#000" };
const DEFAULT_PHASE_STYLE = { stroke: "#3d7cff", background: "#232323", text: "#fff" };

function getPhaseStyle(key: string): { stroke: string; background: string; text: string } {
  const base = PHASE_STYLE_MAP[key] || DEFAULT_PHASE_STYLE;
  if (key === "completed" || key === "Completed") {
    const light = window.matchMedia("(prefers-color-scheme: light)").matches;
    return light ? COMPLETED_LIGHT_MODE : base;
  }
  return base;
}

function applyPhaseStyle(key: string) {
  const style = getPhaseStyle(key);
  const ringEl = document.getElementById("ringProgress");
  if (ringEl instanceof SVGCircleElement) {
    ringEl.style.stroke = style.stroke;
  }
  if (phaseDisplayEl) {
    phaseDisplayEl.style.background = style.background;
    phaseDisplayEl.style.color = style.text;
  }
}

function openModal() {
  const bg = document.getElementById("modalBg");
  if (bg) bg.style.display = "flex";
  settingsModalEscHandler = (e) => {
    if (e.key === "Escape" || e.keyCode === 27) closeModal();
  };
  document.addEventListener("keydown", settingsModalEscHandler);
}

function closeModal() {
  const bg = document.getElementById("modalBg");
  if (bg) bg.style.display = "none";
  if (settingsModalEscHandler) {
    document.removeEventListener("keydown", settingsModalEscHandler);
    settingsModalEscHandler = null;
  }
}

function openCancelModal() {
  const bg = document.getElementById("cancelModalBg");
  if (bg) bg.style.display = "flex";
}

function closeCancelModal() {
  const bg = document.getElementById("cancelModalBg");
  if (bg) bg.style.display = "none";
}

function confirmCancelWorkout() {
  restartWorkout();
  closeCancelModal();
}

function promptCancelWorkout() {
  if (!phaseDisplayEl) return;
  if (phaseDisplayEl.dataset.phaseState === "active") openCancelModal();
}
function parseHrTargetRange(hrTargetText: string) {
  if (!hrTargetText || hrTargetText === "") return null;
  const greaterThanCapMatch = hrTargetText.match(/≥(\d+)\s*\(cap\s*(\d+)\)/);
  if (greaterThanCapMatch) return { min: parseInt(greaterThanCapMatch[1]), max: parseInt(greaterThanCapMatch[2]) };
  const greaterThanMatch = hrTargetText.match(/≥(\d+)/);
  if (greaterThanMatch) {
    const value = parseInt(greaterThanMatch[1]);
    return { min: value, max: 200 };
  }
  const rangeMatch = hrTargetText.match(/(\d+)[–-](\d+)/);
  if (rangeMatch) return { min: parseInt(rangeMatch[1]), max: parseInt(rangeMatch[2]) };
  const lessThanMatch = hrTargetText.match(/<(\d+)/);
  if (lessThanMatch) {
    const value = parseInt(lessThanMatch[1]);
    return { min: 0, max: value - 1 };
  }
  const singleMatch = hrTargetText.match(/(\d+)/);
  if (singleMatch) {
    const value = parseInt(singleMatch[1]);
    return { min: value - 5, max: value + 5 };
  }
  return null;
}

function updateHeartColor(liveBpm: number | null, hrTargetText: string | null) {
  const heartIcon = document.getElementById("heartIcon");
  const hrNowEl = document.getElementById("hrNow");
  if (!heartIcon) return;
  const setHeartWhite = () => {
    heartIcon.style.setProperty("filter", "brightness(0) invert(1)", "important");
    if (hrNowEl) hrNowEl.style.setProperty("color", "black", "important");
  };
  const setHeartColored = (filter: string) => {
    heartIcon.style.setProperty("filter", filter, "important");
    if (hrNowEl) hrNowEl.style.setProperty("color", "white", "important");
  };
  if (!liveBpm || liveBpm <= 0) {
    setHeartWhite();
    return;
  }
  if (!hrTargetText || hrTargetText === "") {
    setHeartWhite();
    return;
  }
  const range = parseHrTargetRange(hrTargetText);
  if (!range) {
    setHeartWhite();
    return;
  }
  let hueRotate = 0;
  if (liveBpm > range.max) hueRotate = 270;
  else if (liveBpm < range.min) hueRotate = 240;
  setHeartColored(
    `brightness(0) saturate(100%) invert(27%) sepia(100%) saturate(10000%) hue-rotate(${hueRotate}deg)`
  );
}

function updateHeartPulse(bpmValue?: number | null) {
  const heartIcon = document.getElementById("heartIcon");
  if (!heartIcon) return;
  const currentLiveBpm = (window as any).liveBpm;
  const currentLastUpdate = (window as any).lastBpmUpdateTime;
  const now = Date.now();
  if (currentLastUpdate && now - currentLastUpdate > BPM_TIMEOUT_MS) {
    heartPulseTargetBpm = null;
    if (heartPulseRafId !== null) cancelAnimationFrame(heartPulseRafId);
    heartPulseRafId = null;
    heartIcon.style.setProperty("transform", "scale(1)", "important");
    (window as any).liveBpm = null;
    updateHrDisplay(null);
    const hrTargetEl = document.getElementById("hrTarget");
    updateHeartColor(null, hrTargetEl ? hrTargetEl.textContent : "");
    return;
  }
  const bpm = bpmValue !== undefined && bpmValue !== null ? bpmValue : currentLiveBpm;
  if (bpm && bpm > 0) {
    heartPulseTargetBpm = bpm;
    if (heartPulseRafId === null) heartPulseRafId = requestAnimationFrame(heartPulseLoop);
    const hrTargetEl = document.getElementById("hrTarget");
    if (hrTargetEl) updateHeartColor(bpm, hrTargetEl.textContent);
  } else {
    heartPulseTargetBpm = null;
    if (heartPulseRafId !== null) cancelAnimationFrame(heartPulseRafId);
    heartPulseRafId = null;
    heartIcon.style.setProperty("transform", "scale(1)", "important");
    const hrTargetEl = document.getElementById("hrTarget");
    updateHeartColor(null, hrTargetEl ? hrTargetEl.textContent : "");
  }
}
function getWarmupSubsectionName(day: string, elapsedSec: number) {
  const hrTargets = typeof (window as any).getHrTargets === "function" ? (window as any).getHrTargets() : {};
  const dayHrTargets = hrTargets[day];
  if (!dayHrTargets || !dayHrTargets.warmup_subsections) return null;
  for (const subsection of dayHrTargets.warmup_subsections) {
    const startSec = subsection.start_min * 60;
    const endSec = subsection.end_min * 60;
    if (elapsedSec >= startSec && elapsedSec < endSec) return subsection.name;
  }
  return null;
}

function getCurrentIntervalName(day: string, elapsedSec: number, blocks: { warm: number }) {
  const hrTargets = typeof (window as any).getHrTargets === "function" ? (window as any).getHrTargets() : {};
  const dayHrTargets = hrTargets[day];
  if (!dayHrTargets || !dayHrTargets.intervals || !dayHrTargets.intervals.phases) return null;
  const warmSec = blocks.warm * 60;
  const sustainElapsed = Math.max(0, elapsedSec - warmSec);
  const phases = dayHrTargets.intervals.phases;
  const isSequence = dayHrTargets.intervals.isSequence;
  let elapsedInPhases = sustainElapsed;
  if (isSequence) {
    const totalDuration = phases.reduce((sum: number, p: any) => sum + p.duration * 60, 0);
    elapsedInPhases = Math.min(sustainElapsed, totalDuration);
  } else {
    const cycleDuration = phases.reduce((sum: number, p: any) => sum + p.duration * 60, 0);
    elapsedInPhases = sustainElapsed % cycleDuration;
  }
  let accumulated = 0;
  for (let i = 0; i < phases.length; i++) {
    const phaseDuration = phases[i].duration * 60;
    if (elapsedInPhases < accumulated + phaseDuration) return phases[i].phase;
    accumulated += phaseDuration;
  }
  return null;
}
function updateDisplay() {
  try {
    if (typeof getPlan !== "function" || typeof getWorkoutMetadata !== "function") return;
    const day = getSelectedDay();
    const plan = getPlan();
    const workoutMetadata = getWorkoutMetadata();
    const base = (plan as any)[day];
    ensureWorkoutDayDropdown();

    const activityIcon = document.getElementById("activityIcon") as HTMLImageElement | null;
    if (activityIcon && base && workoutMetadata[day]) {
      const machine = workoutMetadata[day].machine || "";
      let iconSrc = "";
      const machineLower = machine.toLowerCase();
      if (machineLower.includes("combo") || machineLower.includes("strength")) iconSrc = "dumbbell.png";
      else if (machineLower.includes("bike")) iconSrc = "bike.png";
      else if (machineLower.includes("elliptical")) iconSrc = "elliptical.png";
      if (iconSrc) {
        activityIcon.src = iconSrc;
        activityIcon.style.display = "block";
      } else {
        activityIcon.style.display = "none";
      }
    } else if (activityIcon) {
      activityIcon.style.display = "none";
    }

    const hrTargetEl = document.getElementById("hrTarget");
    const workoutBlocksEl = document.getElementById("workoutBlocks");
    const startBtnEl = document.getElementById("startButton") as HTMLButtonElement | null;
    const cancelBtnEl = document.getElementById("cancelWorkoutButton") as HTMLButtonElement | null;
    const startButtonRowEl = document.getElementById("startButtonRow") as HTMLElement | null;

    if (!base) {
      if (workoutBlocksEl) workoutBlocksEl.textContent = "Rest Day";
      if (phaseDisplayEl) {
        phaseDisplayEl.innerHTML = '<span class="phase-name">Rest Day</span>';
        phaseDisplayEl.dataset.phaseState = "rest";
      }
      if (activityIcon) activityIcon.style.display = "none";
      if (startButtonRowEl) startButtonRowEl.style.display = "none";
      if (cancelBtnEl) cancelBtnEl.style.display = "none";
      updateRing(0, { warm: 1, sustain: 1, cool: 1 } as any);
      if (hrTargetEl) hrTargetEl.textContent = "";
      updateHeartPulse(null);
      updateHeartColor(null, "");
      applyPhaseStyle("Rest");
      return;
    }

    const blocks = adjustedBlockLengths(base as any, null);
    if (workoutBlocksEl)
      workoutBlocksEl.textContent =
        "Warm-Up: " + blocks.warm + " min · Workout: " + blocks.sustain + " min · Cool-Down: " + blocks.cool + " min";

    const start = getStartTime(day);
    let elapsedSec = 0;
    if (!start) {
      if (phaseDisplayEl) {
        phaseDisplayEl.innerHTML = '<span class="phase-name">Not Started</span>';
        phaseDisplayEl.dataset.phaseState = "idle";
      }
      if (typeof (window as any).resetVoiceState === "function") (window as any).resetVoiceState();
      if (startButtonRowEl) startButtonRowEl.style.display = "flex";
      if (startBtnEl) {
        startBtnEl.innerText = "Start Workout";
        startBtnEl.onclick = startWorkout;
        startBtnEl.style.display = "block";
      }
      if (cancelBtnEl) cancelBtnEl.style.display = "none";
      updateRing(0, blocks as any);
      if (hrTargetEl) hrTargetEl.textContent = "";
      updateHeartPulse(null);
      updateHeartColor(null, "");
      applyPhaseStyle("idle");
      return;
    }
    const paused = typeof isPaused === "function" && isPaused(day);
    if (paused) {
      elapsedSec = typeof getPausedElapsed === "function" ? getPausedElapsed(day) : 0;
    } else {
      elapsedSec = Math.floor((Date.now() - parseInt(start)) / 1000);
    }
    const phase = getPhase(elapsedSec, blocks as any);
    updateRing(elapsedSec, blocks as any);

    if (phase.done) {
      if (typeof (window as any).releaseWakeLock === "function") (window as any).releaseWakeLock();
      const session = getSession(day);
      if (session.summaryEmitted === "false" && typeof (window as any).generateWorkoutSummary === "function") {
        const sessionId = session.sessionId;
        const sessionStart = session.sessionStart;
        if (sessionId && sessionStart) {
          const sessionStartTime = parseInt(sessionStart);
          const sessionAge = Date.now() - sessionStartTime;
          const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
          if (sessionAge > MAX_SESSION_AGE_MS) {
            console.warn(`Skipping stale workout session for ${day} on completion (age: ${Math.round(sessionAge / (1000 * 60 * 60))} hours)`);
            clearSession(day);
          } else {
            const endedAt = Date.now();
            (window as any)
              .generateWorkoutSummary(sessionId, sessionStartTime, endedAt, day)
              .then((summary: any) => (window as any).emitWorkoutSummary(summary))
              .then(() => {
                markSummaryEmitted(day);
              })
              .catch((error: any) => {
                console.error("Error emitting workout summary on completion:", error);
                if (error.message && error.message.includes("exceeds maximum")) {
                  console.warn("Stale session detected on completion, cleaning up...");
                  clearSession(day);
                }
              });
          }
        }
      }
      if (phaseDisplayEl) {
        phaseDisplayEl.innerHTML = '<span class="phase-name">Completed</span>';
        phaseDisplayEl.dataset.phaseState = "completed";
      }
      if (typeof (window as any).announcePhaseIfChanged === "function") (window as any).announcePhaseIfChanged("Completed");
      if (startButtonRowEl) startButtonRowEl.style.display = "flex";
      if (startBtnEl) {
        startBtnEl.innerText = "Restart Workout";
        startBtnEl.onclick = restartWorkout;
        startBtnEl.style.display = "block";
      }
      if (cancelBtnEl) cancelBtnEl.style.display = "none";
      if (hrTargetEl) hrTargetEl.textContent = "";
      updateHeartPulse(null);
      updateHeartColor(null, "");
      applyPhaseStyle("completed");
      return;
    }

    if (startButtonRowEl) startButtonRowEl.style.display = "flex";
    if (startBtnEl) {
      if (paused) {
        startBtnEl.innerText = "Resume";
        startBtnEl.onclick = function () {
          resumeWorkout(day);
          if (typeof (window as any).requestWakeLock === "function") (window as any).requestWakeLock();
          updateDisplay();
        };
        startBtnEl.style.display = "block";
      } else {
        startBtnEl.innerText = "Pause";
        startBtnEl.onclick = function () {
          pauseWorkout(day, elapsedSec);
          if (typeof (window as any).releaseWakeLock === "function") (window as any).releaseWakeLock();
          updateDisplay();
        };
        startBtnEl.style.display = "block";
      }
    }
    if (cancelBtnEl) cancelBtnEl.style.display = paused ? "block" : "none";

    let phaseDisplayName = phase.phase;
    if (phase.phase === "Warm-Up") {
      const subsectionName = getWarmupSubsectionName(day, elapsedSec);
      if (subsectionName) phaseDisplayName = "Warm-Up (" + subsectionName + ")";
    } else if (phase.phase === "Sustain") {
      phaseDisplayName = "Workout";
      const intervalName = getCurrentIntervalName(day, elapsedSec, blocks as any);
      if (intervalName) phaseDisplayName = intervalName;
    }

    if (phaseDisplayEl) {
      phaseDisplayEl.innerHTML =
        '<span class="phase-name">' + phaseDisplayName + '</span><span class="phase-time">' + formatTime(phase.timeLeft) + "</span>";
      phaseDisplayEl.dataset.phaseState = "active";
    }
    if (typeof (window as any).announcePhaseIfChanged === "function") (window as any).announcePhaseIfChanged(phaseDisplayName);

    const hrTargetTextValue = hrTargetText(phase.phase, day, elapsedSec, blocks as any);
    if (hrTargetEl) hrTargetEl.textContent = hrTargetTextValue;
    updateHeartPulse();
    const currentLiveBpm = (window as any).liveBpm;
    const currentLastUpdate = (window as any).lastBpmUpdateTime;
    const nowTime = Date.now();
    if (currentLastUpdate && nowTime - currentLastUpdate > BPM_TIMEOUT_MS) {
      updateHrDisplay(null);
      (window as any).liveBpm = null;
    }
    if (currentLiveBpm && currentLiveBpm > 0) updateHeartColor(currentLiveBpm, hrTargetTextValue);
    else updateHeartColor(null, hrTargetTextValue);
    applyPhaseStyle(phase.phase);
  } catch (e: any) {
    if (e instanceof TypeError && e.message && e.message.includes("null")) {
      console.warn("updateDisplay: DOM element missing", e.message);
    } else {
      throw e;
    }
  }
}
function switchTab(tabName: string) {
  const tabs = ["personal", "preferences", "workouts", "sisu", "install"];
  tabs.forEach((name) => {
    const tabEl = document.getElementById(name + "Tab");
    if (tabEl) tabEl.classList.remove("active");
  });
  const buttons = document.querySelectorAll(".tab-button");
  buttons.forEach((btn) => btn.classList.remove("active"));
  const tabIndex: Record<string, number> = { personal: 0, preferences: 1, workouts: 2, sisu: 3, install: 4 };
  if (tabName === "personal") {
    document.getElementById("personalTab")?.classList.add("active");
    (buttons[tabIndex.personal] as HTMLElement | undefined)?.classList.add("active");
  } else if (tabName === "preferences") {
    document.getElementById("preferencesTab")?.classList.add("active");
    (buttons[tabIndex.preferences] as HTMLElement | undefined)?.classList.add("active");
    loadPreferences();
  } else if (tabName === "workouts") {
    document.getElementById("workoutsTab")?.classList.add("active");
    (buttons[tabIndex.workouts] as HTMLElement | undefined)?.classList.add("active");
    loadWorkoutSummaries();
  } else if (tabName === "sisu") {
    document.getElementById("sisuTab")?.classList.add("active");
    (buttons[tabIndex.sisu] as HTMLElement | undefined)?.classList.add("active");
    if (typeof (window as any).loadSisuSettings === "function") (window as any).loadSisuSettings();
    updateHrMonitorLabel();
  } else if (tabName === "install") {
    document.getElementById("installTab")?.classList.add("active");
    (buttons[tabIndex.install] as HTMLElement | undefined)?.classList.add("active");
    if (typeof (window as any).refreshInstallTabContent === "function") (window as any).refreshInstallTabContent();
  }
}

function getShowSecondsCountdown() {
  return localStorage.getItem("showSecondsCountdown") === "true";
}

function getVoicePromptsEnabled() {
  return localStorage.getItem("voicePromptsEnabled") !== "false";
}

function loadPreferences() {
  const cb = document.getElementById("showSecondsCountdown") as HTMLInputElement | null;
  if (cb) cb.checked = getShowSecondsCountdown();
  const voiceCb = document.getElementById("voicePromptsEnabled") as HTMLInputElement | null;
  if (voiceCb) voiceCb.checked = getVoicePromptsEnabled();
}

function savePreferenceShowSeconds(checked: boolean) {
  localStorage.setItem("showSecondsCountdown", checked ? "true" : "false");
}

function savePreferenceVoicePrompts(checked: boolean) {
  localStorage.setItem("voicePromptsEnabled", checked ? "true" : "false");
}
async function loadWorkoutSummaries() {
  const listContainer = document.getElementById("workoutSummaryList");
  if (!listContainer) return;
  listContainer.innerHTML = '<div class="label" style="text-align: center; margin-bottom: 16px;">Loading workouts...</div>';
  try {
    const workouts = await getAllWorkoutSummaries();
    displayWorkoutSummaries(workouts as any);
  } catch (error) {
    console.error("Error loading workouts:", error);
    listContainer.innerHTML = '<div class="label" style="text-align: center; color: #ff4444;">Error loading workouts</div>';
  }
}

function createSwipeHandler(onSwipeLeft: () => void, onSwipeRight: () => void) {
  const state: any = {
    active: false,
    pointer: "none",
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    startT: 0,
    movedX: 0,
    movedY: 0,
    armed: false,
    swiped: false,
    targetEl: null,
  };
  const threshold = 72;
  const velocity = 0.3;
  const armThreshold = 48;
  const applyDragStyle = (dx: number) => {
    const el = state.targetEl as HTMLElement | null;
    if (!el) return;
    el.style.setProperty("--drag-x", `${dx}px`);
    if (dx < 0) el.dataset.dragDirection = "left";
    else if (dx > 0) el.dataset.dragDirection = "right";
    else delete el.dataset.dragDirection;
  };
  const clearDragStyle = () => {
    const el = state.targetEl as HTMLElement | null;
    if (!el) return;
    el.style.setProperty("--drag-x", "0px");
    delete el.dataset.dragDirection;
    delete el.dataset.swipeArmed;
    el.classList.remove("dragging");
  };
  const onStart = (el: HTMLElement, x: number, y: number, pointer: string) => {
    const now = performance.now();
    state.active = true;
    state.pointer = pointer;
    state.startX = x;
    state.startY = y;
    state.lastX = x;
    state.lastY = y;
    state.startT = now;
    state.movedX = 0;
    state.movedY = 0;
    state.armed = false;
    state.swiped = false;
    state.targetEl = el;
    el.classList.add("dragging");
  };
  const onMove = (x: number, y: number) => {
    if (!state.active) return;
    const dx = x - state.startX;
    const dy = y - state.startY;
    state.lastX = x;
    state.lastY = y;
    state.movedX = dx;
    state.movedY = dy;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 16) {
      clearDragStyle();
      return;
    }
    if (Math.abs(dx) > 0) applyDragStyle(dx);
    else {
      clearDragStyle();
      return;
    }
    const shouldArm = Math.abs(dx) >= armThreshold;
    if (shouldArm !== state.armed) {
      state.armed = shouldArm;
      const el = state.targetEl as HTMLElement | null;
      if (el) el.dataset.swipeArmed = shouldArm ? "true" : "false";
      if (shouldArm && navigator.vibrate) navigator.vibrate(10);
    }
  };
  const onEnd = () => {
    if (!state.active || !state.targetEl) return;
    const dt = Math.max(1, performance.now() - state.startT);
    const dx = state.movedX;
    const absX = Math.abs(dx);
    const speed = absX / dt;
    let didSwipe = false;
    let swipeDirection: "left" | "right" | null = null;
    if (absX >= threshold || (absX >= 24 && speed >= velocity)) {
      if (dx < 0) {
        didSwipe = true;
        swipeDirection = "left";
      } else if (dx > 0) {
        didSwipe = true;
        swipeDirection = "right";
      }
    }
    const el = state.targetEl as HTMLElement;
    if (didSwipe && el) {
      state.swiped = true;
      if (swipeDirection === "left" && onSwipeLeft) onSwipeLeft();
      else if (swipeDirection === "right" && onSwipeRight) onSwipeRight();
      el.classList.add("swipe-complete");
      clearDragStyle();
      setTimeout(() => el.classList.remove("swipe-complete"), 400);
    } else {
      clearDragStyle();
    }
    state.active = false;
    state.pointer = "none";
  };
  return {
    onTouchStart: (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      onStart(e.currentTarget as HTMLElement, t.clientX, t.clientY, "touch");
    },
    onTouchMove: (e: TouchEvent) => {
      if (!state.active || state.pointer !== "touch") return;
      const t = e.touches[0];
      if (!t) return;
      onMove(t.clientX, t.clientY);
    },
    onTouchEnd: () => {
      if (state.pointer !== "touch") return;
      onEnd();
    },
    onMouseDown: (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (window.getSelection) window.getSelection()?.removeAllRanges();
      onStart(e.currentTarget as HTMLElement, e.clientX, e.clientY, "mouse");
    },
    onMouseMove: (e: MouseEvent) => {
      if (!state.active || state.pointer !== "mouse") return;
      onMove(e.clientX, e.clientY);
    },
    onMouseUp: () => {
      if (state.pointer !== "mouse") return;
      onEnd();
    },
    onClick: (e: MouseEvent) => {
      if (Math.abs(state.movedX) > 6 || state.swiped) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
  };
}
let pendingDeleteSessionId: string | null = null;

function openDeleteWorkoutModal(sessionId: string) {
  pendingDeleteSessionId = sessionId;
  const bg = document.getElementById("deleteWorkoutModalBg");
  if (bg) bg.style.display = "flex";
}

function closeDeleteWorkoutModal() {
  const bg = document.getElementById("deleteWorkoutModalBg");
  if (bg) bg.style.display = "none";
  pendingDeleteSessionId = null;
}

async function confirmDeleteWorkout() {
  if (pendingDeleteSessionId) {
    const success = await deleteWorkoutSummary(pendingDeleteSessionId);
    if (success) await loadWorkoutSummaries();
    closeDeleteWorkoutModal();
  }
}

async function deleteWorkout(sessionId: string) {
  const success = await deleteWorkoutSummary(sessionId);
  if (success) await loadWorkoutSummaries();
  return success;
}
let currentWorkoutSummary: any = null;

function viewWorkoutSummary(sessionId: string) {
  (window as any).initDB().then((db: IDBDatabase) => {
    const transaction = db.transaction(["workouts"], "readonly");
    const store = transaction.objectStore("workouts");
    const request = store.get(sessionId);
    request.onsuccess = () => {
      const workout = request.result;
      if (workout && workout.summary) {
        const summaryForEmission = { ...workout.summary };
        delete summaryForEmission.day;
        showWorkoutSummaryModal(summaryForEmission);
      }
    };
  });
}

function showWorkoutSummaryModal(summary: any) {
  currentWorkoutSummary = summary;
  const jsonElement = document.getElementById("workoutSummaryJson");
  if (jsonElement) jsonElement.textContent = JSON.stringify(summary, null, 2);
  const bg = document.getElementById("workoutSummaryModalBg");
  if (bg) bg.style.display = "flex";
}

function closeWorkoutSummaryModal() {
  const bg = document.getElementById("workoutSummaryModalBg");
  if (bg) bg.style.display = "none";
  currentWorkoutSummary = null;
}

function downloadWorkoutSummaryJson() {
  if (!currentWorkoutSummary) return;
  downloadWorkoutJson(currentWorkoutSummary.external_session_id);
}

function showToast(message: string, type: "info" | "success" | "error" = "info") {
  const existingToast = document.getElementById("toast");
  if (existingToast) existingToast.remove();
  const toast = document.createElement("div");
  toast.id = "toast";
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add("show"), 10);
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function downloadWorkoutJson(sessionId: string) {
  (window as any).initDB().then((db: IDBDatabase) => {
    const transaction = db.transaction(["workouts"], "readonly");
    const store = transaction.objectStore("workouts");
    const request = store.get(sessionId);
    request.onsuccess = () => {
      const workout = request.result;
      if (workout && workout.summary) {
        const summaryForEmission = { ...workout.summary };
        delete summaryForEmission.day;
        const jsonStr = JSON.stringify(summaryForEmission, null, 2);
        const blob = new Blob([jsonStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `workout-${summaryForEmission.external_session_id}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    };
  });
}
function displayWorkoutSummaries(workouts: any[]) {
  const listContainer = document.getElementById("workoutSummaryList");
  if (!listContainer) return;
  if (workouts.length === 0) {
    listContainer.innerHTML = '<div class="label" style="text-align: center; margin-bottom: 16px;">No workouts recorded yet</div>';
    return;
  }
  listContainer.innerHTML = "";
  workouts.forEach((workout) => {
    const summary = workout.summary;
    const workoutItem = document.createElement("div");
    workoutItem.className = "workout-item";
    workoutItem.dataset.sessionId = summary.external_session_id;
    const date = new Date(summary.startedAt);
    const dateStr = date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const cancelledLabel = summary.cancelled ? '<span class="workout-item-cancelled">cancelled</span>' : "";
    workoutItem.innerHTML = `
      <div class="swipe-left-indicator"></div>
      <div class="swipe-right-indicator"></div>
      <div class="workout-item-header">
        <div>
          <div class="workout-item-title">${summary.intent || "Workout"}</div>
          <div class="workout-item-date">${dateStr}</div>
        </div>
        ${cancelledLabel}
      </div>
      <div class="workout-item-details">
        <div class="workout-item-detail">Duration: ${summary.duration_minutes} min</div>
        <div class="workout-item-detail">Primary Zone: ${summary.primary_zone}</div>
        <div class="workout-item-detail">Stress: ${summary.stress_profile}</div>
      </div>
      <div class="workout-item-actions">
        <button class="button" onclick="viewWorkoutSummary('${summary.external_session_id}')">View</button>
        <button class="button secondary" onclick="downloadWorkoutJson('${summary.external_session_id}')">Download JSON</button>
      </div>
    `;
    const swipe = createSwipeHandler(
      () => {
        const sessionId = workoutItem.dataset.sessionId;
        if (sessionId) {
          workoutItem.classList.add("deleting");
          setTimeout(() => {
            workoutItem.classList.remove("deleting");
            openDeleteWorkoutModal(sessionId);
          }, 300);
        }
      },
      async () => {
        const sessionId = workoutItem.dataset.sessionId;
        if (sessionId) {
          workoutItem.classList.add("sending");
          try {
            const result = await sendWorkoutToSisu(sessionId);
            workoutItem.classList.remove("sending");
            if (result.success) showToast(result.message, "success");
            else showToast(result.message, "error");
          } catch (error: any) {
            workoutItem.classList.remove("sending");
            showToast("Error sending to SISU: " + error.message, "error");
          }
        }
      }
    );
    workoutItem.addEventListener("touchstart", swipe.onTouchStart);
    workoutItem.addEventListener("touchmove", swipe.onTouchMove);
    workoutItem.addEventListener("touchend", swipe.onTouchEnd);
    workoutItem.addEventListener("mousedown", swipe.onMouseDown);
    workoutItem.addEventListener("mousemove", swipe.onMouseMove);
    workoutItem.addEventListener("mouseup", swipe.onMouseUp);
    workoutItem.addEventListener(
      "click",
      (e) => {
        if (swipe.onClick) swipe.onClick(e as any);
      },
      true
    );
    listContainer.appendChild(workoutItem);
  });
}

function registerUiGlobals(phaseBoxEl: HTMLElement | null) {
  phaseDisplayEl = phaseBoxEl;
  if (phaseDisplayEl) {
    phaseDisplayEl.dataset.phaseState = "idle";
    phaseDisplayEl.addEventListener("click", promptCancelWorkout);
  }
  const ringCenter = document.getElementById("ringCenter");
  if (ringCenter) {
    ringCenter.addEventListener("click", () => {
      showElapsedInRing = !showElapsedInRing;
      updateDisplay();
    });
  }
  (window as any).getSelectedDay = getSelectedDay;
  (window as any).getShowElapsed = getShowElapsed;
  (window as any).setSelectedDay = setSelectedDay;
  (window as any).connectHr = connectHr;
  (window as any).updateHrMonitorStatus = updateHrMonitorLabel;
  (window as any).updateHrDisplay = updateHrDisplay;
  (window as any).openModal = openModal;
  (window as any).closeModal = closeModal;
  (window as any).openCancelModal = openCancelModal;
  (window as any).closeCancelModal = closeCancelModal;
  (window as any).confirmCancelWorkout = confirmCancelWorkout;
  (window as any).promptCancelWorkout = promptCancelWorkout;
  (window as any).switchTab = switchTab;
  (window as any).getShowSecondsCountdown = getShowSecondsCountdown;
  (window as any).getVoicePromptsEnabled = getVoicePromptsEnabled;
  (window as any).savePreferenceShowSeconds = savePreferenceShowSeconds;
  (window as any).savePreferenceVoicePrompts = savePreferenceVoicePrompts;
  (window as any).loadWorkoutSummaries = loadWorkoutSummaries;
  (window as any).viewWorkoutSummary = viewWorkoutSummary;
  (window as any).showWorkoutSummaryModal = showWorkoutSummaryModal;
  (window as any).closeWorkoutSummaryModal = closeWorkoutSummaryModal;
  (window as any).downloadWorkoutSummaryJson = downloadWorkoutSummaryJson;
  (window as any).showToast = showToast;
  (window as any).downloadWorkoutJson = downloadWorkoutJson;
  (window as any).openDeleteWorkoutModal = openDeleteWorkoutModal;
  (window as any).closeDeleteWorkoutModal = closeDeleteWorkoutModal;
  (window as any).confirmDeleteWorkout = confirmDeleteWorkout;
  (window as any).deleteWorkout = deleteWorkout;
  (window as any).updateHeartPulse = updateHeartPulse;
  (window as any).updateHeartColor = updateHeartColor;
  (window as any).updateDisplay = updateDisplay;
}

export {
  getSelectedDay,
  setSelectedDay,
  connectHr,
  updateHrDisplay,
  updateHeartPulse,
  updateHeartColor,
  updateDisplay,
  switchTab,
  savePreferenceShowSeconds,
  savePreferenceVoicePrompts,
  loadWorkoutSummaries,
  registerUiGlobals,
};
