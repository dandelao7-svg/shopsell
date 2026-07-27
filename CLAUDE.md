# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # install dependencies
node server.js     # run locally (same as `npm start` / `npm dev`) — needs a filled-in .env
node fix-order.js <orderId>   # one-off admin script: overwrite an order's customer_info
node seed-demo.js             # create/refresh the public demo store (slug `demo`); --wipe to reset its products
node migrate-images.js        # one-off backfill: inline base64 images → hosted /img/ URLs; --dry-run to preview
```

There is **no build step, no test suite, and no linter**. The frontend is plain HTML files served statically — there is nothing to compile. Node >= 18 is required (`carriers.js` and `lib/` rely on global `fetch`/`crypto` and dynamic `import()` of `node-fetch`).

Local setup: `cp .env.example .env`, fill in values, point `DATABASE_URL` at a Postgres instance. The schema is created automatically on first boot (`database.js` `initSchema()`) — no migration step exists; schema changes are made by editing `initSchema` (use `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` so boot stays idempotent).

## Deployment

Railway, deploying from GitHub. `main` branch → production, `staging` branch → staging (see `railway.json`: NIXPACKS, `npm start`, health check at `/health`). Env vars are set in the Railway service's Variables tab, not committed. `README.md` is the end-to-end deploy runbook.

## Architecture

Multi-tenant SaaS ecommerce + shipping platform. A single Express server backs vanilla-HTML frontends; sellers sign up, get a storefront, and connect their own Stripe/carrier/sales-channel accounts.

**Backend is one monolith:** `server.js` (~4200 lines) holds every route and all middleware. Supporting modules:
- `database.js` — the entire PostgreSQL data layer (`pg` Pool). Every table lives in `initSchema()`; all queries are functions exported from here. Rows come back snake_case and are `camelize()`d before returning.
- `carriers.js` — `UPS`, `FedEx`, `USPS` classes + `buildCarrier(carrier, creds)`. Instances are built **per request** from the seller's own credentials (OAuth tokens are cached at module level, keyed by credential, in `_tokenCache`).
- `lib/crypto.js` — AES-256-GCM encrypt/decrypt for secrets at rest (carrier + Stripe creds). Uses `ENCRYPTION_KEY` (64 hex chars). **Never rotate the key once data exists** — existing ciphertext becomes unrecoverable. Fails loud if the key is missing/malformed rather than storing plaintext.
- `lib/shopify.js`, `lib/amazon.js` — sales-channel order import + fulfillment push.
- `lib/labelmerge.js` — combine shipping-label PDFs. `email.js` — transactional email via Resend (no-op if `RESEND_API_KEY` unset).

**Frontend:** static HTML files at the repo root, each a full page with inline JS that calls the JSON API — `index.html` (buyer storefront), `dashboard.html` (seller admin), `shipping.html` (shipping suite), plus `login/signup/reset-password/returns.html`. `server.js` maps clean paths (`/`, `/dashboard`, `/shipping`, …) to these files. No framework, no bundler.

### Key cross-cutting concepts

- **Two auth realms share one `JWT_SECRET`.** Sellers use `requireAuth` (`req.seller`); buyers use `requireBuyerAuth` (`req.buyer`). They are told apart by the `type: 'buyer'` claim — seller tokens are legacy and have no `type`, so `requireAuth` rejects only `type === 'buyer'`. `requirePlan(...plans)` gates features by subscription tier.

- **Two distinct Stripe integrations.** The *platform* account (env `STRIPE_SECRET_KEY`, `STRIPE_PRICE_*`) charges sellers their monthly subscription. Each *seller's own* Stripe account (bring-your-own keys, stored encrypted per seller) processes buyer checkout — there is no global publishable key. Same "BYOA" pattern for carriers: sellers connect their own UPS/FedEx/USPS accounts in Settings, stored encrypted via `lib/crypto`.

- **Multi-tenant host routing.** `resolveStoreByHost(host)` maps an incoming hostname to a seller: a verified custom domain (apex form), or a `<slug>.PLATFORM_DOMAIN` subdomain (`RESERVED_SUBDOMAINS` excluded). Custom domains are verified via a DNS TXT challenge and pointed at `CUSTOM_DOMAIN_TARGET` by CNAME.

- **Webhook raw body.** Stripe (`/api/stripe/webhook`) and Shopify (`/api/webhooks/shopify`) need the raw request body for HMAC verification, so `express.raw()` is registered for those paths **before** `express.json()`. Keep that ordering when touching middleware. `/api/seller/images` relies on the same rule for the opposite reason — a larger `express.json({ limit })` registered ahead of the global parser, whose 100KB default would otherwise reject every upload.

- **Uploaded images.** Product photos, store logos and hero images are stored as bytes in the `images` table and referenced by the path `/img/<id>` (served by a public route; the id is a random token, so the URL is the capability). Store the **path**, never an absolute URL — rows must stay valid across the Railway host, `<slug>` subdomains and verified custom domains; SSR/OG code absolutizes with `storeCanonicalBase(seller)`. Do not reintroduce base64 `data:` URIs: they can't be used as OG/social images and they ride along on every API payload. `migrate-images.js` converts any that predate this.

- **Sales channels.** Orders can be imported from Shopify (public-app OAuth, one shared app credential set) and Amazon into the local `orders` table, deduped by external id. When a label is bought, tracking is pushed back to the source channel as a fulfillment — best-effort, a channel failure must never break the label purchase (`pushChannelFulfillment`).

- **Route naming convention.** `/api/auth/*` and `/api/buyer/*` = authentication; `/api/seller/*` = authenticated seller/dashboard actions; `/api/checkout/*` = buyer purchase flow; `/api/shipping/*` = the shipping suite (rates, labels, tracking, returns). Auth routes are rate-limited at 20/15min, all other `/api` at 100/min.
