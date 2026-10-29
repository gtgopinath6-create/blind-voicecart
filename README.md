# VoiceCart – E-Commerce Website for Visually Impaired Users

An online store built for blind and visually impaired shoppers: every task can be done with the keyboard, a screen reader, or a conversation with **Zoro**, the built-in voice assistant ("Hey Zoro").

## Team

1. Kartik Menon
2. Param Kothari
3. Kashish Hemrajani

## Features

1. **Zoro, the voice assistant.** Press the microphone button (or **Alt+V**), or switch on "Listen for *Hey Zoro*", and talk naturally. Zoro asks follow-up questions, reads out the real options, and checks every important answer with you. Examples:
   - "I'm looking for shoes", "I need black sports shoes in size 9", "something comfortable for my daily walks"
   - "add Nike Air Force 1 to my cart", "read my cart", "check out", "place my order", "sign in", "create an account"
   - "repeat that", "speak more slowly", "go back one step", "start over", "what are my options", "stop listening"
2. **Built-in screen reader**: reads what you hover or move the keyboard focus to. Turn it off when you use NVDA, JAWS or VoiceOver; announcements then go to an ARIA live region so nothing is read twice.
3. **Noir Prestige design** (dark, the default) with an **Ivory** light theme, visible keyboard focus everywhere, and a "Skip to main content" link.
4. **Admin panel** for products and users (administrators only).
5. Search, brand filters, cart, wishlist, wallet and checkout.

### Purchase safety

- The assistant never adds a different product from the one you named. Unknown names are reported, unclear names get a numbered list to choose from, and products priced ₹10,000 or more are read back for a "yes" first.
- "Buy …" adds to the cart and opens billing. Money is only spent after you say **"yes, place order"** to a spoken summary of the total, or press **Pay**.
- Prices, totals, stock and the wallet balance are checked by the server; the browser cannot change them.

### Browser support for voice

Spoken **commands** (the microphone button, Alt+V, or a request right after "Hey Zoro") use one of two engines, chosen automatically unless set otherwise in "Listening and speech settings":
- The browser's own Web Speech API, in **Chrome and Edge** (desktop and Android) and **Safari** (14.1+, not tested in this project). In Chrome, speech is processed by Google's servers (Edge: Microsoft, Safari: Apple), so it needs an internet connection.
- Where that is unavailable (Firefox, and other browsers without it) — or when "Server transcription (Whisper)" is chosen — the browser records one command with `MediaRecorder` and uploads it to `POST /api/voice/transcribe`, which transcribes it with Groq's hosted Whisper model (`server/src/transcribe.js`). The recording is discarded after transcription; nothing is kept on the server. This needs `GROQ_API_KEY` configured on the server (see "Server environment" below) and an internet connection; without either, this engine is unavailable and Zoro falls back as described below.

The **"Hey Zoro" wake-word listener** always uses the Web Speech API (there is no passive, always-listening equivalent for uploaded audio), so it only works in browsers that support it, only while the VoiceCart tab is open, and only once you have switched it on. It is not a background, low-power, on-device wake-word detector (see "Zoro" below).

Wherever voice input is missing or fails — in either engine — Zoro still works by typing ("Type to Zoro" in its panel), and the rest of the site works fully by keyboard. `REACT_APP_VOICE_STT_MODE` can force one command-mode engine for everyone on a build (see `.env.example`).

## Zoro voice assistant

**Listening states** ([src/services/voiceMachine.js](src/services/voiceMachine.js)): `DISABLED` (microphone blocked), `IDLE` (off), `WAKE_WORD_LISTENING`, `COMMAND_LISTENING`, `PROCESSING`, `AWAITING_CONFIRMATION`, `SPEAKING`, `PAUSED` (two minutes without activity, or while you type a password), `ERROR` (said once, then Zoro listens for the same answer again). Speech is acted on only after the microphone button, Alt+V, or "Hey Zoro". Recognition is off while Zoro speaks, and anything that repeats its last sentence is ignored, so it never answers itself. One utterance runs one command. The status line says what is really happening: "Starting the microphone", "Listening", "Thinking", "Speaking", "Waiting for your answer", "Ready for you to type", "Paused".

