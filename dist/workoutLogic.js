import { getHrTargets } from "./workoutData.js";
import { todayName } from "./utils/dateTime.js";
import { getSession, startSession, pauseSession, resumeSession, clearSession } from "./sessionStore.js";
import { handleWorkoutCancellation } from "./workoutLifecycle.js";
const RING_CIRC = 339.292;
const RING_CIRC_LANDSCAPE = 407.1504;
function getRingCircumference() {
    return window.matchMedia("(orientation: landscape)").matches ? RING_CIRC_LANDSCAPE : RING_CIRC;
}
function getStartTime(day) {
    const dayToUse = day || todayName();
    return getSession(dayToUse).startTime;
}
function isPaused(day) {
    const dayToUse = day || todayName();
    return getSession(dayToUse).paused;
}
function getPausedElapsed(day) {
    const dayToUse = day || todayName();
    return getSession(dayToUse).pausedElapsed;
}
function pauseWorkout(day, elapsedSec) {
    const dayToUse = day || todayName();
    pauseSession(dayToUse, elapsedSec !== null && elapsedSec !== void 0 ? elapsedSec : 0);
    if (typeof window.updateDisplay === "function")
        window.updateDisplay();
}
function resumeWorkout(day) {
    const dayToUse = day || todayName();
    resumeSession(dayToUse);
    if (typeof window.updateDisplay === "function")
        window.updateDisplay();
}
function startWorkout() {
    const day = typeof window.getSelectedDay === "function" ? window.getSelectedDay() : todayName();
    const startTime = Date.now();
    if (typeof window.generateUUID === "function") {
        const sessionId = window.generateUUID();
        startSession(day, startTime, sessionId);
        if (typeof window.initDB === "function") {
            window.initDB().catch((err) => console.error("Failed to init DB:", err));
        }
    }
    else {
        startSession(day, startTime, null);
    }
    if (typeof window.requestWakeLock === "function") {
        window.requestWakeLock();
    }
    if (typeof window.updateDisplay === "function")
        window.updateDisplay();
}
async function restartWorkout() {
    const day = typeof window.getSelectedDay === "function" ? window.getSelectedDay() : todayName();
    const session = getSession(day);
    await handleWorkoutCancellation(day);
    if (typeof window.releaseWakeLock === "function") {
        await window.releaseWakeLock();
    }
    clearSession(day);
    if (session.sessionId && typeof window.clearHrSamples === "function") {
        await window.clearHrSamples(session.sessionId).catch((err) => console.error("Error clearing HR samples:", err));
    }
    if (typeof window.updateDisplay === "function")
        window.updateDisplay();
}
function getPhase(elapsedSec, blocks) {
    const w = blocks.warm * 60;
    const s = blocks.sustain * 60;
    const c = blocks.cool * 60;
    if (elapsedSec < w)
        return { phase: "Warm-Up", timeLeft: w - elapsedSec, done: false };
    if (elapsedSec < w + s) {
        const day = typeof window.getSelectedDay === "function" ? window.getSelectedDay() : todayName();
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
            }
            else {
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
    if (elapsedSec < w + s + c)
        return { phase: "Cool-Down", timeLeft: w + s + c - elapsedSec, done: false };
    return { phase: "Completed", timeLeft: 0, done: true };
}
function formatTime(sec, options) {
    const showSeconds = options && "showSeconds" in options ? !!options.showSeconds : true;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const parts = [];
    if (h > 0)
        parts.push(h + "h");
    parts.push(m + "m");
    if (showSeconds)
        parts.push(s + "s");
    return parts.join(" ");
}
function getTodayHRV() {
    return null;
}
function adjustedBlockLengths(base, _hrv) {
    return base;
}
function updateRing(elapsedSec, blocks) {
    const ringEl = document.getElementById("ringProgress");
    const center = document.getElementById("ringCenterText");
    if (!(ringEl instanceof SVGCircleElement) || !blocks)
        return;
    const totalSec = (blocks.warm + blocks.sustain + blocks.cool) * 60;
    if (totalSec <= 0)
        return;
    const cappedElapsed = Math.max(0, Math.min(elapsedSec, totalSec));
    const remaining = totalSec - cappedElapsed;
    const ringCirc = getRingCircumference();
    const showElapsed = typeof window.getShowElapsed === "function" && window.getShowElapsed();
    if (showElapsed) {
        // Increasing ring: fill as elapsed time grows (phase colors match progress)
        const progress = cappedElapsed / totalSec;
        const offset = ringCirc * (1 - progress);
        ringEl.style.strokeDasharray = String(ringCirc);
        ringEl.style.strokeDashoffset = String(offset);
    }
    else {
        // Decrementing ring: show remaining portion
        const visibleLength = ringCirc * (remaining / totalSec);
        ringEl.style.strokeDasharray = `${visibleLength} ${ringCirc}`;
        ringEl.style.strokeDashoffset = "0";
    }
    const showSeconds = typeof window.getShowSecondsCountdown === "function" && window.getShowSecondsCountdown();
    const labelEl = document.getElementById("ringCenterLabel");
    if (center)
        center.textContent = formatTime(showElapsed ? cappedElapsed : remaining, { showSeconds });
    if (labelEl)
        labelEl.textContent = showElapsed ? "total elapsed" : "total remaining";
}
function hrTargetText(phaseName, day, elapsedSec, blocks) {
    const dayHrTargets = getHrTargets()[day];
    if (!dayHrTargets)
        return "";
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
        if (dayHrTargets.warmup)
            return dayHrTargets.warmup + " bpm";
    }
    else if (phaseName === "Cool-Down") {
        if (dayHrTargets.cooldown)
            return dayHrTargets.cooldown + " bpm";
    }
    else if (phaseName === "Sustain") {
        if (dayHrTargets.intervals && dayHrTargets.intervals.phases) {
            const warmSec = blocks.warm * 60;
            const sustainElapsed = Math.max(0, elapsedSec - warmSec);
            const phases = dayHrTargets.intervals.phases;
            const isSequence = dayHrTargets.intervals.isSequence;
            let elapsedInPhases = sustainElapsed;
            if (isSequence) {
                const totalDuration = phases.reduce((sum, p) => sum + p.duration * 60, 0);
                elapsedInPhases = Math.min(sustainElapsed, totalDuration);
            }
            else {
                const cycleDuration = phases.reduce((sum, p) => sum + p.duration * 60, 0);
                elapsedInPhases = sustainElapsed % cycleDuration;
            }
            let accumulated = 0;
            for (let i = 0; i < phases.length; i++) {
                const phaseDuration = phases[i].duration * 60;
                if (elapsedInPhases < accumulated + phaseDuration) {
                    if (phases[i].target_hr_bpm)
                        return phases[i].target_hr_bpm + " bpm";
                    break;
                }
                accumulated += phaseDuration;
            }
        }
        else if (dayHrTargets.main_set) {
            return dayHrTargets.main_set + " bpm";
        }
    }
    return "";
}
let currentHrDevice = null;
const BATTERY_POLL_MS = 2 * 60 * 1000; // 2 minutes
let batteryPollIntervalId = null;
function bleDebugEnabled() {
    try {
        return localStorage.getItem("bleDebug") === "true";
    }
    catch {
        return false;
    }
}
function onHrDisconnect() {
    if (batteryPollIntervalId !== null) {
        clearInterval(batteryPollIntervalId);
        batteryPollIntervalId = null;
    }
    currentHrDevice = null;
    window.hrDeviceName = null;
    window.hrBatteryPercent = null;
    if (typeof window.updateHrMonitorStatus === "function")
        window.updateHrMonitorStatus();
}
function pollBatteryOnce() {
    var _a;
    const device = currentHrDevice;
    if (!((_a = device === null || device === void 0 ? void 0 : device.gatt) === null || _a === void 0 ? void 0 : _a.connected))
        return;
    device.gatt
        .getPrimaryService("battery_service")
        .then((s) => s.getCharacteristic("battery_level").readValue())
        .then((value) => {
        const dv = value instanceof DataView ? value : new DataView(value instanceof ArrayBuffer ? value : value.buffer);
        const pct = dv.getUint8(0);
        if (pct >= 0 && pct <= 100) {
            window.hrBatteryPercent = pct;
            if (typeof window.updateHrMonitorStatus === "function")
                window.updateHrMonitorStatus();
        }
    })
        .catch(() => { });
}
function startBatteryPolling() {
    if (batteryPollIntervalId !== null)
        return;
    batteryPollIntervalId = setInterval(pollBatteryOnce, BATTERY_POLL_MS);
}
async function dumpGattProfile(server) {
    if (!bleDebugEnabled())
        return;
    try {
        const services = await server.getPrimaryServices();
        console.log("[BLE] Primary services:", services.map((s) => s.uuid));
        for (const service of services) {
            try {
                const chars = await service.getCharacteristics();
                console.log(`[BLE] Service ${service.uuid} characteristics:`, chars.map((c) => c.uuid));
                for (const ch of chars) {
                    try {
                        console.log(`[BLE]  - Char ${ch.uuid} props`, ch.properties);
                    }
                    catch {
                        // ignore
                    }
                }
            }
            catch (e) {
                console.log("[BLE] Could not enumerate characteristics for service", service.uuid, e);
            }
        }
    }
    catch (e) {
        console.log("[BLE] Could not enumerate primary services", e);
    }
}
function dataViewFromReadValue(value) {
    if (value instanceof DataView)
        return value;
    if (value instanceof ArrayBuffer)
        return new DataView(value);
    if (value && value.buffer instanceof ArrayBuffer)
        return new DataView(value.buffer);
    return new DataView(new ArrayBuffer(0));
}
async function readBatteryPercentStandardBas(server) {
    var _a;
    // Standard GATT Battery Service (0x180F) / Battery Level (0x2A19)
    const batteryService = await server.getPrimaryService("battery_service");
    const batteryChar = await batteryService.getCharacteristic("battery_level");
    // Prefer notifications if supported (keeps UI updated if device changes it)
    try {
        if ((_a = batteryChar === null || batteryChar === void 0 ? void 0 : batteryChar.properties) === null || _a === void 0 ? void 0 : _a.notify) {
            await batteryChar.startNotifications();
            batteryChar.addEventListener("characteristicvaluechanged", (event) => {
                var _a;
                try {
                    const dv = dataViewFromReadValue((_a = event === null || event === void 0 ? void 0 : event.target) === null || _a === void 0 ? void 0 : _a.value);
                    const v = dv.getUint8(0);
                    if (v >= 0 && v <= 100) {
                        window.hrBatteryPercent = v;
                        if (typeof window.updateHrMonitorStatus === "function")
                            window.updateHrMonitorStatus();
                    }
                }
                catch {
                    // ignore
                }
            });
        }
    }
    catch {
        // ignore; we can still do a one-shot read below
    }
    const dv = dataViewFromReadValue(await batteryChar.readValue());
    const percent = dv.getUint8(0);
    return percent >= 0 && percent <= 100 ? percent : null;
}
const BATTERY_PROBES = [
    { name: "standard_bas_180f_2a19", read: (server) => readBatteryPercentStandardBas(server) },
    // Add vendor-specific probes here as we discover them.
];
async function readBatteryPercentWithProbes(server, device) {
    for (const probe of BATTERY_PROBES) {
        try {
            const v = await probe.read(server, device);
            if (typeof v === "number" && v >= 0 && v <= 100) {
                if (bleDebugEnabled())
                    console.log("[BLE] Battery probe success:", probe.name, v);
                return v;
            }
            if (bleDebugEnabled())
                console.log("[BLE] Battery probe returned null:", probe.name);
        }
        catch (e) {
            if (bleDebugEnabled())
                console.log("[BLE] Battery probe failed:", probe.name, e);
        }
    }
    return null;
}
function initiateHrConnection() {
    const bt = navigator.bluetooth;
    if (!bt || typeof bt.requestDevice !== "function") {
        console.error("Web Bluetooth API not available: navigator.bluetooth is missing.");
        if (typeof window.showToast === "function") {
            window.showToast("Bluetooth not supported in this browser. Use Chrome/Edge on HTTPS (or localhost).");
        }
        return;
    }
    bt.requestDevice({
        filters: [{ services: ["heart_rate"] }],
        // Request access to extra services up-front so we can probe battery (and inspect services in debug mode).
        optionalServices: ["battery_service", "device_information"],
    })
        .then((device) => {
        currentHrDevice = device;
        device.addEventListener("gattserverdisconnected", onHrDisconnect);
        return device.gatt.connect().then((server) => ({ device, server }));
    })
        .then(({ device, server }) => {
        window.hrDeviceName = device.name || "Heart rate sensor";
        if (typeof window.updateHrMonitorStatus === "function")
            window.updateHrMonitorStatus();
        dumpGattProfile(server);
        readBatteryPercentWithProbes(server, device)
            .then((battery) => {
            window.hrBatteryPercent = battery;
            if (typeof window.updateHrMonitorStatus === "function")
                window.updateHrMonitorStatus();
            if (battery !== null)
                startBatteryPolling();
        })
            .catch(() => {
            window.hrBatteryPercent = null;
            if (typeof window.updateHrMonitorStatus === "function")
                window.updateHrMonitorStatus();
        });
        return server.getPrimaryService("heart_rate").then((hrService) => ({ server, hrService }));
    })
        .then(({ hrService }) => hrService.getCharacteristic("heart_rate_measurement"))
        .then((characteristic) => characteristic.startNotifications())
        .then((characteristic) => {
        characteristic.addEventListener("characteristicvaluechanged", handleCharacteristicValueChanged);
    })
        .catch((error) => console.error(error));
}
function parseHrValue(value) {
    value = value.buffer ? value : new DataView(value);
    const flags = value.getUint8(0);
    const rate16Bits = flags & 0x1;
    let index = 1;
    if (rate16Bits) {
        const heartRate = value.getUint16(index, true);
        return heartRate;
    }
    else {
        const heartRate = value.getUint8(index);
        return heartRate;
    }
}
function handleCharacteristicValueChanged(event) {
    const hr = parseHrValue(event.target.value);
    if (typeof window.updateHrDisplay === "function") {
        window.updateHrDisplay(hr);
    }
    window.liveBpm = hr;
    window.lastBpmUpdateTime = Date.now();
    if (typeof window.updateHeartPulse === "function")
        window.updateHeartPulse(hr);
    const hrTargetEl = document.getElementById("hrTarget");
    if (hrTargetEl && typeof window.updateHeartColor === "function") {
        window.updateHeartColor(hr, hrTargetEl.textContent);
    }
    const day = typeof window.getSelectedDay === "function" ? window.getSelectedDay() : todayName();
    const startTime = getStartTime(day);
    if (startTime && typeof window.storeHrSample === "function") {
        const sessionId = getSession(day).sessionId;
        if (sessionId) {
            const elapsedSec = Math.floor((Date.now() - parseInt(startTime)) / 1000);
            window
                .storeHrSample(sessionId, elapsedSec, hr)
                .catch((err) => console.error("Error storing HR sample:", err));
        }
    }
}
export function registerWorkoutLogicGlobals() {
    window.todayName = todayName;
    window.getStartTime = getStartTime;
    window.isPaused = isPaused;
    window.getPausedElapsed = getPausedElapsed;
    window.pauseWorkout = pauseWorkout;
    window.resumeWorkout = resumeWorkout;
    window.startWorkout = startWorkout;
    window.restartWorkout = restartWorkout;
    window.getPhase = getPhase;
    window.formatTime = formatTime;
    window.getTodayHRV = getTodayHRV;
    window.adjustedBlockLengths = adjustedBlockLengths;
    window.updateRing = updateRing;
    window.hrTargetText = hrTargetText;
    window.initiateHrConnection = initiateHrConnection;
}
export { todayName, getStartTime, isPaused, getPausedElapsed, pauseWorkout, resumeWorkout, startWorkout, restartWorkout, getPhase, formatTime, adjustedBlockLengths, updateRing, hrTargetText, initiateHrConnection, };
