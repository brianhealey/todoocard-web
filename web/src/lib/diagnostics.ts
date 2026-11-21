/**
 * Troubleshooting helpers: a read-only GATT survey and the diagnostics file.
 *
 * Nothing here writes to the card or enables notifications. The diagnostics
 * document is built only from what is passed in; settings (API keys, the app
 * token) are never an input, so they cannot end up in it.
 */
import { MIN_FLASHABLE_VERSION } from '@shared/firmware';
import { UUIDS, gattName, hex, parseImageAckDiagnostics, parseStatusRecord, shortUuid, type ImageAckDiagnostics, type StatusRecord } from '@shared/protocol';
import type { AdvSnapshot, AdvWatchState, DeviceInfo, LogEntry, TodooCardClient } from './ble';
import type { FirmwareEntry } from './firmware';
import { TODOOCARD_SERVICES, type RejectedService } from './uuids';

export const DIAGNOSTICS_SCHEMA = 'todoocard-web.diagnostics';
/** v2 adds `mode`, `requestedServices`, `rejectedServices`, `limitations` and the generic survey fields; every v1 field is kept. */
export const DIAGNOSTICS_SCHEMA_VERSION = 2;

export type DiagnosticsMode = 'todoocard' | 'generic';

export interface GattDescriptorRow {
  uuid: string;
  short: string;
  name?: string;
  /** Text of Characteristic User Description (0x2901); other descriptors are listed, not read. */
  valueText?: string;
  error?: string;
}

export interface GattCharRow {
  uuid: string;
  short: string;
  name?: string;
  properties: string[];
  valueHex?: string;
  valueText?: string;
  /** Why a readable value was not read, or what the value means. */
  note?: string;
  error?: string;
  /** Generic survey only: descriptors of this characteristic, when the browser could list them. */
  descriptors?: GattDescriptorRow[];
  descriptorsError?: string;
}

export interface GattServiceRow {
  uuid: string;
  short: string;
  name?: string;
  characteristics: GattCharRow[];
  error?: string;
}

export interface GattScan {
  t: number;
  /** Which survey produced this; absent means the TodooCard survey. */
  mode?: DiagnosticsMode;
  services: GattServiceRow[];
  statusRecord?: StatusRecord;
  imageAck?: ImageAckDiagnostics;
  error?: string;
  /** Generic survey: the device has the TodooCard image or diagnostics service. */
  isTodooCard?: boolean;
  /** Generic survey: connected, but none of the requested services exist on the device. */
  noServices?: boolean;
  /** Generic survey: the device dropped the link part-way; `services` holds what was read until then. */
  disconnected?: boolean;
  /** Generic survey: stopped early (read limit, time limit or an unresponsive device). */
  truncated?: boolean;
  readCount?: number;
  notes?: string[];
}

/** Readable without encryption and without side effects; everything else is listed but not read. */
const TEXT_READS = new Set(['2a00', '2a24', '2a25', '2a26', '2a27', '2a29']);
const RAW_READS = new Set<string>([UUIDS.diagnosticsStatus, UUIDS.diagnosticsImageAck, UUIDS.otaCharacteristic]);
const PROPERTY_NAMES = ['broadcast', 'read', 'writeWithoutResponse', 'write', 'notify', 'indicate', 'authenticatedSignedWrites'] as const;

function timeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const errText = (e: unknown) => (e as Error)?.message ?? String(e);

/**
 * List every service and characteristic the browser may see and read the safe
 * values. One GATT operation at a time, through `client.op()`. The browser only
 * exposes services named when the device was chosen, so anything else on the
 * card is invisible here.
 */
