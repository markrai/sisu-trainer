// UI controls and display updates
let selectedDay = null; // Track selected day for testing (null = today)
let liveBpm = null; // Store live BPM from BLE monitor
let lastBpmUpdateTime = null; // Track when we last received BPM data
const BPM_TIMEOUT_MS = 3000; // Stop animation if no BPM received for 3 seconds

// Expose live BPM variables to workout-logic.js via window object
window.liveBpm = liveBpm;
window.lastBpmUpdateTime = lastBpmUpdateTime;

function getSelectedDay() {
  return selectedDay || todayName();
}

function setSelectedDay(day) {
  selectedDay = day;
}

// Populate workout dropdown once and sync value to selected day
function ensureWorkoutDayDropdown() {
  const select = document.getElementById('workoutDaySelect');
  if (!select) return;
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const plan = typeof getPlan === 'function' ? getPlan() : {};
  const metadata = typeof getWorkoutMetadata === 'function' ? getWorkoutMetadata() : {};
  if (select.options.length === 0) {
    days.forEach((day) => {
      const opt = document.createElement('option');
      opt.value = day;
      const meta = metadata[day];
      opt.textContent = meta && meta.type ? day + ': ' + meta.type : day;
      select.appendChild(opt);
    });
    select.addEventListener('change', function () {
      selectedDay = this.value;
      updateDisplay();
    });
  }
  const current = getSelectedDay();
  if (select.value !== current) select.value = current;
}

// Make function globally accessible
window.getSelectedDay = getSelectedDay;
window.setSelectedDay = setSelectedDay;
window.connectHr = connectHr;

function connectHr() {
  initiateHrConnection();
}

function updateHrDisplay(hr) {
  const hrNowEl = document.getElementById('hrNow');
  if (hrNowEl) {
    if (hr && hr > 0) {
      hrNowEl.textContent = hr; // Display just the number, no "bpm" text
    } else {
      hrNowEl.textContent = ""; // Clear display when no valid HR
    }
  }
}


const PHASE_STYLE_MAP = {
  "Warm-Up": { stroke: "#ffad5c", background: "rgba(255,173,92,0.18)", text: "#ffe9cc" },
  "Sustain": { stroke: "#3d7cff", background: "rgba(61,124,255,0.18)", text: "#dbe5ff" },
  "Cool-Down": { stroke: "#4ade80", background: "rgba(74,222,128,0.18)", text: "#e6fff2" },
  Rest: { stroke: "#888", background: "#1c1c1c", text: "#fff" },
  idle: { stroke: "#3d7cff", background: "#232323", text: "#fff" },
  completed: { stroke: "#64ffda", background: "rgba(100,255,218,0.2)", text: "#d5fff7" }
};
const DEFAULT_PHASE_STYLE = { stroke: "#3d7cff", background: "#232323", text: "#fff" };

let phaseDisplayEl;
let settingsModalEscHandler = null;

function openModal() { 
  document.getElementById('modalBg').style.display = "flex";
  
  // Add ESC key handler to close the modal
  settingsModalEscHandler = (e) => {
    if (e.key === 'Escape' || e.keyCode === 27) {
      closeModal();
    }
  };
  document.addEventListener('keydown', settingsModalEscHandler);
}

function closeModal() { 
  document.getElementById('modalBg').style.display = "none";
  
  // Remove ESC key handler
  if (settingsModalEscHandler) {
    document.removeEventListener('keydown', settingsModalEscHandler);
    settingsModalEscHandler = null;
  }
}
function openCancelModal() { document.getElementById('cancelModalBg').style.display = "flex"; }
function closeCancelModal() { document.getElementById('cancelModalBg').style.display = "none"; }

function confirmCancelWorkout() { restartWorkout(); closeCancelModal(); }
function promptCancelWorkout() {
  if (!phaseDisplayEl) return;
  if (phaseDisplayEl.dataset.phaseState === "active") openCancelModal();
}

function applyPhaseStyle(key) {
  const style = PHASE_STYLE_MAP[key] || DEFAULT_PHASE_STYLE;
  const ring = document.getElementById('ringProgress');
  if (ring) ring.style.stroke = style.stroke;
  if (phaseDisplayEl) {
    phaseDisplayEl.style.background = style.background;
    phaseDisplayEl.style.color = style.text;
  }
}

// saveHRV() removed - HRV will be handled via SISU sync in the future

