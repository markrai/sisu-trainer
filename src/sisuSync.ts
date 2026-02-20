import { getSisuSettings, storeSisuSettings, clearSisuSettings, initDB } from "./workoutStorage.js";

interface SisuConnectionState {
  connected: boolean;
  lastSync: Date | null;
  hrvBaseline: any;
  syncError: string | null;
  host: string | null;
  port: number | null;
}

const sisuConnectionState: SisuConnectionState = {
  connected: false,
  lastSync: null,
  hrvBaseline: null,
  syncError: null,
  host: null,
  port: null,
};

function cleanHostForUrl(host: string) {
  if (!host) return host;
  return String(host)
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/:\d+$/, "")
    .replace(/\/$/, "")
    .replace(/:$/, "");
}

function getSisuProtocol() {
  return window.location.protocol === "https:" ? "https" : "http";
}

const SISU_HEALTH_TIMEOUT_MS = 5000;

async function testSisuConnection(host: string, port: number): Promise<{ ok: boolean; error?: string }> {
  const cleanedHost = cleanHostForUrl(host);
  const protocol = getSisuProtocol();
  const url = `${protocol}://${cleanedHost}:${port}/health`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SISU_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      mode: "cors",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (response.ok) {
      const data = await response.json();
      return { ok: data.status === "ok" };
    }
    return { ok: false, error: `HTTP ${response.status}` };
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    const err = error as Error & { name?: string };
    console.error("SISU connection test error:", error);
    if (err.name === "AbortError") {
      return { ok: false, error: "Connection timed out" };
    }
    if (err.message === "Failed to fetch") {
      return {
        ok: false,
        error: "Cannot reach SISU. Check host/port, that SISU is running, and that it allows CORS from this origin.",
      };
    }
    return { ok: false, error: err.message || String(error) };
  }
}

async function updateSISUStatus(message: string, connected: boolean) {
  const statusEl = document.getElementById("sisuStatus");
  const buttonEl = document.getElementById("sisuConnectButton");
  if (statusEl) {
    statusEl.textContent = message || (connected ? "Connected" : "Not connected");
    statusEl.style.color = connected ? "#3d7cff" : "#888";
  }
  if (buttonEl) {
    buttonEl.textContent = connected ? "Disconnect from SISU" : "Connect to SISU";
    (buttonEl as HTMLButtonElement).onclick = connected ? disconnectSISU : connectSISU;
  }
  sisuConnectionState.connected = connected;
  sisuConnectionState.lastSync = connected ? new Date() : null;
}

