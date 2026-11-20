import { useEffect, useMemo, useRef, useState } from 'react';
import type { DeviceInfo, TodooCardClient } from '../lib/ble';
import { fetchFirmwareBytes, loadFirmwareCatalog, type FirmwareEntry } from '../lib/firmware';
import { runOtaUpdate, verifyFirmware, type OtaProgress } from '../lib/ota';

interface Props {
  client: TodooCardClient;
  info: DeviceInfo | null;
  connected: boolean;
}

export function FirmwarePanel({ client, info, connected }: Props) {
  const [catalog, setCatalog] = useState<FirmwareEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<OtaProgress | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    loadFirmwareCatalog()
      .then((c) => {
        setCatalog(c);
        setSelectedId((c.find((e) => e.latest) ?? c[0])?.id ?? '');
      })
      .catch((e) => setCatalogError((e as Error).message));
  }, []);

  const selected = useMemo(() => catalog?.find((e) => e.id === selectedId) ?? null, [catalog, selectedId]);
  // A card in recovery/debug state reports no firmware version (and often no battery).
  const recoveryMode = info != null && info.firmwareRaw === undefined;
  const receiverVersion = info?.firmwareRaw ?? 0;

  const send = async () => {
    if (!selected) return;
    setConfirming(false);
    setRunning(true);
    setError(null);
    setResult(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const bytes = await fetchFirmwareBytes(selected);
      await verifyFirmware(bytes, selected.sha256, selected.storedCrc32);
      const r = await runOtaUpdate(client, { firmware: bytes, receiverVersion, signal: ac.signal, onProgress: setProgress });
      setResult(
        `Sent ${selected.version}: ${r.packets} packets (${(r.bytes / 1024).toFixed(0)} KB) in ${(r.durationMs / 1000).toFixed(0)} s. The card is verifying and rebooting to apply the update (it will disconnect). Reconnect in ~30 s to confirm the new firmware.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const current = catalog?.filter((e) => e.channel === 'current') ?? [];
  const legacy = catalog?.filter((e) => e.channel === 'legacy') ?? [];

  return (
    <div className="card">
      <h2>Firmware update</h2>
      {catalogError && <div className="banner warn">Couldn’t load the firmware list: {catalogError}</div>}
      {!catalog && !catalogError && <p className="muted">Loading firmware list…</p>}

      {catalog && (
        <>
          <div className="ctrl">
            <label>Firmware</label>
            <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} disabled={running}>
              {current.length > 0 && (
                <optgroup label="Current">
                  {current.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.label}
                      {e.latest ? ' — latest' : ''}
                    </option>
                  ))}
                </optgroup>
              )}
              {legacy.length > 0 && (
                <optgroup label="Legacy / recovery">
                  {legacy.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          {selected && (
            <p className="muted small">
              {(selected.size / 1024).toFixed(0)} KB · CRC {selected.storedCrc32}
              {selected.releaseNotes ? ` · ${selected.releaseNotes}` : ''}
            </p>
          )}

          <div className="banner warn">
            Flashing firmware is the one operation that can brick a card. This card’s dual-slot design means a bad image won’t
            activate, but only send firmware for <strong>this exact device</strong>, keep it near your computer, and don’t
            close this tab until it finishes.
          </div>

          {recoveryMode && (
            <div className="banner">
              This card reports no firmware version (recovery/debug state). The flasher will use the universal safe mode and
              won’t require battery or other services — this is the expected way to recover such a card.
            </div>
          )}

          {!running && !confirming && (
            <button className="btn primary big" disabled={!connected || !selected} onClick={() => setConfirming(true)}>
              Send firmware to card
            </button>
          )}

          {confirming && selected && (
            <div className="confirm">
              <p>
                Flash <strong>{selected.label}</strong> to <strong>{info?.name ?? 'this card'}</strong>? The card will reboot
                to apply it.
              </p>
              <div className="row gap">
                <button className="btn primary" onClick={send}>
                  Yes, flash now
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
        </>
      )}
    </div>
  );
}
