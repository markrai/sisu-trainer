let lastSpokenPhase = null;
function announcePhaseIfChanged(phaseDisplayName) {
    if (!phaseDisplayName || phaseDisplayName === "Not Started") {
        resetVoiceState();
        return;
    }
    if (typeof window.getVoicePromptsEnabled !== "function" || !window.getVoicePromptsEnabled()) {
        return;
    }
    if (phaseDisplayName === lastSpokenPhase)
        return;
    lastSpokenPhase = phaseDisplayName;
    if (!("speechSynthesis" in window))
        return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(phaseDisplayName);
    u.rate = 0.92;
    u.pitch = 1;
    window.speechSynthesis.speak(u);
}
function resetVoiceState() {
    lastSpokenPhase = null;
    if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
    }
}
export function registerVoiceGlobals() {
    window.announcePhaseIfChanged = announcePhaseIfChanged;
    window.resetVoiceState = resetVoiceState;
}
export { announcePhaseIfChanged, resetVoiceState };
