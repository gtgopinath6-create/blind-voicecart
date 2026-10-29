# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

VoiceCart is an e-commerce site built for blind and low-vision users: full keyboard/screen-reader support plus **Zoro**, an in-app voice shopping assistant ("Hey Zoro"). It's a two-part app: a CRA React frontend (`src/`) and a trusted Node/Express backend (`server/`). Firestore is the database; Firebase Auth handles sign-in; Groq provides the voice-intent LLM (optional — an offline parser is the fallback).

`my-app/` is a stray, unused CRA scaffold (just a `package.json`) — ignore it.

## Commands

Frontend (repo root):
```bash
npm install                  # .npmrc sets legacy-peer-deps for react-speech-kit
npm start                    # dev server on :3000, proxies /api to :5055
npm run build                # production build (prebuild regenerates the image manifest)
npm test                     # jest/react-scripts: run once, interactive watch by default
npm test -- --watchAll=false path/to/File.test.js   # run a single test file non-interactively
CATALOG_EMULATOR_HOST=127.0.0.1:8181 CI=true npm test -- catalogEmulator   # needs a running Firestore emulator
```

Backend (`server/`):
```bash
npm install
npm run dev                  # node --watch src/index.js, API on :5055
npm test                     # node --test test/unit/*.test.js
npm test -- test/unit/api.test.js   # single file
npm run test:emulator        # Firestore rules/checkout/wallet/admin against emulators; needs Java 21+
npm run set-admin -- person@example.com [--revoke]   # grant/revoke the `admin` custom claim
npm run fix-image-paths      # fix .png/.PNG case mismatches in stored image paths
npm run dedupe-products      # dry run by default; see flags in README before using --apply
```

Local emulator stack (for exercising sign-in/checkout/admin without touching real Firebase — exact env vars in README.md "Try sign-in, checkout and admin locally"):
```bash
cd server && npx firebase emulators:start --project demo-voicecart --only firestore,auth
# then run the API against the emulators, then the app against that API — see README for full env var sets
```

There is no top-level lint script; ESLint runs via `react-app`/`react-app/jest` config inside `react-scripts` (surfaces during `start`/`build`/`test`).

## Architecture

```
Browser (React, src/)                        Server (Node/Express, server/src/)
  ├─ Firestore SDK: products (read), own      ├─ POST /api/voice/intent      → Groq LLM (key stays server-side)
  │  cart/wishlist/name (write), guarded       ├─ POST /api/voice/transcribe  → Groq Whisper (key stays server-side)
  │  by firestore.rules                        ├─ POST /api/checkout/quote    → server-side totals
  └─ /api/* (Firebase ID token) ────────────▶ ├─ POST /api/checkout          → atomic, idempotent order
                                              ├─ POST /api/wallet/refill     → disabled without a payment provider
                                              └─ /api/admin/users…           → Firebase Admin SDK, admin claim only
```

Key invariant: **the server is the only source of truth for money and stock.** The browser never computes a price/total that is trusted at checkout; `server/src/checkout.js` re-reads prices/stock and `server/src/app.js` wires everything through `authenticate`/`requireAdmin`/`rateLimit` middleware (`server/src/http.js`). `createApp()` in `server/src/app.js` takes `{ config, firebase, fetchImpl }` as injected dependencies specifically so tests can swap in emulators/fakes — follow that pattern when adding routes.

Admin rights come **only** from the Firebase Auth custom claim `admin: true` (set via `npm run set-admin`, implemented in `server/src/adminUsers.js`); a legacy `admin` field on user documents is intentionally ignored anywhere you see user data.

### Voice assistant (Zoro) — the core subsystem

Zoro is implemented as a layered pipeline, each layer in its own service under `src/services/`:

- **State machine** — `voiceMachine.js`. States: `DISABLED → IDLE → WAKE_WORD_LISTENING/COMMAND_LISTENING → PROCESSING → AWAITING_CONFIRMATION/SPEAKING → PAUSED/ERROR`. Any new voice feature has to fit into this state graph, not bypass it.
- **Speech in** — `speechInput.js` has *two* capture engines behind the same `{ text, alternatives, confidence }` `onUtterance` contract, so nothing downstream needs to know which ran: `startRecognitionSession()` (Web Speech API, continuous, pause-based end-of-utterance detection) and `startWhisperSession()` (records via `MediaRecorder`, detects silence by polling input volume, uploads to `POST /api/voice/transcribe`). `GlobalAIVoiceAssistant.js`'s `pickEngine()` chooses between them per the `sttEngine` setting (`speechSettings.js`); **wake-word mode ("Hey Zoro") always uses Web Speech** — there's no passive-listening equivalent for upload-based transcription, so Whisper is command-mode only (mic button, Alt+V, a command right after the wake word).
- **Dialogue/slot-filling** — `zoroDialogue.js`, grounded against the real catalog in `shoppingCatalog.js`. It never lets the AI pick a product; it only maps spoken intent to catalog data and asks the user to confirm.
- **Server intent classification** — `POST /api/voice/intent` (`server/src/voice.js`) calls the Groq LLM and returns one intent from a fixed enum with optional entities. **Both** server and browser re-validate that response before any action is taken; if Groq is unavailable/rate-limited, `fallbackParser`-style offline parsing takes over (see `src/services/__tests__/fallbackParser.test.js`). A bare category word/synonym in a `SEARCH` target (e.g. "shoes") is redirected to the real category page by `categoryFromExactWords()` in `shoppingCatalog.js`, called from `executeAction()` in `voiceActions.js` — that's the single place all three input paths (LLM, offline parser, buttons) converge, so fix routing bugs there, not in the classifiers.
- **Server transcription** — `POST /api/voice/transcribe` (`server/src/transcribe.js`) calls Groq's hosted Whisper model and returns plain text only, no intent; that text re-enters the same classify-then-execute pipeline as typed text. Groq identifies audio format from the **uploaded filename's extension**, not the declared mime type — `transcribe.js`'s `filenameFor()` maps mime → extension; get this wrong and every transcription 400s.
- **Speech out** — `announcer.js`: one global speech queue, one voice/rate, text normalization for numbers/currency/units so a TTS voice doesn't mangle "₹1,49,999" or "UK 9".
- **Purchase safety rules** (don't relax these without explicit instruction): never substitutes a different product than named; unclear names get a disambiguation list; products ≥ ₹10,000 are read back for explicit "yes" before any action; checkout always requires a spoken/typed "yes, place order" or the Pay button, and success is only ever announced from the server's confirmation, never assumed client-side.
- **Passwords are never spoken or sent to the AI** — voice flow moves focus to the password field instead (see `Sign.js` + README "Sign-in by voice").

When touching any of this, `src/services/__tests__/zoroSecurity.test.js` and `voiceActions.test.js` encode the safety invariants above — treat failures there as blocking.

### Catalog reads and Firestore quota

`src/services/catalogService.js` is the **only** path for reading products client-side — it exists specifically to stay under Firestore's free-tier read quota (50k/day). It does paginated reads per screen, in-flight de-duplication, and a multi-minute cache (`invalidateCatalog()` must be called after any admin write). Do not add a new component that reads Firestore products directly; route it through this service. See the "Product reads and the Firestore quota" table in README.md for which screens read how much.

### Product images

Images are static files under `public/images`; `src/services/images.js` resolves a product's stored `image` path to the real file case-insensitively via the generated `src/imageManifest.json` (built by `scripts/generate-image-manifest.js`, run automatically before `start`/`build`/`test`). `ProductImage.js` is the only component that should render a product photo — it already handles missing/broken images and slow loads.

### Design system ("Noir Prestige")

All colors/spacing/type live as CSS custom properties in `src/styles/tokens.css` (semantic tokens like `--color-surface`, `--color-accent`) and shared primitives in `src/styles/base.css`. Components must consume the semantic tokens, never raw color values — this is what keeps the dark "Noir Prestige" theme and the light "Ivory" theme in sync and WCAG-AA compliant. Gold is reserved as an accent (nav underline, selected-state, one primary CTA per view) and is never used for body/button text.

## Environment & config

Frontend env vars are build-time and public (`REACT_APP_*` — never put secrets there). Server env vars (`server/.env` locally, real secrets when hosted) gate Firebase Admin creds, the Groq key (`GROQ_API_KEY`, shared by both `GROQ_MODEL` and `GROQ_WHISPER_MODEL`), CORS origins, and rate-limit proxy trust. `REACT_APP_VOICE_STT_MODE` force-picks the command-mode STT engine app-wide (`automatic`/`webspeech`/`whisper`), overriding each shopper's own setting — useful for rollout testing. Full variable tables are in README.md — read them before adding a new config knob rather than duplicating one.

Full deployment runbook (Cloud Run, Firebase Hosting, Firestore rules/indexes, key rotation) is in `DEPLOYMENT.md`; don't re-derive deployment steps, read that file.

## Testing notes

- Frontend tests use `jest-axe` for accessibility checks in several `__tests__` suites (`routesAndA11y.test.js`) — a11y regressions should fail these, not just be caught by manual review.
- `catalogEmulator.test.js` is excluded from the default `npm test` run and needs a live Firestore emulator (`CATALOG_EMULATOR_HOST`).
- Server `test/emulator/*` needs Java 21+ and runs through `firebase emulators:exec`; `test/unit/*` runs with plain `node --test` and no external services.
- Automated a11y checks (jest-axe/axe-core) catch many but not all accessibility issues — manual screen-reader testing (NVDA/VoiceOver) is still expected before release, per README.
