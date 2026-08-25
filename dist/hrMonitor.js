import { parseHeartRateMeasurement } from "./platform/heartRateMeasurement.js";
import { isNativeRuntime } from "./platform/runtime.js";
let currentHrDevice = null;
let currentHrCharacteristic = null;
const BATTERY_POLL_MS = 2 * 60 * 1000;
let batteryPollIntervalId = null;
let currentBpm = null;
let connectInProgress = false;
const bpmCallbacks = [];
function bleDebugEnabled() {
    try {
        return localStorage.getItem("bleDebug") === "true";
    }
    catch {
        return false;
    }
}
function updateHrStatus() {
    if (typeof window.updateHrMonitorStatus === "function") {
        window.updateHrMonitorStatus();
    }
}
function updateBattery(percent) {
    window.hrBatteryPercent = percent;
    updateHrStatus();
}
function handleBpm(hr) {
    currentBpm = hr;
    for (const cb of bpmCallbacks) {
        try {
            cb(hr);
        }
        catch (error) {
            console.error("hrMonitor onBpm callback error:", error);
        }
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
    connectInProgress = false;
    window.hrDeviceName = null;
    window.hrBatteryPercent = null;
    window.liveBpm = null;
    window.lastBpmUpdateTime = null;
    updateHrStatus();
    if (typeof window.updateDisplay === "function")
        window.updateDisplay();
    if (typeof window.updateHrDisplay === "function")
        window.updateHrDisplay(null);
}
function dataViewFromValue(value) {
    if (value instanceof DataView)
        return value;
    if (value instanceof ArrayBuffer)
        return new DataView(value);
    if (value && value.buffer instanceof ArrayBuffer) {
        return new DataView(value.buffer, value.byteOffset || 0, value.byteLength || value.buffer.byteLength);
    }
    return new DataView(new ArrayBuffer(0));
}
function pollBatteryOnce() {
    var _a;
    const device = currentHrDevice;
    if (!((_a = device === null || device === void 0 ? void 0 : device.gatt) === null || _a === void 0 ? void 0 : _a.connected))
        return;
    device.gatt
        .getPrimaryService("battery_service")
        .then((service) => service.getCharacteristic("battery_level").readValue())
        .then((value) => {
        const percent = dataViewFromValue(value).getUint8(0);
        if (percent >= 0 && percent <= 100)
            updateBattery(percent);
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
        console.log("[BLE] Primary services:", services.map((service) => service.uuid));
        for (const service of services) {
            try {
                const characteristics = await service.getCharacteristics();
                console.log(`[BLE] Service ${service.uuid} characteristics:`, characteristics.map((characteristic) => characteristic.uuid));
                for (const characteristic of characteristics) {
                    try {
                        console.log(`[BLE]  - Char ${characteristic.uuid} props`, characteristic.properties);
                    }
                    catch {
                    }
                }
            }
            catch (error) {
                console.log("[BLE] Could not enumerate characteristics for service", service.uuid, error);
            }
        }
    }
    catch (error) {
        console.log("[BLE] Could not enumerate primary services", error);
    }
}
async function readBatteryPercentStandardBas(server) {
    var _a;
    const batteryService = await server.getPrimaryService("battery_service");
    const batteryCharacteristic = await batteryService.getCharacteristic("battery_level");
    try {
        if ((_a = batteryCharacteristic === null || batteryCharacteristic === void 0 ? void 0 : batteryCharacteristic.properties) === null || _a === void 0 ? void 0 : _a.notify) {
            await batteryCharacteristic.startNotifications();
            batteryCharacteristic.addEventListener("characteristicvaluechanged", (event) => {
                var _a;
                try {
                    const percent = dataViewFromValue((_a = event === null || event === void 0 ? void 0 : event.target) === null || _a === void 0 ? void 0 : _a.value).getUint8(0);
                    if (percent >= 0 && percent <= 100)
                        updateBattery(percent);
                }
                catch {
                }
            });
        }
    }
    catch {
    }
    const percent = dataViewFromValue(await batteryCharacteristic.readValue()).getUint8(0);
    return percent >= 0 && percent <= 100 ? percent : null;
}
const BATTERY_PROBES = [
    { name: "standard_bas_180f_2a19", read: (server) => readBatteryPercentStandardBas(server) },
];
async function readBatteryPercentWithProbes(server, device) {
    for (const probe of BATTERY_PROBES) {
        try {
            const percent = await probe.read(server, device);
            if (typeof percent === "number" && percent >= 0 && percent <= 100) {
                if (bleDebugEnabled())
                    console.log("[BLE] Battery probe success:", probe.name, percent);
                return percent;
            }
            if (bleDebugEnabled())
                console.log("[BLE] Battery probe returned null:", probe.name);
        }
        catch (error) {
            if (bleDebugEnabled())
                console.log("[BLE] Battery probe failed:", probe.name, error);
        }
    }
    return null;
}
function handleCharacteristicValueChanged(event) {
    handleBpm(parseHeartRateMeasurement(dataViewFromValue(event.target.value)));
}
async function connectNative() {
    const { connectNativeBle } = await import("./platform/nativeBle.js");
    await connectNativeBle({
        onConnected: (name) => {
            window.hrDeviceName = name;
            updateHrStatus();
        },
        onDisconnected: onHrDisconnect,
        onBpm: handleBpm,
        onBattery: updateBattery,
    });
}
function connectWeb() {
    const bluetooth = navigator.bluetooth;
    if (!bluetooth || typeof bluetooth.requestDevice !== "function") {
        console.error("Web Bluetooth API not available: navigator.bluetooth is missing.");
        if (typeof window.showToast === "function") {
            window.showToast("Bluetooth not supported in this browser. Use Chrome/Edge on HTTPS (or localhost).");
        }
        connectInProgress = false;
        return;
    }
    bluetooth
        .requestDevice({
        filters: [{ services: ["heart_rate"] }],
        optionalServices: ["battery_service", "device_information"],
    })
        .then((device) => {
        currentHrDevice = device;
        device.addEventListener("gattserverdisconnected", onHrDisconnect);
        return device.gatt.connect().then((server) => ({ device, server }));
    })
        .then(({ device, server }) => {
        window.hrDeviceName = device.name || "Heart rate sensor";
        updateHrStatus();
        void dumpGattProfile(server);
        return server.getPrimaryService("heart_rate").then((hrService) => ({ device, server, hrService }));
    })
        .then(({ device, server, hrService }) => hrService
        .getCharacteristic("heart_rate_measurement")
        .then((characteristic) => ({ device, server, characteristic })))
        .then(({ device, server, characteristic }) => {
        currentHrCharacteristic = characteristic;
        characteristic.addEventListener("characteristicvaluechanged", handleCharacteristicValueChanged);
        return characteristic.startNotifications().then(() => ({ device, server }));
    })
        .then(({ device, server }) => readBatteryPercentWithProbes(server, device).catch(() => null))
        .then((battery) => {
        updateBattery(battery);
        if (battery !== null)
            startBatteryPolling();
    })
        .catch((error) => {
        console.error(error);
        onHrDisconnect();
    })
        .finally(() => {
        connectInProgress = false;
    });
}
export function connect() {
    if (connectInProgress)
        return;
    connectInProgress = true;
    if (isNativeRuntime()) {
        void connectNative()
            .catch((error) => {
            console.error("Native BLE connection error:", error);
            onHrDisconnect();
            if (typeof window.showToast === "function") {
                window.showToast("Unable to connect to the heart-rate monitor.");
            }
        })
            .finally(() => {
            connectInProgress = false;
        });
        return;
    }
    connectWeb();
}
export function onBpm(callback) {
    bpmCallbacks.push(callback);
}
export function getCurrentBpm() {
    return currentBpm;
}
export function disconnect() {
    var _a;
    if (isNativeRuntime()) {
        void import("./platform/nativeBle.js")
            .then(({ disconnectNativeBle }) => disconnectNativeBle())
            .catch((error) => console.error("Native BLE disconnect error:", error));
        return;
    }
    if ((_a = currentHrDevice === null || currentHrDevice === void 0 ? void 0 : currentHrDevice.gatt) === null || _a === void 0 ? void 0 : _a.connected) {
        currentHrDevice.gatt.disconnect();
    }
}
