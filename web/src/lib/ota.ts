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
  client.log('info', `OTA: ${image.length} bytes, ${total} packets, pdu=${proto.packetDataByteCount}, scheduleAck=${proto.requiresScheduleAck}`);

  // Resolve the OTA characteristic.
  const char = await client.op(async () => {
    const svc = await client.server!.getPrimaryService(UUIDS.otaService);
    return svc.getCharacteristic(UUIDS.otaCharacteristic);
  });

  // Listen for schedule-ACK / status notifications.
  let acked = 0;
  const onNotify = (ev: Event) => {
    const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (!v) return;
    const bytes = new Uint8Array(v.buffer);
    const next = parseScheduleAck(bytes, proto.packetDataByteCount, acked, total);
    if (next !== null) acked = next;
  };
  if (char.properties.notify) {
    await client.op(() => char.startNotifications());
    char.addEventListener('characteristicvaluechanged', onNotify);
  }

  // Telink OTA uses write-without-response; fall back to write-with-response if
  // the characteristic doesn't advertise it (some stacks/recovery builds).
  const canNoResp = char.properties.writeWithoutResponse;
  const write = (data: Uint8Array) =>
    client.op(() => {
      const buf = data.slice().buffer as ArrayBuffer;
      return canNoResp ? char.writeValueWithoutResponse(buf) : char.writeValue(buf);
    });

  try {
    throwIfAborted();
    emit({ phase: 'starting', percent: 0, packetIndex: 0, totalPackets: total, bytesSent: 0 });
    await write(startPacket(proto));

    for (let i = 0; i < total; i++) {
      throwIfAborted();
      await write(packets[i]);
      const sentPackets = i + 1;

      // Flow control for fw >= 167: every 16 packets, wait for the device to
      // acknowledge it has persisted them before continuing.
      if (proto.requiresScheduleAck && sentPackets % 16 === 0 && sentPackets < total) {
        const target = sentPackets;
        const deadline = performance.now() + SCHEDULE_ACK_TIMEOUT_MS;
        while (acked < target) {
          throwIfAborted();
          if (performance.now() > deadline) throw new BleError('Firmware update stalled (schedule-ACK timeout).', 'fw-stall');
          await delay(25);
        }
      }

      if (sentPackets % 32 === 0 || sentPackets === total) {
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
    await write(endPacket(maxIndex));

    // The card verifies the whole image's CRC32, writes the inactive slot and
    // reboots to apply — it usually drops the BLE link while doing so.
    emit({ phase: 'rebooting', percent: 100, packetIndex: total, totalPackets: total, bytesSent: image.length });
    await delay(1500);
    emit({ phase: 'done', percent: 100, packetIndex: total, totalPackets: total, bytesSent: image.length });
    return { ok: true, packets: total, bytes: image.length, durationMs: performance.now() - started };
  } catch (e) {
    emit({ phase: 'failed', percent: 0, packetIndex: 0, totalPackets: total, bytesSent: 0 });
    throw e instanceof BleError ? e : new BleError(`Firmware update failed: ${(e as Error).message}`, 'fw-failed', e);
  } finally {
    try {
      char.removeEventListener('characteristicvaluechanged', onNotify);
    } catch {
      /* ignore */
    }
  }
}
