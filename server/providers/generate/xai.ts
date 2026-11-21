import type { Aspect } from '../../../shared/api.js';
import type { GenerateProvider, ModelInfo } from '../types.js';
import { base64ToBytes, upstreamJson } from '../types.js';

/**
 * xAI Grok Imagine. Facts from docs.x.ai (checked 2026-11-20): POST /v1/images/generations with
 * `model`, `prompt`, `n`, `response_format` ("url" | "b64_json"), `aspect_ratio` and `resolution`
 * ("1k" | "2k"); `quality` ("low" | "medium" | "auto") is accepted by grok-imagine-image-2.0 only.
 * There is no documented endpoint for listing image models, so the list here is static.
 */
export const XAI_DEFAULT_MODEL = 'grok-imagine-image-2.0';
export const XAI_IMAGE_MODELS: ModelInfo[] = [
  { id: 'grok-imagine-image-2.0', label: 'Grok Imagine Image 2.0', recommended: true },
  { id: 'grok-imagine-image', label: 'Grok Imagine Image' },
];

const RESOLUTIONS = new Set(['1k', '2k']);
const QUALITIES = new Set(['low', 'medium', 'auto']);

/** Build the request body. Exported for tests. */
export function xaiImageRequest(prompt: string, aspect: Aspect, keys: Record<string, string>, options: Record<string, string>): Record<string, unknown> {
  const model = (options.model || keys.model || XAI_DEFAULT_MODEL).trim();
  const body: Record<string, unknown> = { model, prompt, n: 1, response_format: 'b64_json', aspect_ratio: aspect };
  const resolution = (options.resolution || keys.resolution || '').trim().toLowerCase();
  if (resolution) {
    if (!RESOLUTIONS.has(resolution)) throw new Error(`xAI resolution must be 1k or 2k, not "${resolution}"`);
    body.resolution = resolution;
  }
  const quality = (options.quality || keys.quality || '').trim().toLowerCase();
  if (quality) {
    if (!QUALITIES.has(quality)) throw new Error(`xAI quality must be low, medium or auto, not "${quality}"`);
    // Only grok-imagine-image-2.0 documents the quality parameter; leave it out for other models.
    if (model.startsWith('grok-imagine-image-2')) body.quality = quality;
  }
  return body;
}

/** xAI's examples return JPEG, but the format is not guaranteed, so sniff it. */
export function sniffImageType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  return 'image/jpeg';
}

export const xai: GenerateProvider = {
  descriptor: {
    id: 'xai',
    kind: 'generate',
    name: 'xAI Grok Imagine',
    homepage: 'https://docs.x.ai/docs/guides/image-generations',
    notes: 'Grok image generation. The card’s 2:3 portrait aspect ratio is requested directly. Billed per image by xAI, including images refused by its usage policy.',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'model', label: 'Model', optional: true, placeholder: XAI_DEFAULT_MODEL, help: 'grok-imagine-image-2.0 (default) or grok-imagine-image.' },
      { key: 'quality', label: 'Quality', optional: true, placeholder: 'auto', help: 'low, medium or auto (grok-imagine-image-2.0 only). Low is plenty for a six-colour e-paper panel.' },
      { key: 'resolution', label: 'Resolution', optional: true, placeholder: '1k', help: '1k or 2k. The panel is 528×792, so 1k is enough.' },
    ],
  },
  env: { apiKey: 'XAI_API_KEY', model: 'XAI_IMAGE_MODEL', quality: 'XAI_IMAGE_QUALITY', resolution: 'XAI_IMAGE_RESOLUTION' },
  async listModels() {
    return XAI_IMAGE_MODELS;
  },
  async generate(prompt, aspect, keys, options) {
    const body = xaiImageRequest(prompt, aspect, keys, options);
    const data = await upstreamJson<{ data?: Array<{ b64_json?: string; revised_prompt?: string }> }>(
      'https://api.x.ai/v1/images/generations',
      { method: 'POST', headers: { authorization: `Bearer ${keys.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(170000) },
      'xAI',
    );
    const item = data.data?.[0];
    if (!item?.b64_json) throw new Error('xAI returned no image data');
    const bytes = base64ToBytes(item.b64_json);
    return {
      bytes,
      contentType: sniffImageType(bytes),
      meta: { model: body.model, aspectRatio: aspect, resolution: body.resolution, quality: body.quality, revisedPrompt: item.revised_prompt },
    };
  },
};