**Listening** ([src/services/speechInput.js](src/services/speechInput.js)):
- Recognition runs in continuous mode. Zoro decides you have finished after a short pause following your last words, so "I'm looking for… black shoes" is one request. Before this, the browser's single-phrase mode ended at the first pause and only "I'm looking for" was used. The pause is a setting: "Wait after I stop talking", Short, Normal or Long (0.5, 0.9 or 1.8 s).
- Only final results are acted on. Words still being recognised are shown, never used; if the browser is slow to finalise them, Zoro asks it to.
- The language is a setting ("Language I listen for", English (India) by default; also US, UK, Australian, Canadian, Irish, New Zealand and South African English), remembered on the device. A language the browser cannot recognise is reported, and Zoro switches to typing. Choosing a language does not guarantee accurate recognition: that depends on the browser's recognition service, the microphone, the accent and the room.
- The browser is asked for up to 3 hearings of each phrase. A second hearing is used only to understand an answer that is then read back for a yes: heard "lack", second hearing "black" → "You'd prefer black. Is that correct?". It is never used for a yes, for consent or for a new command. A "yes" the browser rates below 0.5 confidence is asked again, never taken as consent.
- Where a number or colour is the expected answer, common sound-alikes count: "size for" is size 4, a lone "read" is red, "blew" is blue. Each is read back first. Numbers keep their decimals ("nine point two" is 9.2 and is reported as not a whole or half size, never rounded); "9½", "9 1/2", "ten and half", "3k" and "1.5 lakh" are understood. Answers such as "haan", "nahi", "No, I said size ten" and "don't add it" are understood, and polite words never hide a command ("can you repeat that please").
- Problems are explained in plain words (microphone blocked or missing, no internet for recognition, unsupported language), never as error codes. A transient problem is said once and retried quietly; after three in a row, or a microphone that keeps stopping at once, Zoro switches to typing instead of restarting forever.

**Typing.** The panel's "Type to Zoro" box takes the same requests and answers as speech, works without a microphone (and in browsers without speech recognition), and interrupts Zoro if it is talking. After two misheard answers in a row, Zoro suggests it.

**Wake phrase.** Browsers have no on-device wake-word API. When you switch on "Listen for Hey Zoro", the page keeps the browser's speech recognition running while the tab is open (in Chrome, audio goes to Google's speech service) and reacts only to phrases starting with "Hey Zoro". A local detector (for example Picovoice Porcupine with a custom "Hey Zoro" model, or Vosk in WebAssembly) would need a trained model and, for Porcupine, an access key, so it is not included. The microphone button and Alt+V always work.

**Inactivity.** After two minutes with no request or answer (counted from when Zoro stops talking), Zoro says "I've paused listening because there has been no activity…" and releases the microphone. With "Hey Zoro" on, it goes back to waiting for the wake phrase. The conversation is kept, so pressing the microphone resumes the open question. Anything that could spend money or add to the cart is dropped on pause.

**Conversation** ([src/services/zoroDialogue.js](src/services/zoroDialogue.js)) runs in memory only:
- Discovery: category → type → colour → size → a numbered list of matches → a full read-back ("You selected Nike Air Force 1, black, size 9, for ₹9,000. Shall I add this item to your cart?") → added only after "yes". Details you already gave are not asked again; corrections ("actually blue", "change my size to 10", "show cheaper options", "go back one step") keep the rest of the conversation.
- Types, colours, sizes and prices come from the catalog. Spoken words such as "gym" or "walking" map to the closest real sub-category ([src/services/shoppingCatalog.js](src/services/shoppingCatalog.js)) and Zoro says when a match is only the closest one. Nothing is ever picked for you.
- Yes/no answers accept natural phrasing ("that's right", "not quite"). Anything unclear is asked again, never taken as yes.
- Answers to Zoro's questions (email, mobile number, address, measurements) are parsed in the browser ([src/services/speechParsers.js](src/services/speechParsers.js)) and never sent to the AI service.

