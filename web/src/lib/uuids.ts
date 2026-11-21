/**
 * Pure helpers for the Troubleshoot tab's "Inspect any Bluetooth device" mode:
 * UUID parsing for the text box, the list of services asked for in the device
 * chooser, friendly names and the printable rendering of raw values.
 *
 * No DOM and no Web Bluetooth calls here, so everything is unit-testable.
 */
import { UUIDS, gattName, shortUuid } from '@shared/protocol';

const BASE_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Lower-case 128-bit form of a 16-bit number, a short hex string or a full UUID. */
export function canonicalUuid(u: number | string): string {
  if (typeof u === 'number') return `0000${u.toString(16).padStart(4, '0')}${BASE_SUFFIX}`;
  const s = u.trim().toLowerCase();
  if (/^[0-9a-f]{4}$/.test(s)) return `0000${s}${BASE_SUFFIX}`;
  if (/^[0-9a-f]{8}$/.test(s)) return `${s}${BASE_SUFFIX}`;
  return s;
}

/** Services the TodooCard chooser asks for (the app's original list). */
export const TODOOCARD_SERVICES: string[] = [
  0x1800,
  0x1801,
  UUIDS.imageService,
  UUIDS.imageServiceAlt,
  UUIDS.batteryService,
  UUIDS.deviceInfoService,
  UUIDS.diagnosticsService,
  UUIDS.otaService,
].map(canonicalUuid);

/** Built-in extra services requested in generic mode, with the name shown for each. */
export const STANDARD_SERVICES: { uuid: string; name: string }[] = (
  [
    [0x1800, 'Generic Access'],
    [0x1801, 'Generic Attribute'],
    [0x1802, 'Immediate Alert'],
    [0x1803, 'Link Loss'],
    [0x1804, 'Tx Power'],
    [0x1805, 'Current Time'],
    [0x1809, 'Health Thermometer'],
    [0x180a, 'Device Information'],
    [0x180d, 'Heart Rate'],
    [0x180f, 'Battery'],
    [0x1810, 'Blood Pressure'],
    [0x1816, 'Cycling Speed and Cadence'],
    [0x1818, 'Cycling Power'],
    [0x181a, 'Environmental Sensing'],
    [0x181c, 'User Data'],
    [0x181d, 'Weight Scale'],
    [0x1822, 'Pulse Oximeter'],
    [0x1826, 'Fitness Machine'],
    [0x183b, 'Binary Sensor'],
    [0xfe59, 'Nordic Secure DFU'],
    [0xfee0, 'Vendor service FEE0'],
    [0xfee7, 'Vendor service FEE7'],
    [0xffe0, 'Vendor serial service FFE0'],
    [0xfff0, 'Vendor service FFF0'],
    [0xfef0, 'Vendor service FEF0 (TodooCard image service)'],
    [0xfdf0, 'Vendor service FDF0 (TodooCard image service, older hardware)'],
    ['6e400001-b5a3-f393-e0a9-e50e24dcca9e', 'Nordic UART Service'],
    ['00010203-0405-0607-0809-0a0b0c0d1912', 'Telink OTA (firmware update)'],
  ] as [number | string, string][]
).map(([u, name]) => ({ uuid: canonicalUuid(u), name }));

/**
 * Services on the Web Bluetooth blocklist (WebBluetoothCG registries, gatt_blocklist.txt).
 * Chrome drops these from `optionalServices` without an error, so they are removed
 * here and reported instead of silently never showing up.
 */
export const BLOCKLISTED_SERVICES: Record<string, string> = {
  [canonicalUuid(0x1812)]: 'Human Interface Device',
  '00001530-1212-efde-1523-785feabcd123': 'Nordic legacy DFU',
  'f000ffc0-0451-4000-b000-000000000000': 'TI over-the-air download',
  '00060000-0000-1000-8000-00805f9b34fb': 'Cypress bootloader',
  [canonicalUuid(0xfffd)]: 'FIDO',
  [canonicalUuid(0xfff9)]: 'FIDO',
  [canonicalUuid(0xfde2)]: 'Google pairingless FIDO',
};

