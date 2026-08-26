// Workout data transformation and loading
// Workout recipe is now loaded from external data.json file

// Shared state
let plan = {};
let workoutMetadata = {}; // Store type and activities for each day
let hrTargets = {}; // Store HR targets for each day's phases

// Helper function to parse duration_min (handles strings like "60–75" or numbers)
function parseDuration(duration) {
  if (typeof duration === 'number') return duration;
  if (typeof duration === 'string') {
    // Handle ranges like "60–75" or "20–30" - take the first number
    const match = duration.match(/^(\d+)/);
    if (match) return parseInt(match[1]);
  }
  return 0;
}

// Get selected variant for a day (week-based automatic selection)
function getSelectedVariant(day, variants) {
  if (!variants || !Array.isArray(variants) || variants.length === 0) {
    return null;
  }
  
  // Calculate week number (weeks since epoch, alternating A/B)
  // Using a fixed epoch date for consistency (e.g., Jan 1, 2024)
  const epoch = new Date('2024-01-01').getTime();
  const now = Date.now();
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const weekNumber = Math.floor((now - epoch) / msPerWeek);
  const variantIndex = weekNumber % variants.length;
  
  // Get variant by index (A=0, B=1, etc.)
  const selectedVariant = variants[variantIndex];
  console.log(`Week ${weekNumber}: Selected variant ${selectedVariant.id} for ${day}`);
  
  return selectedVariant;
}

// Process a single workout (used for both regular workouts and variants)
function processWorkout(workout, transformed) {
  if (!workout || !workout.day) {
    return;
  }
  
  const warm = parseDuration(workout.warmup?.duration_min || 0);
  const cool = parseDuration(workout.cooldown?.duration_min || 0);
  
  // Store HR targets
  hrTargets[workout.day] = {
    warmup: workout.warmup?.target_hr_bpm || "",
    warmup_subsections: workout.warmup?.subsections || null,
    cooldown: workout.cooldown?.target_hr_bpm || "",
    main_set: workout.main_set?.target_hr_bpm || "",
    intervals: null // Will be populated for interval workouts
  };
  
  // Calculate sustain duration from main_set
  let sustain = 0;
  if (workout.main_set) {
    if (workout.main_set.duration_min) {
      // Simple duration
      sustain = parseDuration(workout.main_set.duration_min);
    } else if (workout.main_set.intervals && Array.isArray(workout.main_set.intervals)) {
      // Interval-based workout
      const intervals = workout.main_set.intervals;
      
      // Check if this is a sequence (explicitly marked) or repeating pattern
      const isSequence = workout.main_set.is_sequence === true;
      
      let totalDuration = 0;
      const intervalPhases = [];
      
      intervals.forEach(interval => {
        // All durations are now in minutes (normalized)
        let intervalDuration = 0;
        if (interval.duration_min) {
          intervalDuration = parseDuration(interval.duration_min);
        }
        totalDuration += intervalDuration;
        
        // Store interval phase info for HR targets
        intervalPhases.push({
          phase: interval.phase,
          duration: intervalDuration,
          target_hr_bpm: interval.target_hr_bpm || ""
        });
      });
      
      if (isSequence) {
        // For sequences (like Friday), use total duration
        // All phases are already in the array, no repetition needed
        sustain = totalDuration;
        hrTargets[workout.day].intervals = {
          phases: intervalPhases,
          repetitions: 1, // Sequences don't repeat
          isSequence: true
        };
      } else {
        // For repeating patterns (like Monday), use explicit repetitions field
        const repetitions = workout.main_set.repetitions || 1;
        
        // For repeating patterns, the intervals array contains one cycle
        // Multiply by repetitions to get total duration
        sustain = totalDuration * repetitions;
        
        hrTargets[workout.day].intervals = {
          phases: intervalPhases,
          repetitions: repetitions,
          isSequence: false
        };
      }
    }
  }
  
  // Only add to transformed if we have valid workout data
  if (warm > 0 || sustain > 0 || cool > 0) {
    transformed[workout.day] = { warm, sustain, cool };
    // Store metadata (type, intent, and activities) for display
    workoutMetadata[workout.day] = {
      type: workout.type || "",
      intent: workout.intent || "",
      activities: Array.isArray(workout.activities) ? workout.activities : []
    };
  } else {
    transformed[workout.day] = null;
  }
}

// Transform workout data structure to the format expected by the app
function transformWorkoutData(workoutData) {
  const transformed = {};
  
  if (!workoutData || !workoutData.weekly_plan) {
    console.error('Invalid workout data structure');
    return transformed;
  }
  
  workoutData.weekly_plan.forEach(workout => {
    if (!workout || !workout.day) {
      return;
    }
    
    // Check if this day has variants
    if (workout.variants && Array.isArray(workout.variants) && workout.variants.length > 0) {
      // Get selected variant based on week number
      const selectedVariant = getSelectedVariant(workout.day, workout.variants);
      if (selectedVariant) {
        // Process the selected variant as a normal workout
        const variantWorkout = {
          ...selectedVariant,
          day: workout.day
        };
        processWorkout(variantWorkout, transformed);
      }
    } else {
      // Single workout (existing behavior - backward compatible)
      processWorkout(workout, transformed);
    }
  });
  
  return transformed;
}

// Initialize workout plan from external JSON file
async function initializeWorkoutPlan() {
  workoutMetadata = {}; // Reset metadata
  hrTargets = {}; // Reset HR targets
  
  try {
    // Fetch workout data from external JSON file
    const response = await fetch('data.json');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const workoutData = await response.json();
    
    // Transform and store the workout data
    plan = transformWorkoutData(workoutData);
    console.log('Plan loaded from data.json:', plan);
  } catch (error) {
    console.error('Failed to load workout data from data.json:', error);
    // Set empty plan if fetch fails - app will show no workouts
    plan = {};
    workoutMetadata = {};
    hrTargets = {};
  }
  
  const today = todayName();
  console.log('Today is:', today, 'Plan for today:', plan[today]);
}

// Getter functions for shared state
function getPlan() { return plan; }
function getWorkoutMetadata() { return workoutMetadata; }
function getHrTargets() { return hrTargets; }