async function loadSisuSettings() {
  try {
    const settings = await getSisuSettings();
    if (settings) {
      sisuConnectionState.host = settings.host;
      sisuConnectionState.port = settings.port;
      const hostInput = document.getElementById("sisuHost") as HTMLInputElement | null;
      const portInput = document.getElementById("sisuPort") as HTMLInputElement | null;
      if (hostInput) {
        let host = settings.host;
        host = host.replace(/^https?:\/\//, "");
        host = host.replace(/:\d+$/, "");
        host = host.replace(/\/$/, "");
        host = host.replace(/:$/, "");
        hostInput.value = host;
      }
      if (portInput) portInput.value = settings.port.toString();
      const cleanedHost = settings.host.replace(/^https?:\/\//, "").replace(/:\d+$/, "").replace(/\/$/, "").replace(/:$/, "");
      const result = await testSisuConnection(cleanedHost, settings.port);
      const isConnected = result.ok;
      const statusMsg = isConnected ? `Connected to ${settings.host}:${settings.port}` : (result.error || "Settings saved but not connected");
      await updateSISUStatus(statusMsg, isConnected);
      return settings;
    } else {
      await updateSISUStatus("Not connected", false);
      return null;
    }
  } catch (error) {
    console.error("Error loading SISU settings:", error);
    await updateSISUStatus("Error loading settings", false);
    return null;
  }
}

async function connectSISU() {
  const hostInput = document.getElementById("sisuHost") as HTMLInputElement | null;
  const portInput = document.getElementById("sisuPort") as HTMLInputElement | null;
  if (!hostInput || !portInput) {
    await updateSISUStatus("Input fields not found", false);
    return;
  }
  const host = cleanHostForUrl(hostInput.value);
  const port = parseInt(portInput.value, 10);
  if (!host || !port || isNaN(port)) {
    await updateSISUStatus("Please enter valid host and port", false);
    return;
  }
  const currentHost = window.location.hostname;
  if (host === currentHost || (host.includes("vo2") && !host.includes("sisu"))) {
    await updateSISUStatus(
      `That looks like this app's host (${host}). Enter your SISU host (e.g. sisu.int.oyehoy.net).`,
      false
    );
    return;
  }
  try {
    const protocol = getSisuProtocol();
    await updateSISUStatus(`Testing ${protocol}://${host}:${port}/health ...`, false);
    const result = await testSisuConnection(host, port);
    if (result.ok) {
      const stored = await storeSisuSettings(host, port);
      if (stored) {
        sisuConnectionState.host = host;
        sisuConnectionState.port = port;
        sisuConnectionState.connected = true;
        await updateSISUStatus(`Connected to ${host}:${port}`, true);
        const infoEl = document.getElementById("sisuConnectionInfo");
        if (infoEl) {
          infoEl.textContent = `Connected to ${host}:${port}`;
          infoEl.style.display = "block";
        }
      } else {
        await updateSISUStatus("Connection successful but failed to save settings", false);
      }
    } else {
      await updateSISUStatus(result.error || "Connection failed - check host and port", false);
    }
  } catch (error: any) {
    console.error("SISU connection error:", error);
    await updateSISUStatus("Connection failed: " + error.message, false);
  }
}

async function disconnectSISU() {
  await clearSisuSettings();
  sisuConnectionState.connected = false;
  sisuConnectionState.host = null;
  sisuConnectionState.port = null;
  sisuConnectionState.hrvBaseline = null;
  sisuConnectionState.syncError = null;
  const hostInput = document.getElementById("sisuHost") as HTMLInputElement | null;
  const portInput = document.getElementById("sisuPort") as HTMLInputElement | null;
  if (hostInput) hostInput.value = "";
  if (portInput) portInput.value = "";
  const infoEl = document.getElementById("sisuConnectionInfo");
  if (infoEl) infoEl.style.display = "none";
  await updateSISUStatus("Disconnected", false);
}

async function syncHRVBaseline() {
  if (!sisuConnectionState.connected) return null;
  return null;
}

async function getTodayHRVFromSISU() {
  if (!sisuConnectionState.connected) return null;
  return null;
}

function adjustedBlockLengthsFromSISU(base: any, todayHRV: any, baselineHRV: any) {
  if (!todayHRV || !baselineHRV) return base;
  return base;
}

async function syncWithSISU() {
  if (!sisuConnectionState.connected) return;
  try {
    await syncHRVBaseline();
    sisuConnectionState.lastSync = new Date();
  } catch (error: any) {
    console.error("SISU sync error:", error);
    sisuConnectionState.syncError = error.message;
  }
}

async function sendWorkoutToSisu(sessionId: string) {
  try {
    const settings = await getSisuSettings();
    if (!settings || !settings.host || !settings.port) {
      return { success: false, message: "SISU not configured. Please connect in Settings > Sync tab." };
    }
    const database = await initDB();
    const tx = database.transaction(["workouts"], "readonly");
    const store = tx.objectStore("workouts");
    const workoutData = await new Promise<any>((resolve, reject) => {
      const request = store.get(sessionId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!workoutData || !workoutData.summary) {
      return { success: false, message: "Workout not found" };
    }
    const summary = workoutData.summary;
    const payload = { ...summary };
    if (typeof payload.day !== "string" || payload.day.trim() === "") {
      delete payload.day;
    }
    const cleanedHost = cleanHostForUrl(settings.host);
    const protocol = getSisuProtocol();
    const url = `${protocol}://${cleanedHost}:${settings.port}/workout/ingest`;
    const response = await fetch(url, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: (AbortSignal as any).timeout(10000),
    });
    if (response.ok) {
      const data = await response.json();
      await storeSisuSettings(settings.host, settings.port);
      return { success: true, message: `Workout sent to SISU (Load: ${data.acuteLoadPoints} points)` };
    } else {
      const errorText = await response.text();
      let errorMessage = `SISU error (${response.status})`;
      try {
        const errorData = JSON.parse(errorText);
        if (errorData.message) errorMessage = errorData.message;
      } catch {
        errorMessage = errorText || errorMessage;
      }
      return { success: false, message: errorMessage };
    }
  } catch (error: any) {
    console.error("Error sending workout to SISU:", error);
    if (error.name === "AbortError") {
      return { success: false, message: "Connection timeout - check SISU server" };
    }
    return { success: false, message: "Network error: " + error.message };
  }
}

export function registerSisuGlobals() {
  (window as any).connectSISU = connectSISU;
  (window as any).disconnectSISU = disconnectSISU;
  (window as any).updateSISUStatus = updateSISUStatus;
  (window as any).syncWithSISU = syncWithSISU;
  (window as any).getTodayHRVFromSISU = getTodayHRVFromSISU;
  (window as any).adjustedBlockLengthsFromSISU = adjustedBlockLengthsFromSISU;
  (window as any).loadSisuSettings = loadSisuSettings;
  (window as any).sendWorkoutToSisu = sendWorkoutToSisu;
}

export {
  loadSisuSettings,
  connectSISU,
  disconnectSISU,
  updateSISUStatus,
  syncWithSISU,
  getTodayHRVFromSISU,
  adjustedBlockLengthsFromSISU,
  sendWorkoutToSisu,
};
