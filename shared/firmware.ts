/**
 * Firmware image validator for the TodooCard T3 (Telink TLSR8258 OTA images).
 *
 * This is the safety guard in front of the flasher. It checks the same things
 * the card checks before it activates an image, plus one thing the card does
 * NOT check: the link layer's empty-packet template at the end of `.data`.
 * Legacy images 1.0.4-1.0.10 ship that template as `02000000 ffffffff` instead
 * of `02000000 01000000`; a card running such a build cannot be held in a
 * connection by any standard Bluetooth controller, so it can never be flashed
 * again from a phone or a browser.
 *
 * Pure TypeScript: no DOM, no Node APIs (SHA-256 is implemented here so the
 * report is synchronous and identical on both sides).
 */
import { crc32, storedCrc32 } from './ota.js';

/** Nothing below this build is offered or accepted by the flasher. */
export const MIN_FLASHABLE_VERSION = 185;

export const FIRMWARE_SIZE_MIN_EXCLUSIVE = 0x3fff;
export const FIRMWARE_SIZE_MAX = 0x1f000;

/** "KNLT" at offset 8. */
const MAGIC = [0x4b, 0x4e, 0x4c, 0x54];
const TEMPLATE_GOOD = [0x02, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00];
const TEMPLATE_BAD = [0x02, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff];
/** How many bytes before the CRC32 trailer are searched for the template. */
const TEMPLATE_WINDOW = 32;

export interface KnownFirmware {
  label: string;
  /** Firmware build number (the byte the card advertises); null for legacy 1.0.x images. */
  version: number | null;
  /** Pre-secure 1.0.x line: never flash. */
  legacy: boolean;
}

/** Images identified by sha256. Legacy entries exist only so they can be named and refused. */
export const KNOWN_FIRMWARE: Readonly<Record<string, KnownFirmware>> = {
  d39529b935c779bc85a1a9781564a9de9990a7acf7c22b8472748aef7d74358d: { label: 'TodooCard T3 v187', version: 187, legacy: false },
  '6a6ed8b20eb7bce6fed426d3f78aa246686bc2bad1e1234e1cf0819d388fd62e': { label: 'TodooCard T3 v185', version: 185, legacy: false },
  a1dcc0f52416190c072f8008162f03a47d7a1ff9c6ffd1068c9f7a8b88828eb2: { label: 'T3 1.0.2 (legacy)', version: null, legacy: true },
  a8800ffabfa10422c84effdb88e232b315b6970db8fe0e6469703c7cbf2e5f36: { label: 'T3 1.0.3 (legacy)', version: null, legacy: true },
  b305ec7fe092b60e0f1a0bfc91e68948050028d70eb2d3f59eba642cbfdf7bc1: { label: 'T3 1.0.4 (legacy)', version: null, legacy: true },
  '05092f37da2e9f8697fdf08a0047cae5649c6290963adcfff12100a154154e38': { label: 'T3 1.0.5 (legacy)', version: null, legacy: true },
  '3e01034c8a0da3eb4b4dd441866468c2596e9e2dd31465f62d4f3b6bdd62147c': { label: 'T3 1.0.6 (legacy)', version: null, legacy: true },
  d45c5ad4e3617c8c4ca9968d53db79d6c705f5bebae7f96f3d21ae1741923568: { label: 'T3 1.0.7 (legacy)', version: null, legacy: true },
  '9b995cc7a09de85b5791893638edaa494e40d8dec7f173217b57ac0aa173b825': { label: 'T3 1.0.8 (legacy)', version: null, legacy: true },
  d165e6eefbb9337e945865a3ee76b72868e244f19f735b682124495ec6df4a82: { label: 'T3 1.0.9 (legacy)', version: null, legacy: true },
  e03a253f05a78baf6b4251bafe20b912cab58d9ea7f572f9c0d68aa6c4c4a37c: { label: 'T3 1.0.10 (legacy)', version: null, legacy: true },
};

export type FirmwareProblemCode =
  | 'too-short'
  | 'magic'
  | 'declared-size'
  | 'size-range'
  | 'size-alignment'
  | 'crc32'
  | 'template-defect'
  | 'template-missing';

