import { getHrTargets } from "./workoutData.js";
import { todayName } from "./utils/dateTime.js";
import { PlanBlock } from "./types.js";
import { getSession, startSession, pauseSession, resumeSession, clearSession } from "./sessionStore.js";
import { handleWorkoutCancellation } from "./workoutLifecycle.js";

const RING_CIRC = 339.292;
const RING_CIRC_LANDSCAPE = 407.1504;

function getRingCircumference() {
  return window.matchMedia("(orientation: landscape)").matches ? RING_CIRC_LANDSCAPE : RING_CIRC;
}

function getStartTime(day?: string) {
  const dayToUse = day || todayName();
  return getSession(dayToUse).startTime;
}

function isPaused(day?: string) {
  const dayToUse = day || todayName();
  return getSession(dayToUse).paused;
}

function getPausedElapsed(day?: string) {
  const dayToUse = day || todayName();
  return getSession(dayToUse).pausedElapsed;
}

function pauseWorkout(day?: string, elapsedSec?: number) {
  const dayToUse = day || todayName();
  pauseSession(dayToUse, elapsedSec ?? 0);
  if (typeof (window as any).updateDisplay === "function") (window as any).updateDisplay();
}

function resumeWorkout(day?: string) {
  const dayToUse = day || todayName();
  resumeSession(dayToUse);
  if (typeof (window as any).updateDisplay === "function") (window as any).updateDisplay();
}

function startWorkout() {
  const day = typeof (window as any).getSelectedDay === "function" ? (window as any).getSelectedDay() : todayName();
  const startTime = Date.now();
  if (typeof (window as any).generateUUID === "function") {
    const sessionId = (window as any).generateUUID();
    startSession(day, startTime, sessionId);
    if (typeof (window as any).initDB === "function") {
      (window as any).initDB().catch((err: any) => console.error("Failed to init DB:", err));
    }
  } else {
    startSession(day, startTime, null);
  }

  if (typeof (window as any).requestWakeLock === "function") {
    (window as any).requestWakeLock();
  }
  if (typeof (window as any).updateDisplay === "function") (window as any).updateDisplay();
}

