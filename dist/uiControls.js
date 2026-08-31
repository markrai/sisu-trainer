import { adjustedBlockLengths, beginWorkout, formatTime, getPhase, getPausedElapsed, getStartTime, isPaused, pauseWorkout, restartWorkout, resumeWorkout, requestEarlyCooldown, planEarlyCooldownTransition, lastPersistedElapsedFromHrSamples, workoutRelativeHrSample, startWorkout, todayName, hrTargetText, parseHrTargetRange, updateRing, tickVo2ProtocolWithCanonicalHr, } from "./workoutLogic.js";
import { getPlan, getWorkoutMetadata } from "./workoutData.js";
import { getAllWorkoutSummaries, deleteWorkoutSummary, getHrSamples } from "./workoutStorage.js";
import { sendWorkoutToSisu } from "./sisuSync.js";
import { handleWorkoutCompletion } from "./workoutLifecycle.js";
import { connect as hrConnect, disconnect as hrDisconnect, onBpm } from "./hrMonitor.js";
import { getSession } from "./sessionStore.js";
import { isVo2WorkoutSelector, vo2ProtocolDisplayName, vo2ProtocolHoldForPhase, vo2ProtocolUiTargets, VO2_WORKOUT_LABEL, VO2_WORKOUT_SELECTOR_ID, } from "./vo2Protocol.js";
import { startDownregulationView, stopDownregulationView } from "./downregulation/index.js";
import { listMachinesForActivity, isMachineId } from "./machines/registry.js";
import { formatBikeBridgeControl, formatBikeBridgeNumber, formatBikeBridgeReadiness, getBikeBridgeSession, } from "./platform/bikeBridgeRuntime.js";
import { getEquipmentSelection, setSelectedMachine } from "./machines/selection.js";
import { recordMachineHeartRateSample, updateMachineGuidanceRuntime, } from "./machines/runtime.js";
import { formatLearnedGuidanceLabel, listLearnedStarts, resetLearnedGuidanceForMachine, } from "./machines/learning/index.js";
import { listHrDynamics, resetHrDynamicsForMachine, } from "./machines/dynamics/index.js";
import { listShadowPredictions, resetShadowPredictionsForMachine, shadowValidationStatusLabel, } from "./machines/prediction/index.js";
import { buildMachineDiagnosticsSnapshot, prepareMachineDiagnosticsExport, } from "./machines/diagnostics/index.js";
import { ACTIVITY_LABELS, getActiveWorkoutActivity } from "./workoutActivity.js";
let selectedDay = null;
let liveBpm = null;
let lastBpmUpdateTime = null;
const BPM_TIMEOUT_MS = 3000;
let showElapsedInRing = false;
let pendingVo2Cues = [];
let heartPulseTargetBpm = null;
let heartPulseRafId = null;
const HEART_PULSE_SCALE = 1.15;
function heartPulseLoop() {
    heartPulseRafId = null;
    const heartIcon = document.getElementById("heartIcon");
    if (!heartIcon || heartPulseTargetBpm === null) {
        if (heartIcon)
            heartIcon.style.setProperty("transform", "scale(1)", "important");
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
window.liveBpm = liveBpm;
window.lastBpmUpdateTime = lastBpmUpdateTime;
let phaseDisplayEl = null;
let settingsModalEscHandler = null;
function getSelectedDay() {
    return selectedDay || todayName();
}
function setSelectedDay(day) {
    selectedDay = day;
}
function ensureWorkoutDayDropdown() {
    const select = document.getElementById("workoutDaySelect");
    if (!select)
        return;
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const plan = typeof getPlan === "function" ? getPlan() : {};
    const metadata = typeof getWorkoutMetadata === "function" ? getWorkoutMetadata() : {};
    if (select.options.length === 0) {
        days.forEach((day) => {
            const opt = document.createElement("option");
            opt.value = day;
            const meta = metadata[day];
            opt.textContent = meta && meta.type ? day + ": " + meta.type : day;
            select.appendChild(opt);
        });
        const vo2Opt = document.createElement("option");
        vo2Opt.value = VO2_WORKOUT_SELECTOR_ID;
        vo2Opt.textContent = VO2_WORKOUT_LABEL;
        select.appendChild(vo2Opt);
        const downregOpt = document.createElement("option");
        downregOpt.value = "Downregulation";
        downregOpt.textContent = "Downregulation";
        select.appendChild(downregOpt);
        select.addEventListener("change", function () {
            selectedDay = this.value;
            updateDisplay();
        });
    }
    const hasVo2 = Array.from(select.options).some((o) => o.value === VO2_WORKOUT_SELECTOR_ID);
    if (!hasVo2) {
        const vo2Opt = document.createElement("option");
        vo2Opt.value = VO2_WORKOUT_SELECTOR_ID;
        vo2Opt.textContent = VO2_WORKOUT_LABEL;
        const downreg = Array.from(select.options).find((o) => o.value === "Downregulation");
        if (downreg)
            select.insertBefore(vo2Opt, downreg);
        else
            select.appendChild(vo2Opt);
    }
    const hasDownreg = Array.from(select.options).some((o) => o.value === "Downregulation");
    if (!hasDownreg) {
        const downregOpt = document.createElement("option");
        downregOpt.value = "Downregulation";
        downregOpt.textContent = "Downregulation";
        select.appendChild(downregOpt);
    }
    const current = getSelectedDay();
    if (select.value !== current)
        select.value = current;
}
function connectHr() {
    const connected = !!window.hrDeviceName;
    if (connected) {
        hrDisconnect();
    }
    else {
        hrConnect();
    }
}
function applyBatteryToElement(batteryEl, battery) {
    if (!batteryEl)
        return;
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
    }
    else {
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
    const name = window.hrDeviceName;
    const battery = window.hrBatteryPercent;
    if (labelEl) {
        if (name) {
            labelEl.textContent = name + " connected";
            labelEl.style.color = "#22c55e";
            labelEl.style.opacity = "1";
        }
        else {
            labelEl.textContent = "Heart Rate Monitor";
            labelEl.style.color = "";
            labelEl.style.opacity = "0.7";
        }
    }
    if (btnEl) {
        if (name) {
            btnEl.textContent = "Disconnect HR Strap";
            btnEl.classList.add("hr-connected");
        }
        else {
            btnEl.textContent = "Connect HR Strap";
            btnEl.classList.remove("hr-connected");
        }
    }
    applyBatteryToElement(batteryEl, battery);
}
function updateHrDisplay(hr) {
    const hrNowEl = document.getElementById("hrNow");
    if (hrNowEl) {
        if (hr && hr > 0) {
            hrNowEl.textContent = hr.toString();
        }
        else {
            hrNowEl.textContent = "";
        }
    }
}
const PHASE_STYLE_MAP = {
    "Warm-Up": { stroke: "#ffad5c", background: "rgba(255,173,92,0.18)", text: "#ffe9cc" },
    Sustain: { stroke: "#3d7cff", background: "rgba(61,124,255,0.18)", text: "#dbe5ff" },
    "Cool-Down": { stroke: "#eab308", background: "rgba(234,179,8,0.18)", text: "#fef9c3" },
    Rest: { stroke: "#888", background: "#1c1c1c", text: "#fff" },
    idle: { stroke: "#3d7cff", background: "#232323", text: "#fff" },
    completed: { stroke: "#fff", background: "rgba(255,255,255,0.2)", text: "#fff" },
};
const COMPLETED_LIGHT_MODE = { stroke: "#000", background: "rgba(0,0,0,0.08)", text: "#000" };
const DEFAULT_PHASE_STYLE = { stroke: "#3d7cff", background: "#232323", text: "#fff" };
function getPhaseStyle(key) {
    const base = PHASE_STYLE_MAP[key] || DEFAULT_PHASE_STYLE;
    if (key === "completed" || key === "Completed") {
        const light = window.matchMedia("(prefers-color-scheme: light)").matches;
        return light ? COMPLETED_LIGHT_MODE : base;
    }
    return base;
}
function applyPhaseStyle(key) {
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
    if (bg)
        bg.style.display = "flex";
    settingsModalEscHandler = (e) => {
        if (e.key === "Escape" || e.keyCode === 27)
            closeModal();
    };
    document.addEventListener("keydown", settingsModalEscHandler);
}
function closeModal() {
    const bg = document.getElementById("modalBg");
    if (bg)
        bg.style.display = "none";
    if (settingsModalEscHandler) {
        document.removeEventListener("keydown", settingsModalEscHandler);
        settingsModalEscHandler = null;
    }
}
function openCancelModal() {
    var _a, _b;
    const cooldownBtn = document.getElementById("earlyCooldownButton");
    if (cooldownBtn) {
        const day = getSelectedDay();
        const session = getSession(day);
        const plan = getPlan();
        const base = plan[day];
        const blocks = (_b = (_a = session.phasePlan) === null || _a === void 0 ? void 0 : _a.blocks) !== null && _b !== void 0 ? _b : (base ? adjustedBlockLengths(base, null) : null);
        const elapsedSec = session.paused
            ? session.pausedElapsed
            : session.startTime
                ? Math.floor((Date.now() - parseInt(session.startTime, 10)) / 1000)
                : 0;
        const decision = planEarlyCooldownTransition({
            blocks,
            hasSession: Boolean(session.startTime),
            elapsedSec,
            paused: session.paused,
            earlyCooldownElapsed: session.earlyCooldownElapsed,
            vo2Protocol: session.vo2ProtocolRuntime,
        });
        const available = decision.type === "enter-early-cooldown";
        cooldownBtn.style.display = available ? "" : "none";
        cooldownBtn.disabled = !available;
    }
    const bg = document.getElementById("cancelModalBg");
    if (bg)
        bg.style.display = "flex";
}
function closeCancelModal() {
    const bg = document.getElementById("cancelModalBg");
    if (bg)
        bg.style.display = "none";
}
let activitySelectEscHandler = null;
function closeActivitySelectModal() {
    const bg = document.getElementById("activitySelectModalBg");
    if (bg)
        bg.style.display = "none";
    if (activitySelectEscHandler) {
        document.removeEventListener("keydown", activitySelectEscHandler);
        activitySelectEscHandler = null;
    }
}
function promptWorkoutActivitySelection(activities) {
    const bg = document.getElementById("activitySelectModalBg");
    const options = document.getElementById("activitySelectOptions");
    if (!bg || !options)
        return;
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
        if (e.key === "Escape" || e.keyCode === 27)
            closeActivitySelectModal();
    };
    document.addEventListener("keydown", activitySelectEscHandler);
}
function confirmCancelWorkout() {
    restartWorkout();
    closeCancelModal();
}
function confirmEarlyCooldownWorkout() {
    const btn = document.getElementById("earlyCooldownButton");
    if (btn === null || btn === void 0 ? void 0 : btn.disabled)
        return;
    if (btn)
        btn.disabled = true;
    closeCancelModal();
    const decision = requestEarlyCooldown();
    if (decision.type === "unavailable" && btn)
        btn.disabled = false;
}
function promptCancelWorkout() {
    if (!phaseDisplayEl)
        return;
    if (phaseDisplayEl.dataset.phaseState === "active")
        openCancelModal();
}
function updateHeartColor(liveBpm, hrTargetText) {
    const heartIcon = document.getElementById("heartIcon");
    const hrNowEl = document.getElementById("hrNow");
    if (!heartIcon)
        return;
    const setHeartWhite = () => {
        heartIcon.style.setProperty("filter", "brightness(0) invert(1)", "important");
        if (hrNowEl)
            hrNowEl.style.setProperty("color", "black", "important");
    };
    const setHeartColored = (filter) => {
        heartIcon.style.setProperty("filter", filter, "important");
        if (hrNowEl)
            hrNowEl.style.setProperty("color", "white", "important");
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
    if (liveBpm > range.max)
        hueRotate = 270;
    else if (liveBpm < range.min)
        hueRotate = 45;
    setHeartColored(`brightness(0) saturate(100%) invert(27%) sepia(100%) saturate(10000%) hue-rotate(${hueRotate}deg)`);
}
function updateHeartPulse(bpmValue) {
    const heartIcon = document.getElementById("heartIcon");
    if (!heartIcon)
        return;
    const currentLiveBpm = window.liveBpm;
    const currentLastUpdate = window.lastBpmUpdateTime;
    const now = Date.now();
    if (currentLastUpdate && now - currentLastUpdate > BPM_TIMEOUT_MS) {
        heartPulseTargetBpm = null;
        if (heartPulseRafId !== null)
            cancelAnimationFrame(heartPulseRafId);
        heartPulseRafId = null;
        heartIcon.style.setProperty("transform", "scale(1)", "important");
        window.liveBpm = null;
        updateHrDisplay(null);
        const hrTargetEl = document.getElementById("hrTarget");
        updateHeartColor(null, hrTargetEl ? hrTargetEl.textContent : "");
        return;
    }
    const bpm = bpmValue !== undefined && bpmValue !== null ? bpmValue : currentLiveBpm;
    if (bpm && bpm > 0) {
        heartPulseTargetBpm = bpm;
        if (heartPulseRafId === null)
            heartPulseRafId = requestAnimationFrame(heartPulseLoop);
        const hrTargetEl = document.getElementById("hrTarget");
        if (hrTargetEl)
            updateHeartColor(bpm, hrTargetEl.textContent);
    }
    else {
        heartPulseTargetBpm = null;
        if (heartPulseRafId !== null)
            cancelAnimationFrame(heartPulseRafId);
        heartPulseRafId = null;
        heartIcon.style.setProperty("transform", "scale(1)", "important");
        const hrTargetEl = document.getElementById("hrTarget");
        updateHeartColor(null, hrTargetEl ? hrTargetEl.textContent : "");
    }
}
function getWarmupSubsectionName(day, elapsedSec) {
    const hrTargets = typeof window.getHrTargets === "function" ? window.getHrTargets() : {};
    const dayHrTargets = hrTargets[day];
    if (!dayHrTargets || !dayHrTargets.warmup_subsections)
        return null;
    for (const subsection of dayHrTargets.warmup_subsections) {
        const startSec = subsection.start_min * 60;
        const endSec = subsection.end_min * 60;
        if (elapsedSec >= startSec && elapsedSec < endSec)
            return subsection.name;
    }
    return null;
}
function deriveWorkoutState(day, plan, workoutMetadata, base, startTime, paused, pausedElapsed, liveBpm, lastBpmUpdateTime) {
    var _a, _b, _c, _d;
    if (day === "Downregulation") {
        return { screen: "downregulation", day: "Downregulation", plan, workoutMetadata };
    }
    if (!base) {
        return { screen: "rest", day, plan, workoutMetadata };
    }
    const session = getSession(day);
    const blocks = (_b = (_a = session.phasePlan) === null || _a === void 0 ? void 0 : _a.blocks) !== null && _b !== void 0 ? _b : adjustedBlockLengths(base, null);
    const workoutBlocksText = "Warm-Up: " + blocks.warm + " min · Workout: " + blocks.sustain + " min · Cool-Down: " + blocks.cool + " min";
    if (!startTime) {
        return { screen: "idle", day, plan, workoutMetadata, base, blocks, workoutBlocksText };
    }
    const elapsedSec = paused ? pausedElapsed : Math.floor((Date.now() - parseInt(startTime)) / 1000);
    const phase = getPhase(elapsedSec, blocks, session.earlyCooldownElapsed, {
        day,
        hrTargets: session.phasePlan ? session.phasePlan.hrTargets : undefined,
        vo2Protocol: session.vo2ProtocolRuntime,
    });
    if (phase.done) {
        return { screen: "completed", day, plan, workoutMetadata, base, blocks, workoutBlocksText, elapsedSec };
    }
    let phaseDisplayName = phase.phase;
    if (isVo2WorkoutSelector(day)) {
        phaseDisplayName = vo2ProtocolDisplayName(phase);
    }
    else if (phase.kind === "warmup") {
        const subsectionName = getWarmupSubsectionName(day, elapsedSec);
        if (subsectionName)
            phaseDisplayName = "Warm-Up (" + subsectionName + ")";
    }
    else if (phase.detailName) {
        phaseDisplayName = phase.detailName;
    }
    else if (phase.kind === "work" || phase.kind === "recovery") {
        phaseDisplayName = "Workout";
    }
    const hrTargetTextValue = isVo2WorkoutSelector(day)
        ? ""
        : hrTargetText(phase.phase, day, elapsedSec, blocks, session.phasePlan ? session.phasePlan.hrTargets : undefined);
    const nowTime = Date.now();
    const liveBpmStale = lastBpmUpdateTime != null && nowTime - lastBpmUpdateTime > BPM_TIMEOUT_MS;
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
        activity: (_d = getActiveWorkoutActivity((_c = workoutMetadata[day]) === null || _c === void 0 ? void 0 : _c.activities, getSession(day).activity)) !== null && _d !== void 0 ? _d : null,
        paused,
        hrTargetTextValue,
        liveBpm: liveBpm !== null && liveBpm !== void 0 ? liveBpm : null,
        liveBpmStale,
    };
}
function renderMachineGuidance(update) {
    const panel = document.getElementById("machineGuidance");
    if (!panel)
        return;
    if (!update || update.guidance.resistance === undefined || update.guidance.cadenceRpm === undefined) {
        panel.hidden = true;
        const bikeLive = document.getElementById("machineGuidanceBikeLive");
        if (bikeLive)
            bikeLive.hidden = true;
        return;
    }
    panel.hidden = false;
    const name = document.getElementById("machineGuidanceName");
    const resistance = document.getElementById("machineGuidanceResistance");
    const cadence = document.getElementById("machineGuidanceCadence");
    const watts = document.getElementById("machineGuidanceWatts");
    if (name)
        name.textContent = update.machine.name;
    if (resistance)
        resistance.textContent = String(update.guidance.resistance);
    if (cadence)
        cadence.textContent = `${update.guidance.cadenceRpm} RPM`;
    if (watts) {
        if (update.guidance.estimatedWatts !== undefined) {
            watts.textContent = `~${update.guidance.estimatedWatts} W @ 70 RPM`;
            watts.hidden = false;
        }
        else {
            watts.textContent = "";
            watts.hidden = true;
        }
    }
    renderBikeBridgeHud();
}
function renderBikeBridgeHud() {
    const live = document.getElementById("machineGuidanceBikeLive");
    if (!live)
        return;
    const panel = document.getElementById("machineGuidance");
    const state = getBikeBridgeSession().getViewState();
    if (!panel || panel.hidden || state.readiness === "not_configured") {
        live.hidden = true;
        live.textContent = "";
        return;
    }
    live.hidden = false;
    const observed = formatBikeBridgeNumber(state.observedResistance);
    const rpm = formatBikeBridgeNumber(state.rpm);
    const watts = formatBikeBridgeNumber(state.watts);
    const stale = state.telemetryStale ? " (stale)" : "";
    live.textContent = `Bike observed ${observed} · ${rpm} RPM · ${watts} W${stale}`;
}
function renderBikeBridgeSettingsStatus() {
    var _a, _b;
    const el = document.getElementById("bikeBridgeStatus");
    if (!el)
        return;
    const state = getBikeBridgeSession().getViewState();
    const lines = [
        `Bike Bridge: ${formatBikeBridgeReadiness(state.readiness)}`,
        `Control: ${formatBikeBridgeControl(state)}`,
        `Resistance: ${formatBikeBridgeNumber(state.observedResistance)}`,
        `Target: ${formatBikeBridgeNumber((_b = (_a = state.desiredResistance) !== null && _a !== void 0 ? _a : state.commandedResistance) !== null && _b !== void 0 ? _b : state.requestedResistance)}`,
        `RPM: ${formatBikeBridgeNumber(state.rpm)}`,
        `Watts: ${formatBikeBridgeNumber(state.watts)}`,
    ];
    if (state.lastError)
        lines.push(state.lastError);
    el.textContent = lines.join("\n");
}
function syncBikeBridgeGuidance(update, workoutActive, paused) {
    getBikeBridgeSession().onGuidance({
        desiredResistance: update === null || update === void 0 ? void 0 : update.guidance.resistance,
        recommendationChanged: (update === null || update === void 0 ? void 0 : update.recommendationChanged) === true,
        workoutActive,
        paused,
    });
    renderBikeBridgeHud();
    const equipmentTab = document.getElementById("equipmentTab");
    if (equipmentTab === null || equipmentTab === void 0 ? void 0 : equipmentTab.classList.contains("active"))
        renderBikeBridgeSettingsStatus();
}
function renderWorkout(state) {
    var _a, _b, _c;
    const downregEl = document.getElementById("downregulationContainer");
    const workoutMainContent = document.getElementById("workoutMainContent");
    const workoutBlocksEl = document.getElementById("workoutBlocks");
    if (state.screen === "downregulation") {
        if (workoutMainContent)
            workoutMainContent.style.display = "none";
        if (workoutBlocksEl)
            workoutBlocksEl.style.display = "none";
        const mainSection = document.getElementById("workoutMainSection");
        if (mainSection) {
            mainSection.style.background = "transparent";
        }
        if (downregEl) {
            downregEl.style.display = "block";
            const canvas = document.getElementById("downregulationCanvas");
            if (canvas) {
                startDownregulationView(downregEl, canvas);
            }
        }
        syncBikeBridgeGuidance(null, false, false);
        return;
    }
    stopDownregulationView();
    if (downregEl)
        downregEl.style.display = "none";
    if (workoutMainContent)
        workoutMainContent.style.display = "";
    if (workoutBlocksEl)
        workoutBlocksEl.style.display = "";
    const mainSection = document.getElementById("workoutMainSection");
    if (mainSection) {
        mainSection.style.background = "";
    }
    ensureWorkoutDayDropdown();
    const activityIcon = document.getElementById("activityIcon");
    const dayMeta = state.workoutMetadata[state.day];
    const hasBase = state.screen !== "rest" && state.base;
    if (activityIcon) {
        if (hasBase && dayMeta) {
            const selectedActivity = state.screen === "active" || state.screen === "completed"
                ? getSession(state.day).activity
                : undefined;
            const activity = getActiveWorkoutActivity(dayMeta.activities, selectedActivity);
            const iconByActivity = {
                bike: "bike.png",
                elliptical: "elliptical.png",
                strength: "dumbbell.png",
            };
            const iconSrc = activity ? iconByActivity[activity] || "" : "";
            if (iconSrc) {
                activityIcon.src = iconSrc;
                activityIcon.style.display = "block";
            }
            else {
                activityIcon.style.display = "none";
            }
        }
        else {
            activityIcon.style.display = "none";
        }
    }
    const hrTargetEl = document.getElementById("hrTarget");
    const startBtnEl = document.getElementById("startButton");
    const cancelBtnEl = document.getElementById("cancelWorkoutButton");
    const startButtonRowEl = document.getElementById("startButtonRow");
    if (state.screen === "rest") {
        renderMachineGuidance(null);
        syncBikeBridgeGuidance(null, false, false);
        if (workoutBlocksEl)
            workoutBlocksEl.textContent = "Rest Day";
        if (phaseDisplayEl) {
            phaseDisplayEl.innerHTML = '<span class="phase-name">Rest Day</span>';
            phaseDisplayEl.dataset.phaseState = "rest";
        }
        if (startButtonRowEl)
            startButtonRowEl.style.display = "none";
        if (cancelBtnEl)
            cancelBtnEl.style.display = "none";
        updateRing(0, { warm: 1, sustain: 1, cool: 1 });
        if (hrTargetEl)
            hrTargetEl.textContent = "";
        updateHeartPulse(null);
        updateHeartColor(null, "");
        applyPhaseStyle("Rest");
        return;
    }
    if (workoutBlocksEl)
        workoutBlocksEl.textContent = state.workoutBlocksText;
    if (state.screen === "idle") {
        renderMachineGuidance(null);
        syncBikeBridgeGuidance(null, false, false);
        if (phaseDisplayEl) {
            phaseDisplayEl.innerHTML = '<span class="phase-name">Not Started</span>';
            phaseDisplayEl.dataset.phaseState = "idle";
        }
        if (typeof window.resetVoiceState === "function")
            window.resetVoiceState();
        if (startButtonRowEl)
            startButtonRowEl.style.display = "flex";
        if (startBtnEl) {
            startBtnEl.innerText = "Start Workout";
            startBtnEl.onclick = startWorkout;
            startBtnEl.style.display = "block";
        }
        if (cancelBtnEl)
            cancelBtnEl.style.display = "none";
        updateRing(0, state.blocks);
        if (hrTargetEl)
            hrTargetEl.textContent = "";
        updateHeartPulse(null);
        updateHeartColor(null, "");
        applyPhaseStyle("idle");
        return;
    }
    if (state.screen === "completed") {
        renderMachineGuidance(null);
        syncBikeBridgeGuidance(null, false, false);
        updateRing(state.elapsedSec, state.blocks);
        if (typeof window.releaseWakeLock === "function")
            window.releaseWakeLock();
        handleWorkoutCompletion(state.day);
        if (phaseDisplayEl) {
            phaseDisplayEl.innerHTML = '<span class="phase-name">Completed</span>';
            phaseDisplayEl.dataset.phaseState = "completed";
        }
        const completedPhrase = isVo2WorkoutSelector(state.day) ? "Test complete" : "Completed";
        if (typeof window.announceWorkoutGuidance === "function") {
            window.announceWorkoutGuidance(completedPhrase, null, pendingVo2Cues);
        }
        else if (typeof window.announcePhaseIfChanged === "function") {
            window.announcePhaseIfChanged(completedPhrase);
        }
        pendingVo2Cues = [];
        if (startButtonRowEl)
            startButtonRowEl.style.display = "flex";
        if (startBtnEl) {
            startBtnEl.innerText = "Restart Workout";
            startBtnEl.onclick = restartWorkout;
            startBtnEl.style.display = "block";
        }
        if (cancelBtnEl)
            cancelBtnEl.style.display = "none";
        if (hrTargetEl)
            hrTargetEl.textContent = "";
        updateHeartPulse(null);
        updateHeartColor(null, "");
        applyPhaseStyle("completed");
        return;
    }
    // state.screen === "active"
    updateRing(state.elapsedSec, state.blocks);
    const active = state;
    if (startButtonRowEl)
        startButtonRowEl.style.display = "flex";
    if (startBtnEl) {
        if (active.paused) {
            startBtnEl.innerText = "Resume";
            startBtnEl.onclick = function () {
                resumeWorkout(active.day);
                if (typeof window.requestWakeLock === "function")
                    window.requestWakeLock();
                updateDisplay();
            };
            startBtnEl.style.display = "block";
        }
        else {
            startBtnEl.innerText = "Pause";
            startBtnEl.onclick = function () {
                pauseWorkout(active.day, active.elapsedSec);
                if (typeof window.releaseWakeLock === "function")
                    window.releaseWakeLock();
                updateDisplay();
            };
            startBtnEl.style.display = "block";
        }
    }
    if (cancelBtnEl)
        cancelBtnEl.style.display = active.paused ? "block" : "none";
    if (phaseDisplayEl) {
        phaseDisplayEl.innerHTML =
            '<span class="phase-name">' +
                active.phaseDisplayName +
                '</span><span class="phase-time">' +
                formatTime(active.phase.timeLeft) +
                "</span>";
        phaseDisplayEl.dataset.phaseState = "active";
    }
    if (hrTargetEl)
        hrTargetEl.textContent = active.hrTargetTextValue;
    updateHeartPulse();
    if (active.liveBpmStale) {
        updateHrDisplay(null);
    }
    if (active.liveBpm != null && active.liveBpm > 0 && !active.liveBpmStale) {
        updateHeartColor(active.liveBpm, active.hrTargetTextValue);
    }
    else {
        updateHeartColor(null, active.hrTargetTextValue);
    }
    const session = getSession(active.day);
    const vo2Targets = isVo2WorkoutSelector(active.day)
        ? vo2ProtocolUiTargets(session.vo2ProtocolRuntime, active.phase.phaseId)
        : null;
    const hold = vo2Targets
        ? { resistance: vo2Targets.holdResistance, cadenceRpm: vo2Targets.holdCadenceRpm }
        : vo2ProtocolHoldForPhase(session.vo2ProtocolRuntime, active.phase.phaseId);
    const targetRange = vo2Targets ? null : parseHrTargetRange(active.hrTargetTextValue);
    const machineUpdate = session.sessionId && active.activity
        ? updateMachineGuidanceRuntime({
            sessionId: session.sessionId,
            activity: active.activity,
            phaseKind: active.phase.kind,
            phaseId: active.phase.phaseId,
            phaseDisplayName: active.phaseDisplayName,
            phaseElapsedSeconds: active.phase.phaseElapsedSeconds,
            phaseDurationSeconds: active.phase.phaseDurationSeconds,
            workoutElapsedSeconds: active.elapsedSec,
            intervalIndex: active.phase.intervalIndex,
            heartRateBpm: (_a = active.liveBpm) !== null && _a !== void 0 ? _a : undefined,
            targetHeartRateMin: vo2Targets ? vo2Targets.targetHeartRateMin : targetRange === null || targetRange === void 0 ? void 0 : targetRange.min,
            targetHeartRateMax: vo2Targets ? vo2Targets.targetHeartRateMax : targetRange === null || targetRange === void 0 ? void 0 : targetRange.max,
            intent: (_b = active.workoutMetadata[active.day]) === null || _b === void 0 ? void 0 : _b.intent,
            holdResistance: hold === null || hold === void 0 ? void 0 : hold.resistance,
            holdCadenceRpm: hold === null || hold === void 0 ? void 0 : hold.cadenceRpm,
        })
        : null;
    syncBikeBridgeGuidance(machineUpdate, true, active.paused);
    renderMachineGuidance(machineUpdate);
    if (typeof window.announceWorkoutGuidance === "function") {
        window.announceWorkoutGuidance(active.phaseDisplayName, (_c = machineUpdate === null || machineUpdate === void 0 ? void 0 : machineUpdate.voiceEvent) !== null && _c !== void 0 ? _c : null, pendingVo2Cues);
    }
    else if (typeof window.announcePhaseIfChanged === "function") {
        window.announcePhaseIfChanged(active.phaseDisplayName);
    }
    pendingVo2Cues = [];
    applyPhaseStyle(active.phase.phase);
}
let updateDisplaySeq = 0;
function updateDisplay() {
    void updateDisplayAsync();
}
async function updateDisplayAsync() {
    var _a;
    const seq = ++updateDisplaySeq;
    try {
        if (typeof getPlan !== "function" || typeof getWorkoutMetadata !== "function")
            return;
        const day = getSelectedDay();
        const plan = getPlan();
        const workoutMetadata = getWorkoutMetadata();
        const base = plan[day];
        const startTime = getStartTime(day);
        const paused = typeof isPaused === "function" && isPaused(day);
        const pausedElapsed = typeof getPausedElapsed === "function" ? getPausedElapsed(day) : 0;
        const liveBpm = window.liveBpm;
        const lastBpmUpdateTime = window.lastBpmUpdateTime;
        if (startTime && isVo2WorkoutSelector(day)) {
            const elapsedSec = paused ? pausedElapsed : Math.floor((Date.now() - parseInt(startTime, 10)) / 1000);
            const tick = await tickVo2ProtocolWithCanonicalHr(day, elapsedSec, paused);
            if (seq !== updateDisplaySeq)
                return;
            pendingVo2Cues = (_a = tick === null || tick === void 0 ? void 0 : tick.cues) !== null && _a !== void 0 ? _a : [];
        }
        else {
            pendingVo2Cues = [];
        }
        const state = deriveWorkoutState(day, plan, workoutMetadata, base, startTime, paused, pausedElapsed, liveBpm, lastBpmUpdateTime);
        if (state.screen === "active" && state.liveBpmStale) {
            window.liveBpm = null;
        }
        renderWorkout(state);
    }
    catch (e) {
        if (e instanceof TypeError && e.message && e.message.includes("null")) {
            console.warn("updateDisplay: DOM element missing", e.message);
        }
        else {
            throw e;
        }
    }
}
function switchTab(tabName) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    const tabs = ["personal", "preferences", "equipment", "workouts", "sisu", "install"];
    tabs.forEach((name) => {
        const tabEl = document.getElementById(name + "Tab");
        if (tabEl)
            tabEl.classList.remove("active");
    });
    const buttons = document.querySelectorAll(".tab-button");
    buttons.forEach((btn) => btn.classList.remove("active"));
    const tabIndex = { personal: 0, preferences: 1, equipment: 2, workouts: 3, sisu: 4, install: 5 };
    if (tabName === "personal") {
        (_a = document.getElementById("personalTab")) === null || _a === void 0 ? void 0 : _a.classList.add("active");
        (_b = buttons[tabIndex.personal]) === null || _b === void 0 ? void 0 : _b.classList.add("active");
    }
    else if (tabName === "preferences") {
        (_c = document.getElementById("preferencesTab")) === null || _c === void 0 ? void 0 : _c.classList.add("active");
        (_d = buttons[tabIndex.preferences]) === null || _d === void 0 ? void 0 : _d.classList.add("active");
        loadPreferences();
    }
    else if (tabName === "equipment") {
        (_e = document.getElementById("equipmentTab")) === null || _e === void 0 ? void 0 : _e.classList.add("active");
        (_f = buttons[tabIndex.equipment]) === null || _f === void 0 ? void 0 : _f.classList.add("active");
        loadEquipmentSettings();
    }
    else if (tabName === "workouts") {
        (_g = document.getElementById("workoutsTab")) === null || _g === void 0 ? void 0 : _g.classList.add("active");
        (_h = buttons[tabIndex.workouts]) === null || _h === void 0 ? void 0 : _h.classList.add("active");
        loadWorkoutSummaries();
    }
    else if (tabName === "sisu") {
        (_j = document.getElementById("sisuTab")) === null || _j === void 0 ? void 0 : _j.classList.add("active");
        (_k = buttons[tabIndex.sisu]) === null || _k === void 0 ? void 0 : _k.classList.add("active");
        if (typeof window.loadSisuSettings === "function")
            window.loadSisuSettings();
        updateHrMonitorLabel();
    }
    else if (tabName === "install") {
        (_l = document.getElementById("installTab")) === null || _l === void 0 ? void 0 : _l.classList.add("active");
        (_m = buttons[tabIndex.install]) === null || _m === void 0 ? void 0 : _m.classList.add("active");
        if (typeof window.refreshInstallTabContent === "function")
            window.refreshInstallTabContent();
    }
}
function getShowSecondsCountdown() {
    return localStorage.getItem("showSecondsCountdown") === "true";
}
function getVoicePromptsEnabled() {
    return localStorage.getItem("voicePromptsEnabled") !== "false";
}
function loadPreferences() {
    const cb = document.getElementById("showSecondsCountdown");
    if (cb)
        cb.checked = getShowSecondsCountdown();
    const voiceCb = document.getElementById("voicePromptsEnabled");
    if (voiceCb)
        voiceCb.checked = getVoicePromptsEnabled();
}
function savePreferenceShowSeconds(checked) {
    localStorage.setItem("showSecondsCountdown", checked ? "true" : "false");
}
function savePreferenceVoicePrompts(checked) {
    localStorage.setItem("voicePromptsEnabled", checked ? "true" : "false");
}
function loadEquipmentSettings() {
    var _a;
    const select = document.getElementById("bikeMachineSelect");
    if (!select)
        return;
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
    select.value = (_a = getEquipmentSelection().bike) !== null && _a !== void 0 ? _a : "";
    loadBikeBridgeSettingsForm();
    renderLearnedGuidancePanel();
    renderHrDynamicsPanel();
    renderShadowPredictionPanel();
}
function renderLearnedGuidancePanel() {
    const section = document.getElementById("learnedGuidanceSection");
    const list = document.getElementById("learnedGuidanceList");
    if (!section || !list)
        return;
    const machineId = getEquipmentSelection().bike;
    const entries = machineId ? listLearnedStarts(machineId) : [];
    if (!machineId || entries.length === 0) {
        section.hidden = true;
        list.innerHTML = "";
        return;
    }
    section.hidden = false;
    list.innerHTML = entries
        .map((entry) => `<div class="learned-guidance-row"><span>${formatLearnedGuidanceLabel(entry.intent, entry.durationClass)}</span><span>R${entry.resistance}</span></div>`)
        .join("");
}
function metricRow(label, value) {
    return `<div class="learned-guidance-row"><span>${label}</span><span>${value}</span></div>`;
}
function sampleCountLabel(count) {
    return count === 1 ? "1 sample" : `${count} samples`;
}
function signedBpm(value) {
    return `${value > 0 ? "+" : ""}${value} bpm`;
}
function reliabilityRows(observationCount, detectedCount, recentObservationCount, recentDetectedCount, fallbackLabel, fallbackCount) {
    const rows = [];
    if (observationCount > 0) {
        rows.push(metricRow("Response observed", `${detectedCount} of ${observationCount}`));
    }
    else if (fallbackCount > 0) {
        rows.push(metricRow(fallbackLabel, sampleCountLabel(fallbackCount)));
    }
    if (recentObservationCount > 0) {
        rows.push(metricRow("Recent", `${recentDetectedCount} of ${recentObservationCount}`));
    }
    return rows;
}
function renderHrDynamicsGroup(entry) {
    const blocks = [];
    if (entry.workStartSampleCount > 0 || entry.workStartObservationCount > 0 || entry.workStartRecentObservationCount > 0) {
        const rows = ['<div class="hr-dynamics-subhead">Work start</div>'];
        if (entry.medianWorkStartDelaySeconds !== undefined) {
            rows.push(metricRow("Typical rise delay", `${entry.medianWorkStartDelaySeconds} s`));
        }
        if (entry.medianWorkStartHrDelta !== undefined) {
            rows.push(metricRow("Observed HR rise", signedBpm(entry.medianWorkStartHrDelta)));
        }
        rows.push(...reliabilityRows(entry.workStartObservationCount, entry.workStartDetectedResponseCount, entry.workStartRecentObservationCount, entry.workStartRecentDetectedResponseCount, "Based on", entry.workStartSampleCount));
        blocks.push(rows.join(""));
    }
    if (entry.increaseSampleCount > 0 || entry.increaseObservationCount > 0 || entry.increaseRecentObservationCount > 0) {
        const rows = ['<div class="hr-dynamics-subhead">+1 resistance</div>'];
        if (entry.medianIncreaseDelaySeconds !== undefined) {
            rows.push(metricRow("Typical response delay", `${entry.medianIncreaseDelaySeconds} s`));
        }
        if (entry.medianIncreaseHrDeltaPerStep !== undefined) {
            rows.push(metricRow("Observed HR change", signedBpm(entry.medianIncreaseHrDeltaPerStep)));
        }
        rows.push(...reliabilityRows(entry.increaseObservationCount, entry.increaseDetectedResponseCount, entry.increaseRecentObservationCount, entry.increaseRecentDetectedResponseCount, "Samples", entry.increaseSampleCount));
        blocks.push(rows.join(""));
    }
    if (entry.decreaseSampleCount > 0 || entry.decreaseObservationCount > 0 || entry.decreaseRecentObservationCount > 0) {
        const rows = ['<div class="hr-dynamics-subhead">-1 resistance</div>'];
        if (entry.medianDecreaseDelaySeconds !== undefined) {
            rows.push(metricRow("Typical response delay", `${entry.medianDecreaseDelaySeconds} s`));
        }
        if (entry.medianDecreaseHrDeltaPerStep !== undefined) {
            rows.push(metricRow("Observed HR change", signedBpm(entry.medianDecreaseHrDeltaPerStep)));
        }
        rows.push(...reliabilityRows(entry.decreaseObservationCount, entry.decreaseDetectedResponseCount, entry.decreaseRecentObservationCount, entry.decreaseRecentDetectedResponseCount, "Samples", entry.decreaseSampleCount));
        blocks.push(rows.join(""));
    }
    if (blocks.length === 0)
        return "";
    if (entry.timingMode || entry.timingPersonalized) {
        const status = entry.timingMode === "earlier"
            ? "Earlier"
            : entry.timingMode === "extended"
                ? "Extended"
                : "Personalized";
        blocks.push(`<div class="hr-dynamics-subhead">Controller timing</div>${metricRow("Status", status)}`);
    }
    return `<div class="hr-dynamics-block"><div class="hr-dynamics-heading">${formatLearnedGuidanceLabel(entry.intent, entry.durationClass)}</div>${blocks.join("")}</div>`;
}
function renderHrDynamicsPanel() {
    const section = document.getElementById("hrDynamicsSection");
    const list = document.getElementById("hrDynamicsList");
    if (!section || !list)
        return;
    const machineId = getEquipmentSelection().bike;
    const entries = machineId ? listHrDynamics(machineId).filter((entry) => entry.workStartSampleCount > 0 ||
        entry.increaseSampleCount > 0 ||
        entry.decreaseSampleCount > 0 ||
        entry.workStartObservationCount > 0 ||
        entry.increaseObservationCount > 0 ||
        entry.decreaseObservationCount > 0 ||
        entry.workStartRecentObservationCount > 0 ||
        entry.increaseRecentObservationCount > 0 ||
        entry.decreaseRecentObservationCount > 0) : [];
    if (!machineId || entries.length === 0) {
        section.hidden = true;
        list.innerHTML = "";
        return;
    }
    section.hidden = false;
    list.innerHTML = entries.map(renderHrDynamicsGroup).join("");
}
function signedBpmPerLevel(value) {
    return `${value > 0 ? "+" : ""}${value} bpm / level`;
}
function renderShadowDirectionBlock(label, diagnostics) {
    const rows = [`<div class="hr-dynamics-subhead">${label}</div>`];
    rows.push(metricRow("Model", signedBpmPerLevel(diagnostics.modelMedianHrPerLevel)));
    rows.push(metricRow("Predictions", String(diagnostics.predictionCount)));
    rows.push(metricRow("Validation", shadowValidationStatusLabel(diagnostics.validationStatus)));
    if (diagnostics.validationOpportunityCount > 0) {
        rows.push(metricRow("Realized", `${diagnostics.realizedPredictionCount} of ${diagnostics.validationOpportunityCount}`));
    }
    if (diagnostics.distinctSessionCount > 0) {
        rows.push(metricRow("Sessions", String(diagnostics.distinctSessionCount)));
    }
    if (diagnostics.medianAbsolutePredictionErrorBpm !== undefined) {
        rows.push(metricRow("Median error", `${diagnostics.medianAbsolutePredictionErrorBpm} bpm`));
    }
    if (diagnostics.medianSignedPredictionErrorBpm !== undefined) {
        rows.push(metricRow("Bias", signedBpm(diagnostics.medianSignedPredictionErrorBpm)));
    }
    if (diagnostics.directionEvaluatedCount > 0) {
        rows.push(metricRow("Direction matched", `${diagnostics.directionMatchCount} of ${diagnostics.directionEvaluatedCount}`));
    }
    if (diagnostics.directionEvaluatedCount > 0) {
        rows.push(metricRow("Within 5 bpm", `${diagnostics.withinToleranceCount} of ${diagnostics.directionEvaluatedCount}`));
    }
    return rows.join("");
}
function renderShadowPredictionGroup(entry) {
    const blocks = [];
    if (entry.increase)
        blocks.push(renderShadowDirectionBlock("+1 resistance", entry.increase));
    if (entry.decrease)
        blocks.push(renderShadowDirectionBlock("-1 resistance", entry.decrease));
    if (blocks.length === 0)
        return "";
    return `<div class="hr-dynamics-block"><div class="hr-dynamics-heading">${formatLearnedGuidanceLabel(entry.intent, entry.durationClass)}</div>${blocks.join("")}</div>`;
}
function renderShadowPredictionPanel() {
    const section = document.getElementById("shadowPredictionSection");
    const list = document.getElementById("shadowPredictionList");
    if (!section || !list)
        return;
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
function exportMachineDiagnostics() {
    const prepared = prepareMachineDiagnosticsExport(buildMachineDiagnosticsSnapshot());
    const blob = new Blob([prepared.body], { type: prepared.mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = prepared.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}
function promptResetShadowPredictions() {
    const machineId = getEquipmentSelection().bike;
    if (!machineId)
        return;
    const bg = document.getElementById("resetShadowPredictionsModalBg");
    if (bg)
        bg.style.display = "flex";
}
function closeResetShadowPredictionsModal() {
    const bg = document.getElementById("resetShadowPredictionsModalBg");
    if (bg)
        bg.style.display = "none";
}
function confirmResetShadowPredictions() {
    const machineId = getEquipmentSelection().bike;
    if (machineId)
        resetShadowPredictionsForMachine(machineId);
    closeResetShadowPredictionsModal();
    renderShadowPredictionPanel();
    renderHrDynamicsPanel();
    renderLearnedGuidancePanel();
}
function promptResetHrDynamics() {
    const machineId = getEquipmentSelection().bike;
    if (!machineId)
        return;
    const bg = document.getElementById("resetHrDynamicsModalBg");
    if (bg)
        bg.style.display = "flex";
}
function closeResetHrDynamicsModal() {
    const bg = document.getElementById("resetHrDynamicsModalBg");
    if (bg)
        bg.style.display = "none";
}
function confirmResetHrDynamics() {
    const machineId = getEquipmentSelection().bike;
    if (machineId)
        resetHrDynamicsForMachine(machineId);
    closeResetHrDynamicsModal();
    renderHrDynamicsPanel();
    renderLearnedGuidancePanel();
    renderShadowPredictionPanel();
}
function promptResetLearnedGuidance() {
    const machineId = getEquipmentSelection().bike;
    if (!machineId)
        return;
    const bg = document.getElementById("resetLearnedModalBg");
    if (bg)
        bg.style.display = "flex";
}
function closeResetLearnedModal() {
    const bg = document.getElementById("resetLearnedModalBg");
    if (bg)
        bg.style.display = "none";
}
function confirmResetLearnedGuidance() {
    const machineId = getEquipmentSelection().bike;
    if (machineId)
        resetLearnedGuidanceForMachine(machineId);
    closeResetLearnedModal();
    renderLearnedGuidancePanel();
    renderHrDynamicsPanel();
    renderShadowPredictionPanel();
}
function loadBikeBridgeSettingsForm() {
    const state = getBikeBridgeSession().getViewState();
    const urlInput = document.getElementById("bikeBridgeUrl");
    if (urlInput && document.activeElement !== urlInput)
        urlInput.value = state.configuredUrl;
    const control = document.getElementById("bikeBridgeAutomaticControl");
    if (control)
        control.checked = state.automaticControlEnabled;
    renderBikeBridgeSettingsStatus();
}
function saveBikeBridgeUrl(value) {
    const result = getBikeBridgeSession().configure({ baseUrl: value });
    const urlInput = document.getElementById("bikeBridgeUrl");
    if (result.ok) {
        if (urlInput)
            urlInput.value = getBikeBridgeSession().getViewState().configuredUrl;
    }
    else {
        showToast(result.error || "Invalid bike bridge URL");
        if (urlInput)
            urlInput.value = getBikeBridgeSession().getViewState().configuredUrl;
    }
    renderBikeBridgeSettingsStatus();
}
function saveBikeBridgeAutomaticControl(enabled) {
    getBikeBridgeSession().configure({ automaticControlEnabled: enabled });
    renderBikeBridgeSettingsStatus();
}
function saveBikeEquipmentSelection(value) {
    if (value && !isMachineId(value))
        return;
    setSelectedMachine("bike", value && isMachineId(value) ? value : undefined);
    renderLearnedGuidancePanel();
    renderHrDynamicsPanel();
    renderShadowPredictionPanel();
    updateDisplay();
}
async function loadWorkoutSummaries() {
    const listContainer = document.getElementById("workoutSummaryList");
    if (!listContainer)
        return;
    listContainer.innerHTML = '<div class="label" style="text-align: center; margin-bottom: 16px;">Loading workouts...</div>';
    try {
        const workouts = await getAllWorkoutSummaries();
        displayWorkoutSummaries(workouts);
    }
    catch (error) {
        console.error("Error loading workouts:", error);
        listContainer.innerHTML = '<div class="label" style="text-align: center; color: #ff4444;">Error loading workouts</div>';
    }
}
function createSwipeHandler(onSwipeLeft, onSwipeRight) {
    const state = {
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
    const applyDragStyle = (dx) => {
        const el = state.targetEl;
        if (!el)
            return;
        el.style.setProperty("--drag-x", `${dx}px`);
        if (dx < 0)
            el.dataset.dragDirection = "left";
        else if (dx > 0)
            el.dataset.dragDirection = "right";
        else
            delete el.dataset.dragDirection;
    };
    const clearDragStyle = () => {
        const el = state.targetEl;
        if (!el)
            return;
        el.style.setProperty("--drag-x", "0px");
        delete el.dataset.dragDirection;
        delete el.dataset.swipeArmed;
        el.classList.remove("dragging");
    };
    const onStart = (el, x, y, pointer) => {
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
    const onMove = (x, y) => {
        if (!state.active)
            return;
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
        if (Math.abs(dx) > 0)
            applyDragStyle(dx);
        else {
            clearDragStyle();
            return;
        }
        const shouldArm = Math.abs(dx) >= armThreshold;
        if (shouldArm !== state.armed) {
            state.armed = shouldArm;
            const el = state.targetEl;
            if (el)
                el.dataset.swipeArmed = shouldArm ? "true" : "false";
            if (shouldArm && navigator.vibrate)
                navigator.vibrate(10);
        }
    };
    const onEnd = () => {
        if (!state.active || !state.targetEl)
            return;
        const dt = Math.max(1, performance.now() - state.startT);
        const dx = state.movedX;
        const absX = Math.abs(dx);
        const speed = absX / dt;
        let didSwipe = false;
        let swipeDirection = null;
        if (absX >= threshold || (absX >= 24 && speed >= velocity)) {
            if (dx < 0) {
                didSwipe = true;
                swipeDirection = "left";
            }
            else if (dx > 0) {
                didSwipe = true;
                swipeDirection = "right";
            }
        }
        const el = state.targetEl;
        if (didSwipe && el) {
            state.swiped = true;
            if (swipeDirection === "left" && onSwipeLeft)
                onSwipeLeft();
            else if (swipeDirection === "right" && onSwipeRight)
                onSwipeRight();
            el.classList.add("swipe-complete");
            clearDragStyle();
            setTimeout(() => el.classList.remove("swipe-complete"), 400);
        }
        else {
            clearDragStyle();
        }
        state.active = false;
        state.pointer = "none";
    };
    return {
        onTouchStart: (e) => {
            if (e.touches.length !== 1)
                return;
            const t = e.touches[0];
            onStart(e.currentTarget, t.clientX, t.clientY, "touch");
        },
        onTouchMove: (e) => {
            if (!state.active || state.pointer !== "touch")
                return;
            const t = e.touches[0];
            if (!t)
                return;
            onMove(t.clientX, t.clientY);
        },
        onTouchEnd: () => {
            if (state.pointer !== "touch")
                return;
            onEnd();
        },
        onMouseDown: (e) => {
            var _a;
            if (e.button !== 0)
                return;
            if (window.getSelection)
                (_a = window.getSelection()) === null || _a === void 0 ? void 0 : _a.removeAllRanges();
            onStart(e.currentTarget, e.clientX, e.clientY, "mouse");
        },
        onMouseMove: (e) => {
            if (!state.active || state.pointer !== "mouse")
                return;
            onMove(e.clientX, e.clientY);
        },
        onMouseUp: () => {
            if (state.pointer !== "mouse")
                return;
            onEnd();
        },
        onClick: (e) => {
            if (Math.abs(state.movedX) > 6 || state.swiped) {
                e.preventDefault();
                e.stopPropagation();
            }
        },
    };
}
let pendingDeleteSessionId = null;
function openDeleteWorkoutModal(sessionId) {
    pendingDeleteSessionId = sessionId;
    const bg = document.getElementById("deleteWorkoutModalBg");
    if (bg)
        bg.style.display = "flex";
}
function closeDeleteWorkoutModal() {
    const bg = document.getElementById("deleteWorkoutModalBg");
    if (bg)
        bg.style.display = "none";
    pendingDeleteSessionId = null;
}
async function confirmDeleteWorkout() {
    if (pendingDeleteSessionId) {
        const success = await deleteWorkoutSummary(pendingDeleteSessionId);
        if (success)
            await loadWorkoutSummaries();
        closeDeleteWorkoutModal();
    }
}
async function deleteWorkout(sessionId) {
    const success = await deleteWorkoutSummary(sessionId);
    if (success)
        await loadWorkoutSummaries();
    return success;
}
let currentWorkoutSummary = null;
function viewWorkoutSummary(sessionId) {
    window.initDB().then((db) => {
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
function showWorkoutSummaryModal(summary) {
    currentWorkoutSummary = summary;
    const jsonElement = document.getElementById("workoutSummaryJson");
    if (jsonElement)
        jsonElement.textContent = JSON.stringify(summary, null, 2);
    const bg = document.getElementById("workoutSummaryModalBg");
    if (bg)
        bg.style.display = "flex";
}
function closeWorkoutSummaryModal() {
    const bg = document.getElementById("workoutSummaryModalBg");
    if (bg)
        bg.style.display = "none";
    currentWorkoutSummary = null;
}
function downloadJsonFile(filename, data) {
    const payload = { ...data };
    delete payload.day;
    const jsonStr = JSON.stringify(payload, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
}
function downloadWorkoutSummaryFile(summary) {
    if (!summary) {
        showToast("Workout summary not available", "error");
        return;
    }
    const sessionId = summary.external_session_id || "workout";
    downloadJsonFile(`workout-${sessionId}.json`, summary);
    showToast("Workout JSON downloaded", "success");
}
function downloadWorkoutSummaryJson() {
    downloadWorkoutSummaryFile(currentWorkoutSummary);
}
function showToast(message, type = "info") {
    const existingToast = document.getElementById("toast");
    if (existingToast)
        existingToast.remove();
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
function displayWorkoutSummaries(workouts) {
    const listContainer = document.getElementById("workoutSummaryList");
    if (!listContainer)
        return;
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
        <button type="button" class="button secondary" data-download-json>Download JSON</button>
      </div>
    `;
        const downloadBtn = workoutItem.querySelector("[data-download-json]");
        if (downloadBtn) {
            downloadBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                downloadWorkoutSummaryFile(summary);
            });
        }
        const swipe = createSwipeHandler(() => {
            const sessionId = workoutItem.dataset.sessionId;
            if (sessionId) {
                workoutItem.classList.add("deleting");
                setTimeout(() => {
                    workoutItem.classList.remove("deleting");
                    openDeleteWorkoutModal(sessionId);
                }, 300);
            }
        }, async () => {
            const sessionId = workoutItem.dataset.sessionId;
            if (sessionId) {
                workoutItem.classList.add("sending");
                try {
                    const result = await sendWorkoutToSisu(sessionId);
                    workoutItem.classList.remove("sending");
                    if (result.success)
                        showToast(result.message, "success");
                    else
                        showToast(result.message, "error");
                }
                catch (error) {
                    workoutItem.classList.remove("sending");
                    showToast("Error sending to SISU: " + error.message, "error");
                }
            }
        });
        workoutItem.addEventListener("touchstart", swipe.onTouchStart);
        workoutItem.addEventListener("touchmove", swipe.onTouchMove);
        workoutItem.addEventListener("touchend", swipe.onTouchEnd);
        workoutItem.addEventListener("mousedown", swipe.onMouseDown);
        workoutItem.addEventListener("mousemove", swipe.onMouseMove);
        workoutItem.addEventListener("mouseup", swipe.onMouseUp);
        workoutItem.addEventListener("click", (e) => {
            if (swipe.onClick)
                swipe.onClick(e);
        }, true);
        listContainer.appendChild(workoutItem);
    });
}
let lastPersistedWorkoutHrElapsed;
let lastPersistedWorkoutHrSessionId = null;
let lastPersistedHydratedSessionId = null;
let lastPersistedHydrate = null;
async function ensureLastPersistedHydrated(sessionId) {
    if (lastPersistedHydratedSessionId === sessionId)
        return;
    if ((lastPersistedHydrate === null || lastPersistedHydrate === void 0 ? void 0 : lastPersistedHydrate.sessionId) === sessionId) {
        await lastPersistedHydrate.promise;
        return;
    }
    const promise = getHrSamples(sessionId)
        .then((samples) => {
        if ((lastPersistedHydrate === null || lastPersistedHydrate === void 0 ? void 0 : lastPersistedHydrate.sessionId) !== sessionId)
            return;
        const max = lastPersistedElapsedFromHrSamples(samples);
        if (lastPersistedWorkoutHrSessionId !== sessionId) {
            lastPersistedWorkoutHrSessionId = sessionId;
            lastPersistedWorkoutHrElapsed = max;
        }
        else if (max !== undefined &&
            (lastPersistedWorkoutHrElapsed === undefined || max > lastPersistedWorkoutHrElapsed)) {
            lastPersistedWorkoutHrElapsed = max;
        }
        lastPersistedHydratedSessionId = sessionId;
    })
        .catch((err) => console.error("Error hydrating persisted HR elapsed:", err));
    lastPersistedHydrate = { sessionId, promise };
    await promise;
}
async function persistWorkoutRelativeHr(session, bpm) {
    if (!session.sessionId)
        return;
    await ensureLastPersistedHydrated(session.sessionId);
    const latest = getSession(getSelectedDay());
    if (latest.sessionId !== session.sessionId)
        return;
    const lastElapsed = latest.sessionId === lastPersistedWorkoutHrSessionId ? lastPersistedWorkoutHrElapsed : undefined;
    const sample = workoutRelativeHrSample(latest, Date.now(), lastElapsed);
    if (!sample || !latest.sessionId)
        return;
    lastPersistedWorkoutHrSessionId = latest.sessionId;
    lastPersistedWorkoutHrElapsed = sample.elapsedSec;
    recordMachineHeartRateSample(latest.sessionId, sample.elapsedSec, bpm);
    if (typeof window.storeHrSample === "function") {
        window.storeHrSample(latest.sessionId, sample.elapsedSec, bpm).catch((err) => console.error("Error storing HR sample:", err));
    }
}
function registerUiGlobals(phaseBoxEl) {
    phaseDisplayEl = phaseBoxEl;
    onBpm((bpm) => {
        liveBpm = bpm;
        lastBpmUpdateTime = Date.now();
        window.liveBpm = liveBpm;
        window.lastBpmUpdateTime = lastBpmUpdateTime;
        updateHrDisplay(bpm);
        const hrTargetEl = document.getElementById("hrTarget");
        updateHeartPulse(bpm);
        updateHeartColor(bpm, hrTargetEl ? hrTargetEl.textContent : "");
        const day = getSelectedDay();
        const session = getSession(day);
        void persistWorkoutRelativeHr(session, bpm);
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
    window.getSelectedDay = getSelectedDay;
    window.getShowElapsed = getShowElapsed;
    window.setSelectedDay = setSelectedDay;
    window.connectHr = connectHr;
    window.updateHrMonitorStatus = updateHrMonitorLabel;
    window.updateHrDisplay = updateHrDisplay;
    window.openModal = openModal;
    window.closeModal = closeModal;
    window.openCancelModal = openCancelModal;
    window.closeCancelModal = closeCancelModal;
    window.closeActivitySelectModal = closeActivitySelectModal;
    window.promptWorkoutActivitySelection = promptWorkoutActivitySelection;
    window.confirmCancelWorkout = confirmCancelWorkout;
    window.confirmEarlyCooldownWorkout = confirmEarlyCooldownWorkout;
    window.promptCancelWorkout = promptCancelWorkout;
    window.switchTab = switchTab;
    window.getShowSecondsCountdown = getShowSecondsCountdown;
    window.getVoicePromptsEnabled = getVoicePromptsEnabled;
    window.savePreferenceShowSeconds = savePreferenceShowSeconds;
    window.savePreferenceVoicePrompts = savePreferenceVoicePrompts;
    window.loadEquipmentSettings = loadEquipmentSettings;
    window.saveBikeEquipmentSelection = saveBikeEquipmentSelection;
    window.saveBikeBridgeUrl = saveBikeBridgeUrl;
    window.saveBikeBridgeAutomaticControl = saveBikeBridgeAutomaticControl;
    window.promptResetLearnedGuidance = promptResetLearnedGuidance;
    window.closeResetLearnedModal = closeResetLearnedModal;
    window.confirmResetLearnedGuidance = confirmResetLearnedGuidance;
    window.promptResetHrDynamics = promptResetHrDynamics;
    window.closeResetHrDynamicsModal = closeResetHrDynamicsModal;
    window.confirmResetHrDynamics = confirmResetHrDynamics;
    window.promptResetShadowPredictions = promptResetShadowPredictions;
    window.closeResetShadowPredictionsModal = closeResetShadowPredictionsModal;
    window.confirmResetShadowPredictions = confirmResetShadowPredictions;
    window.exportMachineDiagnostics = exportMachineDiagnostics;
    window.loadWorkoutSummaries = loadWorkoutSummaries;
    window.viewWorkoutSummary = viewWorkoutSummary;
    window.showWorkoutSummaryModal = showWorkoutSummaryModal;
    window.closeWorkoutSummaryModal = closeWorkoutSummaryModal;
    window.downloadWorkoutSummaryJson = downloadWorkoutSummaryJson;
    window.showToast = showToast;
    window.openDeleteWorkoutModal = openDeleteWorkoutModal;
    window.closeDeleteWorkoutModal = closeDeleteWorkoutModal;
    window.confirmDeleteWorkout = confirmDeleteWorkout;
    window.deleteWorkout = deleteWorkout;
    window.updateHeartPulse = updateHeartPulse;
    window.updateHeartColor = updateHeartColor;
    window.updateDisplay = updateDisplay;
    getBikeBridgeSession().subscribe(() => {
        renderBikeBridgeHud();
        const equipmentTab = document.getElementById("equipmentTab");
        if (equipmentTab === null || equipmentTab === void 0 ? void 0 : equipmentTab.classList.contains("active"))
            renderBikeBridgeSettingsStatus();
    });
}
export { getSelectedDay, setSelectedDay, connectHr, updateHrDisplay, updateHeartPulse, updateHeartColor, updateDisplay, switchTab, savePreferenceShowSeconds, savePreferenceVoicePrompts, loadEquipmentSettings, saveBikeEquipmentSelection, loadWorkoutSummaries, registerUiGlobals, };
