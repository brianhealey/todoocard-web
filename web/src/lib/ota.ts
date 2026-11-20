/**
 * Web Bluetooth firmware flasher (Telink OTA) for the TodooCard T3.
 *
 * Drives the clean-room OTA codec in shared/ota.ts over the Telink OTA
 * characteristic. Works on normal cards and on recovery/debug cards that expose
 * only the OTA service (no battery/DIS) — it never depends on firmware version
 * or battery, and defaults to the universal legacy 16-byte packet mode.
 */
import { UUIDS } from '@shared/protocol';
import {
  buildOtaPackets,
  endPacket,
  negotiateOta,
  normalizeFirmware,
  parseScheduleAck,
  startPacket,
  storedCrc32,
} from '@shared/ota';
import { hex } from '@shared/protocol';
import { BleError, type TodooCardClient } from './ble';

export interface OtaProgress {
  phase: 'preparing' | 'starting' | 'sending' | 'finishing' | 'rebooting' | 'done' | 'failed';
  percent: number;
  packetIndex: number;
  totalPackets: number;
  bytesSent: number;
  totalBytes: number;
}

export interface OtaOptions {
  firmware: Uint8Array;
  /** Receiver firmware version (0/unknown ⇒ legacy packets — the safe default). */
  receiverVersion?: number;
  signal?: AbortSignal;
  onProgress?: (p: OtaProgress) => void;
}

export interface OtaResult {
  ok: true;
  packets: number;
  bytes: number;
  durationMs: number;
}

const SCHEDULE_ACK_TIMEOUT_MS = 8000;

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Validate a firmware blob against its expected sha256 + stored CRC32 before flashing. */
export async function verifyFirmware(bytes: Uint8Array, expectedSha256: string, expectedStoredCrc32: string): Promise<void> {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', ab));
  const sha = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  if (sha.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new BleError('Firmware failed verification (sha256 mismatch) — refusing to flash.', 'fw-verify');
  }
  const crc = '0x' + (storedCrc32(bytes) >>> 0).toString(16).padStart(8, '0');
  if (crc.toLowerCase() !== expectedStoredCrc32.toLowerCase()) {
    throw new BleError('Firmware failed verification (CRC32 trailer mismatch) — refusing to flash.', 'fw-verify');
  }
}