async function restartWorkout() {
  const day = typeof (window as any).getSelectedDay === "function" ? (window as any).getSelectedDay() : todayName();
  const session = getSession(day);

  await handleWorkoutCancellation(day);

  if (typeof (window as any).releaseWakeLock === "function") {
    await (window as any).releaseWakeLock();
  }

  clearSession(day);

  if (session.sessionId && typeof (window as any).clearHrSamples === "function") {
    await (window as any).clearHrSamples(session.sessionId).catch((err: any) => console.error("Error clearing HR samples:", err));
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
  const showElapsed = typeof (window as any).getShowElapsed === "function" && (window as any).getShowElapsed();

  if (showElapsed) {
    // Increasing ring: fill as elapsed time grows (phase colors match progress)
    const progress = cappedElapsed / totalSec;
    const offset = ringCirc * (1 - progress);
    ringEl.style.strokeDasharray = String(ringCirc);
    ringEl.style.strokeDashoffset = String(offset);
  } else {
    // Decrementing ring: show remaining portion
    const visibleLength = ringCirc * (remaining / totalSec);
    ringEl.style.strokeDasharray = `${visibleLength} ${ringCirc}`;
    ringEl.style.strokeDashoffset = "0";
  }

  const showSeconds =
    typeof (window as any).getShowSecondsCountdown === "function" && (window as any).getShowSecondsCountdown();
  const labelEl = document.getElementById("ringCenterLabel");
  if (center) center.textContent = formatTime(showElapsed ? cappedElapsed : remaining, { showSeconds });
  if (labelEl) labelEl.textContent = showElapsed ? "total elapsed" : "total remaining";
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

let currentHrDevice: BluetoothDevice | null = null;
const BATTERY_POLL_MS = 2 * 60 * 1000; // 2 minutes
let batteryPollIntervalId: ReturnType<typeof setInterval> | null = null;

function bleDebugEnabled() {
  try {
    return localStorage.getItem("bleDebug") === "true";
  } catch {
    return false;
  }
}

function onHrDisconnect() {
  if (batteryPollIntervalId !== null) {
    clearInterval(batteryPollIntervalId);
    batteryPollIntervalId = null;
  }
  currentHrDevice = null;
  (window as any).hrDeviceName = null;
  (window as any).hrBatteryPercent = null;
  if (typeof (window as any).updateHrMonitorStatus === "function") (window as any).updateHrMonitorStatus();
}

function pollBatteryOnce() {
  const device = currentHrDevice;
  if (!device?.gatt?.connected) return;
  device.gatt
    .getPrimaryService("battery_service")
    .then((s: any) => s.getCharacteristic("battery_level").readValue())
    .then((value: ArrayBuffer | DataView) => {
      const dv = value instanceof DataView ? value : new DataView(value instanceof ArrayBuffer ? value : (value as any).buffer);
      const pct = dv.getUint8(0);
      if (pct >= 0 && pct <= 100) {
        (window as any).hrBatteryPercent = pct;
        if (typeof (window as any).updateHrMonitorStatus === "function") (window as any).updateHrMonitorStatus();
      }
    })
    .catch(() => {});
}

function startBatteryPolling() {
  if (batteryPollIntervalId !== null) return;
  batteryPollIntervalId = setInterval(pollBatteryOnce, BATTERY_POLL_MS);
}

async function dumpGattProfile(server: any) {
  if (!bleDebugEnabled()) return;
  try {
    const services = await server.getPrimaryServices();
    console.log("[BLE] Primary services:", services.map((s: any) => s.uuid));
    for (const service of services) {
      try {
        const chars = await service.getCharacteristics();
        console.log(`[BLE] Service ${service.uuid} characteristics:`, chars.map((c: any) => c.uuid));
        for (const ch of chars) {
          try {
            console.log(`[BLE]  - Char ${ch.uuid} props`, ch.properties);
          } catch {
            // ignore
          }
        }
      } catch (e) {
        console.log("[BLE] Could not enumerate characteristics for service", service.uuid, e);
      }
    }
  } catch (e) {
    console.log("[BLE] Could not enumerate primary services", e);
  }
}

function dataViewFromReadValue(value: any): DataView {
  if (value instanceof DataView) return value;
  if (value instanceof ArrayBuffer) return new DataView(value);
  if (value && value.buffer instanceof ArrayBuffer) return new DataView(value.buffer);
  return new DataView(new ArrayBuffer(0));
}

async function readBatteryPercentStandardBas(server: any): Promise<number | null> {
  // Standard GATT Battery Service (0x180F) / Battery Level (0x2A19)
  const batteryService = await server.getPrimaryService("battery_service");
  const batteryChar = await batteryService.getCharacteristic("battery_level");

  // Prefer notifications if supported (keeps UI updated if device changes it)
  try {
    if (batteryChar?.properties?.notify) {
      await batteryChar.startNotifications();
      batteryChar.addEventListener("characteristicvaluechanged", (event: any) => {
        try {
          const dv = dataViewFromReadValue(event?.target?.value);
          const v = dv.getUint8(0);
          if (v >= 0 && v <= 100) {
            (window as any).hrBatteryPercent = v;
            if (typeof (window as any).updateHrMonitorStatus === "function") (window as any).updateHrMonitorStatus();
          }
        } catch {
          // ignore
        }
      });
    }
  } catch {
    // ignore; we can still do a one-shot read below
  }

  const dv = dataViewFromReadValue(await batteryChar.readValue());
  const percent = dv.getUint8(0);
  return percent >= 0 && percent <= 100 ? percent : null;
}

type BatteryProbe = {
  name: string;
  read: (server: any, device?: BluetoothDevice) => Promise<number | null>;
};

const BATTERY_PROBES: BatteryProbe[] = [
  { name: "standard_bas_180f_2a19", read: (server) => readBatteryPercentStandardBas(server) },
  // Add vendor-specific probes here as we discover them.
];

async function readBatteryPercentWithProbes(server: any, device?: BluetoothDevice): Promise<number | null> {
  for (const probe of BATTERY_PROBES) {
    try {
      const v = await probe.read(server, device);
      if (typeof v === "number" && v >= 0 && v <= 100) {
        if (bleDebugEnabled()) console.log("[BLE] Battery probe success:", probe.name, v);
        return v;
      }
      if (bleDebugEnabled()) console.log("[BLE] Battery probe returned null:", probe.name);
    } catch (e) {
      if (bleDebugEnabled()) console.log("[BLE] Battery probe failed:", probe.name, e);
    }
  }
  return null;
}

function initiateHrConnection() {
  const bt = (navigator as any).bluetooth as { requestDevice?: Function } | undefined;
  if (!bt || typeof bt.requestDevice !== "function") {
    console.error("Web Bluetooth API not available: navigator.bluetooth is missing.");
    if (typeof (window as any).showToast === "function") {
      (window as any).showToast("Bluetooth not supported in this browser. Use Chrome/Edge on HTTPS (or localhost).");
    }
    return;
  }

  bt.requestDevice({
      filters: [{ services: ["heart_rate"] }],
      // Request access to extra services up-front so we can probe battery (and inspect services in debug mode).
      optionalServices: ["battery_service", "device_information"],
    })
    .then((device: BluetoothDevice) => {
      currentHrDevice = device;
      device.addEventListener("gattserverdisconnected", onHrDisconnect);
      return device.gatt.connect().then((server: any) => ({ device, server }));
    })
    .then(({ device, server }: { device: BluetoothDevice; server: any }) => {
      (window as any).hrDeviceName = device.name || "Heart rate sensor";
      if (typeof (window as any).updateHrMonitorStatus === "function") (window as any).updateHrMonitorStatus();
      dumpGattProfile(server);
      readBatteryPercentWithProbes(server, device)
        .then((battery) => {
          (window as any).hrBatteryPercent = battery;
          if (typeof (window as any).updateHrMonitorStatus === "function") (window as any).updateHrMonitorStatus();
          if (battery !== null) startBatteryPolling();
        })
        .catch(() => {
          (window as any).hrBatteryPercent = null;
          if (typeof (window as any).updateHrMonitorStatus === "function") (window as any).updateHrMonitorStatus();
        });
      return server.getPrimaryService("heart_rate").then((hrService: any) => ({ server, hrService }));
    })
    .then(({ hrService }: { server: any; hrService: any }) => hrService.getCharacteristic("heart_rate_measurement"))
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
    const sessionId = getSession(day).sessionId;
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
