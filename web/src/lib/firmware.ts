/** Loads the bundled firmware catalog (web/public/firmware/manifest.json). */
export interface FirmwareEntry {
  id: string;
  label: string;
  version: string;
  channel: 'current' | 'legacy';
  latest: boolean;
  file: string;
  size: number;
  sha256: string;
  storedCrc32: string;
  releaseNotes: string;
  model: string;
  rawType: number;
}

const base = import.meta.env.BASE_URL ?? '/';

export async function loadFirmwareCatalog(): Promise<FirmwareEntry[]> {
  const res = await fetch(`${base}firmware/manifest.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`firmware manifest ${res.status}`);
  const data = (await res.json()) as { firmwares: FirmwareEntry[] };
  return data.firmwares;
}

export async function fetchFirmwareBytes(entry: FirmwareEntry): Promise<Uint8Array> {
  const res = await fetch(`${base}${entry.file}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`firmware ${entry.file} ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