export async function runOtaUpdate(client: TodooCardClient, opts: OtaOptions): Promise<OtaResult> {
  const { firmware, receiverVersion = 0, signal } = opts;
  const started = performance.now();
  const emit = (p: Omit<OtaProgress, 'totalBytes'>) => opts.onProgress?.({ ...p, totalBytes: firmware.length });
  const throwIfAborted = () => {
    if (signal?.aborted) throw new BleError('Firmware update cancelled.', 'cancelled');
  };

  if (!client.server?.connected) throw new BleError('Card is not connected.', 'nogatt');
  emit({ phase: 'preparing', percent: 0, packetIndex: 0, totalPackets: 0, bytesSent: 0 });

  // Build packets. Chrome negotiates a large MTU, so extended mode is allowed
  // whenever the version supports it; unknown version ⇒ legacy.
  const proto = negotiateOta(receiverVersion, receiverVersion >= 163 ? 244 : 20);
  const image = normalizeFirmware(firmware);
  const { packets, maxIndex } = buildOtaPackets(image, proto.packetDataByteCount);
  const total = packets.length;
  const mode = proto.packetDataByteCount === 16 ? 'legacy/16' : 'extended/80';
  client.log(
    'info',
    `OTA start: receiverVersion=${receiverVersion || 'unknown'} mode=${mode} scheduleAck=${proto.requiresScheduleAck} ` +
      `rawBytes=${firmware.length} imageBytes=${image.length} packets=${total} maxIndex=${maxIndex} ` +
      `crc32Trailer=0x${(storedCrc32(image) >>> 0).toString(16).padStart(8, '0')}`,
  );

  // Resolve the OTA characteristic and report what the card actually exposes.
  const char = await client.op(async () => {
    const svc = await client.server!.getPrimaryService(UUIDS.otaService);
    return svc.getCharacteristic(UUIDS.otaCharacteristic);
  });
  const p = char.properties;
  client.log(
    'info',
    `OTA characteristic: write=${p.write} writeWithoutResponse=${p.writeWithoutResponse} notify=${p.notify} indicate=${p.indicate}`,
  );

  // Listen for schedule-ACK / status notifications. Any non-schedule-ACK packet
  // is logged raw — those carry device-side OTA error/status codes.
  let acked = 0;
  let notifyCount = 0;
  let lastNotify = '';
  const onNotify = (ev: Event) => {
    const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (!v) return;
    const bytes = new Uint8Array(v.buffer);
    notifyCount++;
    lastNotify = hex(bytes);
    const next = parseScheduleAck(bytes, proto.packetDataByteCount, acked, total);
    if (next !== null) {
      acked = next;
      client.log('debug', `OTA notify #${notifyCount}: schedule-ACK → acked=${acked}/${total} [${lastNotify}]`);
    } else {
      // Not a schedule-ACK: a device status/error notification worth surfacing.
      client.log('warn', `OTA notify #${notifyCount}: device status/other [${lastNotify}]`);
    }
  };
  if (p.notify) {
    await client.op(() => char.startNotifications());
    char.addEventListener('characteristicvaluechanged', onNotify);
    client.log('debug', 'OTA notifications enabled');
  } else {
    client.log('warn', 'OTA characteristic has no notify — flow control / error reporting unavailable');
  }

  // Telink OTA uses write-without-response; fall back to write-with-response if
  // the characteristic doesn't advertise it (some stacks/recovery builds).
  const canNoResp = p.writeWithoutResponse;
  client.log('info', `OTA write mode: ${canNoResp ? 'write-without-response' : 'write-with-response (fallback)'}`);
  const write = (data: Uint8Array) =>
    client.op(() => {
      const buf = data.slice().buffer as ArrayBuffer;
      return canNoResp ? char.writeValueWithoutResponse(buf) : char.writeValue(buf);
    });

  let sentPackets = 0;
  const phaseAt = () => (sentPackets === 0 ? 'starting' : sentPackets >= total ? 'finishing' : 'sending');
  try {
    throwIfAborted();
    emit({ phase: 'starting', percent: 0, packetIndex: 0, totalPackets: total, bytesSent: 0 });
    client.log('debug', `OTA → start packet [${hex(startPacket(proto))}]`);
    await write(startPacket(proto));

    for (let i = 0; i < total; i++) {
      throwIfAborted();
      await write(packets[i]);
      sentPackets = i + 1;

      // Flow control for fw >= 167: every 16 packets, wait for the device to
      // acknowledge it has persisted them before continuing.
      if (proto.requiresScheduleAck && sentPackets % 16 === 0 && sentPackets < total) {
        const target = sentPackets;
        client.log('debug', `OTA schedule-ACK wait: target=${target} acked=${acked}`);
        const deadline = performance.now() + SCHEDULE_ACK_TIMEOUT_MS;
        while (acked < target) {
          throwIfAborted();
          if (performance.now() > deadline) {
            throw new BleError(
              `Firmware update stalled: schedule-ACK timeout after ${SCHEDULE_ACK_TIMEOUT_MS} ms ` +
                `(sent=${sentPackets}, acked=${acked}, needed=${target}, notifications=${notifyCount}, lastNotify=[${lastNotify || 'none'}]).`,
              'fw-stall',
            );
          }
          await delay(25);
        }
      }

      if (sentPackets % 64 === 0 || sentPackets === total) {
        client.log('debug', `OTA progress: ${sentPackets}/${total} packets sent, acked=${acked}, notifications=${notifyCount}`);
        emit({
          phase: 'sending',
          percent: Math.min(99, Math.round((sentPackets / total) * 100)),
          packetIndex: sentPackets,
          totalPackets: total,
          bytesSent: Math.min(image.length, sentPackets * proto.packetDataByteCount),
        });
      }
    }

    throwIfAborted();
    emit({ phase: 'finishing', percent: 99, packetIndex: total, totalPackets: total, bytesSent: image.length });
    client.log('debug', `OTA → end packet [${hex(endPacket(maxIndex))}]`);
    await write(endPacket(maxIndex));
    client.log('info', `OTA stream complete: ${total} packets, ${notifyCount} notifications, acked=${acked}. Card verifying + rebooting.`);

    // The card verifies the whole image's CRC32, writes the inactive slot and
    // reboots to apply — it usually drops the BLE link while doing so.
    emit({ phase: 'rebooting', percent: 100, packetIndex: total, totalPackets: total, bytesSent: image.length });
    await delay(1500);
    emit({ phase: 'done', percent: 100, packetIndex: total, totalPackets: total, bytesSent: image.length });
    return { ok: true, packets: total, bytes: image.length, durationMs: performance.now() - started };
  } catch (e) {
    const msg = (e as Error).message;
    client.log(
      'error',
      `OTA failed in phase=${phaseAt()} at packet ${sentPackets}/${total} (acked=${acked}, notifications=${notifyCount}, ` +
        `lastNotify=[${lastNotify || 'none'}], connected=${!!client.server?.connected}): ${msg}`,
    );
    emit({ phase: 'failed', percent: 0, packetIndex: sentPackets, totalPackets: total, bytesSent: 0 });
    throw e instanceof BleError ? e : new BleError(`Firmware update failed: ${msg}`, 'fw-failed', e);
  } finally {
    try {
      char.removeEventListener('characteristicvaluechanged', onNotify);
    } catch {
      /* ignore */
    }
  }
}
