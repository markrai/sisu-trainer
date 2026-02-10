import { getSisuSettings, storeSisuSettings, clearSisuSettings, initDB } from "./workoutStorage.js";
const sisuConnectionState = {
    connected: false,
    lastSync: null,
    hrvBaseline: null,
    syncError: null,
    host: null,
    port: null,
};
function cleanHostForUrl(host) {
    if (!host)
        return host;
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
async function testSisuConnection(host, port) {
    try {
        const cleanedHost = cleanHostForUrl(host);
        const protocol = getSisuProtocol();
        const url = `${protocol}://${cleanedHost}:${port}/health`;
        const response = await fetch(url, {
            method: "GET",
            mode: "cors",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
            const data = await response.json();
            return data.status === "ok";
        }
        return false;
    }
    catch (error) {
        console.error("SISU connection test error:", error);
        return false;
    }
}
async function updateSISUStatus(message, connected) {
    const statusEl = document.getElementById("sisuStatus");
    const buttonEl = document.getElementById("sisuConnectButton");
    if (statusEl) {
        statusEl.textContent = message || (connected ? "Connected" : "Not connected");
        statusEl.style.color = connected ? "#3d7cff" : "#888";
    }
    if (buttonEl) {
        buttonEl.textContent = connected ? "Disconnect from SISU" : "Connect to SISU";
        buttonEl.onclick = connected ? disconnectSISU : connectSISU;
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
            const hostInput = document.getElementById("sisuHost");
            const portInput = document.getElementById("sisuPort");
            if (hostInput) {
                let host = settings.host;
                host = host.replace(/^https?:\/\//, "");
                host = host.replace(/:\d+$/, "");
                host = host.replace(/\/$/, "");
                host = host.replace(/:$/, "");
                hostInput.value = host;
            }
            if (portInput)
                portInput.value = settings.port.toString();
            const cleanedHost = settings.host.replace(/^https?:\/\//, "").replace(/:\d+$/, "").replace(/\/$/, "").replace(/:$/, "");
            const isConnected = await testSisuConnection(cleanedHost, settings.port);
            await updateSISUStatus(isConnected ? `Connected to ${settings.host}:${settings.port}` : "Settings saved but not connected", isConnected);
            return settings;
        }
        else {
            await updateSISUStatus("Not connected", false);
            return null;
        }
    }
    catch (error) {
        console.error("Error loading SISU settings:", error);
        await updateSISUStatus("Error loading settings", false);
        return null;
    }
}
async function connectSISU() {
    const hostInput = document.getElementById("sisuHost");
    const portInput = document.getElementById("sisuPort");
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
        await updateSISUStatus(`That looks like the VO2 host (${host}). Enter your SISU host (e.g. sisu.int.oyehoy.net).`, false);
        return;
    }
    try {
        const protocol = getSisuProtocol();
        await updateSISUStatus(`Testing ${protocol}://${host}:${port}/health ...`, false);
        const isConnected = await testSisuConnection(host, port);
        if (isConnected) {
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
            }
            else {
                await updateSISUStatus("Connection successful but failed to save settings", false);
            }
        }
        else {
            await updateSISUStatus("Connection failed - check host and port", false);
        }
    }
    catch (error) {
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
    const hostInput = document.getElementById("sisuHost");
    const portInput = document.getElementById("sisuPort");
    if (hostInput)
        hostInput.value = "";
    if (portInput)
        portInput.value = "";
    const infoEl = document.getElementById("sisuConnectionInfo");
    if (infoEl)
        infoEl.style.display = "none";
    await updateSISUStatus("Disconnected", false);
}
async function syncHRVBaseline() {
    if (!sisuConnectionState.connected)
        return null;
    return null;
}
async function getTodayHRVFromSISU() {
    if (!sisuConnectionState.connected)
        return null;
    return null;
}
function adjustedBlockLengthsFromSISU(base, todayHRV, baselineHRV) {
    if (!todayHRV || !baselineHRV)
        return base;
    return base;
}
async function syncWithSISU() {
    if (!sisuConnectionState.connected)
        return;
    try {
        await syncHRVBaseline();
        sisuConnectionState.lastSync = new Date();
    }
    catch (error) {
        console.error("SISU sync error:", error);
        sisuConnectionState.syncError = error.message;
    }
}
async function sendWorkoutToSisu(sessionId) {
    try {
        const settings = await getSisuSettings();
        if (!settings || !settings.host || !settings.port) {
            return { success: false, message: "SISU not configured. Please connect in Settings > Sync tab." };
        }
        const database = await initDB();
        const tx = database.transaction(["workouts"], "readonly");
        const store = tx.objectStore("workouts");
        const workoutData = await new Promise((resolve, reject) => {
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
            signal: AbortSignal.timeout(10000),
        });
        if (response.ok) {
            const data = await response.json();
            await storeSisuSettings(settings.host, settings.port);
            return { success: true, message: `Workout sent to SISU (Load: ${data.acuteLoadPoints} points)` };
        }
        else {
            const errorText = await response.text();
            let errorMessage = `SISU error (${response.status})`;
            try {
                const errorData = JSON.parse(errorText);
                if (errorData.message)
                    errorMessage = errorData.message;
            }
            catch {
                errorMessage = errorText || errorMessage;
            }
            return { success: false, message: errorMessage };
        }
    }
    catch (error) {
        console.error("Error sending workout to SISU:", error);
        if (error.name === "AbortError") {
            return { success: false, message: "Connection timeout - check SISU server" };
        }
        return { success: false, message: "Network error: " + error.message };
    }
}
export function registerSisuGlobals() {
    window.connectSISU = connectSISU;
    window.disconnectSISU = disconnectSISU;
    window.updateSISUStatus = updateSISUStatus;
    window.syncWithSISU = syncWithSISU;
    window.getTodayHRVFromSISU = getTodayHRVFromSISU;
    window.adjustedBlockLengthsFromSISU = adjustedBlockLengthsFromSISU;
    window.loadSisuSettings = loadSisuSettings;
    window.sendWorkoutToSisu = sendWorkoutToSisu;
}
export { loadSisuSettings, connectSISU, disconnectSISU, updateSISUStatus, syncWithSISU, getTodayHRVFromSISU, adjustedBlockLengthsFromSISU, sendWorkoutToSisu, };