function updateDisplay() {
  try {
    if (typeof getPlan !== 'function' || typeof getWorkoutMetadata !== 'function') return;
    const day = getSelectedDay();
    const plan = getPlan();
    const workoutMetadata = getWorkoutMetadata();
    const base = plan[day];

    ensureWorkoutDayDropdown();
  
  // Update activity icon based on machine type
  const activityIcon = document.getElementById('activityIcon');
  if (activityIcon && base && workoutMetadata[day]) {
    const machine = workoutMetadata[day].machine || "";
    let iconSrc = "";
    const machineLower = machine.toLowerCase();
    // Check for combo/strength first, then bike, then elliptical
    if (machineLower.includes("combo") || machineLower.includes("strength")) {
      iconSrc = "dumbbell.png";
    } else if (machineLower.includes("bike")) {
      iconSrc = "bike.png";
    } else if (machineLower.includes("elliptical")) {
      iconSrc = "elliptical.png";
    }
    if (iconSrc) {
      activityIcon.src = iconSrc;
      activityIcon.style.display = "block";
    } else {
      activityIcon.style.display = "none";
    }
  } else if (activityIcon) {
    activityIcon.style.display = "none";
  }

  // HRV handling removed - will be managed via SISU sync

  const hrTargetEl = document.getElementById('hrTarget');
  const workoutBlocksEl = document.getElementById('workoutBlocks');
  const startBtnEl = document.getElementById('startButton');

  if (!base) {
    if (workoutBlocksEl) workoutBlocksEl.textContent = "Rest Day";
    if (phaseDisplayEl) {
      phaseDisplayEl.innerHTML = '<span class="phase-name">Rest Day</span>';
      phaseDisplayEl.dataset.phaseState = "rest";
    }
    const activityIcon = document.getElementById('activityIcon');
    if (activityIcon) activityIcon.style.display = "none";
    if (startBtnEl) startBtnEl.style.display = "none";
    updateRing(0, { warm: 1, sustain: 1, cool: 1 });
    if (hrTargetEl) hrTargetEl.textContent = "";
    updateHeartPulse(null);
    updateHeartColor(null, "");
    applyPhaseStyle("Rest");
    return;
  }

  // Use base workout plan directly (HRV adjustments will come from SISU sync in the future)
  const blocks = adjustedBlockLengths(base, null);
  if (workoutBlocksEl) workoutBlocksEl.textContent =
    "Warm-Up: " + blocks.warm + " min · Workout: " + blocks.sustain + " min · Cool-Down: " + blocks.cool + " min";

  const start = getStartTime(day);
  let elapsedSec = 0;

  if (!start) {
    if (phaseDisplayEl) {
      phaseDisplayEl.innerHTML = '<span class="phase-name">Not Started</span>';
      phaseDisplayEl.dataset.phaseState = "idle";
    }
    if (typeof window.resetVoiceState === 'function') window.resetVoiceState();
    if (startBtnEl) {
      startBtnEl.innerText = "Start Workout";
      startBtnEl.onclick = startWorkout;
      startBtnEl.style.display = "block";
    }
    updateRing(0, blocks);
    if (hrTargetEl) hrTargetEl.textContent = "";
    updateHeartPulse(null);
    updateHeartColor(null, "");
    applyPhaseStyle("idle");
    return;
  }

  const paused = typeof window.isPaused === 'function' && window.isPaused(day);
  if (paused) {
    elapsedSec = typeof window.getPausedElapsed === 'function' ? window.getPausedElapsed(day) : 0;
  } else {
    elapsedSec = Math.floor((Date.now() - start) / 1000);
  }
  const phase = getPhase(elapsedSec, blocks);

  updateRing(elapsedSec, blocks);

  if (phase.done) {
    // Release wake lock when workout completes
    if (typeof window.releaseWakeLock === 'function') {
      window.releaseWakeLock();
    }
    
    // Emit workout summary on completion (only once)
    const summaryEmitted = localStorage.getItem("summary_emitted_" + day);
    if (summaryEmitted === "false" && typeof window.generateWorkoutSummary === 'function') {
      const sessionId = localStorage.getItem("session_id_" + day);
      const sessionStart = localStorage.getItem("session_start_" + day);
      if (sessionId && sessionStart) {
        const sessionStartTime = parseInt(sessionStart);
        const sessionAge = Date.now() - sessionStartTime;
        const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
        
        // Skip stale sessions (older than 24 hours)
        if (sessionAge > MAX_SESSION_AGE_MS) {
          console.warn(`Skipping stale workout session for ${day} on completion (age: ${Math.round(sessionAge / (1000 * 60 * 60))} hours)`);
          // Clean up stale session
          localStorage.removeItem("start_" + day);
          localStorage.removeItem("session_id_" + day);
          localStorage.removeItem("session_start_" + day);
          localStorage.removeItem("summary_emitted_" + day);
        } else {
          const endedAt = Date.now();
          window.generateWorkoutSummary(sessionId, sessionStartTime, endedAt, day)
            .then(summary => {
              return window.emitWorkoutSummary(summary);
            })
            .then(() => {
              localStorage.setItem("summary_emitted_" + day, "true");
            })
            .catch(error => {
              console.error('Error emitting workout summary on completion:', error);
              // If error is due to duration validation, clean up the stale session
              if (error.message && error.message.includes('exceeds maximum')) {
                console.warn('Stale session detected on completion, cleaning up...');
                localStorage.removeItem("start_" + day);
                localStorage.removeItem("session_id_" + day);
                localStorage.removeItem("session_start_" + day);
                localStorage.removeItem("summary_emitted_" + day);
              }
            });
        }
      }
    }
    
    if (phaseDisplayEl) {
      phaseDisplayEl.innerHTML = '<span class="phase-name">Completed</span>';
      phaseDisplayEl.dataset.phaseState = "completed";
    }
    if (typeof window.announcePhaseIfChanged === 'function') window.announcePhaseIfChanged('Completed');
    if (startBtnEl) {
      startBtnEl.innerText = "Restart Workout";
      startBtnEl.onclick = restartWorkout;
      startBtnEl.style.display = "block";
    }
    if (hrTargetEl) hrTargetEl.textContent = "";
    updateHeartPulse(null);
    updateHeartColor(null, "");
    applyPhaseStyle("completed");
    return;
  }

  // Play/Pause button: in progress and not paused -> Pause; in progress and paused -> Resume
  if (startBtnEl) {
    if (paused) {
      startBtnEl.innerText = "Resume";
      startBtnEl.onclick = function () {
        if (typeof window.resumeWorkout === 'function') window.resumeWorkout(day);
        if (typeof window.requestWakeLock === 'function') window.requestWakeLock();
        updateDisplay();
      };
      startBtnEl.style.display = "block";
    } else {
      startBtnEl.innerText = "Pause";
      startBtnEl.onclick = function () {
        if (typeof window.pauseWorkout === 'function') window.pauseWorkout(day, elapsedSec);
        if (typeof window.releaseWakeLock === 'function') window.releaseWakeLock();
        updateDisplay();
      };
      startBtnEl.style.display = "block";
    }
  }
  
  // Get phase name, including warmup subsection or interval name if applicable
  let phaseDisplayName = phase.phase;
  if (phase.phase === "Warm-Up") {
    const subsectionName = getWarmupSubsectionName(day, elapsedSec);
    if (subsectionName) {
      phaseDisplayName = "Warm-Up (" + subsectionName + ")";
    }
  } else if (phase.phase === "Sustain") {
    phaseDisplayName = "Workout";
    const intervalName = getCurrentIntervalName(day, elapsedSec, blocks);
    if (intervalName) {
      phaseDisplayName = intervalName;
    }
  }
  
  if (phaseDisplayEl) {
    phaseDisplayEl.innerHTML = '<span class="phase-name">' + phaseDisplayName + '</span><span class="phase-time">' + formatTime(phase.timeLeft) + '</span>';
    phaseDisplayEl.dataset.phaseState = "active";
  }
  if (typeof window.announcePhaseIfChanged === 'function') window.announcePhaseIfChanged(phaseDisplayName);

  const hrTargetTextValue = hrTargetText(phase.phase, day, elapsedSec, blocks);
  if (hrTargetEl) hrTargetEl.textContent = hrTargetTextValue;
  
  // Heart animation is now controlled by live BPM from BLE monitor
  // Check if BPM data is stale and update animation accordingly
  updateHeartPulse();
  
  // Check if BPM data is stale and clear display if needed
  const currentLiveBpm = window.liveBpm;
  const currentLastUpdate = window.lastBpmUpdateTime;
  const now = Date.now();
  if (currentLastUpdate && (now - currentLastUpdate) > BPM_TIMEOUT_MS) {
    // No BPM data received recently - clear display
    updateHrDisplay(null);
    window.liveBpm = null;
  }
  
  // Update heart color based on live BPM vs target range
  if (currentLiveBpm && currentLiveBpm > 0) {
    updateHeartColor(currentLiveBpm, hrTargetTextValue);
  } else {
    updateHeartColor(null, hrTargetTextValue);
  }
  
  applyPhaseStyle(phase.phase);
  } catch (e) {
    if (e instanceof TypeError && e.message && e.message.includes('null')) {
      console.warn('updateDisplay: DOM element missing', e.message);
    } else {
      throw e;
    }
  }
}

