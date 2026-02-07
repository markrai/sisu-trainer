import { getHrTargets } from "./workoutData.js";
import { todayName } from "./utils/dateTime.js";
import { PlanBlock } from "./types.js";

const RING_CIRC = 339.292;
const RING_CIRC_LANDSCAPE = 407.1504;

function getRingCircumference() {
  return window.matchMedia("(orientation: landscape)").matches ? RING_CIRC_LANDSCAPE : RING_CIRC;
}

function getStartTime(day?: string) {
  const dayToUse = day || todayName();
  return localStorage.getItem("start_" + dayToUse);
}

function isPaused(day?: string) {
  const dayToUse = day || todayName();
  return localStorage.getItem("paused_" + dayToUse) === "true";
}

function getPausedElapsed(day?: string) {
  const dayToUse = day || todayName();
  return parseInt(localStorage.getItem("paused_elapsed_" + dayToUse) || "0", 10);
}

function pauseWorkout(day?: string, elapsedSec?: number) {
  const dayToUse = day || todayName();
  localStorage.setItem("paused_" + dayToUse, "true");
  localStorage.setItem("paused_elapsed_" + dayToUse, String(elapsedSec ?? 0));
  if (typeof (window as any).updateDisplay === "function") (window as any).updateDisplay();
}

function resumeWorkout(day?: string) {
  const dayToUse = day || todayName();
  const pausedElapsed = getPausedElapsed(dayToUse);
  const newStart = Date.now() - pausedElapsed * 1000;
  localStorage.setItem("start_" + dayToUse, String(newStart));
  localStorage.removeItem("paused_" + dayToUse);
  localStorage.removeItem("paused_elapsed_" + dayToUse);
  if (typeof (window as any).updateDisplay === "function") (window as any).updateDisplay();
}

function startWorkout() {
  const day = typeof (window as any).getSelectedDay === "function" ? (window as any).getSelectedDay() : todayName();
  const key = "start_" + day;
  const startTime = Date.now();
  localStorage.setItem(key, startTime.toString());

  if (typeof (window as any).generateUUID === "function") {
    const sessionId = (window as any).generateUUID();
    localStorage.setItem("session_id_" + day, sessionId);
    localStorage.setItem("session_start_" + day, startTime.toString());
    localStorage.setItem("summary_emitted_" + day, "false");
    if (typeof (window as any).initDB === "function") {
      (window as any).initDB().catch((err: any) => console.error("Failed to init DB:", err));
    }
  }

  if (typeof (window as any).requestWakeLock === "function") {
    (window as any).requestWakeLock();
  }
  if (typeof (window as any).updateDisplay === "function") (window as any).updateDisplay();
}

async function restartWorkout() {
  const day = typeof (window as any).getSelectedDay === "function" ? (window as any).getSelectedDay() : todayName();
  const key = "start_" + day;
  const startTime = localStorage.getItem(key);
  const sessionId = localStorage.getItem("session_id_" + day);
  const sessionStart = localStorage.getItem("session_start_" + day);
  const summaryEmitted = localStorage.getItem("summary_emitted_" + day);

  if (startTime && sessionId && sessionStart && summaryEmitted === "false" && typeof (window as any).generateWorkoutSummary === "function") {
    const sessionStartTime = parseInt(sessionStart);
    const sessionAge = Date.now() - sessionStartTime;
    const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
    if (sessionAge > MAX_SESSION_AGE_MS) {
      console.warn(`Skipping stale workout session for ${day} (age: ${Math.round(sessionAge / (1000 * 60 * 60))} hours)`);
    } else {
      const endedAt = Date.now();
      try {
        const summary = await (window as any).generateWorkoutSummary(sessionId, sessionStartTime, endedAt, day);
        await (window as any).emitWorkoutSummary(summary);
      } catch (error: any) {
        console.error("Error emitting workout summary on cancel:", error);
        if (error.message && error.message.includes("exceeds maximum")) {
          console.warn("Stale session detected, cleaning up...");
        }
      }
    }
  }

  if (typeof (window as any).releaseWakeLock === "function") {
    await (window as any).releaseWakeLock();
  }

  localStorage.removeItem(key);
  localStorage.removeItem("session_id_" + day);
  localStorage.removeItem("session_start_" + day);
  localStorage.removeItem("summary_emitted_" + day);
  localStorage.removeItem("paused_" + day);
  localStorage.removeItem("paused_elapsed_" + day);

  if (sessionId && typeof (window as any).clearHrSamples === "function") {
    await (window as any).clearHrSamples(sessionId).catch((err: any) => console.error("Error clearing HR samples:", err));
  }

  if (typeof (window as any).updateDisplay === "function") (window as any).updateDisplay();
}

