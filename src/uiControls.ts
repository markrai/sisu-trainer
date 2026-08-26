
import {
  adjustedBlockLengths,
  beginWorkout,
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
  parseHrTargetRange,
  updateRing,
} from "./workoutLogic.js";
import { getPlan, getWorkoutMetadata } from "./workoutData.js";
import { getAllWorkoutSummaries, deleteWorkoutSummary } from "./workoutStorage.js";
import { sendWorkoutToSisu } from "./sisuSync.js";
import { handleWorkoutCompletion } from "./workoutLifecycle.js";
import { connect as hrConnect, disconnect as hrDisconnect, onBpm } from "./hrMonitor.js";
import { getSession } from "./sessionStore.js";
import { startDownregulationView, stopDownregulationView } from "./downregulation/index.js";
import { listMachinesForActivity, isMachineId } from "./machines/registry.js";
import { getEquipmentSelection, setSelectedMachine } from "./machines/selection.js";
import {
  recordMachineHeartRateSample,
  updateMachineGuidanceRuntime,
  type MachineGuidanceRuntimeUpdate,
} from "./machines/runtime.js";
import {
  formatLearnedGuidanceLabel,
  listLearnedStarts,
  resetLearnedGuidanceForMachine,
} from "./machines/learning/index.js";
import {
  listHrDynamics,
  resetHrDynamicsForMachine,
  type LearnedHrDynamics,
} from "./machines/dynamics/index.js";
import {
  listShadowPredictions,
  resetShadowPredictionsForMachine,
  type ShadowResistanceDiagnostics,
} from "./machines/prediction/index.js";
import type { Activity, WorkoutPhaseState } from "./types.js";
import { ACTIVITY_LABELS, getActiveWorkoutActivity } from "./workoutActivity.js";

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
    const downregOpt = document.createElement("option");
    downregOpt.value = "Downregulation";
    downregOpt.textContent = "Downregulation";
    select.appendChild(downregOpt);
    select.addEventListener("change", function () {
      selectedDay = this.value;
      updateDisplay();
    });
  }
  const hasDownreg = Array.from(select.options).some((o) => o.value === "Downregulation");
  if (!hasDownreg) {
    const downregOpt = document.createElement("option");
    downregOpt.value = "Downregulation";
    downregOpt.textContent = "Downregulation";
    select.appendChild(downregOpt);
  }
  const current = getSelectedDay();
  if (select.value !== current) select.value = current;
}

function connectHr() {
  const connected = !!(window as any).hrDeviceName;
  if (connected) {
    hrDisconnect();
  } else {
    hrConnect();
  }
}

function applyBatteryToElement(batteryEl: HTMLElement | null, battery: number | null | undefined) {
  if (!batteryEl) return;
  if (typeof battery === "number" && battery >= 0 && battery <= 100) {
    batteryEl.classList.add("battery-pill");
    batteryEl.style.setProperty("--battery-pct", String(battery));
    const state = battery <= 15 ? "low" : battery <= 35 ? "med" : "good";
    batteryEl.setAttribute("data-battery-state", state);
    batteryEl.style.display = "";
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
    batteryEl.style.removeProperty("--battery-pct");
  }
}

function updateHrMonitorLabel() {
  const labelEl = document.getElementById("hrMonitorLabel");
  const batteryEl = document.getElementById("hrMonitorBattery");
  const btnEl = document.getElementById("connectHrButton");
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
  if (btnEl) {
    if (name) {
      btnEl.textContent = "Disconnect HR Strap";
      btnEl.classList.add("hr-connected");
    } else {
      btnEl.textContent = "Connect HR Strap";
      btnEl.classList.remove("hr-connected");
    }
  }
  applyBatteryToElement(batteryEl as HTMLElement | null, battery);
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

let activitySelectEscHandler: ((e: KeyboardEvent) => void) | null = null;

function closeActivitySelectModal() {
  const bg = document.getElementById("activitySelectModalBg");
  if (bg) bg.style.display = "none";
  if (activitySelectEscHandler) {
    document.removeEventListener("keydown", activitySelectEscHandler);
    activitySelectEscHandler = null;
  }
}

function promptWorkoutActivitySelection(activities: Activity[]) {
  const bg = document.getElementById("activitySelectModalBg");
  const options = document.getElementById("activitySelectOptions");
  if (!bg || !options) return;
  options.innerHTML = "";
  for (const activity of activities) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button";
    button.textContent = ACTIVITY_LABELS[activity];
    button.addEventListener("click", () => {
      closeActivitySelectModal();
      beginWorkout(activity);
    });
    options.appendChild(button);
  }
  bg.style.display = "flex";
  activitySelectEscHandler = (e) => {
    if (e.key === "Escape" || e.keyCode === 27) closeActivitySelectModal();
  };
  document.addEventListener("keydown", activitySelectEscHandler);
}

