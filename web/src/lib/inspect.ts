/**
 * "Inspect any Bluetooth device": a read-only survey of whatever the user picks
 * from an unfiltered chooser.
 *
 * The generic device is held by `GenericInspector`, never by `TodooCardClient`,
 * so the Send and Firmware tabs (which only ever act on the client's device)
 * cannot reach it. Nothing here writes a characteristic or descriptor and
 * nothing starts notifications.
 *
 * Web Bluetooth only exposes services named in `optionalServices` when the
 * device was chosen, so "generic" means a wide built-in list plus UUIDs the
 * user types (see `uuids.ts`).
 */
import { UUIDS, hex, parseFirmwareRevisionString, parseImageAckDiagnostics, parseStatusRecord, shortUuid } from '@shared/protocol';
import { BleError, isWebBluetoothSupported, type DeviceInfo, type LogLevel, type TodooCardClient } from './ble';
import type { GattCharRow, GattScan, GattServiceRow } from './diagnostics';
import { buildRequestedServices, friendlyName, looksLikeTodooCard, printableText, uuidsNamedIn, type RejectedService } from './uuids';

export const GENERIC_MAX_READS = 200;
const READ_TIMEOUT_MS = 5000;
const DISCOVERY_TIMEOUT_MS = 20000;
const SURVEY_BUDGET_MS = 180000;
const MAX_CONSECUTIVE_TIMEOUTS = 3;
const PROPERTY_NAMES = ['broadcast', 'read', 'writeWithoutResponse', 'write', 'notify', 'indicate', 'authenticatedSignedWrites'] as const;
const USER_DESCRIPTION = '2901';

class TimeoutError extends Error {}

/** Reject after `ms`. The underlying promise is left to settle on its own. */
function timeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(`${what} timed out after ${ms / 1000} s`)), ms);
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
const errName = (e: unknown) => (e as DOMException)?.name ?? '';
const bytesOf = (v: DataView) => new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));

export function noServicesMessage(requestedCount: number): string {
  return `Connected, but none of the ${requestedCount} requested services are present. Add the device's service UUIDs in the box and choose it again.`;
}

export interface SurveyTarget {
  server: BluetoothRemoteGATTServer;
  /** Serialises GATT operations for this device. */
  op<T>(fn: () => Promise<T>): Promise<T>;
  log(level: LogLevel, msg: string): void;
  deviceName?: string;
  /** How many services were asked for in the chooser (for the "none present" message). */
  requestedCount: number;
  maxReads?: number;
  readTimeoutMs?: number;
  /** Called with the partial result as it grows. */
  onProgress?: (scan: GattScan) => void;
}

/**
 * List every visible service, characteristic and descriptor and read every
 * readable characteristic as raw bytes. Read-only: `readValue()` on
 * characteristics and on the User Description descriptor are the only value
 * operations. Returns what was collected even when the device drops part-way.
 */
