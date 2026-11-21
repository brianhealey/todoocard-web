/**
 * Web Bluetooth client for TodooCard / T3 cards.
 *
 * Pairing model: the card requires an encrypted link for the Battery Level
 * characteristic. Reading it makes the browser/OS create the bond (the OS may
 * show a pairing prompt). The card only accepts a *new* bond while its physical
 * pairing window is open (hold the hidden rear button ~5 s until the front
 * light flashes; the window closes after 60 s). An existing bond works at any
 * time. A card that refuses drops the connection within about a second.
 */
import {
  CAPABILITY,
  FW,
  UUIDS,
  decodeManufacturerData,
  describeAdvertisement,
  hex as hexOf,
  parseFirmwareRevisionString,
  parseImageAckDiagnostics,
  parseManufacturerData,
  parseStatusRecord,
  type Advertisement,
  type DecodedAdvertisement,
  type ImageAckDiagnostics,
  type StatusRecord,
} from '@shared/protocol';
import { TODOOCARD_SERVICES } from './uuids';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';
export interface LogEntry {
  t: number;
  level: LogLevel;
  msg: string;
}

export interface DeviceInfo {
  name: string;
  id: string;
  model?: string;
  serial?: string;
  firmwareString?: string;
  firmwareRaw?: number;
  hardware?: string;
  manufacturer?: string;
  battery?: number;
  /** True once an encrypted characteristic has been read successfully in this session. */
  bonded: boolean;
  advertisement?: Advertisement;
  flags?: ReturnType<typeof describeAdvertisement>;
  rssi?: number;
  diagnostics?: ImageAckDiagnostics;
  /** Decoded ...1002 status record (latest snapshot). */
  statusRecord?: StatusRecord;
  /** True once Battery Level notifications are flowing. */
  batteryLive?: boolean;
  /** Raw diagnostics snapshots, newest last (capped). */
  snapshots?: DiagSnapshot[];
  services?: string[];
}

export interface DiagSnapshot {
  t: number;
  label: string;
  /** D8B282F0-…1002 (undocumented status record) */
  status?: Uint8Array;
  /** D8B282F0-…1003 (image-ACK record) */
  imageAck?: Uint8Array;
  diagnostics?: ImageAckDiagnostics;
  statusRecord?: StatusRecord;
}

const MAX_SNAPSHOTS = 12;
const MAX_ADVERTISEMENTS = 20;

/** One distinct advertisement payload seen from the selected card (repeats are counted, not stored). */
export interface AdvSnapshot {
  /** First and most recent time this exact payload was seen. */
  t: number;
  lastT: number;
  count: number;
  name?: string;
  rssi?: number;
  txPower?: number;
  /** Manufacturer records as delivered by the browser (company id stripped from `hex`). */
  manufacturerData: { companyId: number; hex: string }[];
  serviceUuids: string[];
  /** Decoded TodooCard (0x5053) record, when present. */
  decoded?: DecodedAdvertisement;
}

/**
 * `unsupported`: this browser has no `watchAdvertisements()` (Chrome needs
 * chrome://flags/#enable-experimental-web-platform-features).
 */
export type AdvWatchState = 'idle' | 'unsupported' | 'watching' | 'error';

function bytesOf(v: DataView): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export class BleError extends Error {
  constructor(message: string, public readonly code: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'BleError';
  }
}

/** Generic Access / Generic Attribute are listed only so the troubleshooting GATT table can show them. */
const OPTIONAL_SERVICES: BluetoothServiceUUID[] = TODOOCARD_SERVICES;