// Get warmup subsection name for display in phase box
function getWarmupSubsectionName(day, elapsedSec) {
  const hrTargets = getHrTargets();
  const dayHrTargets = hrTargets[day];
  if (!dayHrTargets || !dayHrTargets.warmup_subsections) {
    return null;
  }
  
  // Find which warmup sub-section we're in
  for (let i = 0; i < dayHrTargets.warmup_subsections.length; i++) {
    const subsection = dayHrTargets.warmup_subsections[i];
    const startSec = subsection.start_min * 60;
    const endSec = subsection.end_min * 60;
    
    if (elapsedSec >= startSec && elapsedSec < endSec) {
      return subsection.name;
    }
  }
  
  return null;
}

// Get current interval/recovery name for display in phase box
function getCurrentIntervalName(day, elapsedSec, blocks) {
  const hrTargets = getHrTargets();
  const dayHrTargets = hrTargets[day];
  if (!dayHrTargets || !dayHrTargets.intervals || !dayHrTargets.intervals.phases) {
    return null;
  }
  
  const warmSec = blocks.warm * 60;
  const sustainElapsed = Math.max(0, elapsedSec - warmSec);
  const phases = dayHrTargets.intervals.phases;
  const isSequence = dayHrTargets.intervals.isSequence;
  
  let elapsedInPhases = sustainElapsed;
  
  if (isSequence) {
    // For sequences (like Friday), go through all phases once
    const totalDuration = phases.reduce((sum, p) => sum + p.duration * 60, 0);
    elapsedInPhases = Math.min(sustainElapsed, totalDuration);
  } else {
    // For repeating patterns (like Monday), cycle through the phases
    const cycleDuration = phases.reduce((sum, p) => sum + p.duration * 60, 0);
    elapsedInPhases = sustainElapsed % cycleDuration;
  }
  
  let accumulated = 0;
  for (let i = 0; i < phases.length; i++) {
    const phaseDuration = phases[i].duration * 60;
    if (elapsedInPhases < accumulated + phaseDuration) {
      return phases[i].phase; // Return the phase name (e.g., "Interval 1", "Recovery 1")
    }
    accumulated += phaseDuration;
  }
  
  return null;
}