function getPhase(elapsedSec: number, blocks: PlanBlock) {
  const w = blocks.warm * 60;
  const s = blocks.sustain * 60;
  const c = blocks.cool * 60;
  if (elapsedSec < w) return { phase: "Warm-Up", timeLeft: w - elapsedSec, done: false };
  if (elapsedSec < w + s) {
    const day = typeof (window as any).getSelectedDay === "function" ? (window as any).getSelectedDay() : todayName();
    const dayHrTargets = getHrTargets()[day];
    if (dayHrTargets && dayHrTargets.intervals && dayHrTargets.intervals.phases) {
      const warmSec = blocks.warm * 60;
      const sustainElapsed = Math.max(0, elapsedSec - warmSec);
      const phases = dayHrTargets.intervals.phases;
      const isSequence = dayHrTargets.intervals.isSequence;
      let elapsedInPhases = sustainElapsed;
      if (isSequence) {
        const totalDuration = phases.reduce((sum, p) => sum + p.duration * 60, 0);
        elapsedInPhases = Math.min(sustainElapsed, totalDuration);
      } else {
        const cycleDuration = phases.reduce((sum, p) => sum + p.duration * 60, 0);
        elapsedInPhases = sustainElapsed % cycleDuration;
      }
      let accumulated = 0;
      for (let i = 0; i < phases.length; i++) {
        const phaseDuration = phases[i].duration * 60;
        if (elapsedInPhases < accumulated + phaseDuration) {
          const timeLeftInPhase = accumulated + phaseDuration - elapsedInPhases;
          return { phase: "Sustain", timeLeft: timeLeftInPhase, done: false };
        }
        accumulated += phaseDuration;
      }
    }
    return { phase: "Sustain", timeLeft: w + s - elapsedSec, done: false };
  }
  if (elapsedSec < w + s + c) return { phase: "Cool-Down", timeLeft: w + s + c - elapsedSec, done: false };
  return { phase: "Completed", timeLeft: 0, done: true };
}

function formatTime(sec: number, options?: { showSeconds?: boolean }) {
  const showSeconds = options && "showSeconds" in options ? !!options.showSeconds : true;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(h + "h");
  parts.push(m + "m");
  if (showSeconds) parts.push(s + "s");
  return parts.join(" ");
}

function getTodayHRV() {
  return null;
}

function adjustedBlockLengths(base: PlanBlock, _hrv: any) {
  return base;
}

function updateRing(elapsedSec: number, blocks: PlanBlock) {
  const ringEl = document.getElementById("ringProgress");
  const center = document.getElementById("ringCenterText");
  if (!(ringEl instanceof SVGCircleElement) || !blocks) return;
  const totalSec = (blocks.warm + blocks.sustain + blocks.cool) * 60;
  if (totalSec <= 0) return;
  const cappedElapsed = Math.max(0, Math.min(elapsedSec, totalSec));
  const remaining = totalSec - cappedElapsed;
  const ringCirc = getRingCircumference();
  // Decrementing ring: show remaining portion of circle (same direction as before, so color phases feel reversed)
  const visibleLength = ringCirc * (remaining / totalSec);
  ringEl.style.strokeDasharray = `${visibleLength} ${ringCirc}`;
  ringEl.style.strokeDashoffset = "0";
  const showSeconds =
    typeof (window as any).getShowSecondsCountdown === "function" && (window as any).getShowSecondsCountdown();
  if (center) center.textContent = formatTime(remaining, { showSeconds });
}