export function isWebBluetoothSupported(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator && typeof navigator.bluetooth?.requestDevice === 'function';
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new BleError(message, 'timeout')), ms);
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TodooCardClient extends EventTarget {
  device: BluetoothDevice | null = null;
  server: BluetoothRemoteGATTServer | null = null;
  control: BluetoothRemoteGATTCharacteristic | null = null;
  data: BluetoothRemoteGATTCharacteristic | null = null;
  info: DeviceInfo | null = null;
  busy = false;
  private batteryChar: BluetoothRemoteGATTCharacteristic | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private advertisementAbort: AbortController | null = null;
  /** Devices that already carry our event listeners (the chooser returns the same object again). */
  private wired = new WeakSet<BluetoothDevice>();
  /** Distinct advertisement payloads from the selected card, oldest first. */
  advertisements: AdvSnapshot[] = [];
  advWatch: AdvWatchState = 'idle';
  advWatchError: string | null = null;
  private linkStartedAt: number | null = null;
  /** How long the last link lasted when the card (not this app) ended it; null otherwise. */
  lastLinkMs: number | null = null;

  log(level: LogLevel, msg: string) {
    this.dispatchEvent(new CustomEvent<LogEntry>('log', { detail: { t: Date.now(), level, msg } }));
  }

  private emitInfo() {
    this.dispatchEvent(new CustomEvent<DeviceInfo | null>('info', { detail: this.info }));
  }

  /** Serialise GATT operations: Chrome rejects concurrent operations on one device. */
  op<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  get connected(): boolean {
    return !!this.server?.connected;
  }

  /** Show the browser's device chooser filtered to TodooCard advertisements. */
  async requestDevice(): Promise<BluetoothDevice> {
    if (!isWebBluetoothSupported()) {
      throw new BleError('Web Bluetooth is not available. Use Chrome or Edge on a secure (https) page.', 'unsupported');
    }
    const filters: BluetoothLEScanFilter[] = [
      { manufacturerData: [{ companyIdentifier: 0x5053 }] },
      { namePrefix: 'TodooCard' },
      { services: [UUIDS.imageService] },
      // Recovery/debug firmware may advertise only the OTA service (e.g. a card
      // named "NEMR…" with no battery/image services) — still let it be picked.
      { services: [UUIDS.otaService] },
    ];
    let device: BluetoothDevice;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters,
        optionalServices: OPTIONAL_SERVICES,
        optionalManufacturerData: [0x5053],
      } as RequestDeviceOptions);
    } catch (e) {
      if ((e as DOMException)?.name === 'NotFoundError') {
        throw new BleError('No device selected.', 'cancelled', e);
      }
      throw new BleError(`Device chooser failed: ${(e as Error).message}`, 'chooser', e);
    }
    this.attach(device);
    return device;
  }

  attach(device: BluetoothDevice) {
    if (this.device && this.device !== device) {
      this.disconnect();
      this.advertisements = [];
    }
    this.device = device;
    this.info = { name: device.name ?? 'TodooCard', id: device.id, bonded: false };
    if (!this.wired.has(device)) {
      this.wired.add(device);
      device.addEventListener('gattserverdisconnected', () => {
        if (this.device !== device) return;
        if (this.linkStartedAt !== null) {
          this.lastLinkMs = Date.now() - this.linkStartedAt;
          this.linkStartedAt = null;
          this.log('warn', `Disconnected by the card or the link, ${(this.lastLinkMs / 1000).toFixed(1)} s after connecting`);
        } else {
          this.log('warn', 'Disconnected');
        }
        this.control = null;
        this.data = null;
        this.batteryChar = null;
        if (this.info) {
          this.info.batteryLive = false;
          this.emitInfo();
        }
        this.dispatchEvent(new Event('disconnected'));
      });
      device.addEventListener('advertisementreceived', (ev: Event) => {
        if (this.device === device) this.onAdvertisement(ev as BluetoothAdvertisingEvent);
      });
    }
    this.emitInfo();
    this.watchAdvertisements().catch(() => undefined);
  }

  private onAdvertisement(e: BluetoothAdvertisingEvent) {
    const records: AdvSnapshot['manufacturerData'] = [];
    let decoded: DecodedAdvertisement | undefined;
    e.manufacturerData?.forEach((value, companyId) => {
      const bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      records.push({ companyId, hex: hexOf(bytes) });
      if (companyId === 0x5053) {
        const full = new Uint8Array(bytes.length + 2);
        full.set([0x53, 0x50]);
        full.set(bytes, 2);
        decoded = decodeManufacturerData(full) ?? undefined;
        const adv = parseManufacturerData(bytes, false);
        if (adv && this.info) {
          this.info.advertisement = adv;
          this.info.flags = describeAdvertisement(adv);
          this.info.firmwareRaw = adv.firmwareRaw;
        }
      }
    });
    const now = Date.now();
    const name = e.name ?? e.device?.name ?? undefined;
    const serviceUuids = (e.uuids ?? []).map((u) => String(u));
    const rssi = e.rssi ?? undefined;
    const key = (s: Pick<AdvSnapshot, 'name' | 'manufacturerData' | 'serviceUuids'>) =>
      `${s.name ?? ''}|${s.manufacturerData.map((m) => `${m.companyId}:${m.hex}`).join(',')}|${s.serviceUuids.join(',')}`;
    const last = this.advertisements[this.advertisements.length - 1];
    const snap = { name, manufacturerData: records, serviceUuids };
    if (last && key(last) === key(snap)) {
      last.lastT = now;
      last.count++;
      last.rssi = rssi;
    } else {
      this.advertisements = [...this.advertisements, { t: now, lastT: now, count: 1, rssi, txPower: e.txPower ?? undefined, decoded, ...snap }].slice(-MAX_ADVERTISEMENTS);
      this.log('debug', `Advertisement: name=${name ?? '-'} rssi=${rssi ?? '-'} ${records.map((m) => `0x${m.companyId.toString(16)}=[${m.hex}]`).join(' ') || 'no manufacturer data'}`);
    }
    if (this.info) {
      if (rssi !== undefined) this.info.rssi = rssi;
      this.emitInfo();
    }
    this.dispatchEvent(new Event('advertisement'));
  }

  /**
   * Start (or restart) watching the selected card's advertisements. This is
   * behind a flag in most Chrome builds; `advWatch` says what happened. The card
   * stops advertising while it is connected, so packets arrive only before a
   * connection and after a disconnect.
   */
  async watchAdvertisements(): Promise<AdvWatchState> {
    const dev = this.device as (BluetoothDevice & { watchAdvertisements?: (o?: { signal?: AbortSignal }) => Promise<void> }) | null;
    const set = (state: AdvWatchState, error: string | null = null) => {
      this.advWatch = state;
      this.advWatchError = error;
      this.dispatchEvent(new Event('advertisement'));
      return state;
    };
    if (!dev) return set('idle');
    if (typeof dev.watchAdvertisements !== 'function') return set('unsupported');
    this.advertisementAbort?.abort();
    const ac = new AbortController();
    this.advertisementAbort = ac;
    try {
      await dev.watchAdvertisements({ signal: ac.signal });
      this.log('debug', 'Watching advertisements');
      return set('watching');
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      this.log('debug', `Advertisement watching failed: ${msg}`);
      return set('error', msg);
    }
  }

  async connect(): Promise<void> {
    if (!this.device) throw new BleError('No device selected', 'nodevice');
    if (this.server?.connected) return;
    const gatt = this.device.gatt;
    if (!gatt) throw new BleError('Device has no GATT server', 'nogatt');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        this.log('info', `Connecting (attempt ${attempt}/3) ...`);
        this.lastLinkMs = null;
        this.server = await withTimeout(gatt.connect(), 15000, 'Timed out connecting');
        this.linkStartedAt = Date.now();
        this.log('info', 'Connected');
        return;
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        this.log('warn', `Connect failed: ${msg}`);
        if (attempt === 3) {
          const hint = /Unsupported device/i.test(msg)
            ? ' Chrome refused the connection before contacting the card. This usually means another app or browser tab on this computer is holding the card, or Chrome is using a stale handle for it. Close other Bluetooth apps and tabs using the card, wait a few seconds, then choose the card again. If it keeps happening, turn Bluetooth off and on.'
            : '';
          throw new BleError(`Could not connect: ${msg.replace(/\.+$/, '')}.${hint}`, 'connect', e);
        }
        await sleep(attempt === 1 ? 750 : 1500);
      }
    }
  }

  disconnect() {
    this.advertisementAbort?.abort();
    this.advertisementAbort = null;
    if (this.advWatch === 'watching') this.advWatch = 'idle';
    this.linkStartedAt = null; // ended by us: not a drop
    try {
      this.device?.gatt?.disconnect();
    } catch {
      /* ignore */
    }
    this.server = null;
    this.control = null;
    this.data = null;
    this.batteryChar = null;
  }

  /** Subscribe to Battery Level notifications so the panel shows live values. */
  async startBatteryNotifications(): Promise<void> {
    if (!this.server?.connected || this.batteryChar) return;
    try {
      const svc = await this.server.getPrimaryService(UUIDS.batteryService);
      const ch = await svc.getCharacteristic(UUIDS.batteryLevel);
      if (!ch.properties.notify) return;
      ch.addEventListener('characteristicvaluechanged', (ev) => {
        const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
        if (!v || !this.info) return;
        this.info.battery = v.getUint8(0);
        this.info.batteryLive = true;
        this.emitInfo();
      });
      await this.op(() => ch.startNotifications());
      this.batteryChar = ch;
      if (this.info) {
        this.info.batteryLive = true;
        this.emitInfo();
      }
      this.log('debug', 'Battery notifications enabled');
    } catch (e) {
      this.log('debug', `Battery notifications unavailable: ${(e as Error).message}`);
    }
  }

  private async readString(service: BluetoothRemoteGATTService, uuid: BluetoothCharacteristicUUID): Promise<string | undefined> {
    try {
      const ch = await service.getCharacteristic(uuid);
      const v = await this.op(() => ch.readValue());
      return new TextDecoder().decode(v).replace(/\0+$/, '');
    } catch {
      return undefined;
    }
  }

  /**
   * Read the encrypted Battery Level. This is the pairing proof: success means
   * the OS bond exists (or was just created). Failure usually means the card
   * refused a new bond because its pairing window is closed.
   */
  async verifyBond(): Promise<number> {
    if (!this.server?.connected) await this.connect();
    const server = this.server!;
    try {
      const svc = await withTimeout(server.getPrimaryService(UUIDS.batteryService), 10000, 'Battery service discovery timed out');
      const ch = await svc.getCharacteristic(UUIDS.batteryLevel);
      this.log('info', 'Reading encrypted Battery Level to verify/create the system bond ...');
      const v = await withTimeout(this.op(() => ch.readValue()), 30000, 'Encrypted read timed out (did you accept the pairing prompt?)');
      const battery = v.getUint8(0);
      if (this.info) {
        this.info.battery = battery;
        this.info.bonded = true;
        this.emitInfo();
      }
      this.log('info', `Encrypted link verified; battery=${battery}%`);
      return battery;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (!this.server?.connected || /disconnected|GATT Server is disconnected|Network/i.test(msg)) {
        throw new BleError(
          'The card dropped the link during the encrypted read. It is not bonded to this computer: hold the hidden button on the back for 5 seconds until the front light flashes, then connect again within 60 seconds.',
          'notbonded',
          e,
        );
      }
      if (/not allowed|Authentication|insufficient|GATT Error/i.test(msg)) {
        throw new BleError(`Encrypted read refused: ${msg}. Open the pairing window (hold the hidden rear button ~5 s) and retry.`, 'auth', e);
      }
      throw new BleError(msg, 'read', e);
    }
  }

  /** Read Device Information strings. Fills firmwareRaw from the revision string. */
  async readDeviceInfo(): Promise<DeviceInfo> {
    if (!this.server?.connected) await this.connect();
    const server = this.server!;
    const info = this.info ?? { name: this.device?.name ?? 'TodooCard', id: this.device?.id ?? '', bonded: false };
    try {
      const services = await server.getPrimaryServices();
      info.services = services.map((s) => s.uuid);
    } catch {
      /* ignore */
    }
    try {
      const dis = await withTimeout(server.getPrimaryService(UUIDS.deviceInfoService), 10000, 'Device Information discovery timed out');
      info.model = await this.readString(dis, UUIDS.modelNumber);
      info.serial = await this.readString(dis, UUIDS.serialNumber);
      info.firmwareString = await this.readString(dis, UUIDS.firmwareRevision);
      info.hardware = await this.readString(dis, UUIDS.hardwareRevision);
      info.manufacturer = await this.readString(dis, UUIDS.manufacturerName);
      if (info.firmwareString) {
        const raw = parseFirmwareRevisionString(info.firmwareString);
        if (raw !== null) info.firmwareRaw = raw;
      }
    } catch (e) {
      this.log('warn', `Device Information unavailable: ${(e as Error).message}`);
    }
    this.info = info;
    this.emitInfo();
    return info;
  }

  /**
   * Read both vendor diagnostics records and keep a labelled snapshot (for example
   * "connect", "before send", "after send") so the undocumented status record can be
   * decoded by comparing bytes over time.
   */
  async readDiagnostics(label = 'manual'): Promise<ImageAckDiagnostics | null> {
    if (!this.server?.connected) return null;
    const snap: DiagSnapshot = { t: Date.now(), label };
    try {
      const svc = await this.server.getPrimaryService(UUIDS.diagnosticsService);
      try {
        const ack = await svc.getCharacteristic(UUIDS.diagnosticsImageAck);
        snap.imageAck = bytesOf(await this.op(() => ack.readValue()));
        snap.diagnostics = parseImageAckDiagnostics(snap.imageAck) ?? undefined;
      } catch (e) {
        this.log('debug', `Image-ACK diagnostics unavailable: ${(e as Error).message}`);
      }
      try {
        const st = await svc.getCharacteristic(UUIDS.diagnosticsStatus);
        snap.status = bytesOf(await this.op(() => st.readValue()));
        snap.statusRecord = parseStatusRecord(snap.status) ?? undefined;
      } catch (e) {
        this.log('debug', `Status record unavailable: ${(e as Error).message}`);
      }
    } catch (e) {
      this.log('debug', `Diagnostics service unavailable: ${(e as Error).message}`);
      return null;
    }
    if (!snap.imageAck && !snap.status) return null;
    if (this.info) {
      if (snap.diagnostics) this.info.diagnostics = snap.diagnostics;
      if (snap.statusRecord) this.info.statusRecord = snap.statusRecord;
      this.info.snapshots = [...(this.info.snapshots ?? []), snap].slice(-MAX_SNAPSHOTS);
      this.emitInfo();
    }
    this.log('debug', `Diagnostics snapshot (${label}): status=[${snap.status ? hexOf(snap.status) : '-'}] imageAck=[${snap.imageAck ? hexOf(snap.imageAck) : '-'}]`);
    return snap.diagnostics ?? null;
  }

  /** Locate the image-transfer control/data characteristics. */
  async prepareTransferCharacteristics(): Promise<{ control: BluetoothRemoteGATTCharacteristic; data: BluetoothRemoteGATTCharacteristic }> {
    if (!this.server?.connected) await this.connect();
    const server = this.server!;
    let svc: BluetoothRemoteGATTService;
    try {
      svc = await withTimeout(server.getPrimaryService(UUIDS.imageService), 10000, 'Image service discovery timed out');
    } catch {
      svc = await withTimeout(server.getPrimaryService(UUIDS.imageServiceAlt), 10000, 'Image service (FDF0) discovery timed out');
    }
    const [control, data] = await Promise.all([
      svc.getCharacteristic(svc.uuid.startsWith('0000fdf0') ? UUIDS.controlAlt : UUIDS.control),
      svc.getCharacteristic(svc.uuid.startsWith('0000fdf0') ? UUIDS.dataAlt : UUIDS.data),
    ]);
    this.control = control;
    this.data = data;
    return { control, data };
  }

  /**
   * Full connect sequence used by the UI: connect, verify bond (pairing proof),
   * then read device information and diagnostics when supported.
   */
  async connectAndIdentify(): Promise<DeviceInfo> {
    this.busy = true;
    try {
      await this.connect();
      await this.verifyBond();
      // The card may issue Service Changed after encryption; give the cache a moment.
      await sleep(600);
      const info = await this.readDeviceInfo();
      await this.readDiagnostics('connect');
      await this.startBatteryNotifications();
      return info;
    } finally {
      this.busy = false;
    }
  }

  /**
   * GATT-only connect: no pairing/bond, no battery read, device info best-effort.
   * Nothing is written to the card.
   */
  private async connectUnpaired(doneMessage: string): Promise<DeviceInfo> {
    this.busy = true;
    try {
      await this.connect();
      try {
        await this.readDeviceInfo(); // may expose almost nothing in recovery mode
      } catch (e) {
        this.log('warn', `Device info unavailable (${(e as Error).message}) — proceeding anyway.`);
      }
      if (this.info) {
        this.info.bonded = false;
        this.emitInfo();
      }
      this.log('info', doneMessage);
      return this.info ?? { name: this.device?.name ?? 'TodooCard', id: this.device?.id ?? '', bonded: false };
    } finally {
      this.busy = false;
    }
  }

  /**
   * Connect for firmware recovery: for a bricked or OTA-recovery-mode card that
   * can't complete normal pairing — the OTA service stays accessible as the
   * recovery lifeline, so the firmware flasher can still reach it.
   */
  connectForRecovery(): Promise<DeviceInfo> {
    return this.connectUnpaired('Connected in recovery mode (no pairing). You can flash firmware now.');
  }

  /** Connect for troubleshooting: look, do not touch. */
  connectForInspection(): Promise<DeviceInfo> {
    return this.connectUnpaired('Connected without pairing (GATT only).');
  }

  get requiresEncryptedGatt(): boolean {
    const f = this.info?.flags;
    if (f) return f.secure;
    // Without advertisement data assume current secure firmware.
    return (this.info?.firmwareRaw ?? 0xff) >= FW.secureMinimum;
  }

  get pairingWindowOpen(): boolean | undefined {
    const a = this.info?.advertisement;
    return a ? (a.capabilityFlags & CAPABILITY.pairingWindowOpen) !== 0 : undefined;
  }
}