function confirmCancelWorkout() {
  restartWorkout();
  closeCancelModal();
}

function promptCancelWorkout() {
  if (!phaseDisplayEl) return;
  if (phaseDisplayEl.dataset.phaseState === "active") openCancelModal();
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

type WorkoutDisplayState =
  | { screen: "rest"; day: string; plan: any; workoutMetadata: any }
  | { screen: "downregulation"; day: "Downregulation"; plan: any; workoutMetadata: any }
  | {
      screen: "idle";
      day: string;
      plan: any;
      workoutMetadata: any;
      base: any;
      blocks: any;
      workoutBlocksText: string;
    }
  | {
      screen: "completed";
      day: string;
      plan: any;
      workoutMetadata: any;
      base: any;
      blocks: any;
      workoutBlocksText: string;
      elapsedSec: number;
    }
  | {
      screen: "active";
      day: string;
      plan: any;
      workoutMetadata: any;
      base: any;
      blocks: any;
      workoutBlocksText: string;
      elapsedSec: number;
      phase: WorkoutPhaseState;
      phaseDisplayName: string;
      activity: Activity | null;
      paused: boolean;
      hrTargetTextValue: string;
      liveBpm: number | null;
      liveBpmStale: boolean;
    };

function deriveWorkoutState(
  day: string,
  plan: any,
  workoutMetadata: any,
  base: any,
  startTime: string | null,
  paused: boolean,
  pausedElapsed: number,
  liveBpm: number | null,
  lastBpmUpdateTime: number | null
): WorkoutDisplayState {
  if (day === "Downregulation") {
    return { screen: "downregulation", day: "Downregulation", plan, workoutMetadata };
  }
  if (!base) {
    return { screen: "rest", day, plan, workoutMetadata };
  }

  const blocks = adjustedBlockLengths(base, null);
  const workoutBlocksText =
    "Warm-Up: " + blocks.warm + " min · Workout: " + blocks.sustain + " min · Cool-Down: " + blocks.cool + " min";

  if (!startTime) {
    return { screen: "idle", day, plan, workoutMetadata, base, blocks, workoutBlocksText };
  }

  const elapsedSec = paused ? pausedElapsed : Math.floor((Date.now() - parseInt(startTime)) / 1000);
  const phase = getPhase(elapsedSec, blocks);

  if (phase.done) {
    return { screen: "completed", day, plan, workoutMetadata, base, blocks, workoutBlocksText, elapsedSec };
  }

  let phaseDisplayName: string = phase.phase;
  if (phase.kind === "warmup") {
    const subsectionName = getWarmupSubsectionName(day, elapsedSec);
    if (subsectionName) phaseDisplayName = "Warm-Up (" + subsectionName + ")";
  } else if (phase.detailName) {
    phaseDisplayName = phase.detailName;
  } else if (phase.kind === "work" || phase.kind === "recovery") {
    phaseDisplayName = "Workout";
  }

  const hrTargetTextValue = hrTargetText(phase.phase, day, elapsedSec, blocks);
  const nowTime = Date.now();
  const liveBpmStale =
    lastBpmUpdateTime != null && nowTime - lastBpmUpdateTime > BPM_TIMEOUT_MS;

  return {
    screen: "active",
    day,
    plan,
    workoutMetadata,
    base,
    blocks,
    workoutBlocksText,
    elapsedSec,
    phase,
    phaseDisplayName,
    activity: getActiveWorkoutActivity(workoutMetadata[day]?.activities, getSession(day).activity) ?? null,
    paused,
    hrTargetTextValue,
    liveBpm: liveBpm ?? null,
    liveBpmStale,
  };
}

function renderMachineGuidance(update: MachineGuidanceRuntimeUpdate | null) {
  const panel = document.getElementById("machineGuidance");
  if (!panel) return;
  if (!update || update.guidance.resistance === undefined || update.guidance.cadenceRpm === undefined) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const name = document.getElementById("machineGuidanceName");
  const resistance = document.getElementById("machineGuidanceResistance");
  const cadence = document.getElementById("machineGuidanceCadence");
  const watts = document.getElementById("machineGuidanceWatts");
  if (name) name.textContent = update.machine.name;
  if (resistance) resistance.textContent = String(update.guidance.resistance);
  if (cadence) cadence.textContent = `${update.guidance.cadenceRpm} RPM`;
  if (watts) {
    if (update.guidance.estimatedWatts !== undefined) {
      watts.textContent = `~${update.guidance.estimatedWatts} W @ 70 RPM`;
      watts.hidden = false;
    } else {
      watts.textContent = "";
      watts.hidden = true;
    }
  }
}

function renderWorkout(state: WorkoutDisplayState) {
  const downregEl = document.getElementById("downregulationContainer");
  const workoutMainContent = document.getElementById("workoutMainContent");
  const workoutBlocksEl = document.getElementById("workoutBlocks");

  if (state.screen === "downregulation") {
    if (workoutMainContent) (workoutMainContent as HTMLElement).style.display = "none";
    if (workoutBlocksEl) (workoutBlocksEl as HTMLElement).style.display = "none";
    const mainSection = document.getElementById("workoutMainSection");
    if (mainSection) {
      (mainSection as HTMLElement).style.background = "transparent";
    }
    if (downregEl) {
      (downregEl as HTMLElement).style.display = "block";
      const canvas = document.getElementById("downregulationCanvas") as HTMLCanvasElement | null;
      if (canvas) {
        startDownregulationView(downregEl as HTMLElement, canvas);
      }
    }
    return;
  }

  stopDownregulationView();
  if (downregEl) (downregEl as HTMLElement).style.display = "none";
  if (workoutMainContent) (workoutMainContent as HTMLElement).style.display = "";
  if (workoutBlocksEl) (workoutBlocksEl as HTMLElement).style.display = "";
  const mainSection = document.getElementById("workoutMainSection");
  if (mainSection) {
    (mainSection as HTMLElement).style.background = "";
  }

  ensureWorkoutDayDropdown();

  const activityIcon = document.getElementById("activityIcon") as HTMLImageElement | null;
  const dayMeta = state.workoutMetadata[state.day];
  const hasBase = state.screen !== "rest" && (state as any).base;
  if (activityIcon) {
    if (hasBase && dayMeta) {
      const selectedActivity = state.screen === "active" || state.screen === "completed"
        ? getSession(state.day).activity
        : undefined;
      const activity = getActiveWorkoutActivity(dayMeta.activities, selectedActivity);
      const iconByActivity: Partial<Record<Activity, string>> = {
        bike: "bike.png",
        elliptical: "elliptical.png",
        strength: "dumbbell.png",
      };
      const iconSrc = activity ? iconByActivity[activity] || "" : "";
      if (iconSrc) {
        activityIcon.src = iconSrc;
        activityIcon.style.display = "block";
      } else {
        activityIcon.style.display = "none";
      }
    } else {
      activityIcon.style.display = "none";
    }
  }

  const hrTargetEl = document.getElementById("hrTarget");
  const startBtnEl = document.getElementById("startButton") as HTMLButtonElement | null;
  const cancelBtnEl = document.getElementById("cancelWorkoutButton") as HTMLButtonElement | null;
  const startButtonRowEl = document.getElementById("startButtonRow") as HTMLElement | null;

  if (state.screen === "rest") {
    renderMachineGuidance(null);
    if (workoutBlocksEl) workoutBlocksEl.textContent = "Rest Day";
    if (phaseDisplayEl) {
      phaseDisplayEl.innerHTML = '<span class="phase-name">Rest Day</span>';
      phaseDisplayEl.dataset.phaseState = "rest";
    }
    if (startButtonRowEl) startButtonRowEl.style.display = "none";
    if (cancelBtnEl) cancelBtnEl.style.display = "none";
    updateRing(0, { warm: 1, sustain: 1, cool: 1 } as any);
    if (hrTargetEl) hrTargetEl.textContent = "";
    updateHeartPulse(null);
    updateHeartColor(null, "");
    applyPhaseStyle("Rest");
    return;
  }

  if (workoutBlocksEl) workoutBlocksEl.textContent = state.workoutBlocksText;

  if (state.screen === "idle") {
    renderMachineGuidance(null);
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
    updateRing(0, state.blocks as any);
    if (hrTargetEl) hrTargetEl.textContent = "";
    updateHeartPulse(null);
    updateHeartColor(null, "");
    applyPhaseStyle("idle");
    return;
  }

  if (state.screen === "completed") {
    renderMachineGuidance(null);
    updateRing(state.elapsedSec, state.blocks as any);
    if (typeof (window as any).releaseWakeLock === "function") (window as any).releaseWakeLock();
    handleWorkoutCompletion(state.day);
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

  // state.screen === "active"
  updateRing(state.elapsedSec, state.blocks as any);
  const active = state;
  if (startButtonRowEl) startButtonRowEl.style.display = "flex";
  if (startBtnEl) {
    if (active.paused) {
      startBtnEl.innerText = "Resume";
      startBtnEl.onclick = function () {
        resumeWorkout(active.day);
        if (typeof (window as any).requestWakeLock === "function") (window as any).requestWakeLock();
        updateDisplay();
      };
      startBtnEl.style.display = "block";
    } else {
      startBtnEl.innerText = "Pause";
      startBtnEl.onclick = function () {
        pauseWorkout(active.day, active.elapsedSec);
        if (typeof (window as any).releaseWakeLock === "function") (window as any).releaseWakeLock();
        updateDisplay();
      };
      startBtnEl.style.display = "block";
    }
  }
  if (cancelBtnEl) cancelBtnEl.style.display = active.paused ? "block" : "none";

  if (phaseDisplayEl) {
    phaseDisplayEl.innerHTML =
      '<span class="phase-name">' +
      active.phaseDisplayName +
      '</span><span class="phase-time">' +
      formatTime(active.phase.timeLeft) +
      "</span>";
    phaseDisplayEl.dataset.phaseState = "active";
  }
  if (hrTargetEl) hrTargetEl.textContent = active.hrTargetTextValue;
  updateHeartPulse();
  if (active.liveBpmStale) {
    updateHrDisplay(null);
  }
  if (active.liveBpm != null && active.liveBpm > 0 && !active.liveBpmStale) {
    updateHeartColor(active.liveBpm, active.hrTargetTextValue);
  } else {
    updateHeartColor(null, active.hrTargetTextValue);
  }
  const session = getSession(active.day);
  const targetRange = parseHrTargetRange(active.hrTargetTextValue);
  const machineUpdate = session.sessionId && active.activity
    ? updateMachineGuidanceRuntime({
        sessionId: session.sessionId,
        activity: active.activity,
        phaseKind: active.phase.kind as Exclude<WorkoutPhaseState["kind"], "completed">,
        phaseId: active.phase.phaseId,
        phaseDisplayName: active.phaseDisplayName,
        phaseElapsedSeconds: active.phase.phaseElapsedSeconds,
        phaseDurationSeconds: active.phase.phaseDurationSeconds,
        workoutElapsedSeconds: active.elapsedSec,
        intervalIndex: active.phase.intervalIndex,
        heartRateBpm: active.liveBpm ?? undefined,
        targetHeartRateMin: targetRange?.min,
        targetHeartRateMax: targetRange?.max,
        intent: active.workoutMetadata[active.day]?.intent,
      })
    : null;
  renderMachineGuidance(machineUpdate);
  if (typeof (window as any).announceWorkoutGuidance === "function") {
    (window as any).announceWorkoutGuidance(active.phaseDisplayName, machineUpdate?.voiceEvent ?? null);
  } else if (typeof (window as any).announcePhaseIfChanged === "function") {
    (window as any).announcePhaseIfChanged(active.phaseDisplayName);
  }
  applyPhaseStyle(active.phase.phase);
}

function updateDisplay() {
  try {
    if (typeof getPlan !== "function" || typeof getWorkoutMetadata !== "function") return;
    const day = getSelectedDay();
    const plan = getPlan();
    const workoutMetadata = getWorkoutMetadata();
    const base = (plan as any)[day];
    const startTime = getStartTime(day);
    const paused = typeof isPaused === "function" && isPaused(day);
    const pausedElapsed = typeof getPausedElapsed === "function" ? getPausedElapsed(day) : 0;
    const liveBpm = (window as any).liveBpm as number | null;
    const lastBpmUpdateTime = (window as any).lastBpmUpdateTime as number | null;

    const state = deriveWorkoutState(
      day,
      plan,
      workoutMetadata,
      base,
      startTime,
      paused,
      pausedElapsed,
      liveBpm,
      lastBpmUpdateTime
    );

    if (state.screen === "active" && state.liveBpmStale) {
      (window as any).liveBpm = null;
    }

    renderWorkout(state);
  } catch (e: any) {
    if (e instanceof TypeError && e.message && e.message.includes("null")) {
      console.warn("updateDisplay: DOM element missing", e.message);
    } else {
      throw e;
    }
  }
}
function switchTab(tabName: string) {
  const tabs = ["personal", "preferences", "equipment", "workouts", "sisu", "install"];
  tabs.forEach((name) => {
    const tabEl = document.getElementById(name + "Tab");
    if (tabEl) tabEl.classList.remove("active");
  });
  const buttons = document.querySelectorAll(".tab-button");
  buttons.forEach((btn) => btn.classList.remove("active"));
  const tabIndex: Record<string, number> = { personal: 0, preferences: 1, equipment: 2, workouts: 3, sisu: 4, install: 5 };
  if (tabName === "personal") {
    document.getElementById("personalTab")?.classList.add("active");
    (buttons[tabIndex.personal] as HTMLElement | undefined)?.classList.add("active");
  } else if (tabName === "preferences") {
    document.getElementById("preferencesTab")?.classList.add("active");
    (buttons[tabIndex.preferences] as HTMLElement | undefined)?.classList.add("active");
    loadPreferences();
  } else if (tabName === "equipment") {
    document.getElementById("equipmentTab")?.classList.add("active");
    (buttons[tabIndex.equipment] as HTMLElement | undefined)?.classList.add("active");
    loadEquipmentSettings();
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

function loadEquipmentSettings() {
  const select = document.getElementById("bikeMachineSelect") as HTMLSelectElement | null;
  if (!select) return;
  select.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No machine";
  select.appendChild(none);
  for (const machine of listMachinesForActivity("bike")) {
    const option = document.createElement("option");
    option.value = machine.id;
    option.textContent = machine.name;
    select.appendChild(option);
  }
  select.value = getEquipmentSelection().bike ?? "";
  renderLearnedGuidancePanel();
  renderHrDynamicsPanel();
  renderShadowPredictionPanel();
}

function renderLearnedGuidancePanel() {
  const section = document.getElementById("learnedGuidanceSection");
  const list = document.getElementById("learnedGuidanceList");
  if (!section || !list) return;
  const machineId = getEquipmentSelection().bike;
  const entries = machineId ? listLearnedStarts(machineId) : [];
  if (!machineId || entries.length === 0) {
    section.hidden = true;
    list.innerHTML = "";
    return;
  }
  section.hidden = false;
  list.innerHTML = entries
    .map(
      (entry) =>
        `<div class="learned-guidance-row"><span>${formatLearnedGuidanceLabel(entry.intent, entry.durationClass)}</span><span>R${entry.resistance}</span></div>`
    )
    .join("");
}

function metricRow(label: string, value: string): string {
  return `<div class="learned-guidance-row"><span>${label}</span><span>${value}</span></div>`;
}

function sampleCountLabel(count: number): string {
  return count === 1 ? "1 sample" : `${count} samples`;
}

function signedBpm(value: number): string {
  return `${value > 0 ? "+" : ""}${value} bpm`;
}

function reliabilityRows(
  observationCount: number,
  detectedCount: number,
  recentObservationCount: number,
  recentDetectedCount: number,
  fallbackLabel: string,
  fallbackCount: number
): string[] {
  const rows: string[] = [];
  if (observationCount > 0) {
    rows.push(metricRow("Response observed", `${detectedCount} of ${observationCount}`));
  } else if (fallbackCount > 0) {
    rows.push(metricRow(fallbackLabel, sampleCountLabel(fallbackCount)));
  }
  if (recentObservationCount > 0) {
    rows.push(metricRow("Recent", `${recentDetectedCount} of ${recentObservationCount}`));
  }
  return rows;
}

function renderHrDynamicsGroup(entry: LearnedHrDynamics): string {
  const blocks: string[] = [];
  if (entry.workStartSampleCount > 0 || entry.workStartObservationCount > 0 || entry.workStartRecentObservationCount > 0) {
    const rows: string[] = ['<div class="hr-dynamics-subhead">Work start</div>'];
    if (entry.medianWorkStartDelaySeconds !== undefined) {
      rows.push(metricRow("Typical rise delay", `${entry.medianWorkStartDelaySeconds} s`));
    }
    if (entry.medianWorkStartHrDelta !== undefined) {
      rows.push(metricRow("Observed HR rise", signedBpm(entry.medianWorkStartHrDelta)));
    }
    rows.push(
      ...reliabilityRows(
        entry.workStartObservationCount,
        entry.workStartDetectedResponseCount,
        entry.workStartRecentObservationCount,
        entry.workStartRecentDetectedResponseCount,
        "Based on",
        entry.workStartSampleCount
      )
    );
    blocks.push(rows.join(""));
  }
  if (entry.increaseSampleCount > 0 || entry.increaseObservationCount > 0 || entry.increaseRecentObservationCount > 0) {
    const rows: string[] = ['<div class="hr-dynamics-subhead">+1 resistance</div>'];
    if (entry.medianIncreaseDelaySeconds !== undefined) {
      rows.push(metricRow("Typical response delay", `${entry.medianIncreaseDelaySeconds} s`));
    }
    if (entry.medianIncreaseHrDeltaPerStep !== undefined) {
      rows.push(metricRow("Observed HR change", signedBpm(entry.medianIncreaseHrDeltaPerStep)));
    }
    rows.push(
      ...reliabilityRows(
        entry.increaseObservationCount,
        entry.increaseDetectedResponseCount,
        entry.increaseRecentObservationCount,
        entry.increaseRecentDetectedResponseCount,
        "Samples",
        entry.increaseSampleCount
      )
    );
    blocks.push(rows.join(""));
  }
  if (entry.decreaseSampleCount > 0 || entry.decreaseObservationCount > 0 || entry.decreaseRecentObservationCount > 0) {
    const rows: string[] = ['<div class="hr-dynamics-subhead">-1 resistance</div>'];
    if (entry.medianDecreaseDelaySeconds !== undefined) {
      rows.push(metricRow("Typical response delay", `${entry.medianDecreaseDelaySeconds} s`));
    }
    if (entry.medianDecreaseHrDeltaPerStep !== undefined) {
      rows.push(metricRow("Observed HR change", signedBpm(entry.medianDecreaseHrDeltaPerStep)));
    }
    rows.push(
      ...reliabilityRows(
        entry.decreaseObservationCount,
        entry.decreaseDetectedResponseCount,
        entry.decreaseRecentObservationCount,
        entry.decreaseRecentDetectedResponseCount,
        "Samples",
        entry.decreaseSampleCount
      )
    );
    blocks.push(rows.join(""));
  }
  if (blocks.length === 0) return "";
  if (entry.timingMode || entry.timingPersonalized) {
    const status =
      entry.timingMode === "earlier"
        ? "Earlier"
        : entry.timingMode === "extended"
          ? "Extended"
          : "Personalized";
    blocks.push(
      `<div class="hr-dynamics-subhead">Controller timing</div>${metricRow("Status", status)}`
    );
  }
  return `<div class="hr-dynamics-block"><div class="hr-dynamics-heading">${formatLearnedGuidanceLabel(entry.intent, entry.durationClass)}</div>${blocks.join("")}</div>`;
}

function renderHrDynamicsPanel() {
  const section = document.getElementById("hrDynamicsSection");
  const list = document.getElementById("hrDynamicsList");
  if (!section || !list) return;
  const machineId = getEquipmentSelection().bike;
  const entries = machineId ? listHrDynamics(machineId).filter((entry) =>
    entry.workStartSampleCount > 0 ||
    entry.increaseSampleCount > 0 ||
    entry.decreaseSampleCount > 0 ||
    entry.workStartObservationCount > 0 ||
    entry.increaseObservationCount > 0 ||
    entry.decreaseObservationCount > 0 ||
    entry.workStartRecentObservationCount > 0 ||
    entry.increaseRecentObservationCount > 0 ||
    entry.decreaseRecentObservationCount > 0
  ) : [];
  if (!machineId || entries.length === 0) {
    section.hidden = true;
    list.innerHTML = "";
    return;
  }
  section.hidden = false;
  list.innerHTML = entries.map(renderHrDynamicsGroup).join("");
}

function signedBpmPerLevel(value: number): string {
  return `${value > 0 ? "+" : ""}${value} bpm / level`;
}

function renderShadowDirectionBlock(label: string, diagnostics: NonNullable<ShadowResistanceDiagnostics["increase"]>): string {
  const rows = [`<div class="hr-dynamics-subhead">${label}</div>`];
  rows.push(metricRow("Model", signedBpmPerLevel(diagnostics.modelMedianHrPerLevel)));
  rows.push(metricRow("Predictions", String(diagnostics.predictionCount)));
  if (diagnostics.medianAbsolutePredictionErrorBpm !== undefined) {
    rows.push(metricRow("Median error", `${diagnostics.medianAbsolutePredictionErrorBpm} bpm`));
  }
  if (diagnostics.directionEvaluatedCount > 0) {
    rows.push(
      metricRow("Direction matched", `${diagnostics.directionMatchCount} of ${diagnostics.directionEvaluatedCount}`)
    );
  }
  return rows.join("");
}

function renderShadowPredictionGroup(entry: ShadowResistanceDiagnostics): string {
  const blocks: string[] = [];
  if (entry.increase) blocks.push(renderShadowDirectionBlock("+1 resistance", entry.increase));
  if (entry.decrease) blocks.push(renderShadowDirectionBlock("-1 resistance", entry.decrease));
  if (blocks.length === 0) return "";
  return `<div class="hr-dynamics-block"><div class="hr-dynamics-heading">${formatLearnedGuidanceLabel(entry.intent, entry.durationClass)}</div>${blocks.join("")}</div>`;
}

function renderShadowPredictionPanel() {
  const section = document.getElementById("shadowPredictionSection");
  const list = document.getElementById("shadowPredictionList");
  if (!section || !list) return;
  const machineId = getEquipmentSelection().bike;
  const entries = machineId
    ? listShadowPredictions(machineId).filter((entry) => entry.increase || entry.decrease)
    : [];
  if (!machineId || entries.length === 0) {
    section.hidden = true;
    list.innerHTML = "";
    return;
  }
  section.hidden = false;
  list.innerHTML = entries.map(renderShadowPredictionGroup).join("");
}

function promptResetShadowPredictions() {
  const machineId = getEquipmentSelection().bike;
  if (!machineId) return;
  const bg = document.getElementById("resetShadowPredictionsModalBg");
  if (bg) bg.style.display = "flex";
}

function closeResetShadowPredictionsModal() {
  const bg = document.getElementById("resetShadowPredictionsModalBg");
  if (bg) bg.style.display = "none";
}

function confirmResetShadowPredictions() {
  const machineId = getEquipmentSelection().bike;
  if (machineId) resetShadowPredictionsForMachine(machineId);
  closeResetShadowPredictionsModal();
  renderShadowPredictionPanel();
  renderHrDynamicsPanel();
  renderLearnedGuidancePanel();
}

function promptResetHrDynamics() {
  const machineId = getEquipmentSelection().bike;
  if (!machineId) return;
  const bg = document.getElementById("resetHrDynamicsModalBg");
  if (bg) bg.style.display = "flex";
}

function closeResetHrDynamicsModal() {
  const bg = document.getElementById("resetHrDynamicsModalBg");
  if (bg) bg.style.display = "none";
}

function confirmResetHrDynamics() {
  const machineId = getEquipmentSelection().bike;
  if (machineId) resetHrDynamicsForMachine(machineId);
  closeResetHrDynamicsModal();
  renderHrDynamicsPanel();
  renderLearnedGuidancePanel();
  renderShadowPredictionPanel();
}

function promptResetLearnedGuidance() {
  const machineId = getEquipmentSelection().bike;
  if (!machineId) return;
  const bg = document.getElementById("resetLearnedModalBg");
  if (bg) bg.style.display = "flex";
}

function closeResetLearnedModal() {
  const bg = document.getElementById("resetLearnedModalBg");
  if (bg) bg.style.display = "none";
}

function confirmResetLearnedGuidance() {
  const machineId = getEquipmentSelection().bike;
  if (machineId) resetLearnedGuidanceForMachine(machineId);
  closeResetLearnedModal();
  renderLearnedGuidancePanel();
  renderHrDynamicsPanel();
  renderShadowPredictionPanel();
}

function saveBikeEquipmentSelection(value: string) {
  if (value && !isMachineId(value)) return;
  setSelectedMachine("bike", value && isMachineId(value) ? value : undefined);
  renderLearnedGuidancePanel();
  renderHrDynamicsPanel();
  renderShadowPredictionPanel();
  updateDisplay();
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

  onBpm((bpm) => {
    liveBpm = bpm;
    lastBpmUpdateTime = Date.now();
    (window as any).liveBpm = liveBpm;
    (window as any).lastBpmUpdateTime = lastBpmUpdateTime;
    updateHrDisplay(bpm);
    const hrTargetEl = document.getElementById("hrTarget");
    updateHeartPulse(bpm);
    updateHeartColor(bpm, hrTargetEl ? hrTargetEl.textContent : "");
    const day = getSelectedDay();
    const session = getSession(day);
    const startTime = getStartTime(day);
    if (startTime && session.sessionId) {
      const start = typeof startTime === "number" ? startTime : parseInt(String(startTime), 10);
      const elapsedSec = Math.floor((Date.now() - start) / 1000);
      if (!session.paused) recordMachineHeartRateSample(session.sessionId, elapsedSec, bpm);
      if (typeof (window as any).storeHrSample === "function") {
        (window as any).storeHrSample(session.sessionId, elapsedSec, bpm).catch((err: any) => console.error("Error storing HR sample:", err));
      }
    }
  });

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
  (window as any).closeActivitySelectModal = closeActivitySelectModal;
  (window as any).promptWorkoutActivitySelection = promptWorkoutActivitySelection;
  (window as any).confirmCancelWorkout = confirmCancelWorkout;
  (window as any).promptCancelWorkout = promptCancelWorkout;
  (window as any).switchTab = switchTab;
  (window as any).getShowSecondsCountdown = getShowSecondsCountdown;
  (window as any).getVoicePromptsEnabled = getVoicePromptsEnabled;
  (window as any).savePreferenceShowSeconds = savePreferenceShowSeconds;
  (window as any).savePreferenceVoicePrompts = savePreferenceVoicePrompts;
  (window as any).loadEquipmentSettings = loadEquipmentSettings;
  (window as any).saveBikeEquipmentSelection = saveBikeEquipmentSelection;
  (window as any).promptResetLearnedGuidance = promptResetLearnedGuidance;
  (window as any).closeResetLearnedModal = closeResetLearnedModal;
  (window as any).confirmResetLearnedGuidance = confirmResetLearnedGuidance;
  (window as any).promptResetHrDynamics = promptResetHrDynamics;
  (window as any).closeResetHrDynamicsModal = closeResetHrDynamicsModal;
  (window as any).confirmResetHrDynamics = confirmResetHrDynamics;
  (window as any).promptResetShadowPredictions = promptResetShadowPredictions;
  (window as any).closeResetShadowPredictionsModal = closeResetShadowPredictionsModal;
  (window as any).confirmResetShadowPredictions = confirmResetShadowPredictions;
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
  loadEquipmentSettings,
  saveBikeEquipmentSelection,
  loadWorkoutSummaries,
  registerUiGlobals,
};