// Parse HR target range from text (e.g., "110–120 bpm", "<120 bpm", "155–165 bpm", "≥160 (cap 170) bpm")
function parseHrTargetRange(hrTargetText) {
  if (!hrTargetText || hrTargetText === "") {
    return null;
  }
  
  // Try to match patterns like "≥160 (cap 170)" or "≥160"
  const greaterThanCapMatch = hrTargetText.match(/≥(\d+)\s*\(cap\s*(\d+)\)/);
  if (greaterThanCapMatch) {
    return {
      min: parseInt(greaterThanCapMatch[1]),
      max: parseInt(greaterThanCapMatch[2])
    };
  }
  
  // Try to match patterns like "≥160"
  const greaterThanMatch = hrTargetText.match(/≥(\d+)/);
  if (greaterThanMatch) {
    const value = parseInt(greaterThanMatch[1]);
    // For "≥160", treat as range from 160 to 200 (reasonable max)
    return {
      min: value,
      max: 200
    };
  }
  
  // Try to match patterns like "110–120" or "155–165"
  const rangeMatch = hrTargetText.match(/(\d+)[–-](\d+)/);
  if (rangeMatch) {
    return {
      min: parseInt(rangeMatch[1]),
      max: parseInt(rangeMatch[2])
    };
  }
  
  // Try to match less than pattern like "<120"
  const lessThanMatch = hrTargetText.match(/<(\d+)/);
  if (lessThanMatch) {
    const value = parseInt(lessThanMatch[1]);
    return {
      min: 0,
      max: value - 1 // Exclusive upper bound for "<120" means max is 119
    };
  }
  
  // Try to match single number
  const singleMatch = hrTargetText.match(/(\d+)/);
  if (singleMatch) {
    const value = parseInt(singleMatch[1]);
    // For single number, treat as a range with ±5 tolerance
    return {
      min: value - 5,
      max: value + 5
    };
  }
  
  return null;
}

