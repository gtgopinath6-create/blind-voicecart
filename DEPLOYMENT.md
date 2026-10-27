# Deploying VoiceCart

This is the runbook for a **staging** deployment: a separate Firebase project with its own data, used to verify everything before production. Production steps are at the end and need explicit approval before anyone runs them.

Target setup (matches `firebase.json`):

```
Browser ──▶ Firebase Hosting (build/)  ── /api/** rewrite ──▶ Cloud Run "voicecart-api" (server/), region asia-south1
                     │                                                 │
                     └── Firebase Auth + Firestore (rules) ◀── Admin SDK┘
```

The app and the API share one origin, so `REACT_APP_API_BASE_URL` and `ALLOWED_ORIGINS` stay unset. If you host the API anywhere else, remove the `/api/**` rewrite from `firebase.json`, build with `REACT_APP_API_BASE_URL=https://<api-host>` and set `ALLOWED_ORIGINS=https://<app-host>` on the server.

## 0. Prerequisites

- Node.js 20 or newer. firebase-tools 14 requires it, and Node 18 is end-of-life.
- Java 21 or newer, only for `npm run test:emulator`.
- The [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) (`gcloud`).
- The Firebase CLI comes with the server's dev dependencies. Run it as `npx firebase` from `server/`; it finds `../firebase.json` itself.
- A staging Firebase project on the **Blaze** plan. Cloud Run, Cloud Build and Secret Manager need billing, so set a budget alert.

There is deliberately **no `.firebaserc` default project**. Every command passes `--project`, so nothing reaches production by accident.

```bash
export STAGING=<your-staging-project-id>    # e.g. voicecart-staging
export REGION=asia-south1                   # must match firebase.json
# Runs a server script against staging with your own gcloud login (see step 5):
stg() { FIREBASE_PROJECT_ID="$STAGING" FIREBASE_ADMIN_USE_ADC=true "$@"; }
```

## 1. Local gates (before every deploy)

From the repository root:

```bash
npm ci && npm --prefix server ci
CI=true npm test -- --watchAll=false          # frontend
npm --prefix server test                       # server unit tests
(cd server && npm run test:emulator)           # rules, checkout, wallet, admin, scripts (Java 21+)
CI=true GENERATE_SOURCEMAP=false npm run build
grep -rElq 'gsk_[A-Za-z0-9]{20,}|api\.groq\.com|GROQ_API' build && echo "STOP: secret in build" || echo "build clean"
```

Stop if any step fails.

## 2. Create the staging Firebase project (console)

1. Go to <https://console.firebase.google.com>, add a project named `$STAGING` and upgrade it to Blaze.
2. Create the Firestore database in **Native mode**, starting in **production mode**. Step 4 deploys the real rules. For the location, use the production database's location (production console → Firestore → Data). This runbook assumes **asia-south1**. If production is elsewhere, use that region for `REGION` and for `"region"` in `firebase.json`, so the API runs next to its database in both environments.
3. **Authentication → Sign-in method:** enable **Email/Password** and **Google**.
4. **Authentication → Settings → Authorized domains:** `$STAGING.web.app` and `$STAGING.firebaseapp.com` are added automatically. Add any custom domain here.
5. **Project settings → Your apps:** add a **Web app**, then copy its six config values into `.env.staging` in the repository root. This file is ignored by Git, and its values are public:
   ```
   REACT_APP_FIREBASE_API_KEY=...
   REACT_APP_FIREBASE_AUTH_DOMAIN=...
   REACT_APP_FIREBASE_PROJECT_ID=...
   REACT_APP_FIREBASE_STORAGE_BUCKET=...
   REACT_APP_FIREBASE_MESSAGING_SENDER_ID=...
   REACT_APP_FIREBASE_APP_ID=...
   ```
6. Optional: in Google Cloud console → APIs & Services → Credentials, restrict the browser key to the staging domains (HTTP referrers).

## 3. Rotate the Groq key (do this now, whatever else you do)

The old key was in a `REACT_APP_` variable and was shared in a chat, so treat it as compromised.

1. Open <https://console.groq.com/keys> and create one key per environment, such as `voicecart-dev`, `voicecart-staging` and later `voicecart-prod`.
2. Put the new development key into `server/.env` (`GROQ_API_KEY=`), replacing the old value.
3. **Delete the old key** in the Groq console. Anything still using it stops working, which is intended.

