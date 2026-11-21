import { describe, expect, it } from 'vitest';
import { buildDiagnostics, DIAGNOSTICS_LIMITATIONS, type DiagnosticsInput, type GattScan } from '../web/src/lib/diagnostics';
import { GENERIC_MAX_READS, genericDeviceInfo, noServicesMessage, surveyGeneric } from '../web/src/lib/inspect';
import {
  BLOCKLISTED_SERVICES,
  STANDARD_SERVICES,
  TODOOCARD_SERVICES,
  buildRequestedServices,
  canonicalUuid,
  friendlyName,
  looksLikeTodooCard,
  parseUuidList,
  printableText,
  uuidsNamedIn,
} from '../web/src/lib/uuids';

const full = (short: string) => `0000${short}-0000-1000-8000-00805f9b34fb`;
const NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';

describe('extra service UUID box', () => {
  it('accepts 16-bit hex with or without 0x, and 128-bit UUIDs, in any separator mix', () => {
    const p = parseUuidList(`180d, 0x180F\n0XFE95  ${NUS.toUpperCase()};6E400001B5A3F393E0A9E50E24DCCA9F\t0000fe07`);
    expect(p.rejected).toEqual([]);
    expect(p.uuids).toEqual([full('180d'), full('180f'), full('fe95'), NUS, '6e400001-b5a3-f393-e0a9-e50e24dcca9f', full('fe07')]);
  });

  it('removes duplicates across spellings', () => {
    expect(parseUuidList(`180d 0x180D ${full('180d')}`).uuids).toEqual([full('180d')]);
  });

  it('rejects what is not a UUID and says which entries', () => {
    const p = parseUuidList('180d, heart, 18, 0x18000, 12345678-1234-1234-1234-12345678, 180g');
    expect(p.uuids).toEqual([full('180d')]);
    expect(p.rejected.map((r) => r.input)).toEqual(['heart', '18', '0x18000', '12345678-1234-1234-1234-12345678', '180g']);
    for (const r of p.rejected) expect(r.reason).toMatch(/not a UUID/);
  });

  it('rejects blocklisted services with the reason', () => {
    const p = parseUuidList('1812 0xfffd 180d');
    expect(p.uuids).toEqual([full('180d')]);
    expect(p.rejected).toHaveLength(2);
    expect(p.rejected[0]).toMatchObject({ input: '1812', uuid: full('1812') });
    expect(p.rejected[0].reason).toMatch(/blocklist/);
  });

  it('is empty for an empty box', () => {
    expect(parseUuidList('  \n ,, ')).toEqual({ uuids: [], rejected: [] });
  });
});

describe('requested services', () => {
  it('starts with the TodooCard list, adds the standard list and never repeats a UUID', () => {
    const { requested, rejected } = buildRequestedServices('');
    expect(rejected).toEqual([]);
    expect(requested.slice(0, TODOOCARD_SERVICES.length)).toEqual(TODOOCARD_SERVICES);
    expect(new Set(requested).size).toBe(requested.length);
    for (const u of requested) expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    for (const short of ['1800', '1801', '180a', '180f', '1805', '180d', '1809', '1810', '1816', '1818', '181a', '181c', '181d', '1822', '1826', '183b', '1802', '1803', '1804', 'fe59', 'fee0', 'fee7', 'ffe0', 'fff0', 'fef0', 'fdf0']) {
      expect(requested, short).toContain(full(short));
    }
    expect(requested).toContain(NUS);
    expect(requested).toContain('00010203-0405-0607-0809-0a0b0c0d1912');
    expect(requested).toContain('d8b282f0-0f9b-4a7a-b5e8-8e6e5a3c1001');
  });

  it('never asks for a blocklisted service', () => {
    for (const u of Object.keys(BLOCKLISTED_SERVICES)) expect(STANDARD_SERVICES.map((s) => s.uuid)).not.toContain(u);
    const { requested, rejected } = buildRequestedServices('1812, 00001530-1212-efde-1523-785feabcd123, fe95');
    expect(requested).not.toContain(full('1812'));
    expect(requested).not.toContain('00001530-1212-efde-1523-785feabcd123');
    expect(requested[requested.length - 1]).toBe(full('fe95'));
    expect(rejected.map((r) => r.uuid)).toEqual([full('1812'), '00001530-1212-efde-1523-785feabcd123']);
  });

  it('appends user extras once, even when they repeat a built-in', () => {
    const base = buildRequestedServices('').requested;
    const { requested } = buildRequestedServices('180d 0x180d fe95 FE95');
    expect(requested).toEqual([...base, full('fe95')]);
  });

  it('drops what the browser refused and reports it', () => {
    const { requested, rejected } = buildRequestedServices('fe95', [full('fe95'), 0xfee0 as unknown as string]);
    expect(requested).not.toContain(full('fe95'));
    expect(requested).not.toContain(full('fee0'));
    expect(rejected.map((r) => [r.uuid, r.reason])).toEqual([
      [full('fee0'), 'refused by this browser'],
      [full('fe95'), 'refused by this browser'],
    ]);
  });

  it('finds the UUIDs an error message names', () => {
    expect(uuidsNamedIn(`requestDevice() called with blocklisted UUID ${full('1812').toUpperCase()} and 0xFFFD. https://goo.gl/4NeimX`)).toEqual([full('1812'), full('fffd')]);
    expect(uuidsNamedIn('Must be handling a user gesture to show a permission request.')).toEqual([]);
  });

  it('canonicalises numbers and short strings', () => {
    expect(canonicalUuid(0x180d)).toBe(full('180d'));
    expect(canonicalUuid('FEF0')).toBe(full('fef0'));
    expect(canonicalUuid(NUS.toUpperCase())).toBe(NUS);
  });
});