export interface FirmwareProblem {
  code: FirmwareProblemCode;
  /** Plain-language explanation, safe to show to a user. */
  message: string;
}

/**
 * - `ok`: `02 00 00 00 01 00 00 00` found (empty PDU header LLID 1, length 0).
 * - `defect`: `02 00 00 00 ff ff ff ff` found instead: the known unconnectable build.
 * - `missing`: neither found; the image cannot be confirmed safe.
 */
export type EmptyPacketTemplate = 'ok' | 'defect' | 'missing';

export interface FirmwareReport {
  length: number;
  sha256: string;
  /** "KNLT" at offset 8. */
  magicOk: boolean;
  /** u32 LE at 0x18, or null when the file is too short to have one. */
  declaredSize: number | null;
  declaredSizeMatches: boolean;
  /** size > 0x3fff and <= 0x1f000. */
  sizeInRange: boolean;
  /** size & 0xf == 4. */
  sizeAligned: boolean;
  /** Little-endian CRC32 trailer (last four bytes), or null when too short. */
  storedCrc32: number | null;
  /** crc32 over the whole file; a valid image gives 0xFFFFFFFF. */
  crc32Residue: number;
  crcOk: boolean;
  emptyPacketTemplate: EmptyPacketTemplate;
  /** Set when the sha256 matches an image we know. */
  known: KnownFirmware | null;
  /** Firmware build number derived from the image (known hash, else the embedded revision string). */
  version: number | null;
  versionSource: 'known-hash' | 'embedded-string' | null;
  /** `fw=1.0.x` identity string of the legacy line, when present (unreliable: several builds reuse one). */
  legacyVersionString: string | null;
  legacy: boolean;
  problems: FirmwareProblem[];
  /** Every structural rule passes and the empty-packet template is intact. */
  valid: boolean;
  /** `valid`, not legacy, and the derived version is at least MIN_FLASHABLE_VERSION. */
  flashable: boolean;
}

// ---------------------------------------------------------------- SHA-256 --

function isPrime(n: number): boolean {
  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
  return true;
}

/** First 32 bits of the fractional part of `root(prime)` for the first `count` primes. */
function fractionalRoots(count: number, root: (n: number) => number): Uint32Array {
  const out = new Uint32Array(count);
  let n = 2;
  for (let i = 0; i < count; n++) {
    if (!isPrime(n)) continue;
    const r = root(n);
    out[i++] = Math.floor((r - Math.floor(r)) * 0x100000000);
  }
  return out;
}

const SHA_K = fractionalRoots(64, Math.cbrt);
const SHA_H0 = fractionalRoots(8, Math.sqrt);

export function sha256Hex(data: Uint8Array): string {
  const h = new Uint32Array(SHA_H0);
  const bitLen = data.length * 8;
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA_K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}

// -------------------------------------------------------------- inspection --

