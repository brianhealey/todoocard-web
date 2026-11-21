import { describe, expect, it } from 'vitest';
import { sniffImageType, xaiImageRequest, XAI_DEFAULT_MODEL } from '../server/providers/generate/xai';
import { generateProviders } from '../server/providers';

describe('xAI Grok image provider', () => {
  it('is registered with a secret API key field', () => {
    const p = generateProviders.xai;
    expect(p.descriptor.kind).toBe('generate');
    expect(p.descriptor.fields.find((f) => f.key === 'apiKey')?.secret).toBe(true);
    expect(p.env.apiKey).toBe('XAI_API_KEY');
  });
  it('requests the card aspect ratio as base64 with the default model', () => {
    expect(xaiImageRequest('a cat', '2:3', { apiKey: 'k' }, {})).toEqual({ model: XAI_DEFAULT_MODEL, prompt: 'a cat', n: 1, response_format: 'b64_json', aspect_ratio: '2:3' });
  });
  it('passes quality only to the 2.0 model and validates values', () => {
    expect(xaiImageRequest('p', '1:1', {}, { quality: 'Low', resolution: '2K' })).toMatchObject({ quality: 'low', resolution: '2k' });
    expect(xaiImageRequest('p', '1:1', {}, { model: 'grok-imagine-image', quality: 'low' })).not.toHaveProperty('quality');
    expect(() => xaiImageRequest('p', '1:1', {}, { quality: 'ultra' })).toThrow(/quality/);
    expect(() => xaiImageRequest('p', '1:1', {}, { resolution: '4k' })).toThrow(/resolution/);
  });
  it('prefers request options over stored keys', () => {
    expect(xaiImageRequest('p', '3:2', { model: 'grok-imagine-image' }, { model: 'grok-imagine-image-2.0' }).model).toBe('grok-imagine-image-2.0');
  });
  it('sniffs the returned image type', () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
  });
});
