/**
 * Server-side proxy for the vendor firmware update service (cam-api.todoo.tech).
 *
 * The browser can't call it directly (CORS; it's a China-hosted third party), so
 * the web app goes through here. Everything is host-locked to the vendor origin,
 * uses no redirects, and is size/time-capped — the client never supplies a URL,
 * only a validated release id, so there is no SSRF surface.
 */
import type { FirmwareCheckResponse, VendorRelease } from '../shared/api.js';
import { FIRMWARE_SIZE_MAX, FIRMWARE_SIZE_MIN_EXCLUSIVE, MIN_FLASHABLE_VERSION } from '../shared/firmware.js';

const VENDOR_ORIGIN = 'https://cam-api.todoo.tech';
const CHECK_TIMEOUT_MS = 20000;
const ARTIFACT_TIMEOUT_MS = 60000;
const JSON_MAX = 64 * 1024;
const ARTIFACT_MAX = 600 * 1024; // firmware (<512 KB) or the small proof JSON
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

async function vendorGet(url: string, accept: string, maxBytes: number, timeoutMs: number): Promise<{ bytes: Uint8Array; contentType: string }> {
  // Only ever fetch our own constructed vendor URLs.
  if (!url.startsWith(VENDOR_ORIGIN + '/')) throw new Error('refusing non-vendor URL');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept }, redirect: 'manual', signal: ac.signal });
    if (res.status < 200 || res.status >= 300) throw new Error(`vendor returned HTTP ${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) {
      const b = new Uint8Array(await res.arrayBuffer());
      if (b.length > maxBytes) throw new Error('vendor response exceeds limit');
      return { bytes: b, contentType: res.headers.get('content-type') ?? accept };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('vendor response exceeds limit');
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const ch of chunks) {
      out.set(ch, off);
      off += ch.length;
    }
    return { bytes: out, contentType: res.headers.get('content-type') ?? accept };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRelease(r: Record<string, unknown>): VendorRelease | null {
  const num = (v: unknown) => (typeof v === 'number' ? v : NaN);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const id = str(r.id);
  const model = str(r.model);
  const rawType = num(r.raw_type);
  const buildNumber = num(r.build_number);
  const version = str(r.version);
  const sizeBytes = num(r.size_bytes);
  const sha256 = str(r.sha256).toLowerCase();
  const storedCrc32 = str(r.stored_crc32).toLowerCase();
  // Validate the same way the vendor app does before trusting it.
  if (
    !ID_RE.test(id) ||
    model !== 'T3' ||
    rawType !== 4940 ||
    // Catalog policy: never relay a release below v185 (older lines are not
    // known to be recoverable; legacy 1.0.4–1.0.10 cannot hold a connection).
    !(buildNumber >= MIN_FLASHABLE_VERSION && buildNumber < 256) ||
    version !== `v${buildNumber}` ||
    // Same bounds the card enforces on an OTA image.
    !(sizeBytes > FIRMWARE_SIZE_MIN_EXCLUSIVE && sizeBytes <= FIRMWARE_SIZE_MAX && (sizeBytes & 0xf) === 4) ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    !/^0x[0-9a-f]{8}$/.test(storedCrc32)
  ) {
    return null;
  }
  return {
    id,
    model,
    rawType,
    channel: str(r.channel) || 'stable',
    version,
    buildNumber,
    mandatory: r.mandatory === true,
    releaseNotes: str(r.release_notes),
    publishedAt: str(r.published_at) || undefined,
    sizeBytes,
    sha256,
    storedCrc32,
  };
}

export async function checkFirmware(currentBuild: number, recovery: boolean): Promise<FirmwareCheckResponse> {
  const cb = Number.isFinite(currentBuild) && currentBuild > 0 ? Math.floor(currentBuild) : 0;
  const url = `${VENDOR_ORIGIN}/api/v1/updates/firmware?model=T3&current_build=${cb}&channel=stable&recovery=${recovery ? 'true' : 'false'}`;
  const { bytes } = await vendorGet(url, 'application/json', JSON_MAX, CHECK_TIMEOUT_MS);
  const j = JSON.parse(new TextDecoder().decode(bytes)) as { update_available?: boolean; release?: Record<string, unknown> };
  if (!j.update_available || !j.release) return { update_available: false, release: null };
  const release = normalizeRelease(j.release);
  if (!release) return { update_available: false, release: null };
  return { update_available: true, release };
}

/** Fetch a release artifact (the firmware binary or its recovery proof) by validated id. */
export async function fetchArtifact(id: string, kind: 'download' | 'proof'): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (!ID_RE.test(id)) throw new Error('invalid firmware id');
  const url = `${VENDOR_ORIGIN}/api/v1/updates/firmware/${id}/${kind}`;
  return vendorGet(url, 'application/octet-stream, application/json', ARTIFACT_MAX, ARTIFACT_TIMEOUT_MS);
}
