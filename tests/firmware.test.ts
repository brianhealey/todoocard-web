import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MIN_FLASHABLE_VERSION, checkEmptyPacketTemplate, describeFirmwareReport, flashVerdict, inspectFirmware, sha256Hex } from '../shared/firmware';
import { crc32 } from '../shared/ota';

const publicDir = fileURLToPath(new URL('../web/public/', import.meta.url));
const firmwareDir = publicDir + 'firmware/';
const load = (name: string) => new Uint8Array(readFileSync(firmwareDir + name));
const v185 = load('TodooCard-T3-v185.bin');
const v187 = load('TodooCard-T3-v187.bin');

/** Rewrite the declared size and the CRC32 trailer so only the intended defect remains. */
function reseal(image: Uint8Array): Uint8Array {
  const out = image.slice();
  const n = out.length;
  new DataView(out.buffer).setUint32(0x18, n, true);
  // The trailer is the CRC register without the final inversion, so that crc32(whole file) == 0xFFFFFFFF.
  new DataView(out.buffer).setUint32(n - 4, (crc32(out.subarray(0, n - 4)) ^ 0xffffffff) >>> 0, true);
  return out;
}
const indexOf = (hay: Uint8Array, needle: number[]) => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
};
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const codes = (r: ReturnType<typeof inspectFirmware>) => r.problems.map((p) => p.code);