**Sign-in by voice.** Zoro offers email and password, Google, creating an account, or continuing as a guest. It captures the email by voice, spells it back, and fills the field after "yes". **Passwords are typed, never spoken**: speech goes through the browser's speech service and could be overheard. So Zoro moves focus to the password field (password managers work) and pauses until the sign-in page reports the result. Google sign-in opens a pop-up, which needs a key press, so Zoro moves focus to that button. After signing in, Zoro welcomes you on the home page. Failures use the sign-in page's existing messages, which do not reveal whether an account exists.

**Sizes.** Zoro asks whether you know your size. If not, it may note your height and weight but says plainly that they cannot determine shoe size. It then asks for the size of a pair that fits, or your foot length, and can explain how to measure. A foot length is converted only with a **verified brand size chart** in `SIZE_CHARTS` and a known catalog sizing system in `STORE_SHOE_SIZE_SYSTEM` ([src/services/sizeGuide.js](src/services/sizeGuide.js)). Both are empty because the catalog does not say whether its sizes are UK or US, and no chart has been verified. Sizes are never converted between UK, US and EU. Only sizes the product actually lists can be chosen.

**Checkout by voice.** "Check out" reads the server-calculated cart total and asks before opening the billing page. Zoro then asks for each missing delivery detail, reads it back (digits one by one), and fills it after "yes". The order needs an explicit "yes, place order" and goes through the same idempotent server checkout as the Pay button. Success is announced only from the server's confirmation.

**AI.** `POST /api/voice/intent` returns one intent from a fixed list (now including `FIND_PRODUCT`, `SIGN_IN`, `REGISTER`, `HELP`) plus optional entities: `productQuery`, `category`, `productType`, `brand`, `color`, `size`, `sizeSystem`, `budgetMax`, `quantity`, `confirmation`, `correction`, `needsClarification`. Server and browser both validate them, and the browser grounds them in the catalog. Without the AI, the offline parser handles the same requests. `POST /api/voice/transcribe` is the separate speech-to-text step described in "Browser support for voice" above: it only returns text, never an intent, and that text goes through the same classify-then-execute pipeline as typed text. Nothing is sent to either endpoint while a password field has focus.

**Speech output** ([src/services/announcer.js](src/services/announcer.js)). All speech in the app (Zoro, page announcements, focus and hover reading) goes through one queue with one voice and one speed:
- The voice is the best installed voice for the chosen English, Indian English first (on a Mac, "Rishi"), and stays the same for the whole conversation. Novelty voices are never chosen. You can pick another voice in the settings; a chosen voice that is not installed on this device falls back to the automatic choice. Voices load after the page, so the choice is made once they arrive ("voiceschanged").
- The normal speed is 0.95, a starting point that still needs tuning by ear. The panel has Slower and Normal speed buttons; "speak more slowly", "slow down", "speak normally" also work. Speed is remembered on the device.
- Text is made speakable without changing any value: "₹1,49,999" is spoken as "149999 rupees" (Indian digit grouping confuses non-Indian voices), "128 GB" as "128 gigabytes", "UK 9" as "U K 9". Phone numbers and pincodes are read back in short groups ("9 8 7 6 5, 4 3 2 1 0"). Web addresses are never read.
- Long replies are spoken one sentence group at a time. This avoids Chrome cutting long utterances off, and lets "Stop speaking" and then "Resume reply" (or saying "resume") carry on where Zoro stopped. "Repeat" (or "repeat that") says the last reply again, and the same question stays open. "Mute voice" (or "mute") shows replies without speaking them; they then go to the live region for your own screen reader.
- One speaker at a time: a new message replaces the one being spoken, and never talks over it. Hovering never interrupts Zoro or a message, and moving the mouse away stops only hover reading. Focus and hover reading start a moment later, so a click that turns Zoro on cancels them before they reach the browser. (In Chrome on macOS, an utterance cancelled the moment it was queued could stop all later speech. This was seen while testing this app.) A part the browser does not start is nudged, then skipped, so speech never stalls.
- Esc or "Stop speaking" interrupts. Zoro cannot hear you while it is speaking, because the microphone is off then.