export async function surveyGeneric(target: SurveyTarget): Promise<GattScan> {
  const { server, log } = target;
  const maxReads = target.maxReads ?? GENERIC_MAX_READS;
  const readTimeout = target.readTimeoutMs ?? READ_TIMEOUT_MS;
  const scan: GattScan = { t: Date.now(), mode: 'generic', services: [], readCount: 0, notes: [] };
  const progress = () => target.onProgress?.({ ...scan, services: [...scan.services] });
  // The timeout sits inside the queued operation so a read that never settles cannot block the queue.
  const gatt = <T,>(what: string, ms: number, fn: () => Promise<T>) => target.op(() => timeout(fn(), ms, what));
  const dropped = (where: string) => {
    scan.disconnected = true;
    scan.error = `The device disconnected ${where}. Everything read before that is kept below.`;
    log('warn', `Generic survey: device disconnected ${where}`);
  };

  if (!server.connected) return { ...scan, error: 'Not connected.' };

  let services: BluetoothRemoteGATTService[];
  try {
    services = await gatt('Service discovery', DISCOVERY_TIMEOUT_MS, () => server.getPrimaryServices());
  } catch (e) {
    if (!server.connected) {
      dropped('during service discovery');
    } else if (errName(e) === 'NotFoundError' || /no services/i.test(errText(e))) {
      scan.noServices = true;
      scan.error = noServicesMessage(target.requestedCount);
      log('warn', `Generic survey: ${scan.error}`);
    } else {
      scan.error = `Service discovery failed: ${errText(e)}`;
      log('warn', `Generic survey: ${scan.error}`);
    }
    return scan;
  }
  if (services.length === 0) {
    scan.noServices = true;
    scan.error = noServicesMessage(target.requestedCount);
    log('warn', `Generic survey: ${scan.error}`);
    return scan;
  }

  const todoo = looksLikeTodooCard(services.map((s) => s.uuid)) || /^Todoo(Card|Rescue)/i.test(target.deviceName ?? '');
  scan.isTodooCard = todoo;
  log('info', `Generic survey: ${services.length} of ${target.requestedCount} requested service(s) visible${todoo ? '; this looks like a TodooCard' : ''}`);

  // Pass 1: the table (services and characteristics), before any value is read.
  const pending: { row: GattCharRow; ch: BluetoothRemoteGATTCharacteristic }[] = [];
  for (const svc of services) {
    const row: GattServiceRow = { uuid: svc.uuid, short: shortUuid(svc.uuid), name: friendlyName(svc.uuid, todoo), characteristics: [] };
    scan.services.push(row);
    if (scan.disconnected) {
      row.error = 'Disconnected before this service was listed.';
      continue;
    }
    try {
      const chars = await gatt('Characteristic discovery', DISCOVERY_TIMEOUT_MS, () => svc.getCharacteristics());
      for (const ch of chars) {
        const c: GattCharRow = { uuid: ch.uuid, short: shortUuid(ch.uuid), name: friendlyName(ch.uuid, todoo), properties: PROPERTY_NAMES.filter((p) => ch.properties[p]) };
        row.characteristics.push(c);
        pending.push({ row: c, ch });
      }
    } catch (e) {
      if (!server.connected) {
        row.error = 'Disconnected before this service was listed.';
        dropped('while the services were being listed');
      } else if (errName(e) !== 'NotFoundError') {
        row.error = errText(e); // NotFoundError just means "no characteristics"
      }
    }
    progress();
  }

  // Pass 2: values and descriptors, one operation at a time.
  const started = Date.now();
  let timeouts = 0;
  let stopped: string | null = null;
  const canRead = () => {
    if ((scan.readCount ?? 0) >= maxReads) {
      if (!scan.truncated) {
        scan.truncated = true;
        scan.notes!.push(`Stopped reading after ${maxReads} reads; the rest of the table is listed without values.`);
        log('warn', `Generic survey: read limit of ${maxReads} reached`);
      }
      return false;
    }
    return true;
  };
  for (const { row: c, ch } of pending) {
    if (scan.disconnected || stopped) {
      if (ch.properties.read) c.note = scan.disconnected ? 'Not read: the device had disconnected.' : `Not read: ${stopped}`;
      continue;
    }
    if (!server.connected) {
      dropped('during the survey');
      if (ch.properties.read) c.note = 'Not read: the device had disconnected.';
      continue;
    }
    if (Date.now() - started > SURVEY_BUDGET_MS) {
      stopped = `the survey stopped after ${SURVEY_BUDGET_MS / 1000} s.`;
      scan.truncated = true;
      scan.notes!.push(`The survey stopped after ${SURVEY_BUDGET_MS / 1000} s; the rest of the table is listed without values.`);
      if (ch.properties.read) c.note = `Not read: ${stopped}`;
      continue;
    }

    if (ch.properties.read) {
      if (todoo && c.short === '2a19') {
        c.note = 'Not read automatically: on a TodooCard it is encrypted, so reading it starts pairing.';
      } else if (!canRead()) {
        c.note = 'Not read: the read limit for one survey was reached.';
      } else {
        scan.readCount = (scan.readCount ?? 0) + 1;
        try {
          const bytes = bytesOf(await gatt('Read', readTimeout, () => ch.readValue()));
          timeouts = 0;
          c.valueHex = hex(bytes);
          c.valueText = printableText(bytes);
          if (todoo && c.short === UUIDS.diagnosticsStatus) scan.statusRecord = parseStatusRecord(bytes) ?? undefined;
          if (todoo && c.short === UUIDS.diagnosticsImageAck) scan.imageAck = parseImageAckDiagnostics(bytes) ?? undefined;
        } catch (e) {
          c.error = errText(e);
          if (c.short === '2a25' && /blocklist|not permitted|security/i.test(c.error)) c.note = 'The browser does not allow web pages to read the serial number.';
          if (!server.connected) {
            dropped(`while reading ${c.name ?? c.short}`);
            continue;
          }
          if (e instanceof TimeoutError && ++timeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
            stopped = 'the device stopped answering.';
            scan.truncated = true;
            scan.notes!.push(`${MAX_CONSECUTIVE_TIMEOUTS} reads in a row timed out, so the survey stopped. The device is connected but not answering.`);
            log('warn', 'Generic survey: the device stopped answering reads');
            continue;
          }
        }
      }
    }

    // Descriptors: UUIDs only, plus the text of Characteristic User Description.
    try {
      const descs = await gatt('Descriptor discovery', readTimeout, () => ch.getDescriptors());
      c.descriptors = descs.map((d) => ({ uuid: d.uuid, short: shortUuid(d.uuid), name: friendlyName(d.uuid, todoo) }));
      for (let i = 0; i < descs.length; i++) {
        if (shortUuid(descs[i].uuid) !== USER_DESCRIPTION || !canRead()) continue;
        scan.readCount = (scan.readCount ?? 0) + 1;
        try {
          const bytes = bytesOf(await gatt('Descriptor read', readTimeout, () => descs[i].readValue()));
          c.descriptors[i].valueText = new TextDecoder().decode(bytes).replace(/\0+$/, '');
        } catch (e) {
          c.descriptors[i].error = errText(e);
        }
      }
    } catch (e) {
      // NotFoundError: the characteristic has no descriptors. NotSupportedError: this platform cannot list them.
      if (!server.connected) dropped(`while listing descriptors of ${c.name ?? c.short}`);
      else if (errName(e) !== 'NotFoundError') c.descriptorsError = errText(e);
    }
    progress();
  }

  const chars = scan.services.reduce((n, s) => n + s.characteristics.length, 0);
  log('info', `Generic survey ${scan.disconnected ? 'ended early' : 'done'}: ${scan.services.length} service(s), ${chars} characteristic(s), ${scan.readCount} read(s)`);
  return scan;
}

