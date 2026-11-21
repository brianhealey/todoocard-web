import { describe, expect, it } from 'vitest';
import { buildOtaPackets, crc16, endPacket, negotiateOta, normalizeFirmware, OTA_LEGACY, parseScheduleAck, startPacket } from '../shared/ota';

const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe('ota crc16 (CRC-16/MODBUS)', () => {
  it('matches the canonical check vector', () => {
    expect(crc16(enc('123456789'))).toBe(0x4b37);
  });
});

describe('ota negotiation', () => {
  it('falls back to legacy for unknown/old version or small MTU', () => {
    expect(negotiateOta(0, 20)).toEqual(OTA_LEGACY); // recovery/debug device
    expect(negotiateOta(162, 247)).toEqual(OTA_LEGACY);
    expect(negotiateOta(185, 20)).toEqual(OTA_LEGACY); // MTU too small for extended
  });
  it('uses extended packets and schedule-ack by version', () => {
    expect(negotiateOta(165, 247)).toEqual({ packetDataByteCount: 80, requiresScheduleAck: false });
    expect(negotiateOta(185, 247)).toEqual({ packetDataByteCount: 80, requiresScheduleAck: true });
  });
});

describe('ota packetization', () => {
  it('builds a padded, indexed, crc-tailed legacy packet', () => {
    const { packets, maxIndex } = buildOtaPackets(new Uint8Array([0xaa, 0xbb]), 16);
    expect(packets).toHaveLength(1);
    expect(maxIndex).toBe(0);
    const p = packets[0];
    expect(p.length).toBe(20); // 16 data (padded) + 2 index + 2 crc
    expect([p[0], p[1]]).toEqual([0, 0]); // index 0
    expect([p[2], p[3]]).toEqual([0xaa, 0xbb]); // data
    expect(Array.from(p.subarray(4, 18))).toEqual(Array(14).fill(0xff)); // 0xff padding
    const crc = crc16(p.subarray(0, 18));
    expect([p[18], p[19]]).toEqual([crc & 0xff, (crc >> 8) & 0xff]); // crc over index+data
  });

  it('increments the packet index and reports the last index', () => {
    const fw = new Uint8Array(16 * 3 + 5); // 4 packets (3 full + 1 partial)
    const { packets, maxIndex } = buildOtaPackets(fw, 16);
    expect(packets).toHaveLength(4);
    expect([packets[0][0], packets[1][0], packets[2][0], packets[3][0]]).toEqual([0, 1, 2, 3]);
    expect(maxIndex).toBe(3);
    expect(packets[3].length).toBe(16 + 4); // partial padded up to 16
  });

  it('uses 80-byte data packets in extended mode', () => {
    const { packets } = buildOtaPackets(new Uint8Array(80), 80);
    expect(packets[0].length).toBe(84);
  });
});

describe('ota control packets', () => {
  it('start packets differ by mode', () => {
    expect(Array.from(startPacket(OTA_LEGACY))).toEqual([0x01, 0xff]);
    const ext = startPacket({ packetDataByteCount: 80, requiresScheduleAck: true });
    expect(ext.length).toBe(20);
    expect([ext[0], ext[1], ext[2]]).toEqual([0x03, 0xff, 80]);
  });
  it('end packet carries last index and its complement', () => {
    expect(Array.from(endPacket(0))).toEqual([0x02, 0xff, 0x00, 0x00, 0xff, 0xff]);
    expect(Array.from(endPacket(0x1234))).toEqual([0x02, 0xff, 0x34, 0x12, 0xcb, 0xed]);
  });
});

describe('ota firmware normalization', () => {
  it('truncates to the declared length when plausible', () => {
    const img = new Uint8Array(100);
    img[24] = 40; // declared length = 40 (LE)
    expect(normalizeFirmware(img).length).toBe(40);
  });
  it('keeps the image when the declared length is implausible', () => {
    const img = new Uint8Array(100);
    img[24] = 0xff;
    img[25] = 0xff;
    img[26] = 0xff;
    img[27] = 0xff; // declared > length
    expect(normalizeFirmware(img).length).toBe(100);
  });
});

describe('ota schedule-ack parsing', () => {
  it('reads 0xFF08 as an absolute cumulative count (never backwards)', () => {
    expect(parseScheduleAck(new Uint8Array([0x08, 0xff, 0x20, 0x00]), 16, 10, 100)).toBe(32); // 0x20 = 32
    expect(parseScheduleAck(new Uint8Array([0x08, 0xff, 0x05, 0x00]), 16, 10, 100)).toBe(10); // stale ack: don't rewind
    expect(parseScheduleAck(new Uint8Array([0x08, 0xff, 0xff, 0xff]), 16, 0, 100)).toBe(100); // clamp to total
  });
  it('converts 0xFF09 absolute bytes to packets', () => {
    expect(parseScheduleAck(new Uint8Array([0x09, 0xff, 0xa0, 0x00, 0x00, 0x00]), 16, 0, 100)).toBe(10); // 160/16
    expect(parseScheduleAck(new Uint8Array([0x00, 0x00]), 16, 0, 100)).toBeNull();
  });
});