const EXTRA_NAMES: Record<string, string> = {
  ...Object.fromEntries(STANDARD_SERVICES.map((s) => [shortUuid(s.uuid), s.name])),
  // Services not requested by default but nameable when the user adds them.
  '1808': 'Glucose',
  '180e': 'Phone Alert Status',
  '1811': 'Alert Notification',
  '1812': 'Human Interface Device',
  '1814': 'Running Speed and Cadence',
  '1819': 'Location and Navigation',
  '181b': 'Body Composition',
  '181e': 'Bond Management',
  '181f': 'Continuous Glucose Monitoring',
  '1820': 'Internet Protocol Support',
  // Nordic UART
  '6e400002-b5a3-f393-e0a9-e50e24dcca9e': 'Nordic UART RX (write)',
  '6e400003-b5a3-f393-e0a9-e50e24dcca9e': 'Nordic UART TX (notify)',
  // Characteristics
  '2a06': 'Alert Level',
  '2a07': 'Tx Power Level',
  '2a08': 'Date Time',
  '2a0f': 'Local Time Information',
  '2a14': 'Reference Time Information',
  '2a1c': 'Temperature Measurement',
  '2a1d': 'Temperature Type',
  '2a1e': 'Intermediate Temperature',
  '2a23': 'System ID',
  '2a28': 'Software Revision',
  '2a2a': 'Regulatory Certification Data',
  '2a2b': 'Current Time',
  '2a35': 'Blood Pressure Measurement',
  '2a37': 'Heart Rate Measurement',
  '2a38': 'Body Sensor Location',
  '2a39': 'Heart Rate Control Point',
  '2a49': 'Blood Pressure Feature',
  '2a50': 'PnP ID',
  '2a5b': 'CSC Measurement',
  '2a5c': 'CSC Feature',
  '2a5d': 'Sensor Location',
  '2a5e': 'PLX Spot-Check Measurement',
  '2a5f': 'PLX Continuous Measurement',
  '2a60': 'PLX Features',
  '2a63': 'Cycling Power Measurement',
  '2a65': 'Cycling Power Feature',
  '2a66': 'Cycling Power Control Point',
  '2a6d': 'Pressure',
  '2a6e': 'Temperature',
  '2a6f': 'Humidity',
  '2a9d': 'Weight Measurement',
  '2a9e': 'Weight Scale Feature',
  '2aa6': 'Central Address Resolution',
  '2acc': 'Fitness Machine Feature',
  '2ad9': 'Fitness Machine Control Point',
  '2ada': 'Fitness Machine Status',
  '2b29': 'Client Supported Features',
  '2b2a': 'Database Hash',
  '2b3a': 'Server Supported Features',
  ffe1: 'Vendor serial data FFE1',
  // Descriptors
  '2900': 'Characteristic Extended Properties',
  '2901': 'Characteristic User Description',
  '2902': 'Client Characteristic Configuration',
  '2903': 'Server Characteristic Configuration',
  '2904': 'Characteristic Presentation Format',
  '2905': 'Characteristic Aggregate Format',
  '2906': 'Valid Range',
  '2908': 'Report Reference',
};

/**
 * Friendly name for any service, characteristic or descriptor UUID. On a
 * TodooCard the app's own names win (they carry card-specific warnings); on
 * other devices Battery Level is just Battery Level.
 */
export function friendlyName(uuid: string, todooCard = true): string | undefined {
  const short = shortUuid(uuid);
  if (short === '2a19' && !todooCard) return 'Battery Level';
  return gattName(uuid) ?? EXTRA_NAMES[short];
}

export interface RejectedService {
  /** What was typed, or the canonical UUID for entries removed later. */
  input: string;
  uuid?: string;
  reason: string;
}

export interface ParsedUuids {
  /** Canonical 128-bit UUIDs, in the order typed, without duplicates. */
  uuids: string[];
  rejected: RejectedService[];
}

/**
 * Parse the "extra service UUIDs" box. Accepts 16-bit hex (`180d`, `0x180D`),
 * 32-bit hex and full 128-bit UUIDs (with or without dashes), separated by
 * commas, semicolons or any whitespace.
 */
