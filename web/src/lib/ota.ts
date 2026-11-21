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
import { flashVerdict, inspectFirmware } from '@shared/firmware';
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
  /**
   * Build number the catalog claims for this image. Cross-checked against the
   * version derived from the image; used only when the image yields none.
   */
  expectedVersion?: number;
  signal?: AbortSignal;
  onProgress?: (p: OtaProgress) => void;
}

export interface OtaResult {
  ok: true;
  packets: number;
  bytes: number;
  durationMs: number;
}

/**
 * Chrome gives write-without-response no backpressure, so we self-pace to about
 * one packet per BLE connection interval — otherwise packets are dropped/overrun
 * and the card rejects the stream (status 1) and disconnects. The Android app
 * gets this pacing for free from the OS BLE stack.
 */
const PACKET_INTERVAL_MS = 15;
/** Pause if schedule-ACKs fall this far behind (secondary, flash-persist guard). */
const MAX_IN_FLIGHT = 64;
/** How long to wait for the device's 0xFF06 completion result after the end packet. */
const COMPLETION_TIMEOUT_MS = 20000;

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

  // Safety guard, before anything touches the card: every image, whatever its
  // source, must pass the shared validator (structure the card enforces, the
  // link-layer empty-packet template it does not) and be v185 or newer.
  const image = normalizeFirmware(firmware);
  const report = inspectFirmware(image);
  const verdict = flashVerdict(report, { expectedVersion: opts.expectedVersion });
  if (!verdict.ok) {
    client.log('error', `${verdict.message} (sha256 ${report.sha256})`);
    throw new BleError(verdict.message, 'fw-unsafe');
  }
  client.log('info', verdict.message);

  if (!client.server?.connected) throw new BleError('Card is not connected.', 'nogatt');
  emit({ phase: 'preparing', percent: 0, packetIndex: 0, totalPackets: 0, bytesSent: 0 });

  // Build packets. Chrome negotiates a large MTU, so extended mode is allowed
  // whenever the version supports it; unknown version ⇒ legacy.
  const proto = negotiateOta(receiverVersion, receiverVersion >= 163 ? 244 : 20);
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

  // Notifications: schedule-ACK (0xFF08/09) for progress, and the OTA result
  // 0xFF06 (<status>): 0 = success, 1/13 = recoverable rejection, else = fail.
  let acked = 0;
  let notifyCount = 0;
  let lastNotify = '';
  const dev = { result: null as { ok: boolean; code: number } | null };
  const onNotify = (ev: Event) => {
    const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (!v) return;
    const bytes = new Uint8Array(v.buffer);
    notifyCount++;
    lastNotify = hex(bytes);
    const op = bytes.length >= 2 ? bytes[0] | (bytes[1] << 8) : -1;
    if (op === 0xff06 && bytes.length >= 3) {
      const code = bytes[2];
      dev.result = { ok: code === 0, code };
      client.log(code === 0 ? 'info' : 'error', `OTA result 0xFF06 status=${code} (${code === 0 ? 'success' : 'rejected'}) [${lastNotify}]`);
      return;
    }
    const next = parseScheduleAck(bytes, proto.packetDataByteCount, acked, total);
    if (next !== null) {
      acked = next;
      client.log('debug', `OTA notify #${notifyCount}: schedule-ACK → acked=${acked}/${total} [${lastNotify}]`);
    } else {
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
  // Abort the loop the instant the device rejects or the link drops, instead of
  // blindly streaming into a dead connection.
  const checkDevice = () => {
    if (dev.result && !dev.result.ok) {
      throw new BleError(
        `Card rejected the firmware (status ${dev.result.code}) after ${sentPackets} packets. ` +
          `This is an overrun/dropped-packet error — reconnect and try again (pacing is ${PACKET_INTERVAL_MS}ms/packet).`,
        'fw-rejected',
      );
    }
    if (!client.server?.connected) {
      throw new BleError(
        `Card disconnected after ${sentPackets} packets (it likely rejected the stream). Reconnect and retry.`,
        'fw-disconnect',
      );
    }
  };

  try {
    throwIfAborted();
    emit({ phase: 'starting', percent: 0, packetIndex: 0, totalPackets: total, bytesSent: 0 });
    client.log('info', `OTA → start packet [${hex(startPacket(proto))}], pacing ${PACKET_INTERVAL_MS}ms/packet`);
    await write(startPacket(proto));
    await delay(40); // let the card enter OTA mode before streaming

    for (let i = 0; i < total; i++) {
      throwIfAborted();
      checkDevice();
      await write(packets[i]);
      sentPackets = i + 1;

      // Primary throttle: ~one packet per connection interval (overrun fix).
      await delay(PACKET_INTERVAL_MS);

      // Secondary throttle: if schedule-ACKs lag far behind, wait for the card
      // to drain before getting further ahead.
      if (proto.requiresScheduleAck) {
        let guard = 0;
        while (sentPackets - acked > MAX_IN_FLIGHT && guard++ < 500) {
          throwIfAborted();
          checkDevice();
          await delay(10);
        }
      }

      if (sentPackets % 64 === 0 || sentPackets === total) {
        client.log('debug', `OTA progress: ${sentPackets}/${total} sent, acked=${acked}, notifications=${notifyCount}`);
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
    checkDevice();
    emit({ phase: 'finishing', percent: 99, packetIndex: total, totalPackets: total, bytesSent: image.length });
    client.log('info', `OTA → end packet [${hex(endPacket(maxIndex))}]`);
    await write(endPacket(maxIndex));
    client.log('info', `OTA stream complete: ${total} packets, ${notifyCount} notifications, acked=${acked}. Waiting for device result…`);

    // Wait for the card's 0xFF06 result. Success (status 0) → done; the card then
    // reboots and usually drops the link, so a disconnect here is a good sign.
    emit({ phase: 'rebooting', percent: 100, packetIndex: total, totalPackets: total, bytesSent: image.length });
    const deadline = performance.now() + COMPLETION_TIMEOUT_MS;
    while (!dev.result && client.server?.connected && performance.now() < deadline) {
      throwIfAborted();
      await delay(100);
    }
    if (dev.result && !dev.result.ok) {
      throw new BleError(`Card rejected the firmware at verification (status ${dev.result.code}).`, 'fw-rejected');
    }
    if (dev.result?.ok) client.log('info', 'OTA confirmed by device (status 0). Rebooting to apply.');
    else if (!client.server?.connected) client.log('info', 'Card disconnected after the final packet — rebooting to apply (expected).');
    else client.log('warn', 'No explicit completion result within timeout; the card may still be applying. Reconnect to confirm the new version.');

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
