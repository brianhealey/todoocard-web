import { describe, expect, it } from 'vitest';
import { decodeManufacturerData, describeAdvertisement, gattName, parseManufacturerData, parseManufacturerHex, shortUuid } from '../shared/protocol';
import { buildDiagnostics, diagnosticsFileName } from '../web/src/lib/diagnostics';
import { mergeCatalog, vendorReleaseToEntry, type FirmwareEntry } from '../web/src/lib/firmware';

const decodeHex = (text: string) => {
  const p = parseManufacturerHex(text);
  if ('error' in p) throw new Error(p.error);
  return { ...p, decoded: decodeManufacturerData(p.bytes)! };
};

describe('advertisement decoder', () => {
  it('accepts the payload with and without the company prefix', () => {
    for (const text of ['53 50 4c 11 b9 01 13', '5053 4c 11 b9 01 13', 'SP 4c 11 b9 01 13', '4c:11:b9:01:13', '0x4c,0x11,0xb9,0x01,0x13', '53504c11b90113']) {
      const { decoded } = decodeHex(text);
      expect(decoded, text).toMatchObject({ companyId: 0x5053, companyIdOk: true, screenType: 0x134c, screenTypeOk: true, firmwareRaw: 185, modern: true, flagsRaw: 0x11 });
      expect(decoded.flags, text).toEqual({ encryptedGatt: true, pairingWindowOpen: false, fullMac: false, otaRecovery: false, turboLink: true, unknownBits: 0 });
    }
    expect(decodeHex('4c 11 b9 01 13').companyIdAdded).toBe(true);
    expect(decodeHex('53 50 4c 11 b9 01 13').companyIdAdded).toBe(false);
  });

  it('decodes every flag bit and the full device id', () => {
    const { decoded } = decodeHex('SP 4c 0f bb 01 13 ff ff 99 80 68 05');
    expect(decoded.firmwareRaw).toBe(187);
    expect(decoded.flags).toMatchObject({ encryptedGatt: true, pairingWindowOpen: true, fullMac: true, otaRecovery: true, turboLink: false });
    expect(decoded.deviceId).toBe('FF:FF:99:80:68:05');
    expect(decodeHex('SP 4c 91 bb 01 13').decoded.flags!.unknownBits).toBe(0x80);
  });

  it('uses the below-v140 layout: byte 3 is a battery reading, never flags', () => {
    // Legacy 1.0.10: firmware byte 0x81 (129), identity "T3" 1.0.10.
    const { decoded } = decodeHex('SP 4c 1f 81 01 13 54 33 01 00 0a');
    expect(decoded).toMatchObject({ firmwareRaw: 129, modern: false, batteryRaw: 0x1f, batteryVolts: 3.1, productModel: 'T3', semanticVersion: '1.0.10' });
    expect(decoded.flags).toBeUndefined();
    // 0x1f would read as "all flags set" under the modern layout; the summary must not claim any.
    const summary = describeAdvertisement(parseManufacturerData(new Uint8Array([0x4c, 0x1f, 0x81, 0x01, 0x13]), false)!);
    expect(summary).toMatchObject({ secure: false, pairingWindowOpen: false, otaRecovery: false, turboLink: false });
  });

  it('explains input it cannot use', () => {
    expect(parseManufacturerHex('')).toHaveProperty('error');
    expect(parseManufacturerHex('4c 11 b')).toHaveProperty('error');
    expect(parseManufacturerHex('hello')).toHaveProperty('error');
    expect(parseManufacturerHex('4c 11')).toHaveProperty('error');
  });
});

describe('GATT names', () => {
  it('names the services and characteristics a card exposes', () => {
    expect(shortUuid('0000FEF1-0000-1000-8000-00805F9B34FB')).toBe('fef1');
    for (const u of ['fef0', 'fef1', 'fef2', 'fef3', '180f', '2a19', '180a', '2a26']) expect(gattName(`0000${u}-0000-1000-8000-00805f9b34fb`), u).toBeTruthy();
    expect(gattName('00010203-0405-0607-0809-0a0b0c0d1912')).toMatch(/OTA/);
    expect(gattName('00010203-0405-0607-0809-0a0b0c0d2b12')).toMatch(/OTA/);
    expect(gattName('D8B282F0-0F9B-4A7A-B5E8-8E6E5A3C1002')).toMatch(/status/i);
    expect(gattName('d8b282f0-0f9b-4a7a-b5e8-8e6e5a3c1003')).toMatch(/ACK/);
    expect(gattName('12345678-0000-1000-8000-00805f9b34fb')).toBeUndefined();
  });
});

const entry = (version: number, sha: string, extra: Partial<FirmwareEntry> = {}): FirmwareEntry => ({
  id: `TodooCard-T3-v${version}.bin`,
  label: `TodooCard T3 v${version}`,
  version: `v${version}`,
  buildNumber: version,
  channel: 'current',
  latest: false,
  source: 'bundled',
  file: `firmware/TodooCard-T3-v${version}.bin`,
  size: 98932,
  sha256: sha,
  storedCrc32: '0x00000000',
  releaseNotes: '',
  model: 'T3',
  rawType: 4940,
  ...extra,
});
const vendor = (buildNumber: number, sha256: string) =>
  vendorReleaseToEntry({ id: `t3-v${buildNumber}-stable`, model: 'T3', rawType: 4940, channel: 'stable', version: `v${buildNumber}`, buildNumber, mandatory: false, releaseNotes: '', sizeBytes: 98932, sha256, storedCrc32: '0x00000000' });