function indexOfSeq(haystack: Uint8Array, needle: number[], from: number, to: number): number {
  for (let i = Math.max(0, from); i + needle.length <= to; i++) {
    let hit = true;
    for (let k = 0; k < needle.length; k++) {
      if (haystack[i + k] !== needle[k]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

/** Check the link layer's idle-packet template in the bytes just before the CRC32 trailer. */
export function checkEmptyPacketTemplate(bytes: Uint8Array): EmptyPacketTemplate {
  const end = bytes.length - 4;
  const start = end - TEMPLATE_WINDOW;
  if (end < TEMPLATE_GOOD.length) return 'missing';
  if (indexOfSeq(bytes, TEMPLATE_GOOD, start, end) >= 0) return 'ok';
  if (indexOfSeq(bytes, TEMPLATE_BAD, start, end) >= 0) return 'defect';
  return 'missing';
}

const isHexUpper = (b: number) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46);
const isAlnum = (b: number) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);

/**
 * Modern images carry the Device Information firmware revision as a
 * NUL-terminated ASCII string like "0xBB". Returns the build number when the
 * image contains exactly one such value.
 */
export function findEmbeddedVersion(bytes: Uint8Array): number | null {
  const found = new Set<number>();
  for (let i = 0; i + 5 <= bytes.length; i++) {
    if (bytes[i] !== 0x30 || bytes[i + 1] !== 0x78) continue; // "0x"
    if (!isHexUpper(bytes[i + 2]) || !isHexUpper(bytes[i + 3]) || bytes[i + 4] !== 0) continue;
    if (i > 0 && isAlnum(bytes[i - 1])) continue;
    found.add(parseInt(String.fromCharCode(bytes[i + 2], bytes[i + 3]), 16));
  }
  return found.size === 1 ? [...found][0] : null;
}

/** Legacy 1.0.x images carry `model=T3;fw=1.0.x;lcd=0x134C`. Returns the `1.0.x` part. */
export function findLegacyVersionString(bytes: Uint8Array): string | null {
  const needle = [0x3b, 0x66, 0x77, 0x3d]; // ";fw="
  const at = indexOfSeq(bytes, needle, 0, bytes.length);
  if (at < 0) return null;
  let s = '';
  for (let i = at + needle.length; i < bytes.length && s.length < 12; i++) {
    const b = bytes[i];
    if (!((b >= 0x30 && b <= 0x39) || b === 0x2e)) break;
    s += String.fromCharCode(b);
  }
  return s || null;
}

const hex32 = (n: number) => '0x' + (n >>> 0).toString(16).padStart(8, '0');

export function inspectFirmware(bytes: Uint8Array): FirmwareReport {
  const problems: FirmwareProblem[] = [];
  const length = bytes.length;
  const sha256 = sha256Hex(bytes);
  const known = KNOWN_FIRMWARE[sha256] ?? null;

  const hasHeader = length >= 0x1c;
  if (!hasHeader) problems.push({ code: 'too-short', message: `The file is only ${length} bytes; a firmware image is at least 16 KB.` });

  const magicOk = hasHeader && MAGIC.every((b, i) => bytes[8 + i] === b);
  if (hasHeader && !magicOk) problems.push({ code: 'magic', message: 'The "KNLT" marker at offset 8 is missing. This is not a Telink firmware image.' });

  const declaredSize = hasHeader ? (bytes[0x18] | (bytes[0x19] << 8) | (bytes[0x1a] << 16) | (bytes[0x1b] << 24)) >>> 0 : null;
  const declaredSizeMatches = declaredSize !== null && declaredSize === length;
  if (declaredSize !== null && !declaredSizeMatches) {
    problems.push({
      code: 'declared-size',
      message: `The header declares ${declaredSize} bytes but the file is ${length} bytes. The file is truncated, padded or not a firmware image.`,
    });
  }

  const sizeInRange = length > FIRMWARE_SIZE_MIN_EXCLUSIVE && length <= FIRMWARE_SIZE_MAX;
  if (hasHeader && !sizeInRange) {
    problems.push({
      code: 'size-range',
      message: `The size (${length} bytes) is outside what the card accepts (more than ${FIRMWARE_SIZE_MIN_EXCLUSIVE} and at most ${FIRMWARE_SIZE_MAX} bytes).`,
    });
  }
  const sizeAligned = (length & 0xf) === 4;
  if (hasHeader && !sizeAligned) {
    problems.push({ code: 'size-alignment', message: `The size (${length} bytes) does not end on the boundary the card requires (size mod 16 must be 4).` });
  }

  const crc32Residue = crc32(bytes);
  const crcOk = length >= 4 && crc32Residue === 0xffffffff;
  if (hasHeader && !crcOk) {
    problems.push({ code: 'crc32', message: `The checksum does not add up (CRC32 over the file is ${hex32(crc32Residue)}, expected 0xffffffff). The file is corrupted.` });
  }

  const emptyPacketTemplate = hasHeader ? checkEmptyPacketTemplate(bytes) : 'missing';
  if (hasHeader && emptyPacketTemplate === 'defect') {
    problems.push({
      code: 'template-defect',
      message:
        'This build cannot hold a Bluetooth connection — do not flash. Its link-layer idle packet is damaged (the known defect of legacy images 1.0.4–1.0.10); a card running it cannot be reached again from a phone or a browser.',
    });
  } else if (hasHeader && emptyPacketTemplate === 'missing') {
    problems.push({
      code: 'template-missing',
      message: 'The link-layer idle-packet template was not found where a good image has it, so this build cannot be confirmed able to hold a Bluetooth connection.',
    });
  }

  const legacyVersionString = findLegacyVersionString(bytes);
  const legacy = known?.legacy === true || legacyVersionString !== null;

  let version: number | null = null;
  let versionSource: FirmwareReport['versionSource'] = null;
  if (known && known.version !== null) {
    version = known.version;
    versionSource = 'known-hash';
  } else if (!legacy) {
    const embedded = findEmbeddedVersion(bytes);
    if (embedded !== null) {
      version = embedded;
      versionSource = 'embedded-string';
    }
  }

  const valid = problems.length === 0;
  return {
    length,
    sha256,
    magicOk,
    declaredSize,
    declaredSizeMatches,
    sizeInRange,
    sizeAligned,
    storedCrc32: length >= 4 ? storedCrc32(bytes) : null,
    crc32Residue,
    crcOk,
    emptyPacketTemplate,
    known,
    version,
    versionSource,
    legacyVersionString,
    legacy,
    problems,
    valid,
    flashable: valid && !legacy && version !== null && version >= MIN_FLASHABLE_VERSION,
  };
}

export interface FlashVerdict {
  ok: boolean;
  /** Build number the flasher will treat the image as (null when refused before it is known). */
  version: number | null;
  /** Why the image is refused, or a one-line summary when accepted. */
  message: string;
}

/**
 * The flasher's gate. `expectedVersion` is the build number a trusted catalog
 * (bundled manifest or the vendor update service) claims for the image: it is
 * cross-checked against the derived version and used only when the image
 * itself yields none.
 */
export function flashVerdict(report: FirmwareReport, opts: { expectedVersion?: number } = {}): FlashVerdict {
  const refuse = (message: string, version: number | null = null): FlashVerdict => ({ ok: false, version, message: `Refusing to flash: ${message}` });
  if (!report.valid) return refuse(report.problems.map((p) => p.message).join(' '));
  if (report.legacy) {
    return refuse(
      `this is a legacy 1.0.x image${report.known ? ` (${report.known.label})` : ''}. Nothing below v${MIN_FLASHABLE_VERSION} is flashed: the 1.0.x line has no pairing and no recovery channel, and builds 1.0.4–1.0.10 cannot hold a Bluetooth connection.`,
    );
  }
  const expected = opts.expectedVersion !== undefined && opts.expectedVersion > 0 ? opts.expectedVersion : null;
  if (report.version !== null && expected !== null && report.version !== expected) {
    return refuse(`the image identifies itself as v${report.version} but was offered as v${expected}.`, report.version);
  }
  const version = report.version ?? expected;
  if (version === null) return refuse(`the firmware version of this image could not be determined, so it cannot be confirmed to be v${MIN_FLASHABLE_VERSION} or newer.`);
  if (version < MIN_FLASHABLE_VERSION) {
    return refuse(`this image is v${version}. Nothing below v${MIN_FLASHABLE_VERSION} is flashed (older builds are not known to be recoverable).`, version);
  }
  return { ok: true, version, message: `Image validated: v${version}, ${report.length} bytes, sha256 ${report.sha256.slice(0, 12)}…` };
}

/** Plain-language lines for a report (used by the firmware file checker). */
export function describeFirmwareReport(report: FirmwareReport): string[] {
  const lines: string[] = [];
  if (report.known) lines.push(`Recognised image: ${report.known.label}.`);
  else if (report.version !== null) lines.push(`Not one of the images this app knows by hash; it identifies itself as v${report.version}.`);
  else if (report.legacyVersionString) lines.push(`Not known by hash; it carries the legacy identity string fw=${report.legacyVersionString}.`);
  else lines.push('Not one of the images this app knows, and no version could be read from it.');
  if (report.valid) lines.push('Structure is what the card accepts: KNLT marker, declared size, size rules and CRC32 all pass, and the link-layer idle-packet template is intact.');
  for (const p of report.problems) lines.push(p.message);
  const verdict = flashVerdict(report);
  lines.push(verdict.ok ? `This app would accept it for flashing (v${verdict.version}).` : report.valid ? verdict.message : 'This app refuses to flash it.');
  return lines;
}
