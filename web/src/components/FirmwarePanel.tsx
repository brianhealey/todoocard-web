import { useEffect, useMemo, useRef, useState } from 'react';
import { MIN_FLASHABLE_VERSION, flashVerdict, inspectFirmware } from '@shared/firmware';
import { normalizeFirmware } from '@shared/ota';
import { checkVendorFirmware } from '../lib/api';
import type { DeviceInfo, LogEntry, TodooCardClient } from '../lib/ble';
import { entryBuildNumber, fetchFirmwareBytes, mergeCatalog, vendorReleaseToEntry, type FirmwareEntry } from '../lib/firmware';
import { runOtaUpdate, verifyFirmware, type OtaProgress } from '../lib/ota';
import type { Settings } from '../lib/settings';

interface Props {
  client: TodooCardClient;
  info: DeviceInfo | null;
  connected: boolean;
  log: LogEntry[];
  settings: Settings;
  /** Bundled catalog (loaded once by the app and shared with the Troubleshoot tab). */
  bundled: FirmwareEntry[] | null;
  catalogError: string | null;
}

export function FirmwarePanel({ client, info, connected, log, settings, bundled, catalogError }: Props) {
  const [vendorEntry, setVendorEntry] = useState<FirmwareEntry | null>(null);
  const [vendorLive, setVendorLive] = useState(false);
  const [selectedId, setSelectedId] = useState<string>('');
  const [confirming, setConfirming] = useState(false);
  /** The user must tick the risk acknowledgement before every flash. */
  const [accepted, setAccepted] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<OtaProgress | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Recovery/debug state: the card advertises OTA-recovery, or exposes no
  // firmware version (broken/debug build with a minimal GATT).
  const recoveryMode = info != null && (info.flags?.otaRecovery === true || info.firmwareRaw === undefined);
  const receiverVersion = info?.firmwareRaw ?? 0;

  // Ask the vendor update service for the live latest (proxied by our server).
  // Re-runs when the connected card's version changes so recovery/same-version
  // repair is resolved correctly. Any failure silently keeps the bundled list.
  useEffect(() => {
    let cancelled = false;
    checkVendorFirmware(settings, receiverVersion, recoveryMode).then((r) => {
      if (cancelled) return;
      setVendorEntry(r ? vendorReleaseToEntry(r) : null);
      setVendorLive(r != null);
    });
    return () => {
      cancelled = true;
    };
  }, [settings, receiverVersion, recoveryMode]);

  // Merge: a vendor release we do not already bundle is added; the highest
  // build (bundled v187 today) is the pre-selected latest.
  const catalog = useMemo<FirmwareEntry[] | null>(() => (bundled ? mergeCatalog(bundled, vendorEntry) : null), [bundled, vendorEntry]);

  useEffect(() => {
    if (!catalog) return;
    if (!catalog.some((e) => e.id === selectedId)) setSelectedId((catalog.find((e) => e.latest) ?? catalog[0])?.id ?? '');
  }, [catalog, selectedId]);

  const selected = useMemo(() => catalog?.find((e) => e.id === selectedId) ?? null, [catalog, selectedId]);
  // Flag a downgrade: the selected build is older than what's on the card.
  const selectedVersionNum = selected ? entryBuildNumber(selected) : 0;
  const isDowngrade = !!selected && receiverVersion > 0 && selectedVersionNum > 0 && selectedVersionNum < receiverVersion;
  const latestEntry = catalog?.find((e) => e.latest) ?? null;

  const send = async () => {
    if (!selected) return;
    if (!accepted) return;
    setConfirming(false);
    setAccepted(false); // acknowledged once per flash
    setRunning(true);
    setError(null);
    setResult(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const bytes = await fetchFirmwareBytes(selected, settings);
      await verifyFirmware(bytes, selected.sha256, selected.storedCrc32);
      // Safety guard (also enforced inside runOtaUpdate): structure, the
      // link-layer empty-packet template, and nothing below v185.
      const verdict = flashVerdict(inspectFirmware(normalizeFirmware(bytes)), { expectedVersion: selectedVersionNum });
      if (!verdict.ok) throw new Error(verdict.message);
      // Mirror the vendor app's recoverFirmwareUpdate: on a recoverable fault
      // (device rejected a packet, or the link dropped mid-stream), reconnect
      // and re-flash from the start, once.
      const RECOVERABLE = new Set(['fw-rejected', 'fw-disconnect']);
      let r: Awaited<ReturnType<typeof runOtaUpdate>> | undefined;
      for (let attempt = 1; attempt <= 2 && !r; attempt++) {
        try {
          r = await runOtaUpdate(client, { firmware: bytes, receiverVersion, expectedVersion: selectedVersionNum, signal: ac.signal, onProgress: setProgress });
        } catch (e) {
          const code = (e as { code?: string }).code ?? '';
          if (attempt >= 2 || ac.signal.aborted || !RECOVERABLE.has(code)) throw e;
          client.log('warn', `OTA recovery: reconnecting and retrying once (reason: ${code})…`);
          await new Promise((res) => setTimeout(res, 1200));
          try {
            await client.connect();
          } catch {
            /* the retried run will surface a clear error if reconnect failed */
          }
        }
      }
      setResult(
        `Sent ${selected.version}: ${r!.packets} packets (${(r!.bytes / 1024).toFixed(0)} KB) in ${(r!.durationMs / 1000).toFixed(0)} s. The card is verifying and rebooting to apply the update (it will disconnect). Reconnect in ~30 s to confirm the new firmware.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const [recovering, setRecovering] = useState(false);
  const recoveryConnect = async () => {
    setRecovering(true);
    setError(null);
    try {
      await client.requestDevice();
      await client.connectForRecovery();
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code !== 'cancelled') setError(err.message ?? 'Recovery connect failed');
    } finally {
      setRecovering(false);
    }
  };

  return (
    <div className="card">
      <h2>Firmware update</h2>
      {catalogError && <div className="banner warn">Couldn’t load the firmware list: {catalogError}</div>}
      {!catalog && !catalogError && <p className="muted">Loading firmware list…</p>}

      <details className="help">
        <summary>Recover a bricked card (won’t pair / connect)</summary>
        <p className="muted small">
          If a card advertises but normal connect fails, its firmware booted into OTA-recovery mode — it skips normal pairing but
          still accepts a firmware flash over its recovery channel. To recover it:
        </p>
        <ol className="muted small">
          <li>
            <strong>Forget the stale pairing first:</strong> macOS  → System Settings → Bluetooth → the card → “Forget This
            Device”. A firmware change invalidates the old bond, which is what blocks a normal connect.
          </li>
          <li>Click <em>Connect for recovery</em> below and pick the card (it may show a different name, e.g. starting “NEMR…”).</li>
          <li>Pick a firmware (the latest is pre-selected) and Send. Recovery uses the universal safe mode — no pairing or battery needed.</li>
        </ol>
        <p className="muted small">
          A card on legacy firmware 1.0.4–1.0.10 is different: it advertises (as “TodooCard-…” or, on a charger, “TodooRescue”) but no
          computer or phone can hold a connection to it, so it cannot be recovered from a browser. See the Troubleshoot tab.
        </p>
        <button className="btn" disabled={recovering || connected} onClick={recoveryConnect}>
          {recovering ? 'Connecting…' : connected ? 'Already connected' : 'Connect for recovery (no pairing)'}
        </button>
      </details>

      {catalog && (
        <>
          <div className="ctrl">
            <label>Firmware</label>
            <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} disabled={running}>
              {catalog.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                  {e.latest ? ' — latest' : ''}
                </option>
              ))}
            </select>
          </div>

          {selected && (
            <p className="muted small">
              {(selected.size / 1024).toFixed(0)} KB · CRC {selected.storedCrc32} · {selected.source === 'vendor' ? 'live from vendor' : 'bundled'}
              {selected.releaseNotesEn || selected.releaseNotes ? ` · ${selected.releaseNotesEn ?? selected.releaseNotes}` : ''}
              {selected.origin ? ` · ${selected.origin}` : ''}
            </p>
          )}
          <p className="muted small">
            {vendorLive
              ? 'The vendor update service answered with a release for this card.'
              : 'The vendor update service offered nothing newer for this card (or could not be reached: it is China-hosted). Showing the bundled firmware.'}{' '}
            Only v{MIN_FLASHABLE_VERSION} and newer are offered; every image is validated before it is sent.
          </p>

          <div className="disclaimer" role="note" aria-label="Firmware flashing disclaimer">
            <h3>Read this before you flash</h3>
            <ul>
              <li>
                <strong>Flashing firmware can permanently brick your card.</strong> It is the one operation in this app that can leave a card unusable, and a card
                that will not connect over Bluetooth cannot be repaired from a browser, a phone or the vendor app.
              </li>
              <li>
                <strong>You do this entirely at your own risk.</strong> This is an unofficial, community tool. It is not made, endorsed or supported by Sunbelife /
                TodooCard, and it is provided “as is”, without warranty of any kind (MIT licence). The author and contributors accept no responsibility or liability
                for a bricked, damaged or misbehaving card, lost images, or any other consequence of using it.
              </li>
              <li>
                <strong>It may void your warranty.</strong> The vendor may refuse support or replacement for a card flashed with anything other than their own app.
              </li>
              <li>
                <strong>The firmware is the vendor’s, not ours.</strong> Images are redistributed unmodified and checked (size, checksum, known-defect scan) before
                they are sent, but those checks cannot prove an image will work on your particular card or hardware revision. A passing check is not a guarantee.
              </li>
              <li>
                <strong>Only for the TodooCard T3 (528×792, six-colour).</strong> Never flash any other device with these images.
              </li>
              <li>
                <strong>Do not interrupt it.</strong> Keep the card charged (ideally on its charger) and within a metre of the computer, keep this tab open and in
                the foreground, and do not let the computer sleep until the update finishes. An interrupted update normally leaves the old firmware running, but
                that is not guaranteed.
              </li>
              <li>
                <strong>If the card works, you probably do not need this.</strong> Use the vendor’s own app for routine updates; flash from here only if you
                understand and accept the risk.
              </li>
            </ul>
            <label className="field row disclaimer-ack">
              <input type="checkbox" checked={accepted} disabled={running} onChange={(e) => setAccepted(e.target.checked)} />
              <span>
                I have read the above. I understand that flashing can permanently brick my card and that I alone am responsible for the outcome.
              </span>
            </label>
          </div>

          {recoveryMode && (
            <div className="banner">
              This card reports no firmware version (recovery/debug state). The flasher will use the universal safe mode and
              won’t require battery or other services — this is the expected way to recover such a card.
            </div>
          )}

          {isDowngrade && !recoveryMode && (
            <div className="banner warn">
              This build is <strong>older</strong> than the firmware on your card (currently v{receiverVersion}). Flashing it is
              a downgrade{latestEntry ? `; the newest build is ${latestEntry.version}` : ''}.
            </div>
          )}

          {!running && !confirming && (
            <>
              <button className="btn primary big" disabled={!connected || !selected || !accepted} onClick={() => setConfirming(true)}>
                Send firmware to card
              </button>
              {!accepted && <p className="muted small">Tick the acknowledgement above to enable flashing.</p>}
            </>
          )}

          {confirming && selected && (
            <div className="confirm">
              <p>
                Flash <strong>{selected.label}</strong> to <strong>{info?.name ?? 'this card'}</strong>? The card will reboot
                to apply it.
              </p>
              <p className="small">
                <strong>Last warning:</strong> this can permanently brick the card. There is no undo, no warranty, and nobody but you is responsible for the result.
              </p>
              <div className="row gap">
                <button className="btn primary" disabled={!accepted} onClick={send}>
                  I accept the risk — flash now
                </button>
                <button className="btn" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {running && progress && (
            <div className="progress">
              <div className="bar">
                <span style={{ width: `${progress.percent}%` }} />
              </div>
              <div className="row between small">
                <span>
                  {progress.phase === 'preparing' && 'Preparing…'}
                  {progress.phase === 'starting' && 'Starting OTA…'}
                  {progress.phase === 'sending' && `Sending ${progress.packetIndex} / ${progress.totalPackets} packets`}
                  {progress.phase === 'finishing' && 'Finalizing…'}
                  {progress.phase === 'rebooting' && 'Card is rebooting to apply…'}
                  {progress.phase === 'done' && 'Done'}
                  {progress.phase === 'failed' && 'Failed'}
                </span>
                <span>{progress.percent}%</span>
              </div>
              <button className="btn" onClick={() => abortRef.current?.abort()}>
                Cancel
              </button>
            </div>
          )}

          {result && <div className="banner ok">{result}</div>}
          {error && <div className="banner error">{error}</div>}

          <details className="log" open={running || !!error}>
            <summary>
              Update log <span className="muted small">({log.length})</span>
            </summary>
            <div className="row gap">
              <button
                className="btn small"
                onClick={() => navigator.clipboard?.writeText(log.map((l) => `${new Date(l.t).toISOString()} ${l.level} ${l.msg}`).join('\n'))}
              >
                Copy
              </button>
            </div>
            <pre className="logbox">
              {log.slice(-200).map((l, i) => (
                <div key={i} className={`line ${l.level}`}>
                  <span className="muted">{new Date(l.t).toLocaleTimeString()}</span> {l.msg}
                </div>
              ))}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}