Testing on real devices: see [ZORO_SPEECH_TESTING.md](ZORO_SPEECH_TESTING.md).

## Design system ("Noir Prestige")

- **Tokens** live in [src/styles/tokens.css](src/styles/tokens.css): the palette (noir, obsidian, deep charcoal, dark walnut, muted champagne and antique gold, ivory, soft ivory, muted taupe, graphite, and success, error and warning colours), then semantic tokens (`--color-background`, `--color-surface`, `--color-surface-elevated`, `--color-text-primary`, `--color-accent`, `--font-display`, `--radius-card`, `--space-section` and so on), type scale, spacing, motion and layers. Components use the semantic tokens only; raw colour values appear nowhere else.
- **Themes:** Noir Prestige is the default. **Ivory** is the light alternative of the same system (same gold and type, darker inks for contrast). The "Light theme" switch in the header and the voice command "switch to light mode" (or "dark mode") change it. A choice is saved on the device only when someone makes it.
- **Gold is an accent, not a text colour for ordinary content:** the wordmark rule, section labels, the active navigation underline, selected filters and options (walnut fill, gold edge and a check mark), count badges, the voice indicator, and one gold button per view at most (Shop the collection, Add to cart, Proceed to billing, Pay). Body text and button labels are ivory or noir. Every text colour is noted with its contrast ratio in tokens.css; all meet WCAG AA, and control outlines meet 3:1.
- **Type:** Cormorant Garamond for display headings and the wordmark, Inter for everything functional (Google Fonts with `display=swap`; Georgia and Arial are the fallbacks).
- **Product photos** are mostly shot on white or light grey, so they sit on a lit "gallery" frame; a slight contrast lift plus `mix-blend-mode: multiply` blends their backgrounds into it.
- **Voice assistant:** an obsidian panel with one fine gold edge in both themes, a text label for every state (listening, thinking, speaking, waiting for an answer, error, microphone blocked), and on-screen answer buttons that send the same words as a spoken answer. The floating control is a 56 px circle, and the page keeps focused controls clear of it (`scroll-padding-bottom`).
- **Shared building blocks** are in [src/styles/base.css](src/styles/base.css): buttons, fields, chips, panels, banners, tables, the quantity stepper, focus rings, reduced-motion and forced-colours rules.

## Architecture

```
Browser (React, src/)                        Server (Node/Express, server/)
  ├─ Firestore SDK: products (read), own      ├─ POST /api/voice/intent      → Groq LLM (key stays here)
  │  cart/wishlist/name (write), guarded       ├─ POST /api/voice/transcribe  → Groq Whisper (key stays here)
  │  by firestore.rules                        ├─ POST /api/checkout/quote    → server-side totals
  └─ /api/* (with Firebase ID token) ───────▶ ├─ POST /api/checkout          → atomic, idempotent order
                                              ├─ POST /api/wallet/refill     → disabled without a payment provider
                                              └─ /api/admin/users…           → Firebase Admin SDK, admin claim only
```

- **AI:** the browser sends the spoken text and the product names to `/api/voice/intent`. The server calls Groq, which returns one intent from a fixed list. Both server and browser re-check that answer, and plain app code resolves the product against the real catalog and runs the action. If the AI is unavailable or rate-limited, a local keyword parser takes over.
- **Admin rights** come only from the Firebase Auth custom claim `admin: true`, set with `npm run set-admin`. The old `admin` field in user documents is ignored.

### Product reads and the Firestore quota

