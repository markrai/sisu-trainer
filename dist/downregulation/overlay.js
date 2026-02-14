/**
 * Downregulation overlay: tap-to-stop, play icon (1s fade), and session stats panel.
 * Keeps UI and behavior in one place so the main index stays clean.
 */
import { getParticleSizeScale, setParticleSizeScale, getParticleStyle, setParticleStyle, } from "./renderer.js";
const PLAY_ICON_DURATION_MS = 1000;
const FADE_DURATION_MS = 400;
const SESSION_HINT_FADE_MS = 3000;
let playIconWrap = null;
let sessionHintEl = null;
let statsPanel = null;
let statsContent = null;
let doneButton = null;
let tapHandler = null;
let onDismissCallback = null;
let startClickHandler = null;
let settingsBtn = null;
let prefsModal = null;
function ensureElements(container) {
    if (playIconWrap)
        return;
    playIconWrap = container.querySelector("#downregulationPlayIconWrap");
    statsPanel = container.querySelector("#downregulationStatsPanel");
    statsContent = container.querySelector("#downregulationStatsContent");
    doneButton = container.querySelector("#downregulationStatsDone");
    if (!playIconWrap) {
        playIconWrap = document.createElement("div");
        playIconWrap.id = "downregulationPlayIconWrap";
        playIconWrap.className = "downregulation-play-wrap";
        playIconWrap.setAttribute("aria-hidden", "true");
        playIconWrap.innerHTML = '<span class="downregulation-play-icon" aria-hidden="true"></span><span class="downregulation-play-label" aria-hidden="true">click to begin session</span>';
        container.appendChild(playIconWrap);
    }
    if (!statsPanel) {
        statsPanel = document.createElement("div");
        statsPanel.id = "downregulationStatsPanel";
        statsPanel.className = "downregulation-stats-panel";
        statsPanel.setAttribute("aria-live", "polite");
        statsPanel.innerHTML = `
      <h3 class="downregulation-stats-title">Session summary</h3>
      <div id="downregulationStatsContent" class="downregulation-stats-content"></div>
      <button type="button" id="downregulationStatsDone" class="button downregulation-stats-done">Done</button>
    `;
        statsContent = statsPanel.querySelector("#downregulationStatsContent");
        doneButton = statsPanel.querySelector("#downregulationStatsDone");
        container.appendChild(statsPanel);
    }
    else {
        statsContent = statsPanel.querySelector("#downregulationStatsContent");
        doneButton = statsPanel.querySelector("#downregulationStatsDone");
    }
    if (!container.querySelector("#downregulationSessionHint")) {
        sessionHintEl = document.createElement("div");
        sessionHintEl.id = "downregulationSessionHint";
        sessionHintEl.className = "downregulation-session-hint";
        sessionHintEl.setAttribute("aria-hidden", "true");
        sessionHintEl.textContent = "Try to calm the starfield...";
        container.appendChild(sessionHintEl);
    }
    else {
        sessionHintEl = container.querySelector("#downregulationSessionHint");
    }
    if (!container.querySelector("#downregulationSettingsBtn")) {
        settingsBtn = document.createElement("button");
        settingsBtn.setAttribute("type", "button");
        settingsBtn.id = "downregulationSettingsBtn";
        settingsBtn.className = "downregulation-settings-btn";
        settingsBtn.setAttribute("aria-label", "Downregulation preferences");
        settingsBtn.innerHTML = '<img src="settings.svg" alt="" width="28" height="28">';
        settingsBtn.onclick = openDownregulationPrefsModal;
        container.appendChild(settingsBtn);
    }
    else {
        settingsBtn = container.querySelector("#downregulationSettingsBtn");
    }
    if (!document.getElementById("downregulationPrefsModal")) {
        prefsModal = document.createElement("div");
        prefsModal.id = "downregulationPrefsModal";
        prefsModal.className = "modal-bg downregulation-prefs-modal-bg";
        prefsModal.style.display = "none";
        prefsModal.innerHTML = `
      <div class="modal downregulation-prefs-modal">
        <div class="close-btn" id="downregulationPrefsClose" aria-label="Close">✕</div>
        <h3 class="downregulation-stats-title">Downregulation preferences</h3>
        <div class="modal-field modal-field-column">
          <span class="modal-label">Particle style</span>
          <div class="downregulation-style-toggle" role="group" aria-label="Particle style">
            <label class="downregulation-style-option">
              <input type="radio" name="downregulationParticleStyle" value="beads" checked>
              <span>Beads</span>
            </label>
            <label class="downregulation-style-option">
              <input type="radio" name="downregulationParticleStyle" value="starfield">
              <span>Starfield</span>
            </label>
          </div>
        </div>
        <div class="modal-field">
          <label class="modal-label" for="downregulationParticleSizeSlider">Increase size of particles</label>
          <input type="range" id="downregulationParticleSizeSlider" min="1" max="3" step="0.05" value="1">
        </div>
        <p class="label" id="downregulationParticleSizeValue" style="margin-top: 0.5rem; opacity: 0.8;"></p>
        <button type="button" class="button" id="downregulationPrefsCloseBtn">Close</button>
      </div>
    `;
        document.body.appendChild(prefsModal);
        const closeEl = prefsModal.querySelector("#downregulationPrefsClose");
        const closeBtn = prefsModal.querySelector("#downregulationPrefsCloseBtn");
        const slider = prefsModal.querySelector("#downregulationParticleSizeSlider");
        const valueEl = prefsModal.querySelector("#downregulationParticleSizeValue");
        const styleRadios = prefsModal.querySelectorAll('input[name="downregulationParticleStyle"]');
        const updateValueLabel = () => {
            if (valueEl && slider)
                valueEl.textContent = String(Math.round(parseFloat(slider.value) * 100) / 100);
        };
        const applyAndClose = () => {
            if (slider) {
                const v = parseFloat(slider.value);
                setParticleSizeScale(v);
            }
            const checkedStyle = prefsModal.querySelector('input[name="downregulationParticleStyle"]:checked');
            if (checkedStyle && (checkedStyle.value === "beads" || checkedStyle.value === "starfield")) {
                setParticleStyle(checkedStyle.value);
            }
            prefsModal.style.display = "none";
        };
        closeEl === null || closeEl === void 0 ? void 0 : closeEl.addEventListener("click", applyAndClose);
        closeBtn === null || closeBtn === void 0 ? void 0 : closeBtn.addEventListener("click", applyAndClose);
        styleRadios.forEach((radio) => {
            radio.addEventListener("change", () => {
                if (radio.checked && (radio.value === "beads" || radio.value === "starfield")) {
                    setParticleStyle(radio.value);
                }
            });
        });
        slider === null || slider === void 0 ? void 0 : slider.addEventListener("input", () => {
            updateValueLabel();
            const v = parseFloat(slider.value);
            setParticleSizeScale(v);
        });
        prefsModal.addEventListener("click", (e) => {
            if (e.target === prefsModal)
                applyAndClose();
        });
        if (slider)
            slider.value = String(getParticleSizeScale());
        updateValueLabel();
    }
    else {
        prefsModal = document.getElementById("downregulationPrefsModal");
    }
}
/**
 * Show the play icon as "tap to start" — stays visible until the user taps it. On tap, hides the icon and calls onTapToStart (workout begins).
 */