// Update heart icon color based on BPM comparison to target range
function updateHeartColor(liveBpm, hrTargetText) {
  const heartIcon = document.getElementById('heartIcon');
  const hrNowEl = document.getElementById('hrNow');
  if (!heartIcon) return;
  
  function setHrNowColor(color) {
    if (hrNowEl) hrNowEl.style.setProperty('color', color, 'important');
  }
  
  // If no live HR detected, use default color (white)
  if (!liveBpm || liveBpm <= 0) {
    heartIcon.style.setProperty('filter', 'brightness(0) invert(1)', 'important');
    setHrNowColor('white');
    return;
  }
  
  // No target text - can't compare, use white default
  if (!hrTargetText || hrTargetText === "") {
    heartIcon.style.setProperty('filter', 'brightness(0) invert(1)', 'important');
    setHrNowColor('white');
    return;
  }
  
  const range = parseHrTargetRange(hrTargetText);
  if (!range) {
    // Can't parse range, use default color (white)
    heartIcon.style.setProperty('filter', 'brightness(0) invert(1)', 'important');
    setHrNowColor('white');
    return;
  }
  
  // Determine color based on BPM comparison
  let hueRotate = 0; // Default red
  let belowRange = false;
  if (liveBpm > range.max) {
    // Above range - Purple (hue-rotate ~270deg)
    hueRotate = 270;
  } else if (liveBpm < range.min) {
    // Below range - Yellow (hue-rotate ~50deg); BPM text must be black
    hueRotate = 50;
    belowRange = true;
  }
  // Within range stays red (hueRotate = 0)
  
  heartIcon.style.setProperty('filter', `brightness(0) saturate(100%) invert(27%) sepia(100%) saturate(10000%) hue-rotate(${hueRotate}deg)`, 'important');
  setHrNowColor(belowRange ? 'black' : 'white');
}

// Update heart animation based on live BPM from BLE monitor
function updateHeartPulse(bpmValue) {
  const heartIcon = document.getElementById('heartIcon');
  if (!heartIcon) return;
  
  // Get current live BPM from window object (updated by workout-logic.js)
  const currentLiveBpm = window.liveBpm;
  const currentLastUpdate = window.lastBpmUpdateTime;
  
  // Check if BPM data is stale (no update for more than timeout period)
  const now = Date.now();
  if (currentLastUpdate && (now - currentLastUpdate) > BPM_TIMEOUT_MS) {
    // No BPM data received recently - stop animation
    heartIcon.style.setProperty('animation', 'none', 'important');
    window.liveBpm = null;
    // Clear HR display when no signal
    updateHrDisplay(null);
    // Reset to default color when no data
    const hrTargetEl = document.getElementById('hrTarget');
    updateHeartColor(null, hrTargetEl ? hrTargetEl.textContent : "");
    return;
  }
  
  // Use the provided BPM value, or fall back to stored live BPM
  const bpm = bpmValue !== undefined && bpmValue !== null ? bpmValue : currentLiveBpm;
  
  if (bpm && bpm > 0) {
    // Calculate animation duration: 60 seconds / bpm = seconds per beat
    const duration = 60 / bpm;
    // Use different animation name for mobile vs desktop
    const isMobile = window.matchMedia("(max-width: 768px) and (orientation: portrait)").matches;
    const animationName = isMobile ? 'heartPulseMobile' : 'heartPulse';
    // Use !important to override any CSS rules
    heartIcon.style.setProperty('animation', `${animationName} ${duration}s ease-in-out infinite`, 'important');
    console.log('Setting heart animation:', animationName, duration, 's for', bpm, 'bpm (live)');
    
    // Update heart color based on BPM vs target range
    const hrTargetEl = document.getElementById('hrTarget');
    if (hrTargetEl) {
      updateHeartColor(bpm, hrTargetEl.textContent);
    }
  } else {
    // No valid BPM - stop animation
    heartIcon.style.setProperty('animation', 'none', 'important');
    // Reset to default color
    const hrTargetEl = document.getElementById('hrTarget');
    updateHeartColor(null, hrTargetEl ? hrTargetEl.textContent : "");
  }
}

// Expose functions globally after they're defined
window.updateHeartPulse = updateHeartPulse;
window.updateHeartColor = updateHeartColor;