describe('catalog merge', () => {
  const bundled = [entry(187, 'aa', { latest: true }), entry(185, 'bb')];
  const latestOf = (c: FirmwareEntry[]) => c.filter((e) => e.latest).map((e) => e.version);

  it('keeps bundled v187 as latest while the vendor service still reports v185', () => {
    const c = mergeCatalog(bundled, vendor(185, 'BB'));
    expect(c.map((e) => [e.version, e.source])).toEqual([['v187', 'bundled'], ['v185', 'bundled']]);
    expect(latestOf(c)).toEqual(['v187']);
    expect(latestOf(mergeCatalog(bundled, null))).toEqual(['v187']);
  });

  it('adds a vendor release we do not bundle and marks the highest build latest', () => {
    const c = mergeCatalog(bundled, vendor(190, 'cc'));
    expect(c.map((e) => e.version)).toEqual(['v190', 'v187', 'v185']);
    expect(latestOf(c)).toEqual(['v190']);
  });

  it('never adds a vendor release below v185', () => {
    expect(mergeCatalog(bundled, vendor(129, 'dd')).map((e) => e.version)).toEqual(['v187', 'v185']);
  });
});

describe('diagnostics file', () => {
  const doc = buildDiagnostics({
    now: new Date('2026-11-20T12:34:56.789Z'),
    app: { version: '0.1.0', commit: 'abc123', apiVersion: '0.1.0' },
    userAgent: 'test-agent',
    capabilities: { webBluetooth: true, secureContext: true, adapterAvailable: true, watchAdvertisements: false, getDevices: false, requestLEScan: false },
    note: 'dropped after two seconds',
    connected: false,
    info: {
      name: 'FFFF99806805',
      id: 'device-id',
      bonded: false,
      firmwareString: '0xB9',
      firmwareRaw: 185,
      snapshots: [{ t: 0, label: 'connect', status: new Uint8Array([1, 2, 0x25]), imageAck: new Uint8Array([0x27, 1]) }],
    },
    advWatch: 'unsupported',
    advWatchError: null,
    advertisements: [{ t: 1000, lastT: 2000, count: 3, name: 'FFFF99806805', rssi: -60, manufacturerData: [{ companyId: 0x5053, hex: '4c 11 b9 01 13' }], serviceUuids: [] }],
    gatt: { t: 3000, services: [{ uuid: 'x', short: 'fef0', name: 'TodooCard image service', characteristics: [] }] },
    batteryRead: null,
    lastLinkMs: 2100,
    log: [{ t: 4000, level: 'warn', msg: 'Disconnected' }],
    catalog: [entry(187, 'aa', { latest: true }), entry(185, 'bb')],
  });

  it('carries every section the troubleshooting tab promises', () => {
    expect(doc.schema).toBe('todoocard-web.diagnostics');
    expect(doc.schemaVersion).toBe(1);
    expect(doc.generatedAt).toBe('2026-11-20T12:34:56.789Z');
    expect(doc.app).toMatchObject({ version: '0.1.0', commit: 'abc123' });
    expect(doc.userAgent).toBe('test-agent');
    expect(doc.bluetooth?.watchAdvertisements).toBe(false);
    expect(doc.whatHappened).toBe('dropped after two seconds');
    expect(doc.device).toMatchObject({ name: 'FFFF99806805', id: 'device-id', firmwareVersion: 185, lastLinkMs: 2100 });
    expect(doc.advertisements.snapshots[0]).toMatchObject({ count: 3, manufacturerData: [{ companyId: '0x5053', hex: '4c 11 b9 01 13' }] });
    expect(doc.gatt?.services).toHaveLength(1);
    expect(doc.diagnostics.snapshots[0]).toEqual({ t: '1970-01-01T00:00:00.000Z', label: 'connect', status: '01 02 25', imageAck: '27 01' });
    expect(doc.eventLog).toEqual([{ t: '1970-01-01T00:00:04.000Z', level: 'warn', msg: 'Disconnected' }]);
    expect(doc.firmwareCatalog.bundled.map((e) => e.version)).toEqual(['v187', 'v185']);
  });

  it('is plain JSON and has no field for settings, tokens or keys', () => {
    const text = JSON.stringify(doc);
    expect(JSON.parse(text)).toEqual(doc);
    expect(text).not.toMatch(/apikey|api_key|providerKeys|appToken|x-app-token|secret|password/i);
  });

  it('names the download with a file-safe timestamp', () => {
    expect(diagnosticsFileName(new Date('2026-11-20T12:34:56.789Z'))).toBe('todoocard-diagnostics-2026-11-20T12-34-56-789Z.json');
  });
});