export async function scanGatt(client: TodooCardClient): Promise<GattScan> {
  const scan: GattScan = { t: Date.now(), services: [] };
  const server = client.server;
  if (!server?.connected) return { ...scan, error: 'Not connected.' };
  let services: BluetoothRemoteGATTService[];
  try {
    services = await timeout(client.op(() => server.getPrimaryServices()), 15000, 'Service discovery');
  } catch (e) {
    client.log('warn', `GATT survey: service discovery failed: ${errText(e)}`);
    return { ...scan, error: `Service discovery failed: ${errText(e)}` };
  }
  client.log('info', `GATT survey: ${services.length} service(s) visible`);
  for (const svc of services) {
    const row: GattServiceRow = { uuid: svc.uuid, short: shortUuid(svc.uuid), name: gattName(svc.uuid), characteristics: [] };
    scan.services.push(row);
    if (!server.connected) {
      row.error = 'Disconnected before this service was read.';
      continue;
    }
    let chars: BluetoothRemoteGATTCharacteristic[];
    try {
      chars = await timeout(client.op(() => svc.getCharacteristics()), 10000, 'Characteristic discovery');
    } catch (e) {
      row.error = errText(e);
      continue;
    }
    for (const ch of chars) {
      const short = shortUuid(ch.uuid);
      const c: GattCharRow = { uuid: ch.uuid, short, name: gattName(ch.uuid), properties: PROPERTY_NAMES.filter((p) => ch.properties[p]) };
      row.characteristics.push(c);
      const asText = TEXT_READS.has(short);
      if (!ch.properties.read) continue;
      if (short === '2a19') {
        c.note = 'Not read automatically: it is encrypted, so reading it starts pairing. Use the button below.';
        continue;
      }
      if (!asText && !RAW_READS.has(short)) {
        c.note = 'Readable, but not read by this survey.';
        continue;
      }
      try {
        const v = await timeout(client.op(() => ch.readValue()), 8000, 'Read');
        const bytes = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
        c.valueHex = hex(bytes);
        if (asText) c.valueText = new TextDecoder().decode(bytes).replace(/\0+$/, '');
        if (short === UUIDS.diagnosticsStatus) scan.statusRecord = parseStatusRecord(bytes) ?? undefined;
        if (short === UUIDS.diagnosticsImageAck) scan.imageAck = parseImageAckDiagnostics(bytes) ?? undefined;
      } catch (e) {
        c.error = errText(e);
        if (short === '2a25' && /blocklist|not permitted|security/i.test(c.error)) c.note = 'The browser does not allow web pages to read the serial number.';
      }
    }
  }
  const chars = scan.services.reduce((n, s) => n + s.characteristics.length, 0);
  client.log('info', `GATT survey done: ${scan.services.length} service(s), ${chars} characteristic(s)`);
  return scan;
}

export interface BluetoothCapabilities {
  webBluetooth: boolean;
  secureContext: boolean;
  /** `navigator.bluetooth.getAvailability()`; null when it could not be asked. */
  adapterAvailable: boolean | null;
  watchAdvertisements: boolean;
  getDevices: boolean;
  requestLEScan: boolean;
}

export async function collectCapabilities(): Promise<BluetoothCapabilities> {
  const bt = typeof navigator !== 'undefined' ? (navigator.bluetooth as (Bluetooth & { requestLEScan?: unknown }) | undefined) : undefined;
  let adapterAvailable: boolean | null = null;
  try {
    if (bt && typeof bt.getAvailability === 'function') adapterAvailable = await bt.getAvailability();
  } catch {
    adapterAvailable = null;
  }
  const proto = (globalThis as { BluetoothDevice?: { prototype: Record<string, unknown> } }).BluetoothDevice?.prototype ?? {};
  return {
    webBluetooth: !!bt && typeof bt.requestDevice === 'function',
    secureContext: typeof window !== 'undefined' ? window.isSecureContext : false,
    adapterAvailable,
    watchAdvertisements: typeof proto.watchAdvertisements === 'function',
    getDevices: !!bt && typeof bt.getDevices === 'function',
    requestLEScan: !!bt && typeof bt.requestLEScan === 'function',
  };
}

export interface DiagnosticsInput {
  now: Date;
  app: { version: string; commit: string; apiVersion?: string };
  userAgent: string;
  capabilities: BluetoothCapabilities | null;
  note: string;
  connected: boolean;
  info: DeviceInfo | null;
  advWatch: AdvWatchState;
  advWatchError: string | null;
  advertisements: AdvSnapshot[];
  gatt: GattScan | null;
  /** Encrypted Battery Level, only when the user asked for it. */
  batteryRead: { t: number; percent?: number; error?: string } | null;
  /** How long the last link lasted before the card dropped it, when measured. */
  lastLinkMs: number | null;
  log: LogEntry[];
  catalog: FirmwareEntry[] | null;
  /** Which kind of device the file describes. Default: `todoocard`. */
  mode?: DiagnosticsMode;
  /** Canonical UUIDs passed to the chooser as `optionalServices`. Default: the TodooCard list. */
  requestedServices?: string[];
  /** Services that were wanted but not requested (blocklisted, invalid, refused by the browser). */
  rejectedServices?: RejectedService[];
}

/** What a browser cannot show, so a reader does not take a gap for a fact about the device. */
export const DIAGNOSTICS_LIMITATIONS: string[] = [
  'The browser hides every service that was not requested when the device was chosen: a service missing from gatt.services is absent only if it is listed in requestedServices.',
  'Chrome hides the Serial Number characteristic (2A25) from web pages.',
  'Advertisement data needs chrome://flags/#enable-experimental-web-platform-features; without it advertisements.snapshots is empty.',
  'Services on the Web Bluetooth blocklist (for example HID 0x1812) are never exposed to web pages.',
  'Encrypted characteristics are not read automatically; nothing is written and no notifications are enabled, so notify-only values are not captured.',
];

