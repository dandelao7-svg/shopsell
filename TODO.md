# ShopSell — TODO / Backlog

Running list of pending work. Shipped features live in [FEATURES.md](FEATURES.md).

## Stripe / launch-readiness
- [x] **Checkout modernized → PaymentElement** _(9f88a77)_ — Link + wallets +
  more methods; reversed the old deliberate card-only/no-Link decision
  (user-approved). Link-based saved cards. **NOT live-tested** — no store here
  has Stripe connected. Before go-live: connect Stripe (test keys ok) to a
  store, walk a payment through, confirm PaymentElement mounts + Link/cards/
  wallets render. Apple Pay also needs Stripe **domain verification**.
- [ ] **Go-live config (you, not code):** platform Stripe → live key
  (`STRIPE_SECRET_KEY=sk_live_`) + live `STRIPE_PRICE_*` + live
  `STRIPE_WEBHOOK_SECRET`; activate the Stripe **Customer Portal** (dashboard)
  so "Manage billing" works; each seller connects their own live keys.
- [ ] _(optional code)_ Harden the billing-portal route to return a clear
  "portal not activated yet" message instead of a generic 500.

## UI polish
- [x] **Top bar font too small** — bumped `.topbar` 12px → 13.5px + lifted contrast. _(done 2026-07-19)_

## Shipping — NEXT UP (deferred to next session)
- [ ] **Test real shipping labels** on the user's own account — in the past, purchased labels "didn't look right." Buy a real label end-to-end, inspect the output (layout/format/print), and fix rendering issues.
- [ ] **Batch printing test** — needs a **thermal printer** (user is buying one). Test the batch label flow + merged-label PDF output on real hardware.

## Shipping — International (larger effort; not started)
Today the shipping stack is US-domestic by design: `carriers.js` addresses default
`country:'US'`, rate/label calls send no customs data, and the checkout/Quick-Ship
forms assume US state + ZIP. International is a cross-cutting build, worth its own
design doc (like the storefront one) before starting. Components:
- [x] **Customs / commercial invoice** — the core of it. _(DONE 9690535,
  design-doc **Phase 2**.)_ `carriers.js`: `isCrossBorder` + `normalizeCustoms`
  + per-carrier builders (UPS InternationalForms, FedEx customsClearanceDetail
  + CI doc, Shippo /customs/declarations); each `createShipment` takes a
  `customs` arg, injected only cross-border. `/api/shipping/label` accepts a
  `customs` block or auto-assembles one from the order's line items + product
  customs fields. 29 unit tests pass; domestic path unchanged. **Still needs a
  real international-enabled carrier account to verify a live cross-border label
  (built to documented spec, like Walmart was).**
- [x] **Product-level customs data** — HS code + country of origin + customs
  description per product. _(DONE ad1b731 — additive DB columns, create/update
  routes, Add-product + Edit-product forms; verified live: save/normalize/
  round-trip + edit-modal populate. This is design-doc **Phase 1**.)_
- [~] **International addresses** — design-doc **Phase 3**.
  - [x] **Buyer checkout** _(DONE 41ba94e, verified live: 67-country ISO list;
    region dropdown for US/CA/GB/AU, free-text region for everywhere else;
    relaxed validation)._ **This completes the primary international flow:**
    buyer abroad checks out → order captures the foreign address → seller ships
    the order → Phase 2 auto-builds customs from product data. End-to-end works.
  - [x] **Quick Ship (`shipping.html`) manual international** _(DONE 3ced304,
    verified live)_ — ISO country selector + free-text region (non-US) + relaxed
    ZIP; a **manual customs-entry UI** (contents/incoterm + line-item editor:
    description/qty/value/HS/origin) shown only cross-border, blocking generate
    until ≥1 valid item; `qsBuildCustoms()` feeds the label payload; country/
    region also flow into rate shopping (`collectShipmentForm`).
- [x] **International services & rates** _(DONE 3ced304)_ — Quick Ship service
  picker gains UPS Worldwide / FedEx International / USPS Intl options when the
  destination is outside the US; rate shopping now sends the real recipient
  country so cross-border routes return international services.
- [x] **Duties & taxes (DDU/DDP)** _(DONE 6a4bc5f, design-doc **Phase 4**,
  verified live)_ — store-level DDU/DDP setting (dashboard International-shipping
  card, stored in storefront_content); order-based customs uses it; Quick Ship
  has a per-shipment override; buyer checkout shows a duties notice for non-US
  countries (collected-on-delivery vs prepaid, per the store setting).
- [ ] _(Phase 5, later)_ **Landed-cost estimate** at checkout (show buyers the
  actual duty/tax amount) — needs a third-party service (Zonos/Easyship) or a
  simplified estimate. Optional.