export function showPlayIconForStart(container, onTapToStart) {
    ensureElements(container);
    if (!playIconWrap)
        return;
    playIconWrap.classList.remove("downregulation-play-wrap--fade");
    playIconWrap.classList.add("downregulation-play-wrap--clickable");
    playIconWrap.style.display = "flex";
    playIconWrap.style.opacity = "1";
    playIconWrap.style.visibility = "visible";
    const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        playIconWrap === null || playIconWrap === void 0 ? void 0 : playIconWrap.classList.remove("downregulation-play-wrap--clickable");
        playIconWrap === null || playIconWrap === void 0 ? void 0 : playIconWrap.removeEventListener("click", handler);
        playIconWrap === null || playIconWrap === void 0 ? void 0 : playIconWrap.removeEventListener("touchend", handler);
        startClickHandler = null;
        playIconWrap === null || playIconWrap === void 0 ? void 0 : playIconWrap.classList.add("downregulation-play-wrap--fade");
        window.setTimeout(() => {
            hidePlayIcon();
            onTapToStart();
        }, FADE_DURATION_MS);
    };
    startClickHandler = handler;
    playIconWrap.addEventListener("click", handler);
    playIconWrap.addEventListener("touchend", handler, { passive: false });
}
/**
 * Hide the play icon (e.g. after user tapped to start the workout).
 */
export function hidePlayIcon() {
    if (playIconWrap) {
        playIconWrap.style.display = "none";
        playIconWrap.classList.remove("downregulation-play-wrap--clickable", "downregulation-play-wrap--fade");
    }
}
/**
 * Show the session hint "Try to calm the starfield..." with a 3s fade-in, then 3s fade-out.
 * Call when the session has just begun.
 */
