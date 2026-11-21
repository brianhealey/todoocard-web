import { useEffect, useMemo, useRef, useState } from 'react';
import { MIN_FLASHABLE_VERSION } from '@shared/firmware';
import { FW, statusCodeName } from '@shared/protocol';
import type { AdvState } from '../hooks/useClient';
import type { BleError, DeviceInfo, LogEntry, TodooCardClient } from '../lib/ble';
import { buildDiagnostics, collectCapabilities, diagnosticsFileName, downloadJson, scanGatt, type BluetoothCapabilities, type GattScan } from '../lib/diagnostics';
import { entryBuildNumber, type FirmwareEntry } from '../lib/firmware';
import { AdvertDecoder, AdvertFields, FirmwareChecker, SymptomGuide } from './TroubleshootTools';

interface Props {
  client: TodooCardClient;
  info: DeviceInfo | null;
  connected: boolean;
  log: LogEntry[];
  clearLog: () => void;
  adv: AdvState;
  bundled: FirmwareEntry[] | null;
  apiVersion?: string;
  onOpenFirmware: () => void;
}

const FLAG_URL = 'chrome://flags/#enable-experimental-web-platform-features';

export function TroubleshootPanel({ client, info, connected, log, clearLog, adv, bundled, apiVersion, onOpenFirmware }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gatt, setGatt] = useState<GattScan | null>(null);
  const [batteryRead, setBatteryRead] = useState<{ t: number; percent?: number; error?: string } | null>(null);
  const [caps, setCaps] = useState<BluetoothCapabilities | null>(null);
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [lastLinkMs, setLastLinkMs] = useState<number | null>(null);
  const logBox = useRef<HTMLPreElement>(null);

  useEffect(() => {
    collectCapabilities().then(setCaps);
  }, []);

  // How long the last link lasted before the card dropped it: "about 2 s" is the signature of an unpaired central.
  useEffect(() => {
    const onDisc = () => setLastLinkMs(client.lastLinkMs);
    client.addEventListener('disconnected', onDisc);
    return () => client.removeEventListener('disconnected', onDisc);
  }, [client]);

  useEffect(() => {
    const el = logBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const err = e as BleError;
      if (err.code !== 'cancelled') {
        setError(err.message ?? String(e));
        client.log('error', err.message ?? String(e));
      }
    } finally {
      setBusy(null);
    }
  };

  const survey = async () => {
    const scan = await scanGatt(client);
    setGatt(scan);
  };
  const choose = () =>
    run('choose', async () => {
      await client.requestDevice();
      setGatt(null);
      setBatteryRead(null);
      setLastLinkMs(null);
    });
  const connect = (pick: boolean) =>
    run('connect', async () => {
      if (pick || !client.device) {
        await client.requestDevice();
        setGatt(null);
        setBatteryRead(null);
      }
      setLastLinkMs(null);
      await client.connectForInspection();
      await survey();
    });
  const readBattery = () =>
    run('battery', async () => {
      try {
        const percent = await client.verifyBond();
        setBatteryRead({ t: Date.now(), percent });
      } catch (e) {
        setBatteryRead({ t: Date.now(), error: (e as Error).message });
        throw e;
      }
    });

  const latest = useMemo(() => bundled?.find((e) => e.latest) ?? null, [bundled]);
  const latestBuild = latest ? entryBuildNumber(latest) : 0;
  const fw = info?.firmwareRaw;
  const lastAdv = adv.snapshots[adv.snapshots.length - 1];

  const diagnosticsText = () =>
    JSON.stringify(
      buildDiagnostics({
        now: new Date(),
        app: { version: __APP_VERSION__, commit: __APP_COMMIT__, apiVersion },
        userAgent: navigator.userAgent,
        capabilities: caps,
        note,
        connected,
        info,
        advWatch: adv.watch,
        advWatchError: adv.error,
        advertisements: adv.snapshots,
        gatt,
        batteryRead,
        lastLinkMs,
        log,
        catalog: bundled,
      }),
      null,
      2,
    );
  const flash = (what: string) => {
    setCopied(what);
    setTimeout(() => setCopied((c) => (c === what ? null : c)), 2500);
  };
  const copyText = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      flash(what);
    } catch {
      setError('The browser refused clipboard access. Use the download button instead.');
    }
  };

  return (
    <div className="trouble">
      <div className="col">
        <div className="card">
          <h2>Inspect a card</h2>
          <p className="muted small">
            Connects without pairing (GATT only) and reads what the card will tell an unpaired computer. Nothing is written to the card from this tab.
          </p>
          <div className="row gap wrap">
            <button className="btn primary" disabled={!!busy} onClick={() => connect(!info)}>
              {busy === 'connect' ? 'Connecting…' : info ? (connected ? 'Re-read' : 'Connect (no pairing)') : 'Choose card and connect'}
            </button>
            <button className="btn" disabled={!!busy} onClick={choose} title="Pick a card without connecting, to watch what it advertises">
              {info ? 'Choose another card' : 'Choose card only'}
            </button>
            {connected && (
              <button
                className="btn"
                disabled={!!busy}
                onClick={() => {
                  client.disconnect();
                  void client.watchAdvertisements(); // keep showing what it advertises once it is free again
                }}
              >
                Disconnect
              </button>
            )}
          </div>
          {error && <div className="banner error">{error}</div>}

          {info && (
            <table className="kv">
              <tbody>
                <tr>
                  <th>Status</th>
                  <td>
                    <span className={`dot ${connected ? 'on' : 'off'}`} /> {connected ? 'connected' : 'disconnected'}
                    {info.bonded && connected && <span className="chip ok small">encrypted link verified</span>}
                  </td>
                </tr>
                <tr>
                  <th>Name</th>
                  <td>
                    {info.name}
                    {/^TodooRescue/i.test(info.name) && <span className="chip warn small">legacy firmware on external power</span>}
                  </td>
                </tr>
                <tr>
                  <th>Browser id</th>
                  <td className="mono small breakall">{info.id}</td>
                </tr>
                <tr>
                  <th>Firmware</th>
                  <td>
                    {fw !== undefined ? `v${fw} (0x${fw.toString(16).toUpperCase()})` : info.firmwareString ?? 'unknown'}
                    {info.model ? ` · model ${info.model}` : ''}
                    {info.hardware ? ` · hardware ${info.hardware}` : ''}
                    {info.manufacturer ? ` · ${info.manufacturer}` : ''}
                  </td>
                </tr>
                {info.rssi !== undefined && (
                  <tr>
                    <th>Signal</th>
                    <td>{info.rssi} dBm</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          {!connected && lastLinkMs !== null && lastLinkMs < 6000 && (
            <div className="banner warn">
              The card dropped the link {(lastLinkMs / 1000).toFixed(1)} s after it connected. On secure firmware (v140 or newer) that is what an unpaired computer sees
              while the pairing window is closed: hold the rear button until the front light breathes, then connect again. If it used to work, forget the card in the OS
              Bluetooth settings first.
            </div>
          )}
          {info && fw === undefined && connected && (
            <div className="banner">
              No firmware version could be read. The card may be in recovery or a minimal debug state.{' '}
              <button className="btn link" onClick={onOpenFirmware}>
                Open the Firmware tab
              </button>{' '}
              and use “Connect for recovery”.
            </div>
          )}
          {fw !== undefined && latest && (
            <div className={`banner ${fw < latestBuild ? 'warn' : 'ok'}`}>
              {fw < FW.secureMinimum
                ? `This card reports legacy firmware v${fw}. The newest bundled firmware is ${latest.version}.`
                : fw < latestBuild
                  ? `This card reports v${fw}; the newest bundled firmware is ${latest.version}.`
                  : fw === latestBuild
                    ? `This card is on ${latest.version}, the newest bundled firmware.`
                    : `This card reports v${fw}, newer than the newest bundled firmware (${latest.version}).`}{' '}
              {fw < latestBuild && (
                <button className="btn link" onClick={onOpenFirmware}>
                  Open the Firmware tab
                </button>
              )}
            </div>
          )}
        </div>

        <div className="card">
          <h2>What the card advertises</h2>
          {adv.watch === 'unsupported' && (
            <div className="banner">
              This browser does not expose advertisements to web pages, so flags such as “pairing window open” and “OTA recovery” cannot be shown. In Chrome, open{' '}
              <button className="btn link mono" onClick={() => copyText('flag', FLAG_URL)} title="Copy (Chrome does not allow links to chrome:// pages)">
                {FLAG_URL}
              </button>
              {copied === 'flag' ? ' (copied) ' : ' '}
              enable it and relaunch. Until then this view falls back to what a connection gives: the name and the Device Information values.
            </div>
          )}
          {adv.watch === 'error' && <div className="banner warn">Advertisement watching failed: {adv.error}</div>}
          {adv.watch === 'idle' && !info && <p className="muted small">Choose a card to start watching its advertisements.</p>}
          {adv.watch === 'idle' && info && (
            <p className="muted small">
              Not watching.{' '}
              <button className="btn small" onClick={() => void client.watchAdvertisements()}>
                Watch advertisements
              </button>
            </p>
          )}
          {adv.watch === 'watching' && (
            <p className="muted small">
              Watching. The card stops advertising while it is connected, so packets arrive before a connection and after a disconnect
              {adv.snapshots.length === 0 ? '; none received yet.' : '.'}
            </p>
          )}
          {lastAdv && (
            <>
              <table className="kv small">
                <tbody>
                  <tr>
                    <th>Name</th>
                    <td>{lastAdv.name ?? '—'}</td>
                  </tr>
                  <tr>
                    <th>RSSI</th>
                    <td>
                      {lastAdv.rssi !== undefined ? `${lastAdv.rssi} dBm` : '—'} · seen {lastAdv.count}× · last {new Date(lastAdv.lastT).toLocaleTimeString()}
                    </td>
                  </tr>
                  <tr>
                    <th>Manufacturer data</th>
                    <td className="mono breakall">
                      {lastAdv.manufacturerData.length === 0
                        ? '—'
                        : lastAdv.manufacturerData.map((m) => `0x${m.companyId.toString(16).padStart(4, '0')}: ${m.hex}`).join(' | ')}
                    </td>
                  </tr>
                  {lastAdv.serviceUuids.length > 0 && (
                    <tr>
                      <th>Services</th>
                      <td className="mono breakall">{lastAdv.serviceUuids.join(', ')}</td>
                    </tr>
                  )}
                </tbody>
              </table>
              {lastAdv.decoded ? <AdvertFields a={lastAdv.decoded} /> : <p className="muted small">No TodooCard (0x5053) manufacturer record in this advertisement.</p>}
              {adv.snapshots.length > 1 && (
                <details className="help">
                  <summary>Earlier payloads ({adv.snapshots.length - 1})</summary>
                  <div className="snapshots">
                    {adv.snapshots
                      .slice(0, -1)
                      .reverse()
                      .map((a) => (
                        <div key={a.t} className="snapshot mono small">
                          <span className="muted">
                            {new Date(a.t).toLocaleTimeString()} · {a.name ?? '—'} · {a.count}×
                          </span>{' '}
                          {a.manufacturerData.map((m) => m.hex).join(' | ') || '—'}
                        </div>
                      ))}
                  </div>
                </details>
              )}
            </>
          )}
          {!lastAdv && info && adv.watch !== 'watching' && (
            <table className="kv small">
              <tbody>
                <tr>
                  <th>Name (from the chooser)</th>
                  <td>{info.name}</td>
                </tr>
                <tr>
                  <th>Firmware (from GATT)</th>
                  <td>{fw !== undefined ? `v${fw}` : 'not read yet'}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2>Services and characteristics</h2>
          {!gatt && <p className="muted small">Connect to list what the card exposes. Browsers show only the services this app asks for when the card is chosen.</p>}
          <div className="row gap wrap">
            <button className="btn small" disabled={!connected || !!busy} onClick={() => run('survey', survey)}>
              {busy === 'survey' ? 'Reading…' : 'Read again'}
            </button>
            <button className="btn small" disabled={!connected || !!busy} onClick={readBattery} title="Battery Level is encrypted: reading it makes the system pair with the card">
              {busy === 'battery' ? 'Reading…' : 'Read Battery Level (starts pairing)'}
            </button>
          </div>
          {batteryRead && (
            <p className="small">
              Battery Level: {batteryRead.percent !== undefined ? `${batteryRead.percent}% — the encrypted link works, this computer is paired.` : `not readable (${batteryRead.error})`}
            </p>
          )}
          {gatt?.error && <div className="banner warn">{gatt.error}</div>}
          {gatt && gatt.services.length > 0 && (
            <div className="gatt">
              {gatt.services.map((s) => (
                <div key={s.uuid} className="gatt-service">
                  <div className="gatt-head">
                    <strong>{s.name ?? 'Unknown service'}</strong> <span className="mono muted small breakall">{s.short}</span>
                  </div>
                  {s.error && <div className="small muted">Could not list characteristics: {s.error}</div>}
                  {s.characteristics.map((c) => (
                    <div key={c.uuid} className="gatt-char">
                      <div>
                        {c.name ?? 'Unknown characteristic'} <span className="mono muted small breakall">{c.short}</span>
                      </div>
                      <div className="small">
                        {c.properties.map((p) => (
                          <span key={p} className="chip small">
                            {p}
                          </span>
                        ))}
                      </div>
                      {c.valueHex !== undefined && (
                        <div className="mono small breakall">
                          {c.valueText !== undefined ? `“${c.valueText}” · ` : ''}
                          {c.valueHex || '(empty)'}
                        </div>
                      )}
                      {c.note && <div className="small muted">{c.note}</div>}
                      {c.error && <div className="small muted">Read failed: {c.error}</div>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {gatt?.statusRecord && (
            <>
              <h3>Diagnostics status record (…1002)</h3>
              <table className="kv small">
                <tbody>
                  <tr>
                    <th>Phase</th>
                    <td>
                      {statusCodeName(gatt.statusRecord.statusCode)} (0x{gatt.statusRecord.statusCode.toString(16).padStart(2, '0')})
                      {gatt.statusRecord.markerOk ? ' · format markers present' : ' · unexpected markers (different firmware layout?)'}
                    </td>
                  </tr>
                  <tr>
                    <th>Event counter</th>
                    <td>{gatt.statusRecord.eventCounter}</td>
                  </tr>
                  <tr>
                    <th>Other fields</th>
                    <td className="mono">
                      {gatt.statusRecord.aux.join(', ')} <span className="muted">(tentative)</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
          {gatt?.imageAck && (
            <>
              <h3>Image-transfer record (…1003)</h3>
              <table className="kv small">
                <tbody>
                  <tr>
                    <th>Acknowledgements</th>
                    <td>
                      generated {gatt.imageAck.generated}, attempts {gatt.imageAck.attempts}, accepted {gatt.imageAck.accepted}, rejected {gatt.imageAck.rejected}
                    </td>
                  </tr>
                  <tr>
                    <th>Last result</th>
                    <td>
                      code 0x{gatt.imageAck.lastNotifyResult.toString(16).padStart(2, '0')} {gatt.imageAck.lastNotifyResult === 0 ? '(ok)' : ''} · last block {gatt.imageAck.lastReceivedBlock}
                    </td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>

      <div className="col">
        <div className="card">
          <div className="row between">
            <h2>Event log</h2>
            <div className="row gap">
              <button className="btn small" onClick={() => copyText('log', log.map((l) => `${new Date(l.t).toISOString()} ${l.level} ${l.msg}`).join('\n'))}>
                {copied === 'log' ? 'Copied' : 'Copy'}
              </button>
              <button className="btn small" onClick={clearLog}>
                Clear
              </button>
            </div>
          </div>
          <pre className="logbox tall" ref={logBox} aria-live="polite" aria-label="Bluetooth event log">
            {log.length === 0 && <span className="muted">Nothing yet. Events from every tab appear here as they happen.</span>}
            {log.slice(-300).map((l, i) => (
              <div key={i} className={`line ${l.level}`}>
                <span className="muted">{new Date(l.t).toLocaleTimeString()}</span> {l.msg}
              </div>
            ))}
          </pre>
        </div>

        <div className="card">
          <h2>Diagnostics file</h2>
          <p className="muted small">
            One JSON file with everything on this tab: browser and Bluetooth capabilities, the card’s name and id, advertisements, the GATT table and values read, decoded
            diagnostics, the event log and the bundled firmware list. It contains no API keys and nothing from Settings. The card’s serial and Bluetooth identity are
            included, so share it only with someone you would tell those to.
          </p>
          <label className="field">
            <span className="muted small">What happened? (optional, included in the file)</span>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: flashed v187, card rebooted, now it drops two seconds after connecting." />
          </label>
          <div className="row gap wrap tool-examples">
            <button
              className="btn primary"
              onClick={() => {
                const now = new Date();
                downloadJson(diagnosticsFileName(now), diagnosticsText());
              }}
            >
              Build diagnostics file
            </button>
            <button className="btn" onClick={() => copyText('diag', diagnosticsText())}>
              {copied === 'diag' ? 'Copied' : 'Copy to clipboard'}
            </button>
          </div>
          {caps && (
            <p className="muted small">
              Web Bluetooth {caps.webBluetooth ? 'available' : 'missing'} · secure context {caps.secureContext ? 'yes' : 'no'} · adapter{' '}
              {caps.adapterAvailable === null ? 'unknown' : caps.adapterAvailable ? 'present' : 'absent or off'} · advertisement access {caps.watchAdvertisements ? 'yes' : 'no'}
            </p>
          )}
        </div>

        <FirmwareChecker />
        <AdvertDecoder />
        <SymptomGuide />
        <p className="muted small">
          Only v{MIN_FLASHABLE_VERSION} and newer firmware is bundled or accepted by the flasher. Older images were removed after a legacy build left a card unreachable over
          Bluetooth.
        </p>
      </div>
    </div>
  );
}
