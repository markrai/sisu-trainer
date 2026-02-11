// Minimal Web Bluetooth typing guard
type BluetoothDevice = any;

let currentHrDevice: BluetoothDevice | null = null;
const BATTERY_POLL_MS = 2 * 60 * 1000; // 2 minutes
let batteryPollIntervalId: ReturnType<typeof setInterval> | null = null;
let currentBpm: number | null = null;
const bpmCallbacks: Array<(bpm: number) => void> = [];

function bleDebugEnabled() {
  try {
    return localStorage.getItem("bleDebug") === "true";
  } catch {
    return false;
  }
}

function onHrDisconnect() {
  if (batteryPollIntervalId !== null) {
    clearInterval(batteryPollIntervalId);
    batteryPollIntervalId = null;
  }
  currentHrDevice = null;
  currentBpm = null;
  (window as any).hrDeviceName = null;
  (window as any).hrBatteryPercent = null;
  if (typeof (window as any).updateHrMonitorStatus === "function") (window as any).updateHrMonitorStatus();
}

function pollBatteryOnce() {
  const device = currentHrDevice;
  if (!device?.gatt?.connected) return;
  device.gatt
    .getPrimaryService("battery_service")
    .then((s: any) => s.getCharacteristic("battery_level").readValue())
    .then((value: ArrayBuffer | DataView) => {
      const dv = value instanceof DataView ? value : new DataView(value instanceof ArrayBuffer ? value : (value as any).buffer);
      const pct = dv.getUint8(0);
      if (pct >= 0 && pct <= 100) {
        (window as any).hrBatteryPercent = pct;
        if (typeof (window as any).updateHrMonitorStatus === "function") (window as any).updateHrMonitorStatus();
      }
    })
    .catch(() => {});
}

function startBatteryPolling() {
  if (batteryPollIntervalId !== null) return;
  batteryPollIntervalId = setInterval(pollBatteryOnce, BATTERY_POLL_MS);
}

async function dumpGattProfile(server: any) {
  if (!bleDebugEnabled()) return;
  try {
    const services = await server.getPrimaryServices();
    console.log("[BLE] Primary services:", services.map((s: any) => s.uuid));
    for (const service of services) {
      try {
        const chars = await service.getCharacteristics();
        console.log(`[BLE] Service ${service.uuid} characteristics:`, chars.map((c: any) => c.uuid));
        for (const ch of chars) {
          try {
            console.log(`[BLE]  - Char ${ch.uuid} props`, ch.properties);
          } catch {
            // ignore
          }
        }
      } catch (e) {
        console.log("[BLE] Could not enumerate characteristics for service", service.uuid, e);
      }
    }
  } catch (e) {
    console.log("[BLE] Could not enumerate primary services", e);
  }
}

function dataViewFromReadValue(value: any): DataView {
  if (value instanceof DataView) return value;
  if (value instanceof ArrayBuffer) return new DataView(value);
  if (value && value.buffer instanceof ArrayBuffer) return new DataView(value.buffer);
  return new DataView(new ArrayBuffer(0));
}

async function readBatteryPercentStandardBas(server: any): Promise<number | null> {
  // Standard GATT Battery Service (0x180F) / Battery Level (0x2A19)
  const batteryService = await server.getPrimaryService("battery_service");
  const batteryChar = await batteryService.getCharacteristic("battery_level");

  // Prefer notifications if supported (keeps UI updated if device changes it)
  try {
    if (batteryChar?.properties?.notify) {
      await batteryChar.startNotifications();
      batteryChar.addEventListener("characteristicvaluechanged", (event: any) => {
        try {
          const dv = dataViewFromReadValue(event?.target?.value);
          const v = dv.getUint8(0);
          if (v >= 0 && v <= 100) {
            (window as any).hrBatteryPercent = v;
            if (typeof (window as any).updateHrMonitorStatus === "function") (window as any).updateHrMonitorStatus();
          }
        } catch {
          // ignore
        }
      });
    }
  } catch {
    // ignore; we can still do a one-shot read below
  }

  const dv = dataViewFromReadValue(await batteryChar.readValue());
  const percent = dv.getUint8(0);
  return percent >= 0 && percent <= 100 ? percent : null;
}

