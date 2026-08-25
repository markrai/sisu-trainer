function getCapacitorBridge() {
    return globalThis.Capacitor;
}
export function isNativeRuntime() {
    const bridge = getCapacitorBridge();
    if (!bridge)
        return false;
    if (typeof bridge.isNativePlatform === "function") {
        return bridge.isNativePlatform();
    }
    const platform = typeof bridge.getPlatform === "function" ? bridge.getPlatform() : "web";
    return platform === "android" || platform === "ios";
}
export function getRuntimePlatform() {
    var _a, _b;
    const platform = (_b = (_a = getCapacitorBridge()) === null || _a === void 0 ? void 0 : _a.getPlatform) === null || _b === void 0 ? void 0 : _b.call(_a);
    return platform === "android" || platform === "ios" ? platform : "web";
}
export function applyRuntimeDocumentState() {
    if (isNativeRuntime()) {
        document.documentElement.classList.add("capacitor-native");
    }
}
