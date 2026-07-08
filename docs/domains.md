# Domains & TLS setup

shopsell is a multi-tenant SaaS (Shopify-style): the operator does not sell —
each **seller** gets a storefront, reached by hostname. `resolveStoreByHost()`
(`server.js`) maps an incoming host to a seller. There are three host roles:

| Role | Example | Purpose |
|---|---|---|
| **Platform app origin** | `shopsell-production.up.railway.app` (or later `app.nextlao.com`) | dashboard, shipping suite, API, OAuth callbacks, webhooks. Drives `ALLOWED_ORIGIN`. |
| **Seller storefront (subdomain)** | `<slug>.nextlao.com` | every seller gets one free — the `*.myshopify.com` equivalent. |
| **Seller custom domain** | `shop.theirbrand.com` | a seller's own domain, verified + pointed at the platform. |

Config (`server.js`): `PLATFORM_DOMAIN` (default `nextlao.com`),
`CUSTOM_DOMAIN_TARGET` (default `shop.nextlao.com`), and `RESERVED_SUBDOMAINS`
(`www, shop, app, api, admin, mail, dashboard, static, assets, cdn` — never
treated as store slugs).

> **Why the Railway domain can't serve storefronts:** the shared
> `*.up.railway.app` certificate is a *one-label* wildcard — it covers
> `shopsell-production.up.railway.app` but NOT
> `<slug>.shopsell-production.up.railway.app` (two labels), which fails TLS with
> a browser "Privacy error". Seller storefronts therefore **require a real
> platform domain with its own wildcard cert.** This is a launch blocker for the
> SaaS — without it, no seller store is reachable over HTTPS.

---

## 1. Wildcard storefront domain — `*.nextlao.com` (the important one)

Makes every `<slug>.nextlao.com` storefront resolve and serve valid HTTPS. The
routing code is already built — this is DNS + cert only.

### a. Add the wildcard domain in Railway
Railway → **shopsell** service → **Settings → Networking → Custom Domain** → add
`*.nextlao.com`. Railway displays:
- a **CNAME target** (e.g. `xxxx.up.railway.app`), and
- possibly a **DNS validation record** for the wildcard TLS cert (Let's Encrypt
  wildcard certs require a DNS-01 challenge; Railway shows the exact record).

### b. Add the DNS records at the nextlao.com DNS provider
- **Route:** `CNAME`, host `*`, value = the Railway target from (a).
- **Cert validation:** the record Railway showed (often a `_acme-challenge`
  CNAME/TXT). The wildcard cert stays pending until this resolves.

### c. Wait for Active
Railway shows status; cert issuance is usually minutes (allow up to ~1h for DNS
propagation).

### d. Verify
Open a seller's storefront at the **preview URL shown in that seller's
dashboard** (`server.js` builds `https://<storeSlug>.nextlao.com`). It should
load over HTTPS with no privacy error.

**Independent of OAuth/app setup:** storefronts don't use `ALLOWED_ORIGIN`
(that only drives OAuth callbacks, webhooks, reset links, which keep working on
the Railway domain). Adding the wildcard does **not** break existing Shopify/
eBay/Etsy/TikTok connections.

---

## 2. Platform app origin (optional, later)

To move the app itself off the Railway URL onto e.g. `app.nextlao.com`
(`app` is a reserved subdomain, so it won't collide with a seller):

1. Railway → add custom domain `app.nextlao.com` → get its CNAME target.
2. DNS: `CNAME` host `app` → that target (TLS auto-provisions).
3. **Set `ALLOWED_ORIGIN=https://app.nextlao.com`** in Railway — this drives
   OAuth callbacks, webhook URLs, CORS, and password-reset links.
4. **Update every channel's redirect/callback + webhook URLs** to the new origin
   (Shopify via `shopify app deploy`; eBay RuName accepted-URL + account-deletion
   endpoint; Etsy callback; TikTok callback). See `docs/channel-setup.md`.

This is a coordinated migration — do it deliberately, not alongside step 1.

---

## 3. Seller custom domains (already implemented)

A seller connecting `shop.theirbrand.com` is handled by the app:
- Seller adds the domain in their dashboard → gets a **DNS TXT challenge** to
  prove ownership + a **CNAME** to point at `CUSTOM_DOMAIN_TARGET`.
- Once the TXT verifies, `resolveStoreByHost()` matches the custom domain (apex
  form) to the seller. Railway provisions the cert for the added custom domain.

No infra work beyond ensuring `CUSTOM_DOMAIN_TARGET` resolves to the platform.

---

## Quick checklist to go live with storefronts

- [ ] `*.nextlao.com` added as a Railway custom domain, status **Active**
- [ ] DNS: `CNAME * → <railway target>` + cert-validation record
- [ ] `PLATFORM_DOMAIN=nextlao.com` (already the default)
- [ ] Verified a real `<slug>.nextlao.com` storefront loads over HTTPS
- [ ] (later) app origin moved to `app.nextlao.com` + `ALLOWED_ORIGIN` updated + channel redirect URLs migrated