export interface InspectorState {
  name: string;
  id: string;
  connected: boolean;
  /** Canonical UUIDs actually passed to the chooser. */
  requested: string[];
  rejected: RejectedService[];
  /** The generic device is the very card the Send/Firmware tabs are using. */
  sameAsCard: boolean;
  /** How long the last link lasted when the device (not this app) ended it. */
  lastLinkMs: number | null;
}

/**
 * Holds the generically chosen device and its connection, apart from the
 * TodooCard client. It borrows the client only for the shared event log, to
 * refuse work while a transfer is running, and for the operation queue when
 * the user happens to pick the very card the client is using (Chrome allows
 * one GATT operation at a time per device).
 */
export class GenericInspector extends EventTarget {
  device: BluetoothDevice | null = null;
  server: BluetoothRemoteGATTServer | null = null;
  requested: string[] = [];
  rejected: RejectedService[] = [];
  lastLinkMs: number | null = null;
  private linkStartedAt: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private wired = new WeakSet<BluetoothDevice>();
  /** UUIDs this browser refused in this session; never asked for again. */
  private browserRejected = new Set<string>();

  /** UUIDs this browser refused in this session. */
  get refused(): string[] {
    return [...this.browserRejected];
  }

  constructor(private readonly host: TodooCardClient) {
    super();
  }

  log(level: LogLevel, msg: string) {
    this.host.log(level, msg);
  }

  get connected(): boolean {
    return !!this.server?.connected;
  }

  get sameAsCard(): boolean {
    return !!this.device && this.device === this.host.device;
  }

  get state(): InspectorState | null {
    if (!this.device) return null;
    return {
      name: this.device.name ?? 'Unnamed device',
      id: this.device.id,
      connected: this.connected,
      requested: this.requested,
      rejected: this.rejected,
      sameAsCard: this.sameAsCard,
      lastLinkMs: this.lastLinkMs,
    };
  }

  private changed() {
    this.dispatchEvent(new Event('change'));
  }

  /** One GATT operation at a time per device. */
  op<T>(fn: () => Promise<T>): Promise<T> {
    if (this.sameAsCard) return this.host.op(fn);
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private refuseWhileBusy() {
    if (this.host.busy) throw new BleError('The card is busy with a transfer or a connection. Wait for it to finish, then try again.', 'busy');
  }

  /**
   * Show the unfiltered chooser. When the browser refuses a UUID, drop it,
   * say so and ask again instead of failing the whole request.
   */
  async choose(extraText: string): Promise<BluetoothDevice> {
    if (!isWebBluetoothSupported()) {
      throw new BleError('Web Bluetooth is not available. Use Chrome or Edge on a secure (https) page.', 'unsupported');
    }
    this.refuseWhileBusy();
    let device: BluetoothDevice | null = null;
    let list = buildRequestedServices(extraText, this.browserRejected);
    for (let attempt = 0; !device; attempt++) {
      list = buildRequestedServices(extraText, this.browserRejected);
      try {
        device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: list.requested });
      } catch (e) {
        const name = errName(e);
        const msg = errText(e);
        if (name === 'NotFoundError') throw new BleError('No device selected.', 'cancelled', e);
        if (/user gesture|user activation/i.test(msg)) {
          this.rejected = list.rejected;
          this.changed();
          throw new BleError('The browser needs a fresh click to open the device list. Press the button again.', 'gesture', e);
        }
        if ((name === 'SecurityError' || name === 'TypeError') && attempt < 20) {
          const requested = new Set(list.requested);
          let named = uuidsNamedIn(msg).filter((u) => requested.has(u));
          if (named.length === 0) {
            // The browser did not say which one: the built-in list is known to be accepted, so drop the typed extras.
            const builtIn = new Set(buildRequestedServices('').requested);
            named = list.requested.filter((u) => !builtIn.has(u));
          }
          if (named.length > 0) {
            for (const u of named) this.browserRejected.add(u);
            this.log('warn', `The browser refused ${named.map(shortUuid).join(', ')} (${msg}). Asking again without ${named.length === 1 ? 'it' : 'them'}.`);
            continue;
          }
        }
        throw new BleError(`Device chooser failed: ${msg}`, 'chooser', e);
      }
    }