describe('names and TodooCard detection', () => {
  it('names standard services, characteristics and descriptors', () => {
    expect(friendlyName(full('180d'))).toBe('Heart Rate');
    expect(friendlyName(full('2a37'))).toBe('Heart Rate Measurement');
    expect(friendlyName(full('2901'))).toMatch(/User Description/);
    expect(friendlyName(NUS)).toMatch(/Nordic UART/);
    expect(friendlyName('12345678-1234-1234-1234-123456789abc')).toBeUndefined();
  });

  it('warns about pairing on Battery Level only for a TodooCard', () => {
    expect(friendlyName(full('2a19'), true)).toMatch(/pairing/);
    expect(friendlyName(full('2a19'), false)).toBe('Battery Level');
  });

  it('recognises a TodooCard by its image or diagnostics service', () => {
    expect(looksLikeTodooCard([full('180a'), full('fef0')])).toBe(true);
    expect(looksLikeTodooCard([full('fdf0')])).toBe(true);
    expect(looksLikeTodooCard(['D8B282F0-0F9B-4A7A-B5E8-8E6E5A3C1001'])).toBe(true);
    expect(looksLikeTodooCard([full('180a'), full('180f'), NUS])).toBe(false);
  });
});

describe('printable rendering', () => {
  const b = (s: string) => new TextEncoder().encode(s);
  it('renders text, ignoring trailing NULs', () => {
    expect(printableText(b('Polar H10 12345678'))).toBe('Polar H10 12345678');
    expect(printableText(new Uint8Array([0x54, 0x33, 0, 0]))).toBe('T3');
  });
  it('shows stray bytes as dots when the value is mostly text', () => {
    expect(printableText(new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x01]))).toBe('ABCD.');
  });
  it('gives nothing for binary, empty or single-byte values', () => {
    expect(printableText(new Uint8Array([0x01, 0x02, 0x41, 0xff]))).toBeUndefined();
    expect(printableText(new Uint8Array([0x64]))).toBeUndefined();
    expect(printableText(new Uint8Array([]))).toBeUndefined();
    expect(printableText(new Uint8Array([0, 0, 0]))).toBeUndefined();
  });
});