export function showSessionHint(container) {
    ensureElements(container);
    if (!sessionHintEl)
        return;
    sessionHintEl.style.display = "flex";
    sessionHintEl.style.transition = `opacity ${SESSION_HINT_FADE_MS}ms ease`;
    sessionHintEl.style.opacity = "0";
    sessionHintEl.offsetHeight;
    sessionHintEl.style.opacity = "1";
    window.setTimeout(() => {
        if (!sessionHintEl)
            return;
        sessionHintEl.style.opacity = "0";
        window.setTimeout(() => {
            if (sessionHintEl) {
                sessionHintEl.style.display = "none";
                sessionHintEl.style.opacity = "";
                sessionHintEl.style.transition = "";
            }
        }, SESSION_HINT_FADE_MS);
    }, SESSION_HINT_FADE_MS);
}
export function hideSessionHint() {
    if (sessionHintEl) {
        sessionHintEl.style.display = "none";
        sessionHintEl.style.opacity = "";
        sessionHintEl.style.transition = "";
    }
}
function openDownregulationPrefsModal() {
    if (!prefsModal)
        return;
    const slider = prefsModal.querySelector("#downregulationParticleSizeSlider");
    const valueEl = prefsModal.querySelector("#downregulationParticleSizeValue");
    const styleRadios = prefsModal.querySelectorAll('input[name="downregulationParticleStyle"]');
    if (slider)
        slider.value = String(getParticleSizeScale());
    if (valueEl && slider)
        valueEl.textContent = String(Math.round(parseFloat(slider.value) * 100) / 100);
    const currentStyle = getParticleStyle();
    styleRadios.forEach((radio) => {
        radio.checked = radio.value === currentStyle;
    });
    prefsModal.style.display = "flex";
}
/**
 * Show the white play icon in the center for 1s, then fade out. Calls onComplete when done.
 */
export function showPlayIcon(container, onComplete) {
    ensureElements(container);
    if (!playIconWrap) {
        onComplete();
        return;
    }
    playIconWrap.style.display = "flex";
    playIconWrap.style.opacity = "1";
    playIconWrap.classList.remove("downregulation-play-wrap--fade");
    const fadeStart = PLAY_ICON_DURATION_MS - FADE_DURATION_MS;
    const fadeTimer = window.setTimeout(() => {
        playIconWrap === null || playIconWrap === void 0 ? void 0 : playIconWrap.classList.add("downregulation-play-wrap--fade");
    }, fadeStart);
    const endTimer = window.setTimeout(() => {
        window.clearTimeout(fadeTimer);
        if (playIconWrap) {
            playIconWrap.style.display = "none";
            playIconWrap.classList.remove("downregulation-play-wrap--fade");
        }
        onComplete();
    }, PLAY_ICON_DURATION_MS);
}
/**
 * Show the stats panel with the given stats. Done button calls onDismiss.
 */
export function showStats(container, stats, onDismiss) {
    ensureElements(container);
    onDismissCallback = onDismiss;
    if (statsContent) {
        statsContent.innerHTML = stats.summaryLines.map((line) => `<p class="downregulation-stats-line">${escapeHtml(line)}</p>`).join("");
    }
    if (statsPanel) {
        statsPanel.style.display = "block";
        statsPanel.setAttribute("aria-hidden", "false");
    }
    if (doneButton && !doneButton.__downregDoneBound) {
        doneButton.__downregDoneBound = true;
        let dismissScheduled = false;
        const runDismiss = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (dismissScheduled)
                return;
            dismissScheduled = true;
            const cb = onDismissCallback;
            onDismissCallback = null;
            hideStats();
            if (cb) {
                requestAnimationFrame(() => {
                    cb();
                    dismissScheduled = false;
                });
            }
            else {
                dismissScheduled = false;
            }
        };
        doneButton.addEventListener("click", runDismiss);
        doneButton.addEventListener("touchend", runDismiss, { passive: false });
    }
}
function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
}
/**
 * Hide the stats panel (e.g. when leaving the view).
 */
export function hideStats() {
    if (statsPanel) {
        statsPanel.style.display = "none";
        statsPanel.setAttribute("aria-hidden", "true");
    }
    if (statsContent)
        statsContent.innerHTML = "";
    onDismissCallback = null;
}
/**
 * Bind tap/click on the container. When fired: calls onTap(). Use onTap to end session, show play icon, then show stats and pass onDismiss.
 * Ignores taps on the stats panel (e.g. Done button) or play icon so they don't re-trigger the session-end flow.
 */
export function bindTap(container, onTap) {
    unbindTap(container);
    const handler = (e) => {
        const target = e.target;
        if ((statsPanel === null || statsPanel === void 0 ? void 0 : statsPanel.contains(target)) || (playIconWrap === null || playIconWrap === void 0 ? void 0 : playIconWrap.contains(target)) || (settingsBtn === null || settingsBtn === void 0 ? void 0 : settingsBtn.contains(target)))
            return;
        e.preventDefault();
        onTap();
    };
    tapHandler = handler;
    container.addEventListener("click", handler, { passive: false });
    container.addEventListener("touchend", handler, { passive: false });
}
/**
 * Unbind tap handler and hide overlays.
 */
export function unbindTap(container) {
    if (tapHandler) {
        container.removeEventListener("click", tapHandler);
        container.removeEventListener("touchend", tapHandler);
        tapHandler = null;
    }
    if (startClickHandler && playIconWrap) {
        playIconWrap.removeEventListener("click", startClickHandler);
        playIconWrap.removeEventListener("touchend", startClickHandler);
        startClickHandler = null;
    }
    hideStats();
    hidePlayIcon();
    hideSessionHint();
    if (prefsModal)
        prefsModal.style.display = "none";
}
