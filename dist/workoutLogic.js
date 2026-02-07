import { getHrTargets } from "./workoutData.js";
import { todayName } from "./utils/dateTime.js";
const RING_CIRC = 339.292;
const RING_CIRC_LANDSCAPE = 407.1504;
function getRingCircumference() {
    return window.matchMedia("(orientation: landscape)").matches ? RING_CIRC_LANDSCAPE : RING_CIRC;
}
function getStartTime(day) {
    const dayToUse = day || todayName();
    return localStorage.getItem("start_" + dayToUse);
}
function isPaused(day) {
    const dayToUse = day || todayName();
    return localStorage.getItem("paused_" + dayToUse) === "true";
}
function getPausedElapsed(day) {
    const dayToUse = day || todayName();
    return parseInt(localStorage.getItem("paused_elapsed_" + dayToUse) || "0", 10);
}
function pauseWorkout(day, elapsedSec) {
    const dayToUse = day || todayName();
    localStorage.setItem("paused_" + dayToUse, "true");
    localStorage.setItem("paused_elapsed_" + dayToUse, String(elapsedSec !== null && elapsedSec !== void 0 ? elapsedSec : 0));
    if (typeof window.updateDisplay === "function")
        window.updateDisplay();
}
function resumeWorkout(day) {
    const dayToUse = day || todayName();
    const pausedElapsed = getPausedElapsed(dayToUse);
    const newStart = Date.now() - pausedElapsed * 1000;
    localStorage.setItem("start_" + dayToUse, String(newStart));
    localStorage.removeItem("paused_" + dayToUse);
    localStorage.removeItem("paused_elapsed_" + dayToUse);
    if (typeof window.updateDisplay === "function")
        window.updateDisplay();
}
function startWorkout() {
    const day = typeof window.getSelectedDay === "function" ? window.getSelectedDay() : todayName();
    const key = "start_" + day;
    const startTime = Date.now();
    localStorage.setItem(key, startTime.toString());
    if (typeof window.generateUUID === "function") {
        const sessionId = window.generateUUID();
        localStorage.setItem("session_id_" + day, sessionId);
        localStorage.setItem("session_start_" + day, startTime.toString());
        localStorage.setItem("summary_emitted_" + day, "false");
        if (typeof window.initDB === "function") {
            window.initDB().catch((err) => console.error("Failed to init DB:", err));
        }
    }
    if (typeof window.requestWakeLock === "function") {
        window.requestWakeLock();
    }
    if (typeof window.updateDisplay === "function")
        window.updateDisplay();
}
async function restartWorkout() {
    const day = typeof window.getSelectedDay === "function" ? window.getSelectedDay() : todayName();
    const key = "start_" + day;
    const startTime = localStorage.getItem(key);
    const sessionId = localStorage.getItem("session_id_" + day);
    const sessionStart = localStorage.getItem("session_start_" + day);
    const summaryEmitted = localStorage.getItem("summary_emitted_" + day);
    if (startTime && sessionId && sessionStart && summaryEmitted === "false" && typeof window.generateWorkoutSummary === "function") {
        const sessionStartTime = parseInt(sessionStart);
        const sessionAge = Date.now() - sessionStartTime;
        const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
        if (sessionAge > MAX_SESSION_AGE_MS) {
            console.warn(`Skipping stale workout session for ${day} (age: ${Math.round(sessionAge / (1000 * 60 * 60))} hours)`);
        }
        else {
            const endedAt = Date.now();
            try {
                const summary = await window.generateWorkoutSummary(sessionId, sessionStartTime, endedAt, day);
                await window.emitWorkoutSummary(summary);
            }
            catch (error) {
                console.error("Error emitting workout summary on cancel:", error);
                if (error.message && error.message.includes("exceeds maximum")) {
                    console.warn("Stale session detected, cleaning up...");
                }
            }
        }
    }
    if (typeof window.releaseWakeLock === "function") {
        await window.releaseWakeLock();
    }
    localStorage.removeItem(key);
    localStorage.removeItem("session_id_" + day);
    localStorage.removeItem("session_start_" + day);
    localStorage.removeItem("summary_emitted_" + day);
    localStorage.removeItem("paused_" + day);
    localStorage.removeItem("paused_elapsed_" + day);
    if (sessionId && typeof window.clearHrSamples === "function") {
        await window.clearHrSamples(sessionId).catch((err) => console.error("Error clearing HR samples:", err));
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
    // Decrementing ring: show remaining portion of circle (same direction as before, so color phases feel reversed)
    const visibleLength = ringCirc * (remaining / totalSec);
    ringEl.style.strokeDasharray = `${visibleLength} ${ringCirc}`;
    ringEl.style.strokeDashoffset = "0";
    const showSeconds = typeof window.getShowSecondsCountdown === "function" && window.getShowSecondsCountdown();
    if (center)
        center.textContent = formatTime(remaining, { showSeconds });
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
function initiateHrConnection() {
    navigator.bluetooth
        .requestDevice({ filters: [{ services: ["heart_rate"] }] })
        .then((device) => device.gatt.connect())
        .then((server) => server.getPrimaryService("heart_rate"))
        .then((service) => service.getCharacteristic("heart_rate_measurement"))
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
        const sessionId = localStorage.getItem("session_id_" + day);
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
