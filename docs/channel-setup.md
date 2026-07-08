# Sales channel setup

How to connect each marketplace so orders import and tracking pushes back. The
adapter code is already deployed; each channel just needs its **external app
registration** + **Railway env vars** before its "Connect" button works.

All channels share the same runtime flow: **Connect** (OAuth/authorize) →
**Sync** (import unfulfilled orders) → buy a shipping label → the order is marked
shipped on the channel with tracking (`pushChannelFulfillment`, best-effort — a
channel failure never breaks the label buy; the red/green `channelPush` toast
surfaces the result).

Replace `<ALLOWED_ORIGIN>` below with the deployed origin (production:
`https://shopsell-production.up.railway.app`). Callback URLs must match
**exactly** (https, no trailing slash) — a mismatch fails the OAuth handshake.

| Channel | Railway vars | Callback(s) to register | Notes |
|---|---|---|---|
| Shopify | `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | `/api/channels/shopify/callback` | real-time webhooks |
| Amazon | (per-seller creds, no app vars) | — | seller pastes SP-API creds |
| eBay | `EBAY_API_KEY`, `EBAY_API_SECRET`, `EBAY_RU_NAME`, `EBAY_VERIFICATION_TOKEN` | `/api/channels/ebay/callback`, `/api/webhooks/ebay/account-deletion` | RuName ≠ URL; account-deletion gate |
| Etsy | `ETSY_KEYSTRING` | `/api/channels/etsy/callback` | PKCE, no secret |
| TikTok Shop | `TIKTOK_APP_KEY`, `TIKTOK_APP_SECRET` | `/api/channels/tiktok/callback` | region-specific partner approval |

After setting vars in **Railway → shopsell service → Variables**, the service
redeploys automatically. Then go to `/shipping` → **Marketplaces** → the channel
→ **Connect**.

---

## eBay

eBay's OAuth `redirect_uri` is a **RuName** (a redirect *name*), not the literal
URL — the real callback URL is mapped to the RuName in the portal.

### A. Developer account + production keyset
1. **developer.ebay.com** → sign in → accept the Developers Program agreement.
2. **Application Keysets** → use the **Production** keyset. Copy:
   - **App ID (Client ID)** → `EBAY_API_KEY`
   - **Cert ID (Client Secret)** → `EBAY_API_SECRET`
   - (Dev ID is not needed.)

### B. RuName + callback
3. Production keyset → **User tokens** → **Get a Token from eBay via Your
   Application** → **Add eBay Redirect URL**.
4. Set:
   - **Display title:** e.g. `NextLao Shipping`
   - **Privacy policy URL:** any valid URL you own (required)
   - **Auth accepted URL:** `<ALLOWED_ORIGIN>/api/channels/ebay/callback`
   - **Auth declined URL:** `<ALLOWED_ORIGIN>/shipping?ebay=error`
5. Save → copy the generated **RuName** (`YourName-App-PRD-…`) → `EBAY_RU_NAME`.

### C. Marketplace Account Deletion endpoint (required for production Sell API)
eBay requires every production app to validate an account-deletion endpoint (or
request an exemption). The endpoint is already deployed at
`/api/webhooks/ebay/account-deletion`.
6. Generate a 32–80 char token `[A-Za-z0-9_-]`.
7. Set it in Railway as `EBAY_VERIFICATION_TOKEN` **first** (eBay fires the
   validation challenge the instant you save in the portal).
8. Portal → **Alerts & Notifications → Marketplace Account Deletion**: set the
   endpoint to `<ALLOWED_ORIGIN>/api/webhooks/ebay/account-deletion` and the
   verification token to the same value → **Save**. eBay GETs the endpoint with a
   `challenge_code`; the server returns `SHA256(challengeCode + verificationToken
   + endpoint)` and eBay marks it validated.
   - Alternative: request the **exemption** in the same section (valid — we retain
     no eBay buyer PII beyond order records).

### D. Railway + connect
9. Set `EBAY_API_KEY`, `EBAY_API_SECRET`, `EBAY_RU_NAME`, `EBAY_VERIFICATION_TOKEN`.
10. `/shipping` → **eBay → Connect** → sign in as the seller → **Sync** → buy a
    label → confirm the order goes **Fulfilled** on eBay.

---

## Etsy

Easiest channel — PKCE means **no client secret**, just one env var.

### A. Create the app
1. **etsy.com/developers** → sign in → **Create a New App** (name, description,
   purpose = order management / shipping).
2. Copy the **Keystring** (the API key) → `ETSY_KEYSTRING`. The **Shared secret**
   is **not** used (PKCE replaces it). A new app can access your own shop
   immediately.

### B. Register the callback
3. App settings → **Callback URLs** → add exactly
   `<ALLOWED_ORIGIN>/api/channels/etsy/callback` → Save.

### C. Railway + connect
4. Set `ETSY_KEYSTRING` in Railway.
5. `/shipping` → **Etsy → Connect** → approve on Etsy → **Sync unshipped orders**
   → buy a label → confirm it ships on Etsy with tracking.

Scopes `transactions_r transactions_w` are requested automatically. Connecting
*other people's* shops at scale needs Etsy "commercial app" approval, but your own
shop works right away.

---

## TikTok Shop

Heaviest gate: partner/app approval, and **region-specific** (US / UK / SEA each
have their own partner site). Every business API call is HMAC-signed with the app
secret (handled in `lib/tiktok.js`).

### A. Partner account + app
1. **partner.tiktokshop.com** → register as a developer/partner for your shop's
   region. May require business info + approval.
2. **Manage Apps → Create App** → choose an **Order Management / Fulfillment** app
   and request **Orders (read)** + **Fulfillment (write)** scopes.
3. Copy:
   - **App Key** → `TIKTOK_APP_KEY`
   - **App Secret** → `TIKTOK_APP_SECRET`

### B. Register the callback
4. App settings → **Callback / Redirect URL** → `<ALLOWED_ORIGIN>/api/channels/tiktok/callback` → Save.

### C. Railway + connect
5. Set `TIKTOK_APP_KEY`, `TIKTOK_APP_SECRET` in Railway.
6. `/shipping` → **TikTok Shop → Connect** → authorize as the seller → **Sync
   unfulfilled orders** → buy a label.

Watch two things on TikTok:
- **Scopes on the app are the real gate** — an auth error on Sync almost always
  means the Orders/Fulfillment scope isn't granted on the app.
- The **fulfillment push** (resolve shipping provider → create package with
  tracking) hasn't been live-tested. On the first real order, read the
  `channelPush` toast; if it errors, the label still succeeds and the message
  says why.

---

## Adding another channel later

The plumbing is channel-agnostic (`channel_connections` + `orders` tables,
`importChannelOrder`, `pushChannelFulfillment`, the `/api/seller/channels/*`
routes, and the Marketplaces UI). A new channel = one adapter in `lib/<channel>.js`
exposing connect/verify, fetch-orders, map-to-canonical-order, and push-fulfillment,
plus its config + routes + a nav/modal in `shipping.html`. See `lib/ebay.js`
(OAuth), `lib/etsy.js` (OAuth+PKCE), or `lib/tiktok.js` (signed API) as templates.