## 4. Deploy the Firestore rules and indexes to staging

```bash
cd server
npx firebase login
npx firebase deploy --only firestore:rules,firestore:indexes --project "$STAGING"
```

**Verify:** Firebase console → Firestore → Rules shows `firestore.rules` with the current timestamp, and Firestore → Indexes lists two `products` indexes (`category` array-contains with `name` ascending, and with `rating` descending) as **Enabled** after a few minutes. Until then, category pages read their whole category without paging and the browser console warns that the index is missing.

## 5. Copy the product catalog into staging

Local scripts use your own Google login (Application Default Credentials), so no key file is needed:

```bash
gcloud auth login
gcloud auth application-default login
gcloud auth application-default set-quota-project "$STAGING"
cd server
stg npm run copy-catalog -- --from e-commerce-website-69           # dry run, writes nothing
stg npm run copy-catalog -- --from e-commerce-website-69 --apply   # copies products only, never overwrites
```

The script reads the source catalog through the public Firestore REST API, which works because products are publicly readable. It writes only to `FIREBASE_PROJECT_ID`, and refuses to run when source and target are the same project.

**Verify:** the dry run reports the number of products to copy, which was 442 on 2026-10-25. After `--apply`, the staging console shows that number in `products`.

## 6. Deploy the API to Cloud Run

```bash
gcloud config set project "$STAGING"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com

# A dedicated identity for the API: Firestore read/write and Firebase Auth admin only.
gcloud iam service-accounts create voicecart-api --display-name "VoiceCart API"
SA="voicecart-api@$STAGING.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$STAGING" --member "serviceAccount:$SA" --role roles/datastore.user
gcloud projects add-iam-policy-binding "$STAGING" --member "serviceAccount:$SA" --role roles/firebaseauth.admin

# Groq key in Secret Manager (typed, not echoed or kept in shell history).
gcloud secrets create groq-api-key --replication-policy automatic
read -rs GROQ_KEY && printf '%s' "$GROQ_KEY" | gcloud secrets versions add groq-api-key --data-file=- && unset GROQ_KEY
gcloud secrets add-iam-policy-binding groq-api-key --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor

# Run from the repository root. server/.gcloudignore keeps server/.env and node_modules out of the upload.
gcloud run deploy voicecart-api --source server --region "$REGION" \
  --service-account "$SA" --allow-unauthenticated --max-instances 2 \
  --set-env-vars "NODE_ENV=production,FIREBASE_PROJECT_ID=$STAGING,FIREBASE_ADMIN_USE_ADC=true,TRUST_PROXY=2" \
  --set-secrets "GROQ_API_KEY=groq-api-key:latest"
```

- The first `--source` deploy may offer to create an Artifact Registry repository or to grant Cloud Build permissions. Accept both. The Node version comes from `"engines"` in `server/package.json`.
- `--allow-unauthenticated` is required because Firebase Hosting calls the service publicly. The API checks Firebase ID tokens itself.
- `--max-instances 2` caps cost. The rate limiter keeps its counts in memory per instance, so the effective limit is up to twice the configured one.
- Do **not** set `ALLOW_DEV_WALLET_CREDIT`. It is ignored outside the emulator anyway.

**Verify:**

```bash
URL=$(gcloud run services describe voicecart-api --region "$REGION" --format 'value(status.url)')
curl -s "$URL/api/health"    # expect {"ok":true,"ai":true,"firebase":true,"devWalletCredit":false}
```

The startup log (Cloud Run → voicecart-api → Logs) must show `Firebase Admin: enabled (project <staging>)` and `Wallet refill: unavailable`. It must not contain a key or a token.

## 7. Build and deploy the frontend to staging

```bash
# In a subshell, so the staging values don't leak into later production builds:
(set -a; . ./.env.staging; set +a; CI=true GENERATE_SOURCEMAP=false npm run build)
grep -c "$STAGING" build/static/js/main.*.js     # expect 1 or more: the build points at staging
(cd server && npx firebase deploy --only hosting --project "$STAGING")
```

If only some of the six `REACT_APP_FIREBASE_*` values are set, the app refuses to start (a blank page with an error in the browser console). This stops a build from mixing two projects.