    // A different device: drop the old generic link, but never the card the other tabs are using.
    if (this.device && this.device !== device && !this.sameAsCard) this.disconnect();
    this.device = device;
    this.server = null;
    this.requested = list.requested;
    this.rejected = list.rejected;
    this.lastLinkMs = null;
    if (!this.wired.has(device)) {
      this.wired.add(device);
      const dev = device;
      dev.addEventListener('gattserverdisconnected', () => {
        if (this.device !== dev) return;
        if (this.linkStartedAt !== null) {
          this.lastLinkMs = Date.now() - this.linkStartedAt;
          this.linkStartedAt = null;
          this.log('warn', `Generic device disconnected, ${(this.lastLinkMs / 1000).toFixed(1)} s after connecting`);
        }
        this.changed();
      });
    }
    this.log('info', `Generic inspection: chose "${device.name ?? 'unnamed device'}", asked for ${list.requested.length} service(s)`);
    if (list.rejected.length > 0) this.log('warn', `Not requested: ${list.rejected.map((r) => `${r.input} (${r.reason})`).join('; ')}`);
    if (this.sameAsCard) this.log('warn', 'This is the card already selected on the Send and Firmware tabs; it is surveyed read-only over the same connection.');
    this.changed();
    return device;
  }

  async connect(): Promise<void> {
    const device = this.device;
    if (!device) throw new BleError('No device selected', 'nodevice');
    this.refuseWhileBusy();
    if (this.server?.connected) return;
    const name = device.name ?? 'the device';
    if (!device.gatt) throw new BleError(`${name} has no GATT server, so there is nothing to connect to.`, 'nogatt');
    this.log('info', `Generic inspection: connecting to ${name} ...`);
    this.lastLinkMs = null;
    try {
      this.server = await timeout(device.gatt.connect(), DISCOVERY_TIMEOUT_MS, 'Connecting');
    } catch (e) {
      this.log('warn', `Generic inspection: connect failed: ${errText(e)}`);
      this.changed();
      throw new BleError(
        `Could not connect to ${name}: ${errText(e).replace(/\.+$/, '')}. It may be out of range, asleep, not connectable, or already connected to a phone or another computer.`,
        'connect',
        e,
      );
    }
    this.linkStartedAt = Date.now();
    this.log('info', `Generic inspection: connected to ${name}`);
    this.changed();
  }

  disconnect() {
    if (this.sameAsCard && this.host.busy) return; // never cut a running transfer
    this.linkStartedAt = null; // ended by us: not a drop
    if (this.sameAsCard) {
      this.host.disconnect();
    } else {
      try {
        this.device?.gatt?.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.server = null;
    this.changed();
  }

  async survey(onProgress?: (scan: GattScan) => void): Promise<GattScan> {
    this.refuseWhileBusy();
    const server = this.server;
    if (!server?.connected) return { t: Date.now(), mode: 'generic', services: [], error: 'Not connected.' };
    const scan = await surveyGeneric({
      server,
      op: (fn) => this.op(fn),
      log: (level, msg) => this.log(level, msg),
      deviceName: this.device?.name,
      requestedCount: this.requested.length,
      onProgress,
    });
    this.changed();
    return scan;
  }
}

/** Device summary for the diagnostics file, from what a generic survey read (Device Information strings). */
export function genericDeviceInfo(state: { name: string; id: string }, scan: GattScan | null): DeviceInfo {
  const text = (short: string) => {
    for (const s of scan?.services ?? []) {
      const c = s.characteristics.find((x) => x.short === short);
      if (c?.valueHex !== undefined) return c.valueText;
    }
    return undefined;
  };
  const firmwareString = text('2a26');
  const info: DeviceInfo = {
    name: state.name,
    id: state.id,
    bonded: false,
    model: text('2a24'),
    firmwareString,
    hardware: text('2a27'),
    manufacturer: text('2a29'),
    services: scan?.services.map((s) => s.uuid),
  };
  if (scan?.isTodooCard && firmwareString) info.firmwareRaw = parseFirmwareRevisionString(firmwareString) ?? undefined;
  return info;
}
