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
}
export { todayName, getStartTime, isPaused, getPausedElapsed, pauseWorkout, resumeWorkout, startWorkout, restartWorkout, getPhase, formatTime, adjustedBlockLengths, updateRing, hrTargetText, };
