export function parseHeartRateMeasurement(value: DataView): number {
  if (value.byteLength < 2) throw new Error("Invalid Heart Rate Measurement value");
  const flags = value.getUint8(0);
  if ((flags & 0x01) !== 0) {
    if (value.byteLength < 3) throw new Error("Invalid 16-bit Heart Rate Measurement value");
    return value.getUint16(1, true);
  }
  return value.getUint8(1);
}