const iso = (t: number) => new Date(t).toISOString();

/** Assemble the diagnostics document (plain JSON-serialisable data). */
export function buildDiagnostics(i: DiagnosticsInput) {
  const info = i.info;
  return {
    schema: DIAGNOSTICS_SCHEMA,
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt: i.now.toISOString(),
    mode: (i.mode ?? 'todoocard') as DiagnosticsMode,
    limitations: DIAGNOSTICS_LIMITATIONS,
    requestedServices: i.requestedServices ?? TODOOCARD_SERVICES,
    rejectedServices: (i.rejectedServices ?? []).map((r) => ({ input: r.input, uuid: r.uuid ?? null, reason: r.reason })),
    app: { name: 'todoocard-web', version: i.app.version, commit: i.app.commit || null, apiVersion: i.app.apiVersion ?? null },
    userAgent: i.userAgent,
    bluetooth: i.capabilities,
    whatHappened: i.note,
    device: info
      ? {
          name: info.name,
          id: info.id,
          connected: i.connected,
          encryptedLinkVerified: info.bonded,
          model: info.model ?? null,
          serial: info.serial ?? null,
          serialNote: info.serial ? null : 'Not available in browsers: Chrome hides the Serial Number characteristic (2A25) from web pages. Native tools (bleak, nRF Connect) can read it.',
          firmwareString: info.firmwareString ?? null,
          firmwareVersion: info.firmwareRaw ?? null,
          hardware: info.hardware ?? null,
          manufacturer: info.manufacturer ?? null,
          battery: info.battery ?? null,
          rssi: info.rssi ?? null,
          flags: info.flags ?? null,
          lastLinkMs: i.lastLinkMs,
        }
      : null,
    advertisements: {
      watch: i.advWatch,
      watchError: i.advWatchError,
      snapshots: i.advertisements.map((a) => ({
        firstSeen: iso(a.t),
        lastSeen: iso(a.lastT),
        count: a.count,
        name: a.name ?? null,
        rssi: a.rssi ?? null,
        txPower: a.txPower ?? null,
        manufacturerData: a.manufacturerData.map((m) => ({ companyId: `0x${m.companyId.toString(16).padStart(4, '0')}`, hex: m.hex })),
        serviceUuids: a.serviceUuids,
        decoded: a.decoded ?? null,
      })),
    },
    gatt: i.gatt
      ? {
          readAt: iso(i.gatt.t),
          error: i.gatt.error ?? null,
          services: i.gatt.services,
          survey: i.gatt.mode ?? 'todoocard',
          isTodooCard: i.gatt.isTodooCard ?? null,
          noRequestedServicesPresent: i.gatt.noServices ?? false,
          disconnectedDuringSurvey: i.gatt.disconnected ?? false,
          truncated: i.gatt.truncated ?? false,
          readCount: i.gatt.readCount ?? null,
          notes: i.gatt.notes ?? [],
        }
      : null,
    values: {
      batteryLevel: i.batteryRead ? { readAt: iso(i.batteryRead.t), percent: i.batteryRead.percent ?? null, error: i.batteryRead.error ?? null } : null,
    },
    diagnostics: {
      statusRecord: i.gatt?.statusRecord ?? info?.statusRecord ?? null,
      imageAck: i.gatt?.imageAck ?? info?.diagnostics ?? null,
      snapshots: (info?.snapshots ?? []).map((s) => ({
        t: iso(s.t),
        label: s.label,
        status: s.status ? hex(s.status) : null,
        imageAck: s.imageAck ? hex(s.imageAck) : null,
      })),
    },
    eventLog: i.log.map((l) => ({ t: iso(l.t), level: l.level, msg: l.msg })),
    firmwareCatalog: {
      minimumVersion: MIN_FLASHABLE_VERSION,
      bundled: (i.catalog ?? []).map((e) => ({ id: e.id, version: e.version, latest: e.latest, source: e.source, size: e.size, sha256: e.sha256, storedCrc32: e.storedCrc32 })),
    },
  };
}

export type DiagnosticsDocument = ReturnType<typeof buildDiagnostics>;

export function diagnosticsFileName(now: Date): string {
  return `todoocard-diagnostics-${now.toISOString().replace(/[:.]/g, '-')}.json`;
}

export function downloadJson(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
