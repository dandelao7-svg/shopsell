# ShopSell — TODO / Backlog

Running list of pending work. Shipped features live in [FEATURES.md](FEATURES.md).

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
  - [ ] **Quick Ship (`shipping.html`) manual international** — a distinct
    sub-feature: needs the country/region UI **plus a manual customs-entry UI**
    (Quick Ship has no order to auto-assemble customs from, so an intl label
    without it would be rejected) **plus** international service options in the
    service picker. Do these together as one coherent piece.
- [ ] **International services & rates** — surface UPS Worldwide / FedEx
  International / USPS Intl (via Shippo) in rate shopping + Quick Ship service
  picker (rate shopping already returns intl services for cross-border routes;
  the Quick Ship picker's options are still hard-coded domestic).
- [ ] **Duties & taxes** — DDP vs DDU choice (who pays duties); optional landed-cost
  estimate at checkout.
- [ ] **Compliance** — restricted/prohibited items, denied-party screening,
  export EEL/PFC (AES) threshold handling.
- [x] **Design doc written** — see [INTERNATIONAL-SHIPPING-DESIGN.md](INTERNATIONAL-SHIPPING-DESIGN.md) (data model, per-carrier customs payloads, addresses, duties, compliance, 5-phase plan). Phase 1 = product customs fields; Phase 2 = customs on labels.

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
  - [ ] **Phase 2 leftovers:** unify editor `SECTION_SCHEMAS` with index.html registry into a shared `public/storefront-sections.js`; richer field types (link, image-upload) as sections grow.
- [ ] **Phase 3** — more section types (`category_tiles`, `image_with_text`, `newsletter`) + merchandising (collections/tags for section `source`) + drag-drop + live iframe preview.
- [ ] **Phase 4** — starter templates ("Fashion" / "Electronics" / "Minimal") that seed a whole `sections` array.