- [x] **Compliance (partial)** — design-doc **Phase 5**, verified.
  - [x] **Export EEL/PFC (AES)** _(94cb500)_ — `normalizeCustoms` sets the
    low-value exemption `NOEEI 30.37(a)` under $2,500, flags `aesRequired` at/
    above, and accepts an ITN (`AES <itn>`, Quick Ship field); wired into
    Shippo `eel_pfc`. 41 unit tests pass.
  - [x] **Restricted items** _(8a6c9df, verified live)_ — per-product
    "not for international" flag; checkout blocks intl orders containing one,
    and `/api/shipping/label` blocks intl labels for such orders.
  - [ ] **Denied-party screening** — deferred: needs a restricted-party-list
    data source / API (can't do accurately without one).
- [x] **Design doc written** — see [INTERNATIONAL-SHIPPING-DESIGN.md](INTERNATIONAL-SHIPPING-DESIGN.md) (data model, per-carrier customs payloads, addresses, duties, compliance, 5-phase plan). Phase 1 = product customs fields; Phase 2 = customs on labels.
- [~] **UPS Paperless Invoice** — hardened efa4b81 (SoldTo contact) + printed-invoice fallback done fe67aee (`customsForm` captured; Quick Ship "Print customs invoice" button, GIF/PDF-aware, verified live to show only for intl non-paperless labels). **Remaining (UPS-side / live only):** (1) seller enrolls their UPS account in UPS Paperless Invoice (one-time); (2) live cross-border label on an enrolled account to confirm + fill any destination-specific fields (EORI/VAT).

## Feature roadmap — "make it yours" + growth
- [x] **Email-capture popup (phase 1)** — popup → unique single-use welcome code (reuses `discount_codes`) → emailed via Resend → dashboard subscriber list + CSV export. _(done 2026-07-19, deployed + verified)_ **Phase 2 (todo):** bulk marketing send + unsubscribe management.
- [x] **Update user manual (`guide.html`)** — added themes/branding, homepage/banner, hero + bg image, featured carousel, email capture. _(done 2026-07-19)_
- [ ] **Footer social links** — Instagram / TikTok / Facebook icons.
- [ ] **Custom font pairings** beyond the theme defaults.

## Storefront page builder (sections) — see [STOREFRONT-SECTIONS-DESIGN.md](STOREFRONT-SECTIONS-DESIGN.md)
Move the storefront from fixed editable slots → an ordered array of `{type,config}`
section blocks + a registry, so marketers can rearrange/add/remove sections safely.
Supersedes the old "Section show/hide + reorder" and "Visual/live editor" items.

### Phase 1 — Sections engine ✅ COMPLETE (2026-07-24) — no visible change; new capability under the hood
Engine + registry + server persistence all shipped & verified live. Custom layouts
now save/serve/render end-to-end; existing stores unchanged. Next: Phase 2 editor.
Goal: `index.html` can render a store from a `sections` array if present, else fall
back to today's exact layout. No editor yet (that's Phase 2).

- [x] **1. Section registry + schemas** _(done fa2cddb/1bfa23e)_ — new `SECTION_REGISTRY` (inline in `index.html`, exportable later). Define the field-type vocabulary (`text/textarea/richtext/image/link/select/toggle/number/color/collection/repeater`) and schema entries for the 4 core types: `hero`, `featured_carousel`, `product_grid`, `promo_banner`. Render stubs OK at this step.
- [x] **2. Refactor existing markup → render() fns** _(done; DOM-identical verified)_ — pull the current hard-coded hero, featured rail, and shop grid out of `index.html`'s body into `hero.render() / featured_carousel.render() / product_grid.render()`, producing identical HTML from `config` + theme tokens. _Acceptance: output byte-for-byte matches current DOM for the default config._
- [x] **3. New `promo_banner` section** _(done; live countdown verified)_ — render + schema (text, countdown, link, style). First genuinely new section type (Newegg-style deal bar).
- [x] **4. Render loop + hydration** _(done; verified rearrange + hydrate live)_ — `renderStorefront(sc, ctx)` filters enabled/known sections into `#page-home` and `.map(render).join('')`; then `hydrate()` re-wires carousel autoplay, countdowns, add-to-cart, and the category tabs against the dynamically generated markup. _Acceptance: cart/featured/filtering all still work._
- [x] **5. Legacy fallback + `legacyToSections(sc)`** _(done; existing store visually unchanged)_ — when `sc.sections` is absent, synthesize the default `[hero, featured_carousel, product_grid]` from the flat fields so the page is pixel-identical to today. _Acceptance: existing stores unchanged._
- [x] **6. Server: expose + persist + validate `sections`** _(done 78955f0; 19 validator tests incl. URL-scheme XSS guard)_ — add `sections` to the `storefrontContent` object in `GET /api/checkout/config`; make `PUT /api/seller/storefront-content` accept + merge a `sections` array with validation (array, known types only, per-type config shape, max-count cap, sanitize `richtext`). No DB migration (rides existing `storefront_content` JSONB).
- [x] **7. End-to-end verify path** _(done; saved via API → persisted → served → rendered rearranged w/ live countdown → cleared → reverted; javascript: URL stripped end-to-end)_ — set a test store's `sections` via the PUT route (no editor needed), confirm the storefront renders a **rearranged** layout, then clear `sections` → confirm it reverts to the legacy layout. Manual browser check (no test suite).
- [ ] _(optional in P1)_ **Idempotent backfill** of `sections` for existing stores — can defer to Phase 2 since the legacy fallback covers render.

