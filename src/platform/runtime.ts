interface CapacitorRuntimeBridge {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function getCapacitorBridge(): CapacitorRuntimeBridge | undefined {
  return (globalThis as any).Capacitor as CapacitorRuntimeBridge | undefined;
}

export function isNativeRuntime(): boolean {
  const bridge = getCapacitorBridge();
  if (!bridge) return false;
  if (typeof bridge.isNativePlatform === "function") {
    return bridge.isNativePlatform();
  }
  const platform = typeof bridge.getPlatform === "function" ? bridge.getPlatform() : "web";
  return platform === "android" || platform === "ios";
}

export function getRuntimePlatform(): "android" | "ios" | "web" {
  const platform = getCapacitorBridge()?.getPlatform?.();
  return platform === "android" || platform === "ios" ? platform : "web";
}

export function applyRuntimeDocumentState(): void {
  if (isNativeRuntime()) {
    document.documentElement.classList.add("capacitor-native");
  }
}