describe('sha256 (pure TS)', () => {
  it('matches the standard vectors and node:crypto', () => {
    expect(sha256Hex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(new Uint8Array(ascii('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for (const len of [55, 56, 63, 64, 65, 1000]) {
      const d = Uint8Array.from({ length: len }, (_, i) => (i * 31 + 7) & 0xff);
      expect(sha256Hex(d)).toBe(createHash('sha256').update(d).digest('hex'));
    }
  });
});

describe('firmware validator: bundled images', () => {
  it.each([
    ['v187', v187, 187, 'd39529b935c779bc85a1a9781564a9de9990a7acf7c22b8472748aef7d74358d', 0x613495e1],
    ['v185', v185, 185, '6a6ed8b20eb7bce6fed426d3f78aa246686bc2bad1e1234e1cf0819d388fd62e', 0xaa61e31b],
  ] as const)('%s passes every check and is flashable', (_name, image, version, sha, crc) => {
    const r = inspectFirmware(image);
    expect(r.problems).toEqual([]);
    expect(r).toMatchObject({
      length: 98932,
      sha256: sha,
      magicOk: true,
      declaredSize: 98932,
      declaredSizeMatches: true,
      sizeInRange: true,
      sizeAligned: true,
      storedCrc32: crc,
      crc32Residue: 0xffffffff,
      crcOk: true,
      emptyPacketTemplate: 'ok',
      version,
      versionSource: 'known-hash',
      legacy: false,
      valid: true,
      flashable: true,
    });
    expect(flashVerdict(r, { expectedVersion: version })).toMatchObject({ ok: true, version });
  });

  it('reseal() reproduces the vendor trailer, so the synthetic images below differ only where intended', () => {
    expect(Array.from(reseal(v187))).toEqual(Array.from(v187));
  });
});

describe('firmware validator: defects', () => {
  it('flags the damaged empty-packet template of the unconnectable builds', () => {
    const bad = v187.slice();
    const at = bad.length - 20; // ... 02000000 01000000 ffffffff ffffffff <crc>
    expect(Array.from(bad.subarray(at, at + 8))).toEqual([2, 0, 0, 0, 1, 0, 0, 0]);
    bad.set([0xff, 0xff, 0xff, 0xff], at + 4);
    const r = inspectFirmware(reseal(bad));
    expect(r.crcOk).toBe(true);
    expect(r.emptyPacketTemplate).toBe('defect');
    expect(codes(r)).toEqual(['template-defect']);
    expect(r.valid).toBe(false);
    expect(r.flashable).toBe(false);
    const v = flashVerdict(r, { expectedVersion: 187 });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/cannot hold a Bluetooth connection/);
    expect(describeFirmwareReport(r).join(' ')).toMatch(/do not flash/);
  });

  it('matches the tails recorded for the legacy images', () => {
    const tail = (words: string) => {
      const b = new Uint8Array(64).fill(0xaa);
      const bytes = words.replace(/\s/g, '').match(/../g)!.map((h) => parseInt(h, 16));
      b.set(bytes, 60 - bytes.length); // last four bytes stand in for the CRC trailer
      return b;
    };
    expect(checkEmptyPacketTemplate(tail('02000000 01000000 ffffffff ffffffff'))).toBe('ok'); // 1.0.2, 1.0.3, v185, v187
    expect(checkEmptyPacketTemplate(tail('02000000 ffffffff ffffffff ffffffff'))).toBe('defect'); // 1.0.4
    expect(checkEmptyPacketTemplate(tail('10022002 02000000 ffffffff'))).toBe('defect'); // 1.0.10
    expect(checkEmptyPacketTemplate(tail('00000000 00000000'))).toBe('missing');
  });

  it('refuses an image without a recognisable template', () => {
    const img = v187.slice();
    img.fill(0, img.length - 36, img.length - 4);
    const r = inspectFirmware(reseal(img));
    expect(codes(r)).toEqual(['template-missing']);
    expect(flashVerdict(r).ok).toBe(false);
  });

  it('flags a bad CRC', () => {
    const bad = v187.slice();
    bad[0x4000] ^= 0x01;
    const r = inspectFirmware(bad);
    expect(r.crcOk).toBe(false);
    expect(codes(r)).toEqual(['crc32']);
    expect(flashVerdict(r, { expectedVersion: 187 }).ok).toBe(false);
  });

  it('flags a size the card would refuse (alignment, range, declared length)', () => {
    // Drop 8 bytes of padding before the trailer: size & 0xf becomes 12.
    const misaligned = reseal(new Uint8Array([...v187.subarray(0, v187.length - 12), 0, 0, 0, 0]));
    expect(codes(inspectFirmware(misaligned))).toEqual(['size-alignment']);

    const small = reseal(new Uint8Array([...v187.subarray(0, 0x3ff4 - 20), ...v187.subarray(v187.length - 20)]));
    expect(small.length).toBe(0x3ff4);
    expect(codes(inspectFirmware(small))).toEqual(['size-range']);

    const big = new Uint8Array(0x1f004);
    big.set(v187.subarray(0, v187.length - 20));
    big.set(v187.subarray(v187.length - 20), big.length - 20);
    expect(codes(inspectFirmware(reseal(big)))).toEqual(['size-range']);

    const padded = new Uint8Array(v187.length + 16).fill(0xff);
    padded.set(v187);
    expect(codes(inspectFirmware(padded))).toContain('declared-size');

    expect(codes(inspectFirmware(new Uint8Array(10)))).toEqual(['too-short']);
    const noMagic = v187.slice();
    noMagic[8] = 0;
    expect(codes(inspectFirmware(reseal(noMagic)))).toEqual(['magic']);
  });
});

describe('flash verdict: version floor', () => {
  const revisionAt = indexOf(v187, [...ascii('0xBB'), 0]);
  const withRevision = (s: string) => {
    const img = v187.slice();
    img.set(ascii(s), revisionAt);
    return reseal(img);
  };

  it('finds the embedded revision string', () => {
    expect(revisionAt).toBeGreaterThan(0);
  });

  it('derives the version from an unknown but well-formed image', () => {
    const r = inspectFirmware(withRevision('0xBC'));
    expect(r.known).toBeNull();
    expect(r).toMatchObject({ valid: true, version: 188, versionSource: 'embedded-string', flashable: true });
    expect(flashVerdict(r)).toMatchObject({ ok: true, version: 188 });
    expect(flashVerdict(r, { expectedVersion: 187 }).ok).toBe(false); // offered as something it is not
  });

  it(`refuses a well-formed image below v${MIN_FLASHABLE_VERSION}`, () => {
    const r = inspectFirmware(withRevision('0xB8'));
    expect(r).toMatchObject({ valid: true, version: 184, flashable: false });
    const v = flashVerdict(r);
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/v184/);
  });

  it('refuses when no version can be derived, unless a trusted catalog supplies one', () => {
    const r = inspectFirmware(withRevision('zzzz'));
    expect(r).toMatchObject({ valid: true, version: null, flashable: false });
    expect(flashVerdict(r).ok).toBe(false);
    expect(flashVerdict(r, { expectedVersion: 184 }).ok).toBe(false);
    expect(flashVerdict(r, { expectedVersion: 190 })).toMatchObject({ ok: true, version: 190 });
  });

  it('refuses the legacy 1.0.x line even when the template is intact (1.0.2 / 1.0.3)', () => {
    const img = v187.slice();
    img.set(ascii('model=T3;fw=1.0.3;lcd=0x134C'), 0x9000);
    const r = inspectFirmware(reseal(img));
    expect(r).toMatchObject({ valid: true, legacy: true, legacyVersionString: '1.0.3', version: null, flashable: false });
    expect(flashVerdict(r, { expectedVersion: 187 }).message).toMatch(/legacy 1\.0\.x/);
  });
});

describe('bundled firmware manifest', () => {
  interface Entry {
    id: string;
    version: string;
    buildNumber: number;
    channel: string;
    latest: boolean;
    file: string;
    size: number;
    sha256: string;
    storedCrc32: string;
    proof: string;
    proofSha256: string;
  }
  const manifest = JSON.parse(readFileSync(firmwareDir + 'manifest.json', 'utf8')) as { firmwares: Entry[] };
  const nodeSha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

  it('lists at least one image, exactly one of them latest, and it is the highest build', () => {
    expect(manifest.firmwares.length).toBeGreaterThan(0);
    const latest = manifest.firmwares.filter((e) => e.latest);
    expect(latest).toHaveLength(1);
    expect(latest[0].buildNumber).toBe(Math.max(...manifest.firmwares.map((e) => e.buildNumber)));
    expect(latest[0].version).toBe('v187');
  });

  it(`lists nothing below v${MIN_FLASHABLE_VERSION} and no legacy channel`, () => {
    for (const e of manifest.firmwares) {
      expect(e.version).toBe(`v${e.buildNumber}`);
      expect(e.buildNumber).toBeGreaterThanOrEqual(MIN_FLASHABLE_VERSION);
      expect(e.channel).toBe('current');
    }
  });

  it.each(manifest.firmwares.map((e) => [e.id, e] as const))('%s exists, matches size, sha256 and CRC, and passes the validator', (_id, e) => {
    const path = publicDir + e.file;
    expect(existsSync(path)).toBe(true);
    const bytes = new Uint8Array(readFileSync(path));
    expect(bytes.length).toBe(e.size);
    expect(nodeSha(bytes)).toBe(e.sha256);
    const r = inspectFirmware(bytes);
    expect(r.sha256).toBe(e.sha256);
    expect('0x' + r.storedCrc32!.toString(16).padStart(8, '0')).toBe(e.storedCrc32);
    expect(flashVerdict(r, { expectedVersion: e.buildNumber })).toMatchObject({ ok: true, version: e.buildNumber });
    expect(existsSync(publicDir + e.proof)).toBe(true);
    expect(nodeSha(new Uint8Array(readFileSync(publicDir + e.proof)))).toBe(e.proofSha256);
    expect(e.proof).toContain(e.sha256);
  });

  it('ships no firmware image that the manifest does not list', () => {
    const bins = readdirSync(firmwareDir).filter((f) => f.endsWith('.bin')).sort();
    expect(bins).toEqual(manifest.firmwares.map((e) => e.file.replace(/^firmware\//, '')).sort());
  });
});
