/**
 * TodooCard / T3 protocol constants and pure helpers.
 *
 * Written from observed behaviour of the device and the publicly documented
 * workflow of the vendor's "TodooCard Skills" macOS tooling. No vendor code is
 * included here.
 */

export const PANEL_WIDTH = 528;
export const PANEL_HEIGHT = 792;
export const PANEL_PIXELS = PANEL_WIDTH * PANEL_HEIGHT;
/** Two pixels per byte, high nibble first. */
export const CONTROLLER_BYTES = PANEL_PIXELS / 2; // 209088

export const MANUFACTURER_ID = 0x5053;
export const SCREEN_TYPE_T3 = 0x134c;

/** 16-bit UUIDs expanded by the Web Bluetooth helpers. */
export const UUIDS = {
  imageService: 0xfef0,
  imageServiceAlt: 0xfdf0,
  control: 0xfef1,
  controlAlt: 0xfdf1,
  data: 0xfef2,
  dataAlt: 0xfdf2,
  batteryService: 0x180f,
  batteryLevel: 0x2a19,
  deviceInfoService: 0x180a,
  modelNumber: 0x2a24,
  serialNumber: 0x2a25,
  firmwareRevision: 0x2a26,
  hardwareRevision: 0x2a27,
  manufacturerName: 0x2a29,
  diagnosticsService: 'd8b282f0-0f9b-4a7a-b5e8-8e6e5a3c1001',
  /** Undocumented 22-byte status record; captured raw so counters can be decoded over time. */
  diagnosticsStatus: 'd8b282f0-0f9b-4a7a-b5e8-8e6e5a3c1002',
  diagnosticsImageAck: 'd8b282f0-0f9b-4a7a-b5e8-8e6e5a3c1003',
  /** Telink OTA service + characteristic (firmware update). */
  otaService: '00010203-0405-0607-0809-0a0b0c0d1912',
  otaCharacteristic: '00010203-0405-0607-0809-0a0b0c0d2b12',
} as const;

/** Firmware thresholds (raw firmware byte). */
export const FW = {
  secureMinimum: 0x8c, // encrypted GATT when capability bit 0x01 is set
  pairingHoldFiveSeconds: 0x98, // v152: 5 s hold, older needs 10 s
  verifiedTransfer: 0x9d, // v157: 2 KB blocks, 32-block windows with checkpoints
  diagnostics: 0xa5, // v165: retained image-ACK diagnostics
  progressLease: 0xa6, // v166: 10 s valid-progress lease, may reboot after stall
} as const;

export const CAPABILITY = {
  encryptedGatt: 0x01,
  pairingWindowOpen: 0x02,
  /** Bytes 7-12 of the manufacturer payload carry the full 6-byte device id. */
  fullMac: 0x04,
  otaRecovery: 0x08,
  turboLink: 0x10,
} as const;

/** Control commands written to FEF1. */
export const CMD = {
  requestBlockSize: 0x01,
  announcePayload: 0x02,
  startTransfer: 0x03,
  dataAck: 0x05,
} as const;

export const STATUS = {
  success: 0x00,
  malformedBlock: 0x01,
  transferEnd: 0x08,
  flashWriteFailed: 0x09,
  flashVerifyFailed: 0x0a,
} as const;

/** Payload flags for the announce (0x02) command. */
export const PAYLOAD_FLAGS = {
  compressed: 0x01,
  raw: 0x03,
  allowDeviceButton: 0x10,
} as const;

export const VERIFIED_WINDOW_BLOCKS = 32;
export const CHECKPOINT_TIMEOUT_MS = 5000;
export const FINAL_ACK_TIMEOUT_MS = 10000;
export const LEGACY_FINAL_ACK_TIMEOUT_MS = 90000;
export const MAX_REPAIR_REQUESTS = 16;
export const CONTROL_RESPONSE_TIMEOUT_MS = 5000;

export interface Advertisement {
  manufacturerId: number;
  screenType: number;
  capabilityFlags: number;
  firmwareRaw: number;
}

/**
 * Parse the TodooCard manufacturer-specific payload *after* the 2-byte company
 * identifier has been stripped (that is how Web Bluetooth delivers it) or the
 * full payload including the identifier.
 */
export function parseManufacturerData(bytes: Uint8Array, includesCompanyId: boolean): Advertisement | null {
  const d = includesCompanyId ? bytes : concat(new Uint8Array([MANUFACTURER_ID & 0xff, MANUFACTURER_ID >> 8]), bytes);
  if (d.length < 7) return null;
  return {
    manufacturerId: d[0] | (d[1] << 8),
    screenType: d[2] | (d[6] << 8),
    capabilityFlags: d[3],
    firmwareRaw: d[4],
  };
}