Every product read goes through [src/services/catalogService.js](src/services/catalogService.js). Firestore bills each document a query returns, and the free tier allows 50,000 reads a day, reset around midnight Pacific time ([Firestore quotas](https://firebase.google.com/docs/firestore/quotas)). The live catalog has 442 documents (about 70 distinct products), and the app used to read all of them on every page view, which used up the quota.

| Screen | Reads now |
|---|---|
| Category, Shop all | one page at a time (`REACT_APP_CATALOG_PAGE_SIZE`, default 24 documents), in name order with a document-id cursor; "Show more products" reads the next page |
| Home | the top-rated products, one picture per category and the hero product |
| Product page | that product and its stored copies |
| Wishlist | the saved products only |
| Zoro | the category being shopped ("black gym shoes" reads shoes) |
| Search, and a product named to Zoro without a category | the whole catalog once, shared by every screen and kept for 10 minutes, also across reloads (public product data only, in `localStorage`) |
| Admin products | 50 documents at a time, or every document on request; dashboard counts only on request |

Identical requests in flight share one call; results are cached for a few minutes (`invalidateCatalog()` runs after an admin change). Products are read from the server only, so an unreachable server is an error, never an empty catalog. After a quota error (`resource-exhausted`) nothing is requested for a minute and the page says so with a Try again button; network errors are retried twice with backoff and jitter. Checkout never uses these caches: the server re-reads prices and stock.

The category pages need the composite indexes in [firestore.indexes.json](firestore.indexes.json). Until they are deployed, a category page falls back to reading its whole category unpaged (and logs a warning), so it keeps working.

Copies of a product are merged on screen: while more pages remain, a listing holds back the last product name, whose other copies may be on the next page.

### Product images

Images are static files in `public/images`, named in each product's `image` field (a list of `/images/<file>` paths). [src/services/images.js](src/services/images.js) matches paths to the real files regardless of letter case (through `src/imageManifest.json`, regenerated by `scripts/generate-image-manifest.js` before start, build and test). Full `https://` URLs are used as stored. Firebase Storage is not used, and other values are not guessed into URLs. [ProductImage](src/components/ProductImage.js) shows each photo in its frame. If the image is missing or fails, the frame shows the product (or category) name and "Image not available" instead of an empty frame or a broken-image icon. While an image loads slowly, it shows "Loading image…". A URL that failed is not requested again, and development builds log each bad path once with the product id. A category's home-page picture is its highest-rated product (ratings 0–5, ties by name) that has a usable image.

## Setup (local development)

Requirements: Node.js 20 or newer (tested on Node 26; firebase-tools 14 needs 20+). Java 21 or newer, only for the emulator tests.

```bash
# 1. Frontend
npm install                     # .npmrc sets legacy-peer-deps for react-speech-kit

# 2. Backend
cd server
npm install
cp .env.example .env            # then fill in the values below
cd ..
```

**Server environment** (`server/.env` locally; environment variables and secrets when hosted; never commit it):

| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV` | production: yes | `production` when deployed. Defaults to `development`. |
| `FIREBASE_PROJECT_ID` | yes | `e-commerce-website-69`, or the staging project. Must equal the frontend build's `projectId`, because ID tokens are checked against it. |
| `FIREBASE_ADMIN_USE_ADC` | one of these two, for checkout, wallet and admin | `true` uses Application Default Credentials: the service account attached to Cloud Run, or your `gcloud auth application-default login` locally. No key file is needed. |
| `GOOGLE_APPLICATION_CREDENTIALS` | (see above) | Path to a service-account JSON key (Firebase console → Project settings → Service accounts). Keep the file outside the repo. |
| `GROQ_API_KEY` | for AI voice | Groq key, server only. Without it, the offline parser is used. |
| `GROQ_MODEL` | no | Default `openai/gpt-oss-120b`. |
| `GROQ_REASONING_EFFORT` | no | `low` (default), `medium` or `high`, for gpt-oss models. |
| `GROQ_WHISPER_MODEL` | no | Default `whisper-large-v3-turbo`, used by `POST /api/voice/transcribe`. Reuses `GROQ_API_KEY`; billed separately from `GROQ_MODEL`'s text usage. |
| `PORT` | no | Default `5055`. Hosting platforms set it themselves. |
| `ALLOWED_ORIGINS` | only cross-origin | Comma-separated app origins, when the app is not served from the API's origin. |
| `TRUST_PROXY` | no | Number of proxies in front of the server, used to find the client IP for rate limits. Default `1`; use `2` behind Firebase Hosting → Cloud Run (verify, see [DEPLOYMENT.md](DEPLOYMENT.md)). |
| `ALLOW_DEV_WALLET_CREDIT` | no | `true` lets "Refill wallet" add test money **only** when `NODE_ENV` is not `production` **and** the server uses the Firestore emulator. It is ignored against any real project. |
| Payment provider keys | not yet | No provider is integrated (see below), so there are no payment variables. |

**Frontend `.env`** (build-time; everything here is public and bundled into the browser). **Never put API keys or secrets in `REACT_APP_*` variables.**

| Variable | Required | Purpose |
|---|---|---|
| `REACT_APP_API_BASE_URL` | only cross-origin | API URL when `/api` is not served from the app's origin. Leave unset with the Firebase Hosting rewrite in `firebase.json`. |
| `REACT_APP_FIREBASE_API_KEY`, `_AUTH_DOMAIN`, `_PROJECT_ID`, `_STORAGE_BUCKET`, `_MESSAGING_SENDER_ID`, `_APP_ID` | no (all six or none) | Point a build at another Firebase project, such as staging. With none set, the built-in `e-commerce-website-69` settings are used. A partial set stops the app with an error. |
| `REACT_APP_VOICE_STT_MODE` | no | Forces which engine Zoro's command mode uses for everyone on this build: `automatic` (default), `webspeech`, or `whisper`. Overrides each shopper's own setting. See "Browser support for voice" above. |

Run both (two terminals):

```bash
npm run server     # API on http://localhost:5055
npm start          # app on http://localhost:3000, /api is proxied to :5055 (development only)
```

Ports: app 3000, API 5055; emulators: Firestore 8181, Auth 9199, Hosting 5056.

### Try sign-in, checkout and admin locally (emulators)

This runs everything against the local Firebase emulators, so nothing touches a real project. Java 21+ is needed for the emulators.

```bash
# 1. Emulators (demo project: it cannot reach any real Firebase project)
cd server && npx firebase emulators:start --project demo-voicecart --only firestore,auth

# 2. API against the emulators (another terminal, in server/); test wallet money is allowed only here
NODE_ENV=development PORT=5057 FIREBASE_PROJECT_ID=demo-voicecart \
FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9199 \
ALLOW_DEV_WALLET_CREDIT=true ALLOWED_ORIGINS=http://localhost:3518 node src/index.js

# 3. App against the emulators (another terminal, in the project root)
PORT=3518 REACT_APP_USE_FIREBASE_EMULATORS=true REACT_APP_API_BASE_URL=http://localhost:5057 \
REACT_APP_FIREBASE_API_KEY=demo-key REACT_APP_FIREBASE_AUTH_DOMAIN=demo-voicecart.firebaseapp.com \
REACT_APP_FIREBASE_PROJECT_ID=demo-voicecart REACT_APP_FIREBASE_STORAGE_BUCKET=demo-voicecart.appspot.com \
REACT_APP_FIREBASE_MESSAGING_SENDER_ID=0 REACT_APP_FIREBASE_APP_ID=demo-app npm start
```

The emulator starts empty: create an account on the sign-up page, add products with the admin panel, and grant the admin claim with the Admin SDK against the emulator (for example `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9199 FIREBASE_PROJECT_ID=demo-voicecart npm run set-admin -- you@example.test`). `REACT_APP_USE_FIREBASE_EMULATORS` has no effect in production builds.

Without Firebase Admin credentials, the store, search, cart and voice assistant still work. Checkout, wallet and admin user management answer "not configured" instead of pretending to succeed. With credentials, the local server works on the real project's data. New accounts start with a ₹0 wallet and test money is refused there, so a full checkout can only be tried in the emulator tests or on staging (see [DEPLOYMENT.md](DEPLOYMENT.md)).

### Make someone an administrator

The person must have signed up first. The script prints the project it changes, so check it before continuing.

```bash
cd server
npm run set-admin -- person@example.com            # grant (they sign out and in again)
npm run set-admin -- person@example.com --revoke   # revoke; also ends their sessions
```

This needs Firebase Admin credentials for that project: `FIREBASE_ADMIN_USE_ADC=true` after `gcloud auth application-default login`, or `GOOGLE_APPLICATION_CREDENTIALS`.

## Tests

```bash
npm test                     # frontend: voice safety, state machine, cart, catalog paging and quota handling, checkout, routes, axe checks
CATALOG_EMULATOR_HOST=127.0.0.1:8181 CI=true npm test -- catalogEmulator   # the real catalog queries, read-only, against a running Firestore emulator
cd server && npm test        # server: AI proxy, auth, admin checks, rate limits, validation
cd server && npm run test:emulator   # Firestore rules, checkout/wallet/admin and the data scripts against emulators (needs Java 21+)
```

Automated checks (jest-axe, axe-core) catch many accessibility problems but not all. Test with a real screen reader before release.

## Deployment

The full runbook, including a staging checklist with exact commands and verification steps, is in **[DEPLOYMENT.md](DEPLOYMENT.md)**. In short:

1. **Rotate the Groq key.** The previous key was stored in a `REACT_APP_` variable and shared in a chat. Create new keys at <https://console.groq.com/keys>, delete the old one there, and keep keys only in the server environment (Secret Manager when hosted).
2. **Firebase project selection.** There is deliberately no `.firebaserc` default. Every Firebase CLI command passes `--project`. Run the CLI from `server/` as `npx firebase`; it finds `../firebase.json` itself.
3. **Rules and indexes:** `cd server && npx firebase deploy --only firestore:rules,firestore:indexes --project <project-id>`. Then grant admin claims (see above). Accounts that relied on the old `admin` field lose admin access until you do. Index builds take a few minutes; category pages work unpaged until they finish.
4. **API:** Cloud Run service `voicecart-api` in `asia-south1`, running as its own service account with `FIREBASE_ADMIN_USE_ADC=true`, and with `GROQ_API_KEY` from Secret Manager. `server/.gcloudignore` and `server/.dockerignore` keep `server/.env` out of uploads and images.
5. **Frontend:** `CI=true GENERATE_SOURCEMAP=false npm run build`, then `npx firebase deploy --only hosting --project <project-id>`. `firebase.json` rewrites `/api/**` to the Cloud Run service (same origin, so no CORS) and everything else to `index.html`, and sets cache headers. To host the API elsewhere, remove that rewrite and set `REACT_APP_API_BASE_URL` plus `ALLOWED_ORIGINS`.
6. **Optional data cleanup:** the catalog contains exact copies of most products (442 documents, 70 distinct, on 2026-10-25). The app shows one card per product. `npm run dedupe-products` is a dry run (add `-- --report review.json` for a full review); `-- --apply --confirm-project <id>` removes copies whose fields are all identical. It writes a local backup first and re-points carts to the kept copy. The dry run itself reads every product, profile and order, so run it on staging, and back up production first (see DEPLOYMENT.md). `npm run fix-image-paths` similarly fixes `.png`/`.PNG` path case; the app already maps these at runtime.

### Not done yet: payments

No payment provider is connected, so **wallet refill is disabled in production**. To add one (Razorpay, Stripe or similar), create orders on the server, verify the provider's signed webhook on the server, and only then call `creditWallet()` in `server/src/wallet.js` with the provider's payment id. That function is atomic and refuses duplicate ids. Never credit a wallet because the browser says a payment succeeded.

### Before going public

- [ ] New Groq key created, held only by the server; old key deleted.
- [ ] Staging deployed and every check in DEPLOYMENT.md §9 passed.
- [ ] `firestore.rules` and `firestore.indexes.json` deployed, and admin claims granted.
- [ ] Firestore usage watched for a few days (Firebase console → Firestore → Usage) with a budget alert, if billing is enabled.
- [ ] Server deployed with Firebase Admin credentials, `NODE_ENV=production`, and a `FIREBASE_PROJECT_ID` that matches the frontend.
- [ ] A payment provider integrated with a verified webhook (or wallet refill left disabled).
- [ ] Manual test with NVDA or VoiceOver and keyboard only.
- [ ] Groq plan checked: the free tier allows about 8,000 tokens per minute, roughly 6–10 voice commands per minute for all users together. Above that, the offline parser handles commands. Whisper transcription has its own separate Groq rate limit (audio minutes), independent of this token budget.