// A scripted GATT server: no Bluetooth involved.
type FakeChar = { uuid: string; props: string[]; value?: number[] | 'hang' | 'fail'; descriptors?: { uuid: string; text?: string }[] };
function fakeServer(services: { uuid: string; chars: FakeChar[] }[] | 'none', opts: { dropAfterReads?: number } = {}) {
  const calls = { reads: [] as string[], writes: 0, notifies: 0 };
  const server = { connected: true } as { connected: boolean; getPrimaryServices: () => Promise<unknown[]> };
  const view = (bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);
  const forbidden = () => {
    calls.writes++;
    return Promise.reject(new Error('the survey must not write'));
  };
  server.getPrimaryServices = async () => {
    if (services === 'none') throw Object.assign(new Error('No Services found in device.'), { name: 'NotFoundError' });
    return services.map((s) => ({
      uuid: s.uuid,
      getCharacteristics: async () =>
        s.chars.map((c) => ({
          uuid: c.uuid,
          properties: Object.fromEntries(c.props.map((p) => [p, true])),
          readValue: () => {
            calls.reads.push(c.uuid);
            if (opts.dropAfterReads !== undefined && calls.reads.length > opts.dropAfterReads) {
              server.connected = false;
              return Promise.reject(Object.assign(new Error('GATT Server is disconnected.'), { name: 'NetworkError' }));
            }
            if (c.value === 'hang') return new Promise<DataView>(() => undefined);
            if (c.value === 'fail') return Promise.reject(new Error('GATT operation not permitted.'));
            return Promise.resolve(view(c.value ?? []));
          },
          writeValue: forbidden,
          writeValueWithResponse: forbidden,
          writeValueWithoutResponse: forbidden,
          startNotifications: () => {
            calls.notifies++;
            return Promise.reject(new Error('the survey must not subscribe'));
          },
          getDescriptors: async () => {
            if (!c.descriptors) throw Object.assign(new Error('No Descriptors found in Characteristic.'), { name: 'NotFoundError' });
            return c.descriptors.map((d) => ({
              uuid: d.uuid,
              readValue: async () => {
                calls.reads.push(d.uuid);
                return view([...new TextEncoder().encode(d.text ?? '')]);
              },
              writeValue: forbidden,
            }));
          },
        })),
    }));
  };
  return { server: server as unknown as BluetoothRemoteGATTServer, calls, raw: server };
}
const run = (f: ReturnType<typeof fakeServer>, extra: Partial<Parameters<typeof surveyGeneric>[0]> = {}) => {
  const log: string[] = [];
  return surveyGeneric({ server: f.server, op: (fn) => fn(), log: (_l, m) => log.push(m), requestedCount: 37, ...extra }).then((scan) => ({ scan, log }));
};