export function parseUuidList(text: string): ParsedUuids {
  const uuids: string[] = [];
  const rejected: RejectedService[] = [];
  for (const token of text.split(/[\s,;]+/).filter(Boolean)) {
    const t = token.toLowerCase().replace(/^0x/, '');
    let uuid: string | null = null;
    if (/^[0-9a-f]{4}$/.test(t) || /^[0-9a-f]{8}$/.test(t)) uuid = canonicalUuid(t);
    else if (UUID_RE.test(t)) uuid = t;
    else if (/^[0-9a-f]{32}$/.test(t)) uuid = `${t.slice(0, 8)}-${t.slice(8, 12)}-${t.slice(12, 16)}-${t.slice(16, 20)}-${t.slice(20)}`;
    if (!uuid) {
      rejected.push({ input: token, reason: 'not a UUID: use 4 hex digits (180d or 0x180d) or a full 128-bit UUID' });
    } else if (BLOCKLISTED_SERVICES[uuid]) {
      rejected.push({ input: token, uuid, reason: `on the Web Bluetooth blocklist (${BLOCKLISTED_SERVICES[uuid]}); browsers never expose it to web pages` });
    } else if (!uuids.includes(uuid)) {
      uuids.push(uuid);
    }
  }
  return { uuids, rejected };
}

export interface RequestedServices {
  /** Canonical UUIDs to pass as `optionalServices`. */
  requested: string[];
  rejected: RejectedService[];
}

/**
 * The full list for the generic chooser: TodooCard services, the standard
 * list, then the user's extras; without duplicates, without blocklisted UUIDs
 * and without anything the browser refused earlier in this session.
 */
export function buildRequestedServices(extraText: string, browserRejected: Iterable<string> = []): RequestedServices {
  const parsed = parseUuidList(extraText);
  const refused = new Set([...browserRejected].map(canonicalUuid));
  const requested: string[] = [];
  const rejected = [...parsed.rejected];
  const seen = new Set<string>();
  for (const uuid of [...TODOOCARD_SERVICES, ...STANDARD_SERVICES.map((s) => s.uuid), ...parsed.uuids]) {
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    if (refused.has(uuid)) rejected.push({ input: shortUuid(uuid), uuid, reason: 'refused by this browser' });
    else if (BLOCKLISTED_SERVICES[uuid]) rejected.push({ input: shortUuid(uuid), uuid, reason: `on the Web Bluetooth blocklist (${BLOCKLISTED_SERVICES[uuid]})` });
    else requested.push(uuid);
  }
  return { requested, rejected };
}

/** UUIDs an error message names (full 128-bit form or `0x180d`), canonical and deduplicated. */
export function uuidsNamedIn(message: string): string[] {
  const out: string[] = [];
  const add = (u: string) => {
    if (!out.includes(u)) out.push(u);
  };
  for (const m of message.toLowerCase().matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) add(m[0]);
  for (const m of message.toLowerCase().matchAll(/\b0x([0-9a-f]{4})\b/g)) add(canonicalUuid(m[1]));
  return out;
}

/**
 * Printable-ASCII rendering of a raw value, or undefined when the bytes do not
 * look like text. Trailing NULs are ignored; a value counts as text when it has
 * at least two bytes and at least 80 % of them are printable ASCII. Other
 * bytes are shown as `.`.
 */
export function printableText(bytes: Uint8Array): string | undefined {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  if (end < 2) return undefined;
  let printable = 0;
  let out = '';
  for (let i = 0; i < end; i++) {
    const b = bytes[i];
    const ok = b >= 0x20 && b <= 0x7e;
    if (ok) printable++;
    out += ok ? String.fromCharCode(b) : '.';
  }
  return printable / end >= 0.8 ? out : undefined;
}

/** Does this set of visible services say "TodooCard"? (image service, older image service, diagnostics) */
export function looksLikeTodooCard(serviceUuids: string[]): boolean {
  const shorts = serviceUuids.map(shortUuid);
  return shorts.includes('fef0') || shorts.includes('fdf0') || shorts.includes(UUIDS.diagnosticsService);
}