// Tab switching for settings modal
function switchTab(tabName) {
  // Hide all tabs
  document.getElementById('personalTab').classList.remove('active');
  document.getElementById('preferencesTab').classList.remove('active');
  document.getElementById('workoutsTab').classList.remove('active');
  document.getElementById('sisuTab').classList.remove('active');
  document.getElementById('installTab').classList.remove('active');
  
  // Remove active class from all buttons
  const buttons = document.querySelectorAll('.tab-button');
  buttons.forEach(btn => btn.classList.remove('active'));
  
  // Show selected tab
  if (tabName === 'personal') {
    document.getElementById('personalTab').classList.add('active');
    buttons[0].classList.add('active');
  } else if (tabName === 'preferences') {
    document.getElementById('preferencesTab').classList.add('active');
    buttons[1].classList.add('active');
    loadPreferences();
  } else if (tabName === 'workouts') {
    document.getElementById('workoutsTab').classList.add('active');
    buttons[2].classList.add('active');
    loadWorkoutSummaries();
  } else if (tabName === 'sisu') {
    document.getElementById('sisuTab').classList.add('active');
    buttons[3].classList.add('active');
    // Load SISU settings when tab is opened
    if (typeof window.loadSisuSettings === 'function') {
      window.loadSisuSettings();
    }
  } else if (tabName === 'install') {
    document.getElementById('installTab').classList.add('active');
    buttons[4].classList.add('active');
    if (typeof window.refreshInstallTabContent === 'function') window.refreshInstallTabContent();
  }
}

// Preferences: show seconds in ring countdown (default off)
function getShowSecondsCountdown() {
  return localStorage.getItem('showSecondsCountdown') === 'true';
}

function getVoicePromptsEnabled() {
  return localStorage.getItem('voicePromptsEnabled') !== 'false';
}

function loadPreferences() {
  const cb = document.getElementById('showSecondsCountdown');
  if (cb) cb.checked = getShowSecondsCountdown();
  const voiceCb = document.getElementById('voicePromptsEnabled');
  if (voiceCb) voiceCb.checked = getVoicePromptsEnabled();
}

function savePreferenceShowSeconds(checked) {
  localStorage.setItem('showSecondsCountdown', checked ? 'true' : 'false');
}

function savePreferenceVoicePrompts(checked) {
  localStorage.setItem('voicePromptsEnabled', checked ? 'true' : 'false');
}

// Load and display workout summaries
async function loadWorkoutSummaries() {
  const listContainer = document.getElementById('workoutSummaryList');
  if (!listContainer) return;
  
  listContainer.innerHTML = '<div class="label" style="text-align: center; margin-bottom: 16px;">Loading workouts...</div>';
  
  try {
    const workouts = await window.getAllWorkoutSummaries();
    displayWorkoutSummaries(workouts);
  } catch (error) {
    console.error('Error loading workouts:', error);
    listContainer.innerHTML = '<div class="label" style="text-align: center; color: #ff4444;">Error loading workouts</div>';
  }
}