export function describeAdvertisement(a: Advertisement) {
  // Byte 3 is a flag byte only on secure-era firmware (>= v140); older firmware
  // puts a battery reading there, so no flag may be derived from it.
  const modern = a.screenType === SCREEN_TYPE_T3 && a.firmwareRaw >= FW.secureMinimum;
  const secure = modern && (a.capabilityFlags & CAPABILITY.encryptedGatt) !== 0;
  return {
    isTodooCard: a.manufacturerId === MANUFACTURER_ID && a.screenType === SCREEN_TYPE_T3,
    secure,
    pairingWindowOpen: secure && (a.capabilityFlags & CAPABILITY.pairingWindowOpen) !== 0,
    otaRecovery: modern && (a.capabilityFlags & CAPABILITY.otaRecovery) !== 0,
    turboLink: modern && (a.capabilityFlags & CAPABILITY.turboLink) !== 0,
    firmwareVersion: a.firmwareRaw,
    pairingHoldSeconds: a.firmwareRaw >= FW.pairingHoldFiveSeconds ? 5 : 10,
  };
}

/** Everything the manufacturer payload says, for the troubleshooting views. */
export interface DecodedAdvertisement {
  /** Payload including the 2-byte company id, as hex. */
  hex: string;
  companyId: number;
  companyIdOk: boolean;
  screenType: number;
  screenTypeOk: boolean;
  firmwareRaw: number;
  /** True for firmware >= v140, where byte 3 is a flag byte. */
  modern: boolean;
  flagsRaw?: number;
  flags?: {
    encryptedGatt: boolean;
    pairingWindowOpen: boolean;
    fullMac: boolean;
    otaRecovery: boolean;
    turboLink: boolean;
    /** Bits set that this decoder has no name for. */
    unknownBits: number;
  };
  /** Below v140 byte 3 is a battery reading (tenths of a volt when 20-60). */
  batteryRaw?: number;
  batteryVolts?: number;
  /** Six-byte device id, when the FULL_MAC flag is set and the payload is long enough. */
  deviceId?: string;
  /** Legacy extended identity: two-character model and a semantic version such as 1.0.10. */
  productModel?: string;
  semanticVersion?: string;
}

