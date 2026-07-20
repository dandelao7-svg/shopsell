# ShopSell — TODO / Backlog

Running list of pending work. Shipped features live in [FEATURES.md](FEATURES.md).

## UI polish
- [x] **Top bar font too small** — bumped `.topbar` 12px → 13.5px + lifted contrast. _(done 2026-07-19)_

## Shipping — NEXT UP (deferred to next session)
- [ ] **Test real shipping labels** on the user's own account — in the past, purchased labels "didn't look right." Buy a real label end-to-end, inspect the output (layout/format/print), and fix rendering issues.
- [ ] **Batch printing test** — needs a **thermal printer** (user is buying one). Test the batch label flow + merged-label PDF output on real hardware.

## Feature roadmap — "make it yours" + growth
- [x] **Email-capture popup (phase 1)** — popup → unique single-use welcome code (reuses `discount_codes`) → emailed via Resend → dashboard subscriber list + CSV export. _(done 2026-07-19, deployed + verified)_ **Phase 2 (todo):** bulk marketing send + unsubscribe management.
- [x] **Update user manual (`guide.html`)** — added themes/branding, homepage/banner, hero + bg image, featured carousel, email capture. _(done 2026-07-19)_
- [ ] **Section show/hide + reorder** — let tenants toggle/reorder homepage sections (hero, category tiles, featured rail, etc.).
- [ ] **Footer social links** — Instagram / TikTok / Facebook icons.
- [ ] **Custom font pairings** beyond the theme defaults.
- [ ] _(later)_ Visual / live editor.
