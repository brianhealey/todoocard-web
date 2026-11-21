# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repository.

## What this is

A browser app that flashes images onto TodooCard / T3 six-colour e-paper cards over **Web
Bluetooth**, plus a small Node API that proxies image search and AI image generation with
user-supplied keys. Unofficial; TodooCard is a Sunbelife product. MIT licensed, so **never copy
code from the vendor's tooling** (their repo has no licence) and **do not add QuickLZ** (GPL).
Protocol behaviour may be learned from observation and documentation only.

## Layout

- `shared/` pure TypeScript used by both sides; no DOM, no Node APIs.
  - `protocol.ts` constants (UUIDs, firmware thresholds, commands, status codes), advertisement and
    control-message parsing, diagnostics parsing.
  - `image.ts` Floyd–Steinberg six-ink dithering, nibble packing, T3 panel calibration
    (vertical flip), controller raster order.
  - `payload.ts` raw payload for v157+, QuickLZ *stored-block* container (framing only) for older firmware.
  - `ota.ts` Telink OTA codec (packets, CRC16/CRC32, schedule-ACK parsing).
  - `firmware.ts` the firmware image validator and flash gate (`inspectFirmware`, `flashVerdict`,
    `MIN_FLASHABLE_VERSION`, own SHA-256). See "Firmware catalog policy".
- `web/` Vite + React 18 + TypeScript. `web/src/lib/ble.ts` is the Web Bluetooth client
  (`TodooCardClient`), `web/src/lib/transfer.ts` the transfer state machine, `compose.ts` canvas
  composition, `api.ts` + `settings.ts` the backend client and localStorage settings,
  `ota.ts` the flasher, `firmware.ts` the catalog (bundled manifest + vendor merge),
  `diagnostics.ts` the read-only GATT survey and the diagnostics-file builder (schema v2: `mode`,
  `requestedServices`, `rejectedServices`, `limitations`; never remove a field older files had),
  `uuids.ts` pure UUID parsing, the generic-mode service list, the Web Bluetooth service
  blocklist and friendly names, `inspect.ts` the "Inspect any Bluetooth device" mode
  (`GenericInspector` + `surveyGeneric`).
  - `App.tsx` owns three top-level tabs (`components/Tabs.tsx`, ARIA tablist): **Send** (image
    workflow), **Firmware** (`FirmwarePanel`: all flashing, vendor check, recovery connect),
    **Troubleshoot** (`TroubleshootPanel` + `TroubleshootTools`). Panels stay mounted while
    hidden so a running transfer or OTA keeps its state; one `TodooCardClient` (`useClient`) is
    shared by all tabs. The Troubleshoot tab must never write to the card or start notifications.
  - Generic inspection (`acceptAllDevices`) keeps its device in `GenericInspector`, owned by
    `TroubleshootPanel`; never `attach()` that device to `TodooCardClient`, so Send and Firmware
    cannot act on a non-TodooCard. It uses its own operation queue, or `TodooCardClient.op()` when
    the chosen device is the client's own card. Put the per-read timeout inside the queued
    operation so a hung read cannot block the queue. On a TodooCard (FEF0/FDF0 or the diagnostics
    service) it must not read 2A19. Web Bluetooth cannot discover services that were not in
    `optionalServices` at chooser time; new defaults go in `STANDARD_SERVICES`.
- `server/` Hono on Node 22: `index.ts` routes, `firmware.ts` host-locked vendor update proxy
  (relays v185+ only), `proxy.ts` SSRF-guarded image fetch, `keys.ts`
  key resolution (client keys first, env second), `ratelimit.ts`, `providers/{search,generate}/*`.
- `tests/` vitest. `tests/fixtures/expected*.bin` were produced by the vendor converter from
  `upright.png`; `image.test.ts` requires byte-identical output. Do not regenerate the expected
  files without that converter; do not "fix" a parity failure by editing the fixture.
- `deploy/` Dockerfile companions: k8s manifests, docker-compose, Cloudflare Tunnel notes.

## Commands

```bash
npm run dev          # vite :5173 (proxies /api) + tsx watch server :8787
npm test             # vitest (protocol parsing, pipeline, vendor parity, firmware validator + manifest)
npm run typecheck    # both tsconfigs (web: Bundler resolution, server: NodeNext)
npm run build        # dist/web + dist/server; `npm start` serves both on :8787
docker build -t todoocard-web .   # image runs as numeric USER 100:101
```

Shared modules import siblings with a `.js` extension (`./protocol.js`) so they compile under
NodeNext; keep that convention.

## Protocol facts (verified on firmware v187, card model T3)

- Manufacturer data company id `0x5053`, screen type `0x134C`; flags bit 0x01 encrypted GATT,
  0x02 pairing window open, 0x08 OTA recovery (refuse sends), 0x10 Turbo Link.
