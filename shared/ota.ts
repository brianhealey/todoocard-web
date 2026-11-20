/**
 * Telink BLE OTA codec for the TodooCard T3 (TLSR8258).
 *
 * Clean-room port of the vendor app's `FirmwareUpdateSession`
 * (com.sunbelife.potatocard), cross-checked against the firmware OTA handler.
 * See todoocard-firmware/docs/ota.md for the full protocol.
 *
 * Pure functions only — no Web Bluetooth here (that lives in web/src/lib/ota.ts).
 */

/** CRC-16/MODBUS: init 0xFFFF, reflected poly 0xA001, no final XOR. */
export function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) {
      const lsb = crc & 1;
      crc >>>= 1;
      if (lsb) crc ^= 0xa001;
    }
  }
  return crc & 0xffff;
}

/** CRC-32 of the whole image must equal 0xFFFFFFFF for a valid Telink OTA image. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The 4-byte little-endian CRC32 the Telink image carries as its trailer. */
export function storedCrc32(bytes: Uint8Array): number {
  if (bytes.length < 4) return 0;
  const n = bytes.length;
  return ((bytes[n - 1] << 24) | (bytes[n - 2] << 16) | (bytes[n - 3] << 8) | bytes[n - 4]) >>> 0;
}

/**
 * Truncate a firmware image to its declared length (u32 LE at offset 24) when
 * that length is plausible; otherwise return the input unchanged.
 */
export function normalizeFirmware(input: Uint8Array): Uint8Array {
  if (input.length < 28) return input.slice();
  const declared = (input[24] | (input[25] << 8) | (input[26] << 16) | (input[27] << 24)) >>> 0;
  if (declared > 0 && declared <= input.length) return input.slice(0, declared);
  return input.slice();
}

export interface OtaProtocol {
  /** 16 (legacy) or 80 (extended). */
  packetDataByteCount: number;
  /** schedule-ACK flow control required (firmware >= 167). */
  requiresScheduleAck: boolean;
}

export const OTA_LEGACY: OtaProtocol = { packetDataByteCount: 16, requiresScheduleAck: false };

/**
 * Pick the packet size from the receiver firmware version and the usable ATT
 * write size. Unknown/old versions fall back to legacy (the universal safe mode).
 */
export function negotiateOta(receiverVersion: number, maxWriteValueBytes: number): OtaProtocol {
  if (receiverVersion >= 163 && maxWriteValueBytes >= 84) {
    return { packetDataByteCount: 80, requiresScheduleAck: receiverVersion >= 167 };
  }
  return OTA_LEGACY;
}

export interface OtaPackets {
  packets: Uint8Array[];
  /** index of the final data packet (goes into the end packet). */
  maxIndex: number;
}

/** Build the ordered list of OTA data packets for a (normalized) firmware image. */
export function buildOtaPackets(firmware: Uint8Array, packetDataByteCount: number): OtaPackets {
  const packets: Uint8Array[] = [];
  let i = 0;
  let n = 0;
  while (i < firmware.length) {
    const iMin = Math.min(packetDataByteCount, firmware.length - i);
    const iCeil = iMin === packetDataByteCount ? packetDataByteCount : Math.ceil(iMin / 16) * 16;
    const packet = new Uint8Array(iCeil + 4).fill(0xff);
    packet[0] = n & 0xff;
    packet[1] = (n >> 8) & 0xff;
    for (let k = 0; k < iMin; k++) packet[k + 2] = firmware[i + k];
    const crc = crc16(packet.subarray(0, iCeil + 2));
    packet[iCeil + 2] = crc & 0xff;
    packet[iCeil + 3] = (crc >> 8) & 0xff;
    packets.push(packet);
    i += packetDataByteCount;
    n = (n + 1) & 0xffff;
  }
  return { packets, maxIndex: (n - 1) & 0xffff };
}

export function startPacket(proto: OtaProtocol): Uint8Array {
  if (proto.packetDataByteCount === 16) return new Uint8Array([0x01, 0xff]);
  const p = new Uint8Array(20);
  p[0] = 0x03;
  p[1] = 0xff;
  p[2] = proto.packetDataByteCount & 0xff;
  return p;
}

export function endPacket(maxIndex: number): Uint8Array {
  const inv = ~maxIndex & 0xffff;
  return new Uint8Array([0x02, 0xff, maxIndex & 0xff, (maxIndex >> 8) & 0xff, inv & 0xff, (inv >> 8) & 0xff]);
}

/**
 * Parse a schedule-ACK notification. Returns the new absolute acknowledged
 * packet count, or null if the notification is not a schedule-ACK.
 */
export function parseScheduleAck(bytes: Uint8Array, pdu: number, prevAcked: number, totalPackets: number): number | null {
  if (bytes.length < 4) return null;
  const op = bytes[0] | (bytes[1] << 8);
  if (op === 0xff08) {
    const delta = bytes[2] | (bytes[3] << 8);
    return delta > 0 ? Math.min(totalPackets, prevAcked + delta) : prevAcked;
  }
  if (op === 0xff09) {
    if (bytes.length < 6) return null;
    const absBytes = (bytes[2] | (bytes[3] << 8) | (bytes[4] << 16) | (bytes[5] << 24)) >>> 0;
    return Math.min(totalPackets, Math.ceil(absBytes / pdu));
  }
  return null;
}
