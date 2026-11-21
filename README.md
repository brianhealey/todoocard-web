# TodooCard Web

Flash pictures onto TodooCard / T3 six-colour e-paper cards straight from Chrome.
No app to install: the page talks to the card over **Web Bluetooth**, prepares the
image in the browser (crop, rotate, six-ink dithering, panel calibration) and
sends it with the card's verified-window transfer protocol. An optional small
backend lets you **search the web for images** and **generate images with AI**
using your own API keys.

> Unofficial project. TodooCard is a product of Sunbelife; this tool is not
> affiliated with or endorsed by them.

## Features

- **Pair and inspect** a card: model, serial, firmware, hardware revision, battery,
  bond state and (when the browser exposes advertisements) capability flags.
- **Upload** JPEG/PNG/WebP/GIF, drag-and-drop or paste. Images never leave the browser.
  EXIF orientation is honoured.
- **Editor**: fill or fit, rotate, zoom, pan, background colour, brightness,
  contrast and saturation, with a live preview of the dithered six-ink result and
  an ink-usage bar.
- **Search** images via Openverse or Wikimedia Commons (no key), Pexels, Unsplash,
  Pixabay, Google Programmable Search, Brave or SerpApi (your key).
- **Generate** images with OpenAI GPT Image (newest model your key can use, e.g.
  gpt-image-2.6-flare; gpt-image-1 was retired by OpenAI in October 2026), Stability AI,
  Google Imagen or Replicate (FLUX etc.), with the card's 2:3 aspect ratio.
- **Send** with progress, cancel, protocol log and the card's refresh acknowledgement
  as the only success signal.