describe('generic survey', () => {
  it('lists everything, reads every readable value as hex and never writes or subscribes', async () => {
    const f = fakeServer([
      {
        uuid: full('180d'),
        chars: [
          { uuid: full('2a37'), props: ['notify'] },
          { uuid: full('2a38'), props: ['read'], value: [1], descriptors: [{ uuid: full('2901'), text: 'Sensor location' }, { uuid: full('2902') }] },
          { uuid: full('2a39'), props: ['write'] },
        ],
      },
      { uuid: full('180f'), chars: [{ uuid: full('2a19'), props: ['read', 'notify'], value: [87] }] },
      { uuid: full('180a'), chars: [{ uuid: full('2a29'), props: ['read'], value: [...new TextEncoder().encode('Polar Electro Oy')] }, { uuid: full('2a25'), props: ['read'], value: 'fail' }] },
    ]);
    const { scan } = await run(f);
    expect(scan.mode).toBe('generic');
    expect(scan.isTodooCard).toBe(false);
    expect(scan.error).toBeUndefined();
    const [hr, batt, dis] = scan.services;
    expect(hr).toMatchObject({ short: '180d', name: 'Heart Rate' });
    expect(hr.characteristics.map((c) => [c.short, c.properties, c.valueHex])).toEqual([
      ['2a37', ['notify'], undefined],
      ['2a38', ['read'], '01'],
      ['2a39', ['write'], undefined],
    ]);
    expect(hr.characteristics[1].descriptors).toEqual([
      { uuid: full('2901'), short: '2901', name: 'Characteristic User Description', valueText: 'Sensor location' },
      { uuid: full('2902'), short: '2902', name: 'Client Characteristic Configuration' },
    ]);
    // Battery Level is read on a device that is not a TodooCard.
    expect(batt.characteristics[0]).toMatchObject({ name: 'Battery Level', valueHex: '57' });
    expect(dis.characteristics[0]).toMatchObject({ valueHex: '50 6f 6c 61 72 20 45 6c 65 63 74 72 6f 20 4f 79', valueText: 'Polar Electro Oy' });
    expect(dis.characteristics[1].error).toMatch(/not permitted/);
    expect(dis.characteristics[1].note).toMatch(/serial number/);
    expect(scan.readCount).toBe(5);
    expect(f.calls.writes).toBe(0);
    expect(f.calls.notifies).toBe(0);
  });

  it('does not read Battery Level on a TodooCard, and still decodes its diagnostics records', async () => {
    const status = new Array(22).fill(0);
    const f = fakeServer([
      { uuid: full('fef0'), chars: [{ uuid: full('fef1'), props: ['write', 'notify'] }] },
      { uuid: full('180f'), chars: [{ uuid: full('2a19'), props: ['read', 'notify'], value: [50] }] },
      {
        uuid: 'd8b282f0-0f9b-4a7a-b5e8-8e6e5a3c1001',
        chars: [
          { uuid: 'd8b282f0-0f9b-4a7a-b5e8-8e6e5a3c1002', props: ['read'], value: status },
          { uuid: 'd8b282f0-0f9b-4a7a-b5e8-8e6e5a3c1003', props: ['read'], value: [0x27, 0x01, 0, 0, 3, 0, 3, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 0] },
        ],
      },
    ]);
    const { scan } = await run(f);
    expect(scan.isTodooCard).toBe(true);
    expect(f.calls.reads).not.toContain(full('2a19'));
    expect(scan.services[1].characteristics[0].note).toMatch(/pairing/);
    expect(scan.services[1].characteristics[0].valueHex).toBeUndefined();
    expect(scan.services[2].characteristics[0].valueHex).toBe(status.map(() => '00').join(' '));
    expect(scan.statusRecord).toMatchObject({ eventCounter: 0 });
    expect(scan.imageAck).toMatchObject({ generated: 3, accepted: 3, lastReceivedBlock: 7 });
  });

  it('explains a device with none of the requested services', async () => {
    const { scan, log } = await run(fakeServer('none'));
    expect(scan.noServices).toBe(true);
    expect(scan.error).toBe(noServicesMessage(37));
    expect(scan.error).toMatch(/none of the 37 requested services are present/);
    expect(log.join('\n')).toMatch(/none of the 37 requested services/);
  });

  it('keeps what was read when the device drops mid-survey', async () => {
    const chars = ['2a00', '2a01', '2a04', '2aa6'].map((u) => ({ uuid: full(u), props: ['read'], value: [1, 2] }));
    const f = fakeServer([{ uuid: full('1800'), chars }], { dropAfterReads: 2 });
    const { scan, log } = await run(f);
    expect(scan.disconnected).toBe(true);
    expect(scan.error).toMatch(/disconnected/);
    const c = scan.services[0].characteristics;
    expect(c.map((x) => x.valueHex)).toEqual(['01 02', '01 02', undefined, undefined]);
    expect(c[3].note).toMatch(/disconnected/);
    expect(f.calls.reads).toHaveLength(3); // nothing attempted after the drop
    expect(log.join('\n')).toMatch(/disconnected/);
  });

  it('caps the number of reads', async () => {
    const chars = Array.from({ length: 8 }, (_, i) => ({ uuid: full((0x2b00 + i).toString(16)), props: ['read'], value: [i] }));
    const f = fakeServer([{ uuid: full('fee0'), chars }]);
    const { scan } = await run(f, { maxReads: 5 });
    expect(GENERIC_MAX_READS).toBe(200);
    expect(f.calls.reads).toHaveLength(5);
    expect(scan.truncated).toBe(true);
    expect(scan.notes?.join(' ')).toMatch(/after 5 reads/);
    expect(scan.services[0].characteristics).toHaveLength(8);
    expect(scan.services[0].characteristics[7].note).toMatch(/limit/);
  });

  it('times out a read that never answers and stops when the device stays silent', async () => {
    const chars = Array.from({ length: 6 }, (_, i) => ({ uuid: full((0x2b00 + i).toString(16)), props: ['read'], value: 'hang' as const }));
    const f = fakeServer([{ uuid: full('fee0'), chars }]);
    const { scan } = await run(f, { readTimeoutMs: 10 });
    const c = scan.services[0].characteristics;
    expect(c[0].error).toMatch(/timed out/);
    expect(f.calls.reads).toHaveLength(3);
    expect(scan.truncated).toBe(true);
    expect(c[5].note).toMatch(/stopped answering/);
  });
});