### Later phases (tracked in the design doc)
- [x] **Phase 2** — dashboard editor **DONE & verified live** (5a4c03a + draft mode a20550b). Storefront page → "Page layout" card: loads draft/live/default, reorder ↑/↓, enable/disable, delete, add-picker, schema-driven per-section forms. **Draft-vs-published (a20550b):** Save draft (live untouched) / Publish / Discard draft / Preview (localStorage, banner, no persist) / Reset, with a status line; buyers never see drafts (`/api/checkout/config` reads only `sections`). Verified full lifecycle live: draft → live-unchanged → reopen-loads-draft → preview → publish→live → reset.
  - [x] **Phase 2 leftovers** — `SECTION_SCHEMAS` unified into shared
    `public/storefront-sections.js` (see Phase 3 below). Image *upload* (vs URL)
    still deferred.
- [~] **Phase 3** — in progress.
  - [x] **Shared registry** — `public/storefront-sections.js` is now the single
    catalog: `index.html` loads it for render, `dashboard.html` for the editor
    forms, and `server.js` `require()`s it for the PUT type-allowlist. Killed a
    3-way duplication that had already drifted — the editor never exposed hero
    CTAs, `product_grid.columns`, `featured_carousel.autoplay`, or the
    `promo_banner` link. All now editable, and `columns`/`autoplay` are wired to
    real behavior (inline grid-template / rotation opt-out).
  - [x] **3 new section types** — `category_tiles` (repeater of image/label/link
    tiles), `image_with_text` (editorial split, left/right), `newsletter`
    (inline twin of the capture popup, posts to the same `/api/store/subscribe`
    so the discount % can't disagree between the two entry points).
  - [x] **Editor field types** — every type in the shared vocabulary is now
    implemented: link (label+url pair), collection, number (min/max), image,
    color, richtext, and a **repeater** widget with add/remove/reorder.
  - [ ] **Merchandising** — collections/tags for section `source`. Schema+editor
    are ready (`collection` field, `all`/`featured` options); needs the product
    tags/collections data model (design-doc §8) before more sources exist.
  - [ ] **Drag-drop reorder** — ↑/↓ buttons work today; drag is polish.
  - [ ] **Live iframe preview** — today's Preview opens a new tab.
  - [ ] **Not yet verified in the live dashboard** — the editor was verified by
    unit-testing its form generation + a local harness of the storefront render
    (no DB locally). Walk the Page layout card once on the deployed site: add a
    Category tiles section, fill 2–3 tiles, Save draft → Preview → Publish.
- [ ] **Phase 4** — starter templates ("Fashion" / "Electronics" / "Minimal") that seed a whole `sections` array.

## Demo store
- [x] **Public demo storefront built** — `seed-demo.js` + `demo-content.js`
  (pure data) create/refresh a seller with slug `demo` ("Northwind Supply"):
  8 products, a 7-section layout using every section type, and **self-hosted**
  images in `public/demo/` (~1.5 MB, `CREDITS.md` records source + the
  depicts-it / unbranded / no-faces selection rules). Idempotent — matches the
  seller by slug and products by SKU. The account has a random password hash and
  no Stripe subscription, so it can't be logged into or billed, and `plan='demo'`
  excludes it from operator metrics (`getAdminStats` / `getRecentSellers`).
- [ ] **Run it** — needs `DATABASE_URL` pointed at production: `node seed-demo.js`.
  Not run yet (no DB access locally). Until then `/?store=demo` 404s.
- [ ] **Decide whether to link it publicly** from the landing page / signup —
  deliberately NOT linked yet.
- [ ] _(optional)_ Reuse `demo-content.js` as **starter content for new signups**
  so a brand-new store isn't empty. Shares the images + catalog; small follow-on.
