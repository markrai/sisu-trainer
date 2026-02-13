let currentHrDevice = null;
/** Keep a reference so the characteristic is not GC'd (important on Android Chrome). */
let currentHrCharacteristic = null;
const BATTERY_POLL_MS = 2 * 60 * 1000; // 2 minutes
let batteryPollIntervalId = null;
let currentBpm = null;
const bpmCallbacks = [];
function bleDebugEnabled() {
    try {
        return localStorage.getItem("bleDebug") === "true";
    }
    catch {
        return false;
    }
}
function onHrDisconnect() {
    if (batteryPollIntervalId !== null) {
        clearInterval(batteryPollIntervalId);
        batteryPollIntervalId = null;
    }
    currentHrDevice = null;
    currentHrCharacteristic = null;
    currentBpm = null;
    window.hrDeviceName = null;
    window.hrBatteryPercent = null;
    window.liveBpm = null;
    window.lastBpmUpdateTime = null;
    if (typeof window.updateHrMonitorStatus === "function")
        window.updateHrMonitorStatus();
    if (typeof window.updateDisplay === "function")
        window.updateDisplay();
    if (typeof window.updateHrDisplay === "function")
        window.updateHrDisplay(null);
}
function pollBatteryOnce() {
    var _a;
    const device = currentHrDevice;
    if (!((_a = device === null || device === void 0 ? void 0 : device.gatt) === null || _a === void 0 ? void 0 : _a.connected))
        return;
    device.gatt
        .getPrimaryService("battery_service")
        .then((s) => s.getCharacteristic("battery_level").readValue())
        .then((value) => {
        const dv = value instanceof DataView ? value : new DataView(value instanceof ArrayBuffer ? value : value.buffer);
        const pct = dv.getUint8(0);
        if (pct >= 0 && pct <= 100) {
            window.hrBatteryPercent = pct;
            if (typeof window.updateHrMonitorStatus === "function")
                window.updateHrMonitorStatus();
        }
    })
        .catch(() => { });
}
function startBatteryPolling() {
    if (batteryPollIntervalId !== null)
        return;
    batteryPollIntervalId = setInterval(pollBatteryOnce, BATTERY_POLL_MS);
}
async function dumpGattProfile(server) {
    if (!bleDebugEnabled())
        return;
    try {
        const services = await server.getPrimaryServices();
        console.log("[BLE] Primary services:", services.map((s) => s.uuid));
        for (const service of services) {
            try {
                const chars = await service.getCharacteristics();
                console.log(`[BLE] Service ${service.uuid} characteristics:`, chars.map((c) => c.uuid));
                for (const ch of chars) {
                    try {
                        console.log(`[BLE]  - Char ${ch.uuid} props`, ch.properties);
                    }
                    catch {
                        // ignore
                    }
                }
            }
            catch (e) {
                console.log("[BLE] Could not enumerate characteristics for service", service.uuid, e);
            }
        }
    }
    catch (e) {
        console.log("[BLE] Could not enumerate primary services", e);
    }
}
function dataViewFromReadValue(value) {
    if (value instanceof DataView)
        return value;
    if (value instanceof ArrayBuffer)
        return new DataView(value);
    if (value && value.buffer instanceof ArrayBuffer)
        return new DataView(value.buffer);
    return new DataView(new ArrayBuffer(0));
}
async function readBatteryPercentStandardBas(server) {
    var _a;
    // Standard GATT Battery Service (0x180F) / Battery Level (0x2A19)
    const batteryService = await server.getPrimaryService("battery_service");
    const batteryChar = await batteryService.getCharacteristic("battery_level");
    // Prefer notifications if supported (keeps UI updated if device changes it)
    try {
        if ((_a = batteryChar === null || batteryChar === void 0 ? void 0 : batteryChar.properties) === null || _a === void 0 ? void 0 : _a.notify) {
            await batteryChar.startNotifications();
            batteryChar.addEventListener("characteristicvaluechanged", (event) => {
                var _a;
                try {
                    const dv = dataViewFromReadValue((_a = event === null || event === void 0 ? void 0 : event.target) === null || _a === void 0 ? void 0 : _a.value);
                    const v = dv.getUint8(0);
                    if (v >= 0 && v <= 100) {
                        window.hrBatteryPercent = v;
                        if (typeof window.updateHrMonitorStatus === "function")
                            window.updateHrMonitorStatus();
                    }
                }
                catch {
                    // ignore
                }
            });
        }
    }
    catch {
        // ignore; we can still do a one-shot read below
    }
    const dv = dataViewFromReadValue(await batteryChar.readValue());
    const percent = dv.getUint8(0);
    return percent >= 0 && percent <= 100 ? percent : null;
}
const BATTERY_PROBES = [
    { name: "standard_bas_180f_2a19", read: (server) => readBatteryPercentStandardBas(server) },
    // Add vendor-specific probes here as we discover them.
];
async function readBatteryPercentWithProbes(server, device) {
    for (const probe of BATTERY_PROBES) {
        try {
            const v = await probe.read(server, device);
            if (typeof v === "number" && v >= 0 && v <= 100) {
                if (bleDebugEnabled())
                    console.log("[BLE] Battery probe success:", probe.name, v);
                return v;
            }
            if (bleDebugEnabled())
                console.log("[BLE] Battery probe returned null:", probe.name);
        }
        catch (e) {
            if (bleDebugEnabled())
                console.log("[BLE] Battery probe failed:", probe.name, e);
        }
    }
    return null;
}
function parseHrValue(value) {
    value = value.buffer ? value : new DataView(value);
    const flags = value.getUint8(0);
    const rate16Bits = flags & 0x1;
    let index = 1;
    if (rate16Bits) {
        const heartRate = value.getUint16(index, true);
        return heartRate;
    }
    else {
        const heartRate = value.getUint8(index);
        return heartRate;
    }
}
function handleCharacteristicValueChanged(event) {
    const hr = parseHrValue(event.target.value);
    currentBpm = hr;
    for (const cb of bpmCallbacks) {
        try {
            cb(hr);
        }
        catch (e) {
            console.error("hrMonitor onBpm callback error:", e);
        }
    }
}
export function connect() {
    const bt = navigator.bluetooth;
    if (!bt || typeof bt.requestDevice !== "function") {
        console.error("Web Bluetooth API not available: navigator.bluetooth is missing.");
        if (typeof window.showToast === "function") {
            window.showToast("Bluetooth not supported in this browser. Use Chrome/Edge on HTTPS (or localhost).");
        }
        return;
    }
    bt.requestDevice({
        filters: [{ services: ["heart_rate"] }],
        // Request access to extra services up-front so we can probe battery (and inspect services in debug mode).
        optionalServices: ["battery_service", "device_information"],
    })
        .then((device) => {
        currentHrDevice = device;
        device.addEventListener("gattserverdisconnected", onHrDisconnect);
        return device.gatt.connect().then((server) => ({ device, server }));
    })
        .then(({ device, server }) => {
        window.hrDeviceName = device.name || "Heart rate sensor";
        if (typeof window.updateHrMonitorStatus === "function")
            window.updateHrMonitorStatus();
        dumpGattProfile(server);
        return server.getPrimaryService("heart_rate").then((hrService) => ({ device, server, hrService }));
    })
        .then(({ device, server, hrService }) => hrService.getCharacteristic("heart_rate_measurement").then((characteristic) => ({ device, server, characteristic })))
        .then(({ device, server, characteristic }) => {
        currentHrCharacteristic = characteristic;
        characteristic.addEventListener("characteristicvaluechanged", handleCharacteristicValueChanged);
        return characteristic.startNotifications().then(() => ({ device, server }));
    })
        .then(({ device, server }) => readBatteryPercentWithProbes(server, device).catch(() => {
        window.hrBatteryPercent = null;
        if (typeof window.updateHrMonitorStatus === "function")
            window.updateHrMonitorStatus();
        return null;
    }))
        .then((battery) => {
        window.hrBatteryPercent = battery;
        if (typeof window.updateHrMonitorStatus === "function")
            window.updateHrMonitorStatus();
        if (battery !== null)
            startBatteryPolling();
    })
        .catch((error) => console.error(error));
}
export function onBpm(callback) {
    bpmCallbacks.push(callback);
}
export function getCurrentBpm() {
    return currentBpm;
}
export function disconnect() {
    var _a;
    if ((_a = currentHrDevice === null || currentHrDevice === void 0 ? void 0 : currentHrDevice.gatt) === null || _a === void 0 ? void 0 : _a.connected) {
        currentHrDevice.gatt.disconnect();
    }
}
