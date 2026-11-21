import type { VendorRelease } from '@shared/api';
import { MIN_FLASHABLE_VERSION } from '@shared/firmware';
import type { Settings } from './settings';
import { fetchVendorArtifact } from './api';

/** A selectable firmware build — from the bundled catalog or the live vendor service. */
export interface FirmwareEntry {
  id: string;
  label: string;
  version: string;
  /** 'current' is bundled; 'vendor' comes live from the update service. */
  channel: 'current' | 'vendor';
  latest: boolean;
  source: 'bundled' | 'vendor';
  /** Bundled: static path under /firmware. Vendor: unused (fetched by id via proxy). */
  file?: string;
  size: number;
  sha256: string;
  storedCrc32: string;
  releaseNotes: string;
  /** English rendering of the vendor's release notes (bundled entries). */
  releaseNotesEn?: string;
  /** Where the bundled image came from. */
  origin?: string;
  /** Recovery proof published with the image (bundled entries). */
  proof?: string;
  proofSha256?: string;
  model: string;
  rawType: number;
  buildNumber?: number;
}

const base = import.meta.env.BASE_URL ?? '/';

/** Build number of an entry: explicit, else parsed from a `v187`-style version. */
export function entryBuildNumber(e: Pick<FirmwareEntry, 'version' | 'buildNumber'>): number {
  if (typeof e.buildNumber === 'number' && e.buildNumber > 0) return e.buildNumber;
  const m = /^v(\d{1,3})$/.exec(e.version);
  return m ? parseInt(m[1], 10) : 0;
}

export async function loadFirmwareCatalog(): Promise<FirmwareEntry[]> {
  const res = await fetch(`${base}firmware/manifest.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`firmware manifest ${res.status}`);
  const data = (await res.json()) as { firmwares: Omit<FirmwareEntry, 'source'>[] };
  // Catalog policy: nothing below v185 is ever offered, whatever the manifest says.
  return data.firmwares.map((e): FirmwareEntry => ({ ...e, channel: 'current', source: 'bundled' })).filter((e) => entryBuildNumber(e) >= MIN_FLASHABLE_VERSION);
}

/** Map a live vendor release into a catalog entry. */
export function vendorReleaseToEntry(r: VendorRelease): FirmwareEntry {
  return {
    id: r.id,
    label: `TodooCard T3 ${r.version} (vendor service)`,
    version: r.version,
    channel: 'vendor',
    latest: false,
    source: 'vendor',
    size: r.sizeBytes,
    sha256: r.sha256,
    storedCrc32: r.storedCrc32,
    releaseNotes: r.releaseNotes || 'Release from the vendor update service.',
    model: r.model,
    rawType: r.rawType,
    buildNumber: r.buildNumber,
  };
}

/**
 * Merge the bundled catalog with the vendor service's answer. A vendor release
 * whose bytes we already bundle (same sha256) adds nothing; a different one is
 * added. Exactly one entry, the highest build, ends up marked latest.
 */
export function mergeCatalog(bundled: FirmwareEntry[], vendor: FirmwareEntry | null): FirmwareEntry[] {
  const all = [...bundled];
  if (vendor && entryBuildNumber(vendor) >= MIN_FLASHABLE_VERSION && !bundled.some((e) => e.sha256.toLowerCase() === vendor.sha256.toLowerCase())) all.push(vendor);
  all.sort((a, b) => entryBuildNumber(b) - entryBuildNumber(a) || (a.source === 'bundled' ? -1 : 1));
  return all.map((e, i) => ({ ...e, latest: i === 0 }));
}

export async function fetchFirmwareBytes(entry: FirmwareEntry, settings: Settings): Promise<Uint8Array> {
  if (entry.source === 'vendor') return fetchVendorArtifact(settings, entry.id, 'download');
  const res = await fetch(`${base}${entry.file}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`firmware ${entry.file} ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
