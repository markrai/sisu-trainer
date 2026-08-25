import { isNativeRuntime } from "./platform/runtime.js";
let lastSpokenPhase = null;
let speechRequestId = 0;
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
    const requestId = ++speechRequestId;
    if (isNativeRuntime()) {
        void import("./platform/nativeSpeech.js")
            .then(({ speakNative }) => {
            if (requestId !== speechRequestId || lastSpokenPhase !== phaseDisplayName)
                return;
            return speakNative(phaseDisplayName);
        })
            .catch((error) => console.error("Native speech error:", error));
        return;
    }
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
    speechRequestId++;
    if (isNativeRuntime()) {
        void import("./platform/nativeSpeech.js")
            .then(({ stopNativeSpeech }) => stopNativeSpeech())
            .catch((error) => console.error("Native speech stop error:", error));
        return;
    }
    if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
    }
}
export function registerVoiceGlobals() {
    window.announcePhaseIfChanged = announcePhaseIfChanged;
    window.resetVoiceState = resetVoiceState;
}
export { announcePhaseIfChanged, resetVoiceState };
