import { BleClient, numberToUUID } from "@capacitor-community/bluetooth-le";
import { parseHeartRateMeasurement } from "./heartRateMeasurement.js";
const HEART_RATE_SERVICE = numberToUUID(0x180d);
const HEART_RATE_MEASUREMENT = numberToUUID(0x2a37);
const BATTERY_SERVICE = numberToUUID(0x180f);
const BATTERY_LEVEL = numberToUUID(0x2a19);
const BATTERY_POLL_MS = 2 * 60 * 1000;
let initializePromise = null;
let activeDeviceId = null;
let activeHandlers = null;
let batteryPollIntervalId = null;
function initializeBle() {
    if (!initializePromise) {
        initializePromise = BleClient.initialize({ androidNeverForLocation: true }).catch((error) => {
            initializePromise = null;
            throw error;
        });
    }
    return initializePromise;
}
function clearBatteryPolling() {
    if (batteryPollIntervalId !== null) {
        clearInterval(batteryPollIntervalId);
        batteryPollIntervalId = null;
    }
}
function handleDisconnect(deviceId) {
    if (activeDeviceId !== deviceId)
        return;
    const handlers = activeHandlers;
    activeDeviceId = null;
    activeHandlers = null;
    clearBatteryPolling();
    handlers === null || handlers === void 0 ? void 0 : handlers.onDisconnected();
}
async function readBattery(deviceId) {
    try {
        const value = await BleClient.read(deviceId, BATTERY_SERVICE, BATTERY_LEVEL);
        const percent = value.getUint8(0);
        return percent >= 0 && percent <= 100 ? percent : null;
    }
    catch {
        return null;
    }
}
async function updateBattery(deviceId) {
    const percent = await readBattery(deviceId);
    if (activeDeviceId !== deviceId)
        return false;
    activeHandlers === null || activeHandlers === void 0 ? void 0 : activeHandlers.onBattery(percent);
    return percent !== null;
}
export async function connectNativeBle(handlers) {
    await initializeBle();
    if (activeDeviceId)
        await disconnectNativeBle();
    const device = await BleClient.requestDevice({
        services: [HEART_RATE_SERVICE],
        optionalServices: [BATTERY_SERVICE],
        displayMode: "list",
    });
    activeDeviceId = device.deviceId;
    activeHandlers = handlers;
    try {
        await BleClient.connect(device.deviceId, handleDisconnect);
        handlers.onConnected(device.name || "Heart rate sensor");
        await BleClient.startNotifications(device.deviceId, HEART_RATE_SERVICE, HEART_RATE_MEASUREMENT, (value) => handlers.onBpm(parseHeartRateMeasurement(value)));
        if (await updateBattery(device.deviceId)) {
            batteryPollIntervalId = setInterval(() => {
                void updateBattery(device.deviceId);
            }, BATTERY_POLL_MS);
        }
    }
    catch (error) {
        try {
            await BleClient.disconnect(device.deviceId);
        }
        catch {
        }
        handleDisconnect(device.deviceId);
        throw error;
    }
}
export async function disconnectNativeBle() {
    const deviceId = activeDeviceId;
    if (!deviceId)
        return;
    try {
        await BleClient.stopNotifications(deviceId, HEART_RATE_SERVICE, HEART_RATE_MEASUREMENT);
    }
    catch {
    }
    try {
        await BleClient.disconnect(deviceId);
    }
    finally {
        handleDisconnect(deviceId);
    }
}