// Swipe handler for workout items
function createSwipeHandler(onSwipeLeft, onSwipeRight) {
  const state = {
    active: false,
    pointer: 'none',
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    startT: 0,
    movedX: 0,
    movedY: 0,
    armed: false,
    swiped: false,
    targetEl: null
  };

  const threshold = 72;
  const velocity = 0.3;
  const armThreshold = 48;

  const applyDragStyle = (dx, dy) => {
    const el = state.targetEl;
    if (!el) return;
    el.style.setProperty('--drag-x', `${dx}px`);
    if (dx < 0) {
      el.dataset.dragDirection = 'left';
    } else if (dx > 0) {
      el.dataset.dragDirection = 'right';
    } else {
      delete el.dataset.dragDirection;
    }
  };

  const clearDragStyle = () => {
    const el = state.targetEl;
    if (!el) return;
    el.style.setProperty('--drag-x', '0px');
    delete el.dataset.dragDirection;
    delete el.dataset.swipeArmed;
    el.classList.remove('dragging');
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
    el.classList.add('dragging');
  };

  const onMove = (x, y) => {
    if (!state.active) return;
    const dx = x - state.startX;
    const dy = y - state.startY;
    state.lastX = x;
    state.lastY = y;
    state.movedX = dx;
    state.movedY = dy;

    // If vertical intent dominates early, abort dragging visuals
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 16) {
      clearDragStyle();
      return;
    }

    // Apply drag style for both left and right swipes
    if (Math.abs(dx) > 0) {
      applyDragStyle(dx, dy);
    } else {
      clearDragStyle();
      return;
    }

    // Arm swipes (left or right)
    const shouldArm = Math.abs(dx) >= armThreshold;
    if (shouldArm !== state.armed) {
      state.armed = shouldArm;
      const el = state.targetEl;
      if (el) el.dataset.swipeArmed = shouldArm ? 'true' : 'false';
      // Haptic feedback
      if (shouldArm && navigator.vibrate) {
        navigator.vibrate(10);
      }
    }
  };

  const onEnd = () => {
    if (!state.active || !state.targetEl) return;
    const dt = Math.max(1, performance.now() - state.startT);
    const dx = state.movedX;
    const absX = Math.abs(dx);
    const speed = absX / dt;

    let didSwipe = false;
    let swipeDirection = null;
    if (absX >= threshold || (absX >= 24 && speed >= velocity)) {
      if (dx < 0) {
        didSwipe = true;
        swipeDirection = 'left';
      } else if (dx > 0) {
        didSwipe = true;
        swipeDirection = 'right';
      }
    }

    const el = state.targetEl;
    if (didSwipe && el) {
      state.swiped = true;
      if (swipeDirection === 'left' && onSwipeLeft) {
        onSwipeLeft();
      } else if (swipeDirection === 'right' && onSwipeRight) {
        onSwipeRight();
      }
      el.classList.add('swipe-complete');
      clearDragStyle();
      setTimeout(() => el.classList.remove('swipe-complete'), 400);
    } else {
      clearDragStyle();
    }

    state.active = false;
    state.pointer = 'none';
  };

  return {
    onTouchStart: (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      onStart(e.currentTarget, t.clientX, t.clientY, 'touch');
    },
    onTouchMove: (e) => {
      if (!state.active || state.pointer !== 'touch') return;
      const t = e.touches[0];
      if (!t) return;
      onMove(t.clientX, t.clientY);
    },
    onTouchEnd: () => {
      if (state.pointer !== 'touch') return;
      onEnd();
    },
    onMouseDown: (e) => {
      if (e.button !== 0) return;
      if (window.getSelection) window.getSelection().removeAllRanges();
      onStart(e.currentTarget, e.clientX, e.clientY, 'mouse');
    },
    onMouseMove: (e) => {
      if (!state.active || state.pointer !== 'mouse') return;
      onMove(e.clientX, e.clientY);
    },
    onMouseUp: () => {
      if (state.pointer !== 'mouse') return;
      onEnd();
    },
    onClick: (e) => {
      if (Math.abs(state.movedX) > 6 || state.swiped) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  };
}

// Delete workout confirmation modal
let pendingDeleteSessionId = null;

function openDeleteWorkoutModal(sessionId) {
  pendingDeleteSessionId = sessionId;
  document.getElementById('deleteWorkoutModalBg').style.display = "flex";
}

function closeDeleteWorkoutModal() {
  document.getElementById('deleteWorkoutModalBg').style.display = "none";
  pendingDeleteSessionId = null;
}

async function confirmDeleteWorkout() {
  if (pendingDeleteSessionId) {
    const success = await window.deleteWorkoutSummary(pendingDeleteSessionId);
    if (success) {
      // Reload the workout list
      await loadWorkoutSummaries();
    }
    closeDeleteWorkoutModal();
  }
}

// Delete workout
async function deleteWorkout(sessionId) {
  const success = await window.deleteWorkoutSummary(sessionId);
  if (success) {
    // Reload the workout list
    await loadWorkoutSummaries();
  }
  return success;
}

