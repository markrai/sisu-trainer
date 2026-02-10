import { todayName } from "./utils/dateTime.js";
let plan = {};
let workoutMetadata = {};
let hrTargets = {};
function parseDuration(duration) {
    if (typeof duration === "number")
        return duration;
    if (typeof duration === "string") {
        const match = duration.match(/^(\d+)/);
        if (match)
            return parseInt(match[1]);
    }
    return 0;
}
function getSelectedVariant(day, variants) {
    if (!variants || !Array.isArray(variants) || variants.length === 0)
        return null;
    const epoch = new Date("2024-01-01").getTime();
    const now = Date.now();
    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    const weekNumber = Math.floor((now - epoch) / msPerWeek);
    const variantIndex = weekNumber % variants.length;
    return variants[variantIndex];
}
function processWorkout(workout, transformed) {
    var _a, _b, _c, _d, _e, _f;
    if (!workout || !workout.day)
        return;
    const warm = parseDuration(((_a = workout.warmup) === null || _a === void 0 ? void 0 : _a.duration_min) || 0);
    const cool = parseDuration(((_b = workout.cooldown) === null || _b === void 0 ? void 0 : _b.duration_min) || 0);
    hrTargets[workout.day] = {
        warmup: ((_c = workout.warmup) === null || _c === void 0 ? void 0 : _c.target_hr_bpm) || "",
        warmup_subsections: ((_d = workout.warmup) === null || _d === void 0 ? void 0 : _d.subsections) || null,
        cooldown: ((_e = workout.cooldown) === null || _e === void 0 ? void 0 : _e.target_hr_bpm) || "",
        main_set: ((_f = workout.main_set) === null || _f === void 0 ? void 0 : _f.target_hr_bpm) || "",
        intervals: null,
    };
    let sustain = 0;
    if (workout.main_set) {
        if (workout.main_set.duration_min) {
            sustain = parseDuration(workout.main_set.duration_min);
        }
        else if (workout.main_set.intervals && Array.isArray(workout.main_set.intervals)) {
            const intervals = workout.main_set.intervals;
            const isSequence = workout.main_set.is_sequence === true;
            let totalDuration = 0;
            const intervalPhases = [];
            intervals.forEach((interval) => {
                let intervalDuration = 0;
                if (interval.duration_min)
                    intervalDuration = parseDuration(interval.duration_min);
                totalDuration += intervalDuration;
                intervalPhases.push({ phase: interval.phase, duration: intervalDuration, target_hr_bpm: interval.target_hr_bpm || "" });
            });
            if (isSequence) {
                sustain = totalDuration;
                hrTargets[workout.day].intervals = { phases: intervalPhases, repetitions: 1, isSequence: true };
            }
            else {
                const repetitions = workout.main_set.repetitions || 1;
                sustain = totalDuration * repetitions;
                hrTargets[workout.day].intervals = { phases: intervalPhases, repetitions, isSequence: false };
            }
        }
    }
    if (warm > 0 || sustain > 0 || cool > 0) {
        transformed[workout.day] = { warm, sustain, cool };
        workoutMetadata[workout.day] = {
            type: workout.type || "",
            intent: workout.intent || "",
            machine: workout.machine || "",
        };
    }
    else {
        transformed[workout.day] = null;
    }
}
function transformWorkoutData(workoutData) {
    const transformed = {};
    if (!workoutData || !workoutData.weekly_plan) {
        console.error("Invalid workout data structure");
        return transformed;
    }
    workoutData.weekly_plan.forEach((workout) => {
        if (!workout || !workout.day)
            return;
        if (workout.variants && Array.isArray(workout.variants) && workout.variants.length > 0) {
            const selectedVariant = getSelectedVariant(workout.day, workout.variants);
            if (selectedVariant) {
                const variantWorkout = { ...selectedVariant, day: workout.day };
                processWorkout(variantWorkout, transformed);
            }
        }
        else {
            processWorkout(workout, transformed);
        }
    });
    return transformed;
}
async function initializeWorkoutPlan() {
    workoutMetadata = {};
    hrTargets = {};
    try {
        const response = await fetch("data.json");
        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);
        const workoutData = await response.json();
        plan = transformWorkoutData(workoutData);
    }
    catch (error) {
        console.error("Failed to load workout data from data.json:", error);
        plan = {};
        workoutMetadata = {};
        hrTargets = {};
    }
    const today = todayName();
    console.log("Today is:", today, "Plan for today:", plan[today]);
}
const getPlan = () => plan;
const getWorkoutMetadata = () => workoutMetadata;
const getHrTargets = () => hrTargets;
export function registerWorkoutDataGlobals() {
    window.initializeWorkoutPlan = initializeWorkoutPlan;
    window.getPlan = getPlan;
    window.getWorkoutMetadata = getWorkoutMetadata;
    window.getHrTargets = getHrTargets;
}
export { initializeWorkoutPlan, getPlan, getWorkoutMetadata, getHrTargets };