describe('diagnostics file, schema v2', () => {
  const base: DiagnosticsInput = {
    now: new Date('2026-11-20T12:34:56.789Z'),
    app: { version: '0.1.0', commit: 'abc123' },
    userAgent: 'test-agent',
    capabilities: null,
    note: '',
    connected: true,
    info: { name: 'FFFF99806805', id: 'card-id', bonded: false, firmwareRaw: 187 },
    advWatch: 'unsupported',
    advWatchError: null,
    advertisements: [],
    gatt: { t: 3000, services: [{ uuid: full('fef0'), short: 'fef0', name: 'TodooCard image service', characteristics: [] }] },
    batteryRead: null,
    lastLinkMs: null,
    log: [],
    catalog: [],
  };
  const V1_KEYS = ['schema', 'schemaVersion', 'generatedAt', 'app', 'userAgent', 'bluetooth', 'whatHappened', 'device', 'advertisements', 'gatt', 'values', 'diagnostics', 'eventLog', 'firmwareCatalog'];

  it('TodooCard mode: v2 fields added, every v1 field kept', () => {
    const doc = buildDiagnostics(base);
    expect(doc.schemaVersion).toBe(2);
    expect(doc.mode).toBe('todoocard');
    for (const k of V1_KEYS) expect(doc, k).toHaveProperty(k);
    expect(doc.requestedServices).toEqual(TODOOCARD_SERVICES);
    expect(doc.rejectedServices).toEqual([]);
    expect(doc.limitations).toEqual(DIAGNOSTICS_LIMITATIONS);
    expect(doc.limitations.join(' ')).toMatch(/not requested/);
    expect(doc.limitations.join(' ')).toMatch(/Serial Number/);
    expect(doc.limitations.join(' ')).toMatch(/enable-experimental-web-platform-features/);
    expect(doc.gatt).toMatchObject({ readAt: '1970-01-01T00:00:03.000Z', error: null, survey: 'todoocard' });
    expect(doc.gatt?.services).toHaveLength(1);
    expect(Object.keys(doc.device!)).toEqual(expect.arrayContaining(['name', 'id', 'connected', 'encryptedLinkVerified', 'serial', 'serialNote', 'firmwareVersion', 'battery', 'flags', 'lastLinkMs']));
  });

  it('generic mode: requested and rejected lists, descriptors and raw reads', () => {
    const { requested, rejected } = buildRequestedServices('1812 fe95 nonsense');
    const gatt: GattScan = {
      t: 5000,
      mode: 'generic',
      isTodooCard: false,
      readCount: 2,
      notes: [],
      services: [
        {
          uuid: full('180a'),
          short: '180a',
          name: 'Device Information',
          characteristics: [
            { uuid: full('2a29'), short: '2a29', name: 'Manufacturer Name', properties: ['read'], valueHex: '50 6f 6c 61 72', valueText: 'Polar' },
            { uuid: full('2a24'), short: '2a24', name: 'Model Number', properties: ['read'], valueHex: '48 31 30', valueText: 'H10', descriptors: [{ uuid: full('2901'), short: '2901', valueText: 'Model' }] },
          ],
        },
      ],
    };
    const info = genericDeviceInfo({ name: 'Polar H10', id: 'generic-id' }, gatt);
    expect(info).toMatchObject({ name: 'Polar H10', id: 'generic-id', manufacturer: 'Polar', model: 'H10', bonded: false });
    expect(info.firmwareRaw).toBeUndefined();
    const doc = buildDiagnostics({ ...base, mode: 'generic', info, gatt, requestedServices: requested, rejectedServices: rejected });
    expect(doc.schemaVersion).toBe(2);
    expect(doc.mode).toBe('generic');
    for (const k of V1_KEYS) expect(doc, k).toHaveProperty(k);
    expect(doc.requestedServices).toContain(full('fe95'));
    expect(doc.requestedServices).toContain(full('180d'));
    expect(doc.requestedServices).not.toContain(full('1812'));
    expect(doc.rejectedServices.map((r) => r.input)).toEqual(['1812', 'nonsense']);
    expect(doc.rejectedServices[1]).toMatchObject({ uuid: null });
    expect(doc.device).toMatchObject({ name: 'Polar H10', manufacturer: 'Polar', model: 'H10', firmwareVersion: null });
    expect(doc.gatt).toMatchObject({ survey: 'generic', isTodooCard: false, readCount: 2, truncated: false, disconnectedDuringSurvey: false, noRequestedServicesPresent: false });
    expect(doc.gatt?.services[0].characteristics[0]).toMatchObject({ valueHex: '50 6f 6c 61 72', valueText: 'Polar' });
    expect(doc.gatt?.services[0].characteristics[1].descriptors).toEqual([{ uuid: full('2901'), short: '2901', valueText: 'Model' }]);
    expect(doc.limitations.length).toBeGreaterThanOrEqual(3);
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });
});