## 8. Grant the first staging administrator

1. Sign up on `https://$STAGING.web.app` with the administrator's email. `set-admin` needs an existing account.
2. Then run:
   ```bash
   cd server
   stg npm run set-admin -- admin@example.com     # prints "Project: <staging>" and "Granted admin"
   ```
3. Sign out and back in, then open `/admin`.

To revoke: `stg npm run set-admin -- admin@example.com --revoke`. This also ends that person's sessions.

## 9. Staging verification

Unchecked items are **not verified**.

```bash
H="https://$STAGING.web.app"
curl -s "$H/api/health"                                                         # JSON (not HTML), firebase:true
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$H/api/checkout" -H 'Content-Type: application/json' -d '{}'     # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$H/api/admin/users" -H 'Content-Type: application/json' -d '{}'  # 401
curl -sI "$H/api/health" | grep -i '^cache-control'                             # no-store
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$H/categories/Shoes"  # 200 text/html (deep link)
```

**Rules and API with a real token.** Create a throwaway test account on the staging site first:

```bash
KEY=<staging REACT_APP_FIREBASE_API_KEY>
read -r EMAIL && read -rs PASSWORD
AUTH=$(curl -s "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$KEY" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"returnSecureToken\":true}"); unset PASSWORD
TOKEN=$(printf '%s' "$AUTH" | node -pe 'JSON.parse(require("fs").readFileSync(0)).idToken')
USER_ID=$(printf '%s' "$AUTH" | node -pe 'JSON.parse(require("fs").readFileSync(0)).localId')
DOC="https://firestore.googleapis.com/v1/projects/$STAGING/databases/(default)/documents"

# Must be 403: a user cannot raise their wallet, make themselves admin, or write orders.
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH "$DOC/users/$USER_ID?updateMask.fieldPaths=wallet" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"fields":{"wallet":{"integerValue":"999999"}}}'
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH "$DOC/users/$USER_ID?updateMask.fieldPaths=admin" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"fields":{"admin":{"booleanValue":true}}}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$DOC/orders" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"fields\":{\"uid\":{\"stringValue\":\"$USER_ID\"}}}"
# Must be 200: the user may change their own cart.
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH "$DOC/users/$USER_ID?updateMask.fieldPaths=cart" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"fields":{"cart":{"arrayValue":{}}}}'
# Through Hosting: 200 quote (proves Authorization reaches Cloud Run), 501 refill (no payment provider).
curl -s -X POST "$H/api/checkout/quote" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
curl -s -X POST "$H/api/wallet/refill" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"amount":100,"idempotencyKey":"stagingcheck00000001"}'
```