- Web Bluetooth has no advertisement access without a Chrome flag, so firmware comes from Device
  Information `0x2A26` (string like `0xBB` = v187) and flags appear only if `watchAdvertisements()` exists.
- Pairing proof is a successful read of the **encrypted Battery Level (180F/2A19)**; the OS creates
  the bond then. The card drops unbonded centrals within ~1 s unless its physical pairing window is
  open (hidden flush rear button held ~5 s, 60 s window).
- Control FEF1: `01` → `01 <blockSize> 00`; `02 <len u32le> <flags>` → `02 00`; `03` starts; device
  sends `05 00 <index u32le>` block requests / checkpoints; `05 08` = refresh done; `05 01/09/0A` =
  errors. Data FEF2: `<index u32le> + payload` (blockSize − 4 bytes, 240 in practice).
- v157+ (`0x9D`): windows of 32 blocks, last write with response, wait ≤5 s for the checkpoint, lower
  index = repair, max 16 repairs; success only on `05 08`. Flags `0x03` = raw controller bitmap
  (what we send), `0x01` = QuickLZ container.
- Chrome allows one GATT operation at a time per device: route everything through
  `TodooCardClient.op()`. Pass real `ArrayBuffer`s to `writeValue*` (TS 5.7 BufferSource typing).
- A v187 card transferred 872 blocks in ~9 s from Chrome; it disconnects after `05 08` while it
  redraws, so a post-send disconnect is expected.

## Firmware catalog policy

- **Nothing below v185, ever.** Bundled: v187 (latest; from vendor Android app 1.2.22, the vendor
  API still reports v185) and v185. Do not re-add the `SE0368NW40-T3-1.0.*` images: 1.0.4–1.0.10
  have a damaged link-layer empty-packet template (`02000000 ffffffff` instead of
  `02000000 01000000` at the end of `.data`), so a card running them cannot hold a connection with
  any standard controller; one had to be rescued with a custom nRF52840 link layer
  (`todoocard-firmware/docs/recovery-log.md`).
- Every flash goes through `flashVerdict(inspectFirmware(image))` inside `runOtaUpdate()`; do not
  add a path that bypasses it. It enforces the card's own rules (KNLT at 8, declared size at 0x18
  == length, size > 0x3fff, <= 0x1f000, `size & 0xf == 4`, crc32(file) == 0xFFFFFFFF), the
  empty-packet template in the last 32 bytes before the CRC trailer, and version >= 185 (known
  hash, else the embedded `0xNN` revision string, else the catalog's build number).
- The Firmware tab carries a prominent own-risk / no-warranty / no-liability disclaimer and an
  acknowledgement checkbox that gates every flash (reset after each one). Keep both; do not
  weaken the wording or make the acknowledgement sticky.
- Adding a firmware: put the `.bin` and its `<sha256>.proof.json` in `web/public/firmware/`, add
  the manifest entry (exactly one `latest`, the highest build) and the hash in `KNOWN_FIRMWARE`.
  `tests/firmware.test.ts` checks every listed file (size, sha256, CRC, proof) and fails on any
  unlisted `.bin` or any version below 185.
- Advertisement byte 3 is a flag byte only on firmware >= v140; below that it is a battery
  reading (`decodeManufacturerData`). Legacy 1.0.x advertises as `TodooCard-<MAC>`, or
  `TodooRescue` on external power; that is not a recovery mode.

## Backend rules

- `/api/*` requires `X-App-Token` when `APP_ACCESS_TOKEN` is set, **except `/api/health`** (probes).
- Keys: client keys in the request body win when `ALLOW_CLIENT_KEYS` is true; otherwise env.
  Never log or persist keys.
- `/api/image` must stay SSRF-safe: http(s) only, public addresses only (DNS-resolved), manual
  redirects re-checked, 25 MB cap, image content types only.
- Adding a provider: one file in `server/providers/search` or `generate` implementing
  `SearchProvider`/`GenerateProvider` plus registration in `server/providers/index.ts`. Declare
  `fields` (secret flag, optional) and `env` names; the UI renders them automatically.
- Openverse anonymous API caps `page_size` at 20.

## Deployment

- CI (`.github/workflows/ci.yml`) runs typecheck/test/build and publishes multi-arch
  `ghcr.io/brianhealey/todoocard-web` with tags `latest`, `main`, `sha-<7>`.
- Brian's instance: cluster-iac repo, `cluster-manifests/apps/todoocard-web` (pinned `sha-` tag,
  bump to roll) behind `apps/cloudflared`; public https://todoo.hee-hee.net, LAN
  https://cards.homelab.local. Pods run with `runAsNonRoot`; the image user must stay numeric.

## Testing against a real card

Web Bluetooth's device chooser is a native dialog the user must click. Build, run `npm run dev`,
and ask the user to click Connect; verify with the in-app log (enable debug in Settings). Never
send to a card without the user's explicit go-ahead: it replaces the display.