type BatteryProbe = {
  name: string;
  read: (server: any, device?: BluetoothDevice) => Promise<number | null>;
};

const BATTERY_PROBES: BatteryProbe[] = [
  { name: "standard_bas_180f_2a19", read: (server) => readBatteryPercentStandardBas(server) },
  // Add vendor-specific probes here as we discover them.
];

async function readBatteryPercentWithProbes(server: any, device?: BluetoothDevice): Promise<number | null> {
  for (const probe of BATTERY_PROBES) {
    try {
      const v = await probe.read(server, device);
      if (typeof v === "number" && v >= 0 && v <= 100) {
        if (bleDebugEnabled()) console.log("[BLE] Battery probe success:", probe.name, v);
        return v;
      }
      if (bleDebugEnabled()) console.log("[BLE] Battery probe returned null:", probe.name);
    } catch (e) {
      if (bleDebugEnabled()) console.log("[BLE] Battery probe failed:", probe.name, e);
    }
  }
  return null;
}

function parseHrValue(value: any): number {
  value = value.buffer ? value : new DataView(value);
  const flags = value.getUint8(0);
  const rate16Bits = flags & 0x1;
  let index = 1;
  if (rate16Bits) {
    const heartRate = value.getUint16(index, true);
    return heartRate;
  } else {
    const heartRate = value.getUint8(index);
    return heartRate;
  }
}

function handleCharacteristicValueChanged(event: any) {
  const hr = parseHrValue(event.target.value);
  currentBpm = hr;
  for (const cb of bpmCallbacks) {
    try {
      cb(hr);
    } catch (e) {
      console.error("hrMonitor onBpm callback error:", e);
    }
  }
}

export function connect(): void {
  const bt = (navigator as any).bluetooth as { requestDevice?: Function } | undefined;
  if (!bt || typeof bt.requestDevice !== "function") {
    console.error("Web Bluetooth API not available: navigator.bluetooth is missing.");
    if (typeof (window as any).showToast === "function") {
      (window as any).showToast("Bluetooth not supported in this browser. Use Chrome/Edge on HTTPS (or localhost).");
    }
    return;
  }

  bt.requestDevice({
      filters: [{ services: ["heart_rate"] }],
      // Request access to extra services up-front so we can probe battery (and inspect services in debug mode).
      optionalServices: ["battery_service", "device_information"],
    })
    .then((device: BluetoothDevice) => {
      currentHrDevice = device;
      device.addEventListener("gattserverdisconnected", onHrDisconnect);
      return device.gatt.connect().then((server: any) => ({ device, server }));
    })
    .then(({ device, server }: { device: BluetoothDevice; server: any }) => {
      (window as any).hrDeviceName = device.name || "Heart rate sensor";
      if (typeof (window as any).updateHrMonitorStatus === "function") (window as any).updateHrMonitorStatus();
      dumpGattProfile(server);
      readBatteryPercentWithProbes(server, device)
        .then((battery) => {
          (window as any).hrBatteryPercent = battery;
          if (typeof (window as any).updateHrMonitorStatus === "function") (window as any).updateHrMonitorStatus();
          if (battery !== null) startBatteryPolling();
        })
        .catch(() => {
          (window as any).hrBatteryPercent = null;
          if (typeof (window as any).updateHrMonitorStatus === "function") (window as any).updateHrMonitorStatus();
        });
      return server.getPrimaryService("heart_rate").then((hrService: any) => ({ server, hrService }));
    })
    .then(({ hrService }: { server: any; hrService: any }) => hrService.getCharacteristic("heart_rate_measurement"))
    .then((characteristic: any) => characteristic.startNotifications())
    .then((characteristic: any) => {
      characteristic.addEventListener("characteristicvaluechanged", handleCharacteristicValueChanged);
    })
    .catch((error: any) => console.error(error));
}

export function onBpm(callback: (bpm: number) => void): void {
  bpmCallbacks.push(callback);
}

export function getCurrentBpm(): number | null {
  return currentBpm;
}