**Rate limit and `TRUST_PROXY`.** Each request below calls Groq, so some may answer 503 (Groq's own limit). That is fine.

```bash
for i in $(seq 1 31); do curl -s -o /dev/null -w '%{http_code} ' -X POST "$H/api/voice/intent" -H 'Content-Type: application/json' -d '{"text":"open shoes","products":[]}'; done; echo
# Expect no 429 in the first 30, and 429 on the 31st. Then, within a minute:
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$H/api/voice/intent" -H 'X-Forwarded-For: 203.0.113.9' -H 'Content-Type: application/json' -d '{"text":"hi","products":[]}'   # still 429: a fake header can't bypass the limit
```

From a different network, for example a phone hotspot, the first request must **not** get 429. If it does, all users share one IP as far as the server can tell: raise `TRUST_PROXY` by one and redeploy. If the fake-header request is not 429, lower it.

**In the browser:**

- [ ] Sign up with email and password. The Firestore console shows `users/<uid>` with `wallet: 0`.
- [ ] Google sign-in works on `$STAGING.web.app`.
- [ ] Guest cart: add items while signed out, then sign in. The items are merged with no duplicates.
- [ ] Voice in Chrome: Alt+V, then "open shoes" and "add Nike Air Force 1 to my cart" (it asks for size and colour). A name it doesn't know is reported, never substituted.
- [ ] Checkout. Staging only: set a test user's `wallet` to e.g. 20000 in the Firestore console, because there is no payment provider. Fill in the delivery details and double-click **Pay**. Exactly **one** document appears in `orders`, the wallet drops once by the order total, and the cart empties. "Place my order" by voice requires a spoken "yes".
- [ ] `/admin` is denied to ordinary users and works for the claimed admin. Creating a user keeps the admin signed in.
- [ ] Keyboard only: Tab reaches the skip link, every control is reachable, and focus is visible.
- [ ] NVDA (Windows) or VoiceOver (macOS/iOS) pass with the built-in reader turned **off**. Nothing is read twice.
- [ ] Cloud Run logs contain no tokens, keys, emails or delivery addresses.

## 10. Rehearse the catalog cleanup on staging

The production catalog holds exact copies of most products: 442 documents but 70 distinct versions as of 2026-10-25. Try the cleanup on the staging copy first:

```bash
cd server
stg npm run dedupe-products -- --report dedupe-review.json      # dry run: what would go, what needs a person
stg npm run dedupe-products -- --apply --confirm-project "$STAGING"   # backup in server/backups/, re-points carts, deletes copies
stg npm run dedupe-products                                     # expect 0 duplicate copies
```

The dry run reads every product, profile and order once (it prints the count) and changes nothing. The review file lists each group of identical copies and the copy kept, every name stored in several different versions with the fields that differ (price, sizes, colours, images, stock and so on), and the cart, wishlist and order lines that point at copies that would go. It holds document ids and counts, no customer details. `--apply` refuses to run unless `--confirm-project` matches `FIREBASE_PROJECT_ID`.

How it decides:

- Documents are deleted only when **every field** matches another document, compared regardless of field order. The copy kept is the one with the smallest id, which is also the copy the app shows.
- Names that exist in several *different* versions (22 names on 2026-10-25) are reported and left alone for a person to review. The app already shows one card per product by merging such versions.
- Orders are never changed. Each order line keeps its own name, size, colour and price, so an order that names a deleted copy's id still reads correctly.

Before `--apply`, the script writes the deleted documents and the original carts and wishlists it changes to `server/backups/products-dedupe-<time>.json`, with owner-only permissions and ignored by Git. If that write fails, it stops. Cart and wishlist lines that pointed at a deleted copy are re-pointed to the kept copy before anything is deleted.

Remaining risks:

- A cart line added between the dry run and `--apply` could still point at a deleted copy. Checkout then reports "no longer available" instead of charging, and the item can be added again.
- Data changes made after the backup are not in it.

## 11. Production (needs explicit approval; not part of staging)

Run these only after every staging item passes and someone approves. Each one changes live data or access.

1. **Back up production Firestore.** On the Blaze plan:
   ```bash
   gcloud firestore export gs://<backup-bucket>/pre-launch --project e-commerce-website-69
   ```
   On the Spark plan, managed export is unavailable, so the dedupe script's own backup is the only copy of the deleted documents.
2. **Deploy the rules and indexes:**
   ```bash
   npx firebase deploy --only firestore:rules,firestore:indexes --project e-commerce-website-69
   ```
   Any old frontend build that writes wallet or purchase history from the browser stops working at that moment (intended). Administrators who relied on the old `admin` field lose access until step 3.
3. **Grant the admin claims:** run `set-admin` with `FIREBASE_PROJECT_ID=e-commerce-website-69` for each administrator.
4. **Deploy:** repeat steps 6–7 with the production project, a separate production Groq key, and no `.env.staging`, so the built-in production Firebase config is used.
5. Optionally run `dedupe-products`: dry run with `--report`, review it, then `--apply --confirm-project e-commerce-website-69`. Do not run the dry run while the daily read quota is nearly used up: it reads every product, profile and order.
6. Payments: until a provider's verified webhook calls `creditWallet()` (see README), refills stay disabled, so new users (wallet 0) cannot buy anything.

## Rollback

- **Frontend:** Firebase console → Hosting → Release history → roll back to the previous release.
- **API:**
  ```bash
  gcloud run revisions list --service voicecart-api --region "$REGION"
  gcloud run services update-traffic voicecart-api --region "$REGION" --to-revisions <previous-revision>=100
  ```
- **Rules:** Firebase console → Firestore → Rules keeps earlier versions. Re-publish the previous one.
- **Indexes:** extra indexes are harmless to keep. To remove them, delete them in Firebase console → Firestore → Indexes.
- **Catalog cleanup:** re-create documents from `server/backups/products-dedupe-<time>.json` (each entry holds `id` and `data`), or import the managed export.
