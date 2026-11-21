import { useMemo, useRef, useState, type DragEvent } from 'react';
import { MIN_FLASHABLE_VERSION, describeFirmwareReport, flashVerdict, inspectFirmware, type FirmwareReport } from '@shared/firmware';
import { decodeManufacturerData, parseManufacturerHex, type DecodedAdvertisement } from '@shared/protocol';

const hex2 = (n: number) => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;
const hex8 = (n: number) => `0x${(n >>> 0).toString(16).padStart(8, '0')}`;

/** Decoded manufacturer record as a table; shared by the live view and the paste decoder. */
export function AdvertFields({ a }: { a: DecodedAdvertisement }) {
  const f = a.flags;
  return (
    <table className="kv small">
      <tbody>
        <tr>
          <th>Company id</th>
          <td>
            0x{a.companyId.toString(16).padStart(4, '0')} {a.companyIdOk ? '(“SP”, TodooCard)' : '— not the TodooCard id 0x5053'}
          </td>
        </tr>
        <tr>
          <th>Screen type</th>
          <td>
            0x{a.screenType.toString(16).toUpperCase().padStart(4, '0')} {a.screenTypeOk ? '(T3, 528×792 six-colour)' : '— not a T3 panel'}
          </td>
        </tr>
        <tr>
          <th>Firmware</th>
          <td>
            v{a.firmwareRaw} ({hex2(a.firmwareRaw)}){a.semanticVersion ? ` · identity ${a.productModel} ${a.semanticVersion}` : ''}
            {!a.modern && <span className="chip warn small">legacy, below v140</span>}
            {a.modern && a.firmwareRaw < MIN_FLASHABLE_VERSION && <span className="chip warn small">older than v{MIN_FLASHABLE_VERSION}</span>}
          </td>
        </tr>
        {f && a.flagsRaw !== undefined && (
          <tr>
            <th>Flags</th>
            <td>
              {hex2(a.flagsRaw)}: {f.encryptedGatt ? 'encrypted GATT (pairing required)' : 'no encryption'}
              {f.pairingWindowOpen ? ', pairing window OPEN' : ', pairing window closed'}
              {f.otaRecovery ? ', OTA RECOVERY mode' : ''}
              {f.turboLink ? ', turbo link' : ''}
              {f.fullMac ? ', full device id present' : ''}
              {f.unknownBits ? `, unknown bits ${hex2(f.unknownBits)}` : ''}
            </td>
          </tr>
        )}
        {a.batteryRaw !== undefined && (
          <tr>
            <th>Battery byte</th>
            <td>
              {hex2(a.batteryRaw)}
              {a.batteryVolts !== undefined ? ` ≈ ${a.batteryVolts.toFixed(1)} V` : ' (not a plausible voltage)'} — below v140 this byte is a battery reading, not flags, so
              pairing, recovery and turbo cannot be read from it.
            </td>
          </tr>
        )}
        {a.deviceId && (
          <tr>
            <th>Device id</th>
            <td className="mono">{a.deviceId}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export function AdvertDecoder() {
  const [text, setText] = useState('');
  const parsed = useMemo(() => (text.trim() ? parseManufacturerHex(text) : null), [text]);
  const decoded = parsed && 'bytes' in parsed ? decodeManufacturerData(parsed.bytes) : null;
  return (
    <div className="card">
      <h2>Advertisement decoder</h2>
      <p className="muted small">
        Paste the manufacturer data from any BLE scanner (nRF Connect, LightBlue, <span className="mono">bleak</span>), with or without the{' '}
        <span className="mono">53 50</span> / <span className="mono">5053</span> / <span className="mono">SP</span> company prefix.
      </p>
      <label className="field">
        <span className="muted small">Manufacturer data (hex)</span>
        <input type="text" className="mono" value={text} onChange={(e) => setText(e.target.value)} placeholder="53 50 4c 11 bb 01 13" spellCheck={false} autoComplete="off" />
      </label>
      <div className="row gap wrap tool-examples">
        <span className="muted small">Examples:</span>
        <button className="btn small" onClick={() => setText('SP 4c 11 bb 01 13')}>
          v187, paired use
        </button>
        <button className="btn small" onClick={() => setText('5350 4c 13 b9 01 13')}>
          v185, pairing window open
        </button>
        <button className="btn small" onClick={() => setText('4c 1e 81 01 13 54 33 01 00 0a')}>
          legacy 1.0.10
        </button>
      </div>
      {parsed && 'error' in parsed && <div className="banner warn">{parsed.error}</div>}
      {decoded && (
        <>
          {parsed && 'bytes' in parsed && parsed.companyIdAdded && <p className="muted small">No company prefix found; assumed the bytes follow 0x5053.</p>}
          <AdvertFields a={decoded} />
          {decoded.companyIdOk && decoded.screenTypeOk && !decoded.modern && (
            <div className="banner warn">
              This is legacy 1.0.x-era firmware. If it is one of builds 1.0.4–1.0.10 nothing can hold a connection to it; see the symptom guide.
            </div>
          )}
          {decoded.flags?.otaRecovery && <div className="banner warn">The card is in OTA recovery mode: use “Connect for recovery” on the Firmware tab and flash the latest firmware.</div>}
        </>
      )}
    </div>
  );
}

function ReportTable({ r }: { r: FirmwareReport }) {
  const mark = (ok: boolean) => <span className={`chip small ${ok ? 'ok' : 'error'}`}>{ok ? 'pass' : 'FAIL'}</span>;
  return (
    <table className="kv small">
      <tbody>
        <tr>
          <th>Size</th>
          <td>
            {r.length.toLocaleString()} bytes {mark(r.sizeInRange && r.sizeAligned)}
          </td>
        </tr>
        <tr>
          <th>KNLT marker</th>
          <td>{mark(r.magicOk)}</td>
        </tr>
        <tr>
          <th>Declared size</th>
          <td>
            {r.declaredSize === null ? '—' : r.declaredSize.toLocaleString()} {mark(r.declaredSizeMatches)}
          </td>
        </tr>
        <tr>
          <th>CRC32</th>
          <td>
            trailer {r.storedCrc32 === null ? '—' : hex8(r.storedCrc32)}, residue {hex8(r.crc32Residue)} {mark(r.crcOk)}
          </td>
        </tr>
        <tr>
          <th>Idle-packet template</th>
          <td>
            {r.emptyPacketTemplate === 'ok' ? 'intact' : r.emptyPacketTemplate === 'defect' ? 'damaged (02000000 ffffffff)' : 'not found'} {mark(r.emptyPacketTemplate === 'ok')}
          </td>
        </tr>
        <tr>
          <th>Version</th>
          <td>
            {r.version !== null ? `v${r.version} (${r.versionSource === 'known-hash' ? 'known image' : 'read from the image'})` : r.legacyVersionString ? `legacy, fw=${r.legacyVersionString}` : 'unknown'}
          </td>
        </tr>
        <tr>
          <th>SHA-256</th>
          <td className="mono breakall">{r.sha256}</td>
        </tr>
      </tbody>
    </table>
  );
}

/** Runs the flasher's validator on a local file. Nothing is uploaded and nothing is sent to a card. */
export function FirmwareChecker() {
  const [name, setName] = useState<string | null>(null);
  const [report, setReport] = useState<FirmwareReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = async (file: File | undefined | null) => {
    if (!file) return;
    setError(null);
    setReport(null);
    setName(file.name);
    if (file.size > 4 * 1024 * 1024) {
      setError('That file is larger than 4 MB; a T3 firmware image is under 127 KB.');
      return;
    }
    try {
      setReport(inspectFirmware(new Uint8Array(await file.arrayBuffer())));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDrag(false);
    void load(e.dataTransfer.files?.[0]);
  };

  const verdict = report ? flashVerdict(report) : null;
  const unconnectable = report?.emptyPacketTemplate === 'defect';

  return (
    <div className="card">
      <h2>Firmware file checker</h2>
      <p className="muted small">
        Checks a <span className="mono">.bin</span> with the same validator the flasher uses. The file stays in this browser and nothing is sent to a card.
      </p>
      <div
        className={`drop ${drag ? 'drag' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        <p className="muted small">Drop a firmware .bin here, or</p>
        <button className="btn" onClick={() => inputRef.current?.click()}>
          Choose file…
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".bin,application/octet-stream"
          hidden
          onChange={(e) => {
            void load(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      {error && <div className="banner error">{error}</div>}
      {report && verdict && (
        <>
          <h3 className="breakall">{name}</h3>
          {unconnectable ? (
            <div className="banner error">
              <strong>This build cannot hold a Bluetooth connection — do not flash.</strong> It has the damaged link-layer idle packet of legacy images 1.0.4–1.0.10.
            </div>
          ) : verdict.ok ? (
            <div className="banner ok">Valid firmware image, v{verdict.version}. The flasher would accept it.</div>
          ) : (
            <div className="banner error">{verdict.message}</div>
          )}
          <ul className="plain small">
            {describeFirmwareReport(report).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          <ReportTable r={report} />
        </>
      )}
    </div>
  );
}

interface Symptom {
  symptom: string;
  cause: string;
  action: string;
}

const SYMPTOMS: Symptom[] = [
  {
    symptom: 'Connects, then drops after about 2 seconds',
    cause: 'The card runs secure firmware (v140 or newer) and this computer is not paired with it, while the card’s pairing window is closed. It drops any unpaired central.',
    action:
      'Hold the hidden rear button until the front light breathes (about 5 s on v152 and newer; the vendor app says 10 s), then connect within the minute the window stays open and accept the system pairing prompt.',
  },
  {
    symptom: 'Pairing used to work, now every connect fails or drops',
    cause: 'A stale pairing in the operating system. A firmware change or a pairing with another computer invalidates the old bond.',
    action: 'Forget the card in the OS Bluetooth settings (macOS: System Settings → Bluetooth → the card → Forget This Device), then pair again with the pairing window open.',
  },
  {
    symptom: 'The chooser shows “TodooRescue”',
    cause:
      'Legacy 1.0.x firmware on external power: that firmware advertises as “TodooCard-<MAC>” on battery and “TodooRescue” while charging. It is the same firmware and the same services, not a recovery mode.',
    action: 'Unplugging changes only the name. If it connects (1.0.2 or 1.0.3), flash the latest firmware from the Firmware tab. If connecting always times out, see the next entry.',
  },
  {
    symptom: 'A legacy card (1.0.4–1.0.10) is visible but connecting always times out',
    cause:
      'Those builds have a damaged link-layer idle packet. The card joins the connection but nothing it sends while idle is valid, so no phone, computer or standard Bluetooth chip can talk to it.',
    action:
      'It cannot be fixed from a browser or any app. It needs a central with a custom link layer that tolerates the bad packet (an nRF52840 running the rescue firmware described in the firmware project’s recovery notes), which then delivers a current image over the normal OTA.',
  },
  {
    symptom: 'Firmware shows “unknown”',
    cause: 'The card did not expose Device Information: it is in OTA recovery or a minimal debug state, or the link dropped before the version could be read.',
    action: 'Use “Connect for recovery (no pairing)” on the Firmware tab and flash the latest firmware. The flasher uses the universal 16-byte mode when the version is unknown.',
  },
  {
    symptom: 'A firmware update stalls or fails part-way',
    cause: 'Packets were lost or overran. The card writes to its inactive slot, so the running firmware is untouched until a complete, verified image has arrived.',
    action: 'Retry. Keep the card within a metre of the computer and on charge, keep the tab in the foreground, and close other apps that may be connected to it.',
  },
  {
    symptom: 'The card is not in the chooser at all',
    cause: 'It is connected to something else (it stops advertising while connected), out of range, or flat.',
    action: 'Close the vendor app and other tabs, turn Bluetooth off on the phone it was paired with, charge the card for a few minutes and try again.',
  },
  {
    symptom: 'Image sending is refused with “OTA recovery mode”',
    cause: 'The card is running its OTA-only recovery mode (its advertisement sets the recovery flag); it accepts firmware only.',
    action: 'Flash the latest firmware from the Firmware tab (“Connect for recovery” if a normal connect fails), then reconnect.',
  },
];

export function SymptomGuide() {
  return (
    <div className="card">
      <h2>Symptom guide</h2>
      <div className="symptoms">
        {SYMPTOMS.map((s) => (
          <details key={s.symptom} className="symptom">
            <summary>{s.symptom}</summary>
            <p className="small">
              <strong>Why:</strong> {s.cause}
            </p>
            <p className="small">
              <strong>What to do:</strong> {s.action}
            </p>
          </details>
        ))}
      </div>
    </div>
  );
}