function hrTargetText(phaseName: string, day: string, elapsedSec: number, blocks: PlanBlock) {
  const dayHrTargets = getHrTargets()[day];
  if (!dayHrTargets) return "";
  if (phaseName === "Warm-Up") {
    if (dayHrTargets.warmup_subsections && Array.isArray(dayHrTargets.warmup_subsections)) {
      for (const subsection of dayHrTargets.warmup_subsections) {
        const startSec = subsection.start_min * 60;
        const endSec = subsection.end_min * 60;
        if (elapsedSec >= startSec && elapsedSec < endSec) {
          return subsection.target_hr_bpm + " bpm";
        }
      }
    }
    if (dayHrTargets.warmup) return dayHrTargets.warmup + " bpm";
  } else if (phaseName === "Cool-Down") {
    if (dayHrTargets.cooldown) return dayHrTargets.cooldown + " bpm";
  } else if (phaseName === "Sustain") {
    if (dayHrTargets.intervals && dayHrTargets.intervals.phases) {
      const warmSec = blocks.warm * 60;
      const sustainElapsed = Math.max(0, elapsedSec - warmSec);
      const phases = dayHrTargets.intervals.phases;
      const isSequence = dayHrTargets.intervals.isSequence;
      let elapsedInPhases = sustainElapsed;
      if (isSequence) {
        const totalDuration = phases.reduce((sum, p) => sum + p.duration * 60, 0);
        elapsedInPhases = Math.min(sustainElapsed, totalDuration);
      } else {
        const cycleDuration = phases.reduce((sum, p) => sum + p.duration * 60, 0);
        elapsedInPhases = sustainElapsed % cycleDuration;
      }
      let accumulated = 0;
      for (let i = 0; i < phases.length; i++) {
        const phaseDuration = phases[i].duration * 60;
        if (elapsedInPhases < accumulated + phaseDuration) {
          if (phases[i].target_hr_bpm) return phases[i].target_hr_bpm + " bpm";
          break;
        }
        accumulated += phaseDuration;
      }
    } else if (dayHrTargets.main_set) {
      return dayHrTargets.main_set + " bpm";
    }
  }
  return "";
}

// Minimal Web Bluetooth typing guard
type BluetoothDevice = any;

function initiateHrConnection() {
  (navigator as any).bluetooth
    .requestDevice({ filters: [{ services: ["heart_rate"] }] })
    .then((device: BluetoothDevice) => device.gatt.connect())
    .then((server: any) => server.getPrimaryService("heart_rate"))
    .then((service: any) => service.getCharacteristic("heart_rate_measurement"))
    .then((characteristic: any) => characteristic.startNotifications())
    .then((characteristic: any) => {
      characteristic.addEventListener("characteristicvaluechanged", handleCharacteristicValueChanged);
    })
    .catch((error: any) => console.error(error));
}

function parseHrValue(value: any) {
  value = value.buffer ? value : new DataView(value);
  const flags = value.getUint8(0);
  const rate16Bits = flags & 0x1;
  let index = 1;
  if (rate16Bits) {
    const heartRate = value.getUint16(index, true);
    return heartRate;
  } else {
    const heartRate = value.getUint8(index);
    return heartRate;
  }
}

function handleCharacteristicValueChanged(event: any) {
  const hr = parseHrValue(event.target.value);
  if (typeof (window as any).updateHrDisplay === "function") {
    (window as any).updateHrDisplay(hr);
  }
  (window as any).liveBpm = hr;
  (window as any).lastBpmUpdateTime = Date.now();
  if (typeof (window as any).updateHeartPulse === "function") (window as any).updateHeartPulse(hr);
  const hrTargetEl = document.getElementById("hrTarget");
  if (hrTargetEl && typeof (window as any).updateHeartColor === "function") {
    (window as any).updateHeartColor(hr, hrTargetEl.textContent);
  }
  const day = typeof (window as any).getSelectedDay === "function" ? (window as any).getSelectedDay() : todayName();
  const startTime = getStartTime(day);
  if (startTime && typeof (window as any).storeHrSample === "function") {
    const sessionId = localStorage.getItem("session_id_" + day);
    if (sessionId) {
      const elapsedSec = Math.floor((Date.now() - parseInt(startTime)) / 1000);
      (window as any)
        .storeHrSample(sessionId, elapsedSec, hr)
        .catch((err: any) => console.error("Error storing HR sample:", err));
    }
  }
}

export function registerWorkoutLogicGlobals() {
  (window as any).todayName = todayName;
  (window as any).getStartTime = getStartTime;
  (window as any).isPaused = isPaused;
  (window as any).getPausedElapsed = getPausedElapsed;
  (window as any).pauseWorkout = pauseWorkout;
  (window as any).resumeWorkout = resumeWorkout;
  (window as any).startWorkout = startWorkout;
  (window as any).restartWorkout = restartWorkout;
  (window as any).getPhase = getPhase;
  (window as any).formatTime = formatTime;
  (window as any).getTodayHRV = getTodayHRV;
  (window as any).adjustedBlockLengths = adjustedBlockLengths;
  (window as any).updateRing = updateRing;
  (window as any).hrTargetText = hrTargetText;
  (window as any).initiateHrConnection = initiateHrConnection;
}

export {
  todayName,
  getStartTime,
  isPaused,
  getPausedElapsed,
  pauseWorkout,
  resumeWorkout,
  startWorkout,
  restartWorkout,
  getPhase,
  formatTime,
  adjustedBlockLengths,
  updateRing,
  hrTargetText,
  initiateHrConnection,
};
