# ShopSell — TODO / Backlog

Running list of pending work. Shipped features live in [FEATURES.md](FEATURES.md).

## UI polish
- [ ] **Top bar font too small** — the `.topbar` strip ("Free shipping on every order…" on the left, "My account / Track order / Help" on the right) is 12px and hard to read. Bump the size for legibility. _(reported 2026-07-19 — one-line CSS fix in index.html)_

## Shipping
- [ ] **Test real shipping labels** on the user's own account — in the past, purchased labels "didn't look right." Buy a real label end-to-end, inspect the output (layout/format/print), and fix rendering issues. _(after email-capture + manual)_

## Feature roadmap — "make it yours" + growth
- [ ] **Email-capture popup (phase 1)** — visitor popup offering a configurable % off for their email → record subscriber → generate a unique single-use welcome code (reuses `discount_codes`) → email it via Resend → dashboard subscriber list + CSV export. _Phase 2:_ bulk marketing send + unsubscribe management.
- [ ] **Update user manual (`guide.html`)** — add the new customization features (themes, accent color, logo, featured carousel, announcement bar, hero text + background image).
- [ ] **Section show/hide + reorder** — let tenants toggle/reorder homepage sections (hero, category tiles, featured rail, etc.).
- [ ] **Footer social links** — Instagram / TikTok / Facebook icons.
- [ ] **Custom font pairings** beyond the theme defaults.
- [ ] _(later)_ Visual / live editor.