- **Firmware** tab: flash the bundled firmware (v187, or v185) over the card's Telink OTA
  channel, check the vendor update service, and reconnect to a card in OTA recovery without pairing.
  Every image is validated before a byte is sent (see [Firmware policy](#firmware-policy)).
- **Troubleshoot** tab: connect without pairing, see what the card advertises, list its
  services and characteristics, read the diagnostics records, and build a diagnostics JSON file
  to attach to a bug report. Also a firmware file checker, an advertisement decoder and a symptom guide.

## Requirements

- Chrome or Edge (desktop, Android, ChromeOS). Safari and Firefox do not implement Web Bluetooth.
- A secure origin: `https://` or `http://localhost`.
- On macOS, Chrome needs Bluetooth permission (System Settings → Privacy & Security → Bluetooth).
- A TodooCard / T3 528×792 card. Firmware v157 (0x9D) and newer is tested; older firmware uses the legacy path (untested).

## Quick start

```bash
# with Docker
docker run --rm -p 8787:8787 ghcr.io/brianhealey/todoocard-web:latest
# open http://localhost:8787

# or from source (Node 20+)
npm install
npm run dev        # web on :5173 (proxying /api), API on :8787
npm run build && npm start
```

Provider keys can be entered in **Settings** in the browser (stored in that browser's
localStorage and sent only inside the request that uses them) or configured server-side
through environment variables (see `.env.example`). When both exist, the browser key wins.

## Pairing the card

The card only accepts a new computer while its physical pairing window is open.

1. Find the button on the back. It is **flush and invisible**, under the surface near an edge; press firmly.
2. Hold it about 5 seconds until the front light flashes quickly. The window stays open for 60 seconds.
3. Click **Connect card**, pick the card in Chrome's chooser, and accept the system pairing prompt if one appears.
4. The app reads the encrypted Battery Level characteristic. Success means the bond exists; that is the same proof the vendor tooling uses. Once bonded, the card reconnects without the button.

A card that disconnects about a second after connecting is refusing an unbonded computer: reopen the window and try again.

## The three tabs

The connection is shared: connect on any tab and the others see the same card.

- **Send** is the image workflow: connect and pair, pick or generate a picture, edit, send.
- **Firmware** holds everything that flashes: the firmware list, the vendor update check, the
  update log, and *Connect for recovery (no pairing)* for a card that is in OTA recovery or shows
  no firmware version.
- **Troubleshoot** never writes to the card. *Choose card and connect* opens a GATT-only link and
  reads Device Information, the two diagnostics records and the OTA characteristic; the encrypted
  Battery Level is read only when you press its button, because that starts pairing. With
  `chrome://flags/#enable-experimental-web-platform-features` enabled it also decodes the card's
  advertisements (firmware, pairing window, OTA recovery). *Build diagnostics file* downloads
  `todoocard-diagnostics-<timestamp>.json`; it contains no API keys and nothing from Settings, but
  it does contain the card's name, serial and Bluetooth identity.

Tabs are addressable (`#send`, `#firmware`, `#troubleshoot`) and keyboard accessible (arrow keys, Home, End).

## Firmware policy

> **Disclaimer: flashing firmware is entirely at your own risk.** It can permanently brick a card,
> and a card that no longer connects over Bluetooth cannot be repaired from a browser, a phone or
> the vendor app. This is an unofficial tool, not made, endorsed or supported by Sunbelife; it is
> provided "as is" without warranty of any kind (see `LICENSE`), and the author and contributors
> accept no responsibility or liability for bricked or damaged cards, lost images, voided
> warranties or any other consequence. The checks described below reduce the risk; they do not
> remove it. The Firmware tab shows this disclaimer and requires an explicit acknowledgement
> before every flash.

**Nothing below v185 is bundled or accepted.** The app used to offer the legacy images
`SE0368NW40-T3-1.0.2 … 1.0.10`. Flashing 1.0.10 left a card unusable over Bluetooth: in images
1.0.4–1.0.10 the link layer's empty-packet template (the last words of `.data`) is
`02000000 ffffffff` instead of `02000000 01000000`, so the card's idle packets are malformed and no
standard Bluetooth controller can hold a connection to it. Recovering that card took a custom link
layer on an nRF52840. 1.0.2 and 1.0.3 are intact but have no pairing and no recovery channel, so
they are gone too.

- Bundled: **v187** (newest, from the vendor Android app 1.2.22; the vendor update API still
  reports v185 as its newest stable release) and **v185** (previous stable). `web/public/firmware/manifest.json`
  lists size, sha256, CRC32 trailer and the vendor's recovery proof for each.
- `shared/firmware.ts` is the guard. `inspectFirmware()` checks what the card enforces (`KNLT` at
  offset 8, declared size at 0x18 equal to the file length, size > 0x3fff, ≤ 0x1f000 and
  `size & 0xf == 4`, CRC32 over the file equal to 0xFFFFFFFF) plus what it does not: the
  empty-packet template in the last 32 bytes before the CRC trailer. `flashVerdict()` then refuses
  anything invalid, anything from the 1.0.x line and anything whose version is below 185.
  `runOtaUpdate()` calls it before touching the card, so the rule holds for bundled images,
  vendor-fetched images and any source added later. The server applies the same floor to releases
  it relays from the vendor service.
- A card that is already on 1.0.4–1.0.10 cannot be fixed from a browser; the symptom guide on the
  Troubleshoot tab says what it needs.

## How it works

```
image ─▶ canvas 528×792 (fit/rotate/adjust) ─▶ Floyd–Steinberg to 6 inks ─▶ panel calibration
      ─▶ controller byte order ─▶ BLE: 01 (block size) · 02 (length+flags) · 03 (start)
      ─▶ 32-block windows on FEF2, Flash checkpoint acks on FEF1 ─▶ 05 08 refresh ack
```

- Inks: black 0, white 1, yellow 2, red 3, blue 5, green 6; two pixels per byte, high nibble first.
- Panel calibration for T3 is a vertical flip of the upright image, then the SE0368-class
  controller raster order. The unit tests check both bitmaps byte-for-byte against output of the
  vendor converter (`tests/fixtures`).
- Firmware v157+ accepts either a QuickLZ stream or the **raw controller bitmap**; this project
  sends the raw bitmap (about 15 % more bytes, no GPL compression code). Firmware before v157 gets
  the QuickLZ *stored-block* container, which is framing only.
- Transfers are windowed: at most 32 blocks, the last with a write-with-response, then wait up to
  5 s for the device's durable checkpoint. A lower index is a repair, not a restart. The display
  only counts as updated after the `05 08` acknowledgement. On v165+ the retained image-ACK
  diagnostics are read after a failure.

Web Bluetooth cannot read advertisements without a Chrome flag, so firmware is read from the
Device Information service (`0x2A26`, e.g. `0xBB` = v187) and the capability flags are shown only
when `watchAdvertisements()` is available.

## Backend API

| Route | Purpose |
|---|---|
| `GET /api/health` | liveness |
| `GET /api/config` | providers, which have server keys, whether an app token is required |
| `POST /api/search` | `{provider, query, page?, orientation?, keys?}` → normalised results |
| `POST /api/generate` | `{provider, prompt, aspect, keys?, options?}` → image bytes |
| `POST /api/models` | `{provider, keys?}` → image models the key can use (OpenAI), best first |
| `GET /api/firmware/check?current_build=&recovery=` | asks the vendor update service for a newer T3 release (v185+ only) |
| `GET /api/firmware/artifact/:id/:kind` | relays a vendor release (`download`) or its recovery proof (`proof`); host-locked, no client URL |
| `GET /api/image?url=` | CORS-free image fetch with SSRF protection (public hosts only, 25 MB, image types only) |

Environment variables: `PORT`, `APP_ACCESS_TOKEN` (when set, clients must send `X-App-Token`),
`ALLOW_CLIENT_KEYS` (default `true`), and per-provider keys: `PEXELS_API_KEY`,
`UNSPLASH_ACCESS_KEY`, `PIXABAY_API_KEY`, `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX`, `BRAVE_SEARCH_KEY`,
`SERPAPI_KEY`, `OPENAI_API_KEY`, `STABILITY_API_KEY`, `GEMINI_API_KEY`, `REPLICATE_API_TOKEN`.
Requests are rate limited per client IP (search 60/min, generate 10/min, image 120/min).

Adding a provider is one file in `server/providers/search` or `server/providers/generate`
plus a line in `server/providers/index.ts`.

## Deployment

- `Dockerfile` builds a small multi-arch image; CI publishes `ghcr.io/brianhealey/todoocard-web` on every push to `main`.
- `deploy/k8s/` has a Deployment, Service and example Ingress. `deploy/cloudflared.md` explains exposing it through a Cloudflare Tunnel (Web Bluetooth needs https).
- `deploy/docker-compose.yml` for a single host.

Protect a public instance with `APP_ACCESS_TOKEN` or Cloudflare Access; otherwise anyone can use your server-side keys and image proxy.

## Development

```bash
npm run dev          # vite + tsx watch
npm test             # vitest: protocol parsing, pipeline, vendor parity, firmware validator, manifest integrity
npm run typecheck
npm run fixtures     # regenerate tests/fixtures/upright.png (expected.*.bin come from the vendor converter)
```

Layout: `shared/` (protocol constants, image pipeline, payload builders, OTA codec, firmware validator: pure TS used by both sides),
`web/` (React + Vite app, Web Bluetooth client and transfer state machine in `web/src/lib`),
`server/` (Hono API and providers), `tests/`, `deploy/`.

## Known limitations

- No QuickLZ compression (raw bitmap on v157+, roughly 60–90 s per image over BLE).
- Pre-v157 firmware path is implemented from the documented behaviour but has not been run against a device.
- Capability flags (pairing window open, OTA recovery, Turbo Link) need `chrome://flags/#enable-experimental-web-platform-features` for advertisement access; without it the app relies on the device refusing unbonded links.
- HEIC input is not decodable by Chrome; convert first.

## Credits

Protocol behaviour was learned from Sunbelife's public
[TodooCard Skills](https://github.com/Sunbelife/TodooCard_Skills) macOS tooling and from
observing a v187 card. All code here is original and MIT licensed.
