import { BleClient, numberToUUID } from "@capacitor-community/bluetooth-le";
import { dispatchHeartRateMeasurement } from "./heartRateDispatch.js";

const HEART_RATE_SERVICE = numberToUUID(0x180d);
const HEART_RATE_MEASUREMENT = numberToUUID(0x2a37);
const BATTERY_SERVICE = numberToUUID(0x180f);
const BATTERY_LEVEL = numberToUUID(0x2a19);
const BATTERY_POLL_MS = 2 * 60 * 1000;

export interface NativeBleHandlers {
  onConnected: (name: string) => void;
  onDisconnected: () => void;
  onBpm: (bpm: number) => void;
  /**
   * All RR intervals from one 0x2A37 notification, in chronological order.
   * Prefer this over per-interval callbacks so HRV can reconstruct beat timing.
   */
  onRrIntervals?: (rrIntervalsMs: readonly number[]) => void;
  /** Optional EE/RR bytes were malformed; BPM was still delivered. */
  onOptionalFieldError?: (message: string) => void;
  /** Clean BPM-only measurement (optional fields OK, no RR). */
  onOptionalFieldsOk?: () => void;
  /** Silent clear of a stale optional-field diagnostic before RR ingest. */
  onClearOptionalFieldError?: () => void;
  onBattery: (percent: number | null) => void;
}

let initializePromise: Promise<void> | null = null;
let activeDeviceId: string | null = null;
let activeHandlers: NativeBleHandlers | null = null;
let batteryPollIntervalId: ReturnType<typeof setInterval> | null = null;

function initializeBle(): Promise<void> {
  if (!initializePromise) {
    initializePromise = BleClient.initialize({ androidNeverForLocation: true }).catch((error) => {
      initializePromise = null;
      throw error;
    });
  }
  return initializePromise;
}

function clearBatteryPolling(): void {
  if (batteryPollIntervalId !== null) {
    clearInterval(batteryPollIntervalId);
    batteryPollIntervalId = null;
  }
}

function handleDisconnect(deviceId: string): void {
  if (activeDeviceId !== deviceId) return;
  const handlers = activeHandlers;
  activeDeviceId = null;
  activeHandlers = null;
  clearBatteryPolling();
  handlers?.onDisconnected();
}

function dispatchMeasurement(value: DataView): void {
  const handlers = activeHandlers;
  if (!handlers) return;
  dispatchHeartRateMeasurement(value, {
    onBpm: handlers.onBpm,
    onRrIntervals: handlers.onRrIntervals,
    onOptionalFieldError: handlers.onOptionalFieldError,
    onOptionalFieldsOk: handlers.onOptionalFieldsOk,
    onClearOptionalFieldError: handlers.onClearOptionalFieldError,
  });
}

async function readBattery(deviceId: string): Promise<number | null> {
  try {
    const value = await BleClient.read(deviceId, BATTERY_SERVICE, BATTERY_LEVEL);
    const percent = value.getUint8(0);
    return percent >= 0 && percent <= 100 ? percent : null;
  } catch {
    return null;
  }
}

async function updateBattery(deviceId: string): Promise<boolean> {
  const percent = await readBattery(deviceId);
  if (activeDeviceId !== deviceId) return false;
  activeHandlers?.onBattery(percent);
  return percent !== null;
}

export async function connectNativeBle(handlers: NativeBleHandlers): Promise<void> {
  await initializeBle();
  if (activeDeviceId) await disconnectNativeBle();

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
    await BleClient.startNotifications(
      device.deviceId,
      HEART_RATE_SERVICE,
      HEART_RATE_MEASUREMENT,
      (value) => {
        try {
          dispatchMeasurement(value);
        } catch (error) {
          console.error("Native BLE Heart Rate Measurement parse error:", error);
        }
      }
    );
    if (await updateBattery(device.deviceId)) {
      batteryPollIntervalId = setInterval(() => {
        void updateBattery(device.deviceId);
      }, BATTERY_POLL_MS);
    }
  } catch (error) {
    try {
      await BleClient.disconnect(device.deviceId);
    } catch {
    }
    handleDisconnect(device.deviceId);
    throw error;
  }
}

export async function disconnectNativeBle(): Promise<void> {
  const deviceId = activeDeviceId;
  if (!deviceId) return;
  try {
    await BleClient.stopNotifications(deviceId, HEART_RATE_SERVICE, HEART_RATE_MEASUREMENT);
  } catch {
  }
  try {
    await BleClient.disconnect(deviceId);
  } finally {
    handleDisconnect(deviceId);
  }
}