// Display workout summaries in the list
function displayWorkoutSummaries(workouts) {
  const listContainer = document.getElementById('workoutSummaryList');
  if (!listContainer) return;
  
  if (workouts.length === 0) {
    listContainer.innerHTML = '<div class="label" style="text-align: center; margin-bottom: 16px;">No workouts recorded yet</div>';
    return;
  }
  
  listContainer.innerHTML = '';
  
  workouts.forEach(workout => {
    const summary = workout.summary;
    const workoutItem = document.createElement('div');
    workoutItem.className = 'workout-item';
    workoutItem.dataset.sessionId = summary.external_session_id;
    
    const date = new Date(summary.startedAt);
    const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    workoutItem.innerHTML = `
      <div class="swipe-left-indicator"></div>
      <div class="swipe-right-indicator"></div>
      <div class="workout-item-header">
        <div>
          <div class="workout-item-title">${summary.intent || 'Workout'}</div>
          <div class="workout-item-date">${dateStr}</div>
        </div>
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
    
    // Add swipe handler with both left (delete) and right (send to SISU) actions
    const swipe = createSwipeHandler(
      // Left swipe: delete
      () => {
        const sessionId = workoutItem.dataset.sessionId;
        if (sessionId) {
          workoutItem.classList.add('deleting');
          setTimeout(() => {
            // Reset the swipe animation
            workoutItem.classList.remove('deleting');
            // Show delete confirmation dialog
            openDeleteWorkoutModal(sessionId);
          }, 300);
        }
      },
      // Right swipe: send to SISU
      async () => {
        const sessionId = workoutItem.dataset.sessionId;
        if (sessionId) {
          workoutItem.classList.add('sending');
          try {
            const result = await window.sendWorkoutToSisu(sessionId);
            workoutItem.classList.remove('sending');
            if (result.success) {
              showToast(result.message, 'success');
            } else {
              showToast(result.message, 'error');
            }
          } catch (error) {
            workoutItem.classList.remove('sending');
            showToast('Error sending to SISU: ' + error.message, 'error');
          }
        }
      }
    );
    
    workoutItem.addEventListener('touchstart', swipe.onTouchStart);
    workoutItem.addEventListener('touchmove', swipe.onTouchMove);
    workoutItem.addEventListener('touchend', swipe.onTouchEnd);
    workoutItem.addEventListener('mousedown', swipe.onMouseDown);
    workoutItem.addEventListener('mousemove', swipe.onMouseMove);
    workoutItem.addEventListener('mouseup', swipe.onMouseUp);
    
    // Prevent click after swipe
    workoutItem.addEventListener('click', (e) => {
      if (swipe.onClick) swipe.onClick(e);
    }, true);
    
    listContainer.appendChild(workoutItem);
  });
}

// View workout summary in modal
let currentWorkoutSummary = null;

function viewWorkoutSummary(sessionId) {
  // Find workout in IndexedDB
  window.initDB().then(db => {
    const transaction = db.transaction(['workouts'], 'readonly');
    const store = transaction.objectStore('workouts');
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

// Show workout summary modal
function showWorkoutSummaryModal(summary) {
  currentWorkoutSummary = summary;
  const jsonElement = document.getElementById('workoutSummaryJson');
  if (jsonElement) {
    jsonElement.textContent = JSON.stringify(summary, null, 2);
  }
  document.getElementById('workoutSummaryModalBg').style.display = 'flex';
}

// Close workout summary modal
function closeWorkoutSummaryModal() {
  document.getElementById('workoutSummaryModalBg').style.display = 'none';
  currentWorkoutSummary = null;
}

// Download workout summary as JSON
function downloadWorkoutSummaryJson() {
  if (!currentWorkoutSummary) return;
  downloadWorkoutJson(currentWorkoutSummary.external_session_id);
}

// Toast notification function
function showToast(message, type = 'info') {
  // Remove existing toast if any
  const existingToast = document.getElementById('toast');
  if (existingToast) {
    existingToast.remove();
  }
  
  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  
  // Trigger animation
  setTimeout(() => toast.classList.add('show'), 10);
  
  // Remove after 3 seconds
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Download specific workout JSON
function downloadWorkoutJson(sessionId) {
  window.initDB().then(db => {
    const transaction = db.transaction(['workouts'], 'readonly');
    const store = transaction.objectStore('workouts');
    const request = store.get(sessionId);
    
    request.onsuccess = () => {
      const workout = request.result;
      if (workout && workout.summary) {
        const summaryForEmission = { ...workout.summary };
        delete summaryForEmission.day;
        
        const jsonStr = JSON.stringify(summaryForEmission, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
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

// Expose functions globally
window.switchTab = switchTab;
window.getShowSecondsCountdown = getShowSecondsCountdown;
window.getVoicePromptsEnabled = getVoicePromptsEnabled;
window.savePreferenceShowSeconds = savePreferenceShowSeconds;
window.savePreferenceVoicePrompts = savePreferenceVoicePrompts;
window.loadWorkoutSummaries = loadWorkoutSummaries;
window.viewWorkoutSummary = viewWorkoutSummary;
window.showWorkoutSummaryModal = showWorkoutSummaryModal;
window.closeWorkoutSummaryModal = closeWorkoutSummaryModal;
window.downloadWorkoutSummaryJson = downloadWorkoutSummaryJson;
window.showToast = showToast;
window.downloadWorkoutJson = downloadWorkoutJson;