/** Decode a manufacturer payload that includes the 2-byte company id (`53 50 4c ...`). */
export function decodeManufacturerData(d: Uint8Array): DecodedAdvertisement | null {
  if (d.length < 7) return null;
  const companyId = d[0] | (d[1] << 8);
  const screenType = d[2] | (d[6] << 8);
  const firmwareRaw = d[4];
  const modern = screenType === SCREEN_TYPE_T3 && firmwareRaw >= FW.secureMinimum;
  const out: DecodedAdvertisement = {
    hex: hex(d),
    companyId,
    companyIdOk: companyId === MANUFACTURER_ID,
    screenType,
    screenTypeOk: screenType === SCREEN_TYPE_T3,
    firmwareRaw,
    modern,
  };
  if (modern) {
    const f = d[3];
    const named = CAPABILITY.encryptedGatt | CAPABILITY.pairingWindowOpen | CAPABILITY.fullMac | CAPABILITY.otaRecovery | CAPABILITY.turboLink;
    out.flagsRaw = f;
    out.flags = {
      encryptedGatt: (f & CAPABILITY.encryptedGatt) !== 0,
      pairingWindowOpen: (f & CAPABILITY.pairingWindowOpen) !== 0,
      fullMac: (f & CAPABILITY.fullMac) !== 0,
      otaRecovery: (f & CAPABILITY.otaRecovery) !== 0,
      turboLink: (f & CAPABILITY.turboLink) !== 0,
      unknownBits: f & ~named & 0xff,
    };
    if (out.flags.fullMac && d.length >= 13) {
      out.deviceId = Array.from(d.subarray(7, 13), (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
    }
  } else {
    out.batteryRaw = d[3];
    if (d[3] >= 20 && d[3] <= 60) out.batteryVolts = d[3] / 10;
    else if (d[3] >= 2 && d[3] <= 6) out.batteryVolts = d[3];
  }
  const isIdChar = (b: number) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
  if (!out.flags?.fullMac && out.companyIdOk && d.length >= 12 && isIdChar(d[7]) && isIdChar(d[8])) {
    out.productModel = String.fromCharCode(d[7], d[8]);
    out.semanticVersion = `${d[9]}.${d[10]}.${d[11]}`;
  }
  return out;
}

/**
 * Parse manufacturer data pasted as hex. Accepts spaces, colons, commas and
 * `0x` prefixes, and the payload with or without the company id (`53 50` as
 * sent on air, `5053` as the id is usually written, or a literal `SP`).
 * Returns the payload including the company id.
 */
export function parseManufacturerHex(text: string): { bytes: Uint8Array; companyIdAdded: boolean } | { error: string } {
  let t = text.trim();
  let literalPrefix = false;
  if (/^sp/i.test(t)) {
    literalPrefix = true;
    t = t.slice(2);
  }
  const digits = t.replace(/0x/gi, '').replace(/[\s:,;.\-_]/g, '');
  if (!digits) return { error: 'Paste the manufacturer data as hex, for example 53 50 4c 11 bb 01 13.' };
  if (!/^[0-9a-f]+$/i.test(digits)) return { error: 'Only hex digits (0-9, a-f) and separators are understood.' };
  if (digits.length % 2 !== 0) return { error: 'An odd number of hex digits: a digit is missing.' };
  const raw = new Uint8Array(digits.length / 2);
  for (let i = 0; i < raw.length; i++) raw[i] = parseInt(digits.substr(i * 2, 2), 16);
  const sp = new Uint8Array([MANUFACTURER_ID & 0xff, MANUFACTURER_ID >> 8]);
  const startsWithId = raw.length >= 2 && ((raw[0] === 0x53 && raw[1] === 0x50) || (raw[0] === 0x50 && raw[1] === 0x53));
  const companyIdAdded = !(literalPrefix || startsWithId);
  const bytes = concat(sp, !literalPrefix && startsWithId ? raw.subarray(2) : raw);
  if (bytes.length < 7) return { error: `Too short: ${bytes.length - 2} payload bytes, at least 5 are needed (type, flags, firmware and the screen type).` };
  return { bytes, companyIdAdded };
}

/** Friendly names for the services and characteristics a TodooCard exposes. */
const GATT_NAMES: Record<string, string> = {
  '1800': 'Generic Access',
  '1801': 'Generic Attribute',
  '180a': 'Device Information',
  '180f': 'Battery',
  '2a00': 'Device Name',
  '2a01': 'Appearance',
  '2a04': 'Preferred Connection Parameters',
  '2a05': 'Service Changed',
  '2a19': 'Battery Level (encrypted: reading it starts pairing)',
  '2a24': 'Model Number',
  '2a25': 'Serial Number',
  '2a26': 'Firmware Revision',
  '2a27': 'Hardware Revision',
  '2a29': 'Manufacturer Name',
  fef0: 'TodooCard image service',
  fef1: 'Image control (commands and acknowledgements)',
  fef2: 'Image data (blocks)',
  fef3: 'FEF3 (undocumented; identity string on legacy 1.0.x firmware)',
  fdf0: 'Image service (older hardware)',
  fdf1: 'Image control (older hardware)',
  fdf2: 'Image data (older hardware)',
  [UUIDS.diagnosticsService]: 'TodooCard diagnostics (read-only telemetry)',
  [UUIDS.diagnosticsStatus]: 'Diagnostics status record (22 bytes)',
  [UUIDS.diagnosticsImageAck]: 'Diagnostics image-ACK record (20 bytes)',
  [UUIDS.otaService]: 'Telink OTA (firmware update)',
  [UUIDS.otaCharacteristic]: 'Telink OTA data',
};

/** Short form of a Bluetooth-base UUID (`fef1`), else the lower-case 128-bit UUID. */
export function shortUuid(uuid: string): string {
  const u = uuid.toLowerCase();
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(u);
  return m ? m[1] : u;
}

export function gattName(uuid: string): string | undefined {
  return GATT_NAMES[shortUuid(uuid)];
}

/**
 * The Device Information "Firmware Revision String" on T3 reads like "0xBB".
 * Returns the raw firmware byte or null when unparseable.
 */
export function parseFirmwareRevisionString(s: string): number | null {
  const t = s.trim();
  const hex = /^0x([0-9a-f]{1,2})$/i.exec(t);
  if (hex) return parseInt(hex[1], 16);
  const dec = /^v?(\d{1,3})$/i.exec(t);
  if (dec) {
    const n = parseInt(dec[1], 10);
    return n >= 0 && n <= 255 ? n : null;
  }
  return null;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function u32le(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

export function readU32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

export function hex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

export type ControlMessage =
  | { kind: 'blockSize'; ok: boolean; blockSize: number }
  | { kind: 'announce'; ok: boolean }
  | { kind: 'ack'; status: number; index?: number }
  | { kind: 'unknown'; bytes: Uint8Array };

export function parseControlMessage(bytes: Uint8Array): ControlMessage {
  const cmd = bytes[0];
  if (cmd === CMD.requestBlockSize && bytes.length >= 3) {
    return { kind: 'blockSize', ok: bytes[2] === STATUS.success, blockSize: bytes[1] };
  }
  if (cmd === CMD.announcePayload && bytes.length >= 2) {
    return { kind: 'announce', ok: bytes[1] === STATUS.success };
  }
  if (cmd === CMD.dataAck && bytes.length >= 2) {
    const status = bytes[1];
    if (status === STATUS.success && bytes.length >= 6) {
      return { kind: 'ack', status, index: readU32le(bytes, 2) };
    }
    return { kind: 'ack', status };
  }
  return { kind: 'unknown', bytes };
}

export function describeAckStatus(status: number): string {
  switch (status) {
    case STATUS.malformedBlock:
      return 'Device rejected a malformed or out-of-order image block (status 0x01)';
    case STATUS.flashWriteFailed:
      return 'External Flash write failed on the device (status 0x09)';
    case STATUS.flashVerifyFailed:
      return 'External Flash readback verification failed on the device (status 0x0A)';
    default:
      return `Device interrupted image transfer with status 0x${status.toString(16).padStart(2, '0')}`;
  }
}

export interface ImageAckDiagnostics {
  session: number;
  flags: number;
  generated: number;
  attempts: number;
  accepted: number;
  rejected: number;
  requestedBlock: number;
  previousStatus: number;
  lastNotifyResult: number;
  lastReceivedBlock: number;
}

export function parseImageAckDiagnostics(d: Uint8Array): ImageAckDiagnostics | null {
  if (d.length < 20 || d[0] !== 0x27 || d[1] !== 0x01) return null;
  const u16 = (o: number) => d[o] | (d[o + 1] << 8);
  return {
    session: d[2],
    flags: d[3],
    generated: u16(4),
    attempts: u16(6),
    accepted: u16(8),
    rejected: u16(10),
    requestedBlock: readU32le(d, 12),
    previousStatus: d[16],
    lastNotifyResult: d[17],
    lastReceivedBlock: u16(18),
  };
}

/**
 * Decoded ...1002 "status record" (22 bytes). Layout recovered clean-room from
 * TLSR8258 firmware v185 (see todoocard-firmware/docs/gatt.md). The buffer is a
 * window into a larger SRAM status struct; ...1003 is the next window.
 *
 * Confidence: `marker*`, `eventCounter` are verified (constants match live
 * captures; the counter writer is unambiguous). `statusCode` and `selfTest` are
 * medium-confidence; `aux*` are the remaining u16 fields, semantics tentative.
 */
export interface StatusRecord {
  header: number; // [0]
  /** [1] result/phase code of the on-device self-test / transfer state machine. */
  statusCode: number;
  /** [2]==0x25 && [11]==0x26 && [12]==0x01 — firmware format signature. */
  markerOk: boolean;
  /** [2..10] 9-byte self-test / identity sub-block. */
  selfTest: number[];
  /** [13] valid/active flag (firmware sets to 1 on update). */
  valid: number;
  /** u16 [14..15], saturating event counter. */
  eventCounter: number;
  /** u16 [16..17], [18..19], [20..21] — further counters/values (tentative). */
  aux: [number, number, number];
  /** True when the three signature markers are all present. */
}

const STATUS_CODE_NAMES: Record<number, string> = {
  0x11: 'started',
  0x02: 'stage 2',
  0x04: 'stage 4',
  0x09: 'stage 9',
  0x0b: 'stage 11',
  0x10: 'finalizing',
  0x12: 'idle / complete',
};

export function statusCodeName(v: number): string {
  return STATUS_CODE_NAMES[v] ?? `0x${v.toString(16).padStart(2, '0')}`;
}

export function parseStatusRecord(d: Uint8Array): StatusRecord | null {
  if (d.length < 22) return null;
  const u16 = (o: number) => d[o] | (d[o + 1] << 8);
  return {
    header: d[0],
    statusCode: d[1],
    markerOk: d[2] === 0x25 && d[11] === 0x26 && d[12] === 0x01,
    selfTest: Array.from(d.slice(2, 11)),
    valid: d[13],
    eventCounter: u16(14),
    aux: [u16(16), u16(18), u16(20)],
  };
}
