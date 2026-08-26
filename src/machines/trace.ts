export type MachineId = "proform-smart-power-10";

export interface MachineGuidanceTraceEntry {
  elapsedSeconds: number;
  resistance: number;
  cadenceRpm: number;
  estimatedWatts?: number;
  reason: string;
}
