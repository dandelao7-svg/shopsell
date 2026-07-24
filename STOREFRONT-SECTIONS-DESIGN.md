# Storefront Sections — Design Doc

**Status:** Draft · **Author:** design session 2026-07-24 · **Owner:** Dan

Goal: let a marketer build storefronts as structurally different as JCPenney,
Macy's, and Newegg — rearranging, adding, and removing whole page sections —
**without** being able to break the layout or make it ugly, and without a build
step being added to the stack.

---

## 1. Where we are today

The storefront is a **fixed layout with editable slots**.

- **Storage:** `sellers.storefront_content` — a per-seller `JSONB` blob
  (`database.js` `getSellerStorefrontContent` / `setSellerStorefrontContent`).
- **Shape:** a flat bag of named fields, assembled in `server.js`
  (`GET /api/checkout/config`, ~line 1709): `theme`, `accentColor`, `logoUrl`,
  `heroEyebrow/Title/Subtext/Cta1/Cta2/Image`, `announcement*`, `popup*`,
  `featuredRailEnabled`, plus static pages `about/faq/privacy/terms/contactEmail`.
- **Render:** `index.html` is a hard-coded page. It has fixed DOM nodes
  (`#heroTitle`, `#featuredRail`, `.cat-strip`, `.shop-section`) and injects the
  seller's text into them by id (`setText('heroTitle', sc.heroTitle)`, etc.).
- **Editor:** dashboard writes the same flat fields via
  `PUT /api/seller/storefront-content` and appearance routes.

**Why this caps flexibility:** the three big retailers don't differ in *wording*
— they differ in *structure*: different section types, in different orders,
some repeated (Macy's department tiles, Newegg deal/countdown banners,
editorial image+text blocks). Our model can restyle the fixed boxes but can't
reorder them, add new ones, or drop unused ones. Also note the homepage
category tabs (`All / Clothing / Accessories / Home & Living / Beauty`) are
**hard-coded** in `index.html`, not data-driven — see §8.

---

## 2. The core shift: sections, not slots

Adopt the model every flexible builder uses (Shopify, Squarespace, BigCommerce,
Webflow): **the page is an ordered array of section blocks**, each
`{ id, type, config }`. Marketers add / remove / reorder / duplicate sections and
edit each section's settings. `storefront_content` already is the right home.

### Data model

Extend the existing blob with a `sections` array. Global appearance keys stay
exactly as they are.

```jsonc
{
  // GLOBAL — unchanged
  "theme": "classic",
  "accentColor": "#e63946",
  "logoUrl": "https://…",
  "contactEmail": "…", "about": "…", "faq": "…", "privacy": "…", "terms": "…",

  // NEW — the ordered page
  "sections": [
    { "id": "a1", "type": "hero",              "config": { "eyebrow": "…", "title": "…", "subtext": "…", "image": "…", "cta1": {…}, "cta2": {…} } },
    { "id": "a2", "type": "category_tiles",    "config": { "heading": "Shop by department", "tiles": [ {…} ] } },
    { "id": "a3", "type": "featured_carousel", "config": { "heading": "Trending now", "source": "featured", "autoplay": true } },
    { "id": "a4", "type": "promo_banner",      "config": { "text": "48-hour deal", "countdownTo": "2026-08-01T00:00:00Z", "link": "…" } },
    { "id": "a5", "type": "product_grid",      "config": { "source": "all", "columns": 4, "showFilters": true } },
    { "id": "a6", "type": "image_with_text",   "config": { "image": "…", "heading": "…", "body": "…", "cta": {…}, "imageSide": "left" } }
  ]
}
```

### Backward compatibility (non-negotiable)

- If `sections` is **absent**, `index.html` renders **today's fixed layout**
  exactly as now. No existing store changes until it opts in.
- A one-time, idempotent migration synthesizes a starter `sections` array from a
  store's current flat fields (see §7 mapping). Runs lazily the first time a
  store opens the new editor, or as a backfill script.

---

## 3. The section registry (the safety valve)

A single source of truth: a catalog of allowed section **types**, each declaring
two things.

```js
// storefront-sections.js  (shared shape; frontend uses render, editor uses schema)
const SECTION_REGISTRY = {
  hero: {
    label: "Hero",
    // 1) settings schema — DRIVES THE EDITOR UI AUTOMATICALLY
    schema: [
      { key: "eyebrow", type: "text",     label: "Eyebrow" },
      { key: "title",   type: "richtext", label: "Headline" },
      { key: "subtext", type: "textarea", label: "Subtext" },
      { key: "image",   type: "image",    label: "Background image" },
      { key: "cta1",    type: "link",     label: "Primary button" },
      { key: "cta2",    type: "link",     label: "Secondary button" }
    ],
    // 2) render — returns HTML built ONLY from theme tokens (see §5)
    render: (config, ctx) => `<section class="ss-hero"> … </section>`
  },
  // category_tiles, featured_carousel, product_grid, promo_banner,
  // image_with_text, rich_text, newsletter, trust_bar …
};
```

Two payoffs:

- **Marketers can only use registered types**, and every section is rendered by
  our code — never raw user markup — so a rearranged page stays safe.
- **The editor is generic.** Because each type declares its `schema`, the
  dashboard renders the right form controls automatically. Adding a new section
  type = one registry entry, zero bespoke editor code.

Field `type`s to support in the schema: `text`, `textarea`, `richtext`,
`image`, `link` (`{label,url}`), `select`, `toggle`, `number`, `color`,
`collection` (picks a product source), `repeater` (list of sub-items, e.g.
tiles/slides).

---

## 4. Initial section catalog

Seven types cover all three reference retailers. Each renders inside theme
tokens.

| Type | Purpose | Key settings |
|---|---|---|
| `hero` | Top banner / slideshow | eyebrow, title, subtext, image(s), CTAs |
| `category_tiles` | Macy's-style department grid | repeater of {image, label, link} |
| `featured_carousel` | Auto-scrolling product rail | heading, source (collection/tag), autoplay |
| `product_grid` | Main shopping grid | source, columns, filters on/off |
| `promo_banner` | Newegg-style deal / countdown | text, countdown, link, style |
| `image_with_text` | Editorial block | image, heading, body, CTA, image side |
| `newsletter` | Email capture (reuse existing popup→code) | headline, subtext, percent |

Later: `trust_bar` (logos/badges), `rich_text`, `video`, `testimonials`,
`collection_list`.

---

## 5. Rendering engine (`index.html`)

Replace the hard-coded page body with a render loop:

```js
function renderStorefront(sc, ctx) {
  const host = document.getElementById('page-home');
  const sections = sc.sections?.length ? sc.sections : legacyToSections(sc); // fallback
  host.innerHTML = sections
    .filter(s => SECTION_REGISTRY[s.type] && s.enabled !== false)
    .map(s => SECTION_REGISTRY[s.type].render(s.config, ctx))
    .join('');
  hydrate(host); // wire carousels, countdowns, add-to-cart, etc.
}
```

**Guardrails that keep it on-brand no matter how it's arranged:**

1. Every section's markup uses **theme design tokens** (CSS variables for color,
   font, spacing, radius) — the same ones `theme`/`accentColor` already drive.
   A fully rearranged page still looks like one coherent store.
2. No raw HTML/CSS from marketers. `richtext` fields are sanitized (allowlist of
   tags); everything else is typed values. ("Flexible" ≠ "hand-write markup.")
3. Sections are self-contained and order-independent — no section assumes another
   is above/below it.

---

## 6. The editor (dashboard)

Schema-driven, so it scales to any number of section types for free.

- **Section list:** the store's `sections` as reorderable rows (add / duplicate /
  delete / toggle-visible / drag to reorder).
- **Section settings:** clicking a row renders a form from that type's `schema`.
- **Add section:** a picker of registry types (with thumbnails).
- **Live preview:** an `<iframe>` of `index.html` in a preview mode that re-renders
  from the in-progress `sections` on each change (Shopify-style). Phase this in —
  Phase 2 can ship with save-then-refresh.
- **Persistence:** `PUT /api/seller/storefront-content` merges `sections` into the
  blob (same merge pattern already used for appearance keys).

---

## 7. Migration: flat fields → starter sections

`legacyToSections(sc)` builds the default page so existing stores look identical:

```
hero              ← heroEyebrow/Title/Subtext/Cta1/Cta2/Image
featured_carousel ← featuredRailEnabled (source: "featured")
product_grid      ← the current shop section (source: "all", filters on)
```

`announcement*` becomes a global bar (above sections, not a section). `popup*`
stays global. Idempotent: only synthesizes when `sections` is absent.

---

## 8. Dependency: merchandising / collections

Newegg vs Macy's is also about *what* products show where — collections,
categories, tags, filters. Product-bearing sections (`featured_carousel`,
`product_grid`, `category_tiles`) need a **`source`**: a collection or tag.

Today categories are **hard-coded** in `index.html` (`All / Clothing / …`) and
"featured" is a per-product `is_featured` flag. To make sections truly reusable
this needs a small parallel track:

- Product **tags / collections** (seller-defined), stored per product.
- Section `source` = `"all" | "featured" | "collection:<id>" | "tag:<slug>"`.

Can ship Phase 1 using only `all` + `featured` (already exist) and add
collections in parallel — sections are forward-compatible with it.

---

## 9. Phasing

1. **Sections engine** — `sections` array, `SECTION_REGISTRY` with 3–4 core types
   (hero, featured_carousel, product_grid, promo_banner), render loop in
   `index.html`, legacy fallback + migration. *No visible change for existing
   stores; new capability available.*
2. **Editor** — reorder / add / remove / toggle + schema-generated forms;
   save-then-refresh preview.
3. **More types + merchandising** — category_tiles, image_with_text, newsletter;
   collections/tags for `source`; drag-drop; live iframe preview.
4. **Starter templates** — named presets ("Fashion", "Electronics", "Minimal")
   that seed a whole `sections` array, so a marketer starts one click away from a
   Macy's-like or Newegg-like layout.

---

## 10. Open decisions

- **Templates vs blank start** for new stores (recommend: ship with the current
  layout as the default template).
- **Rich text scope** — how much HTML to allow (recommend: tight allowlist —
  bold/italic/links/headings — no arbitrary markup).
- **Per-section theming** — allow a section to override background/spacing, or
  keep all styling global (recommend: global first; add per-section
  background/padding later, still from tokens).
- **Draft vs published** — do marketers edit live or stage changes? (recommend:
  add a `draftSections` alongside `sections` in Phase 2 so edits publish
  atomically.)
- **Mobile** — section order is shared across breakpoints; the theme's responsive
  rules handle reflow. Revisit per-section mobile controls only if needed.

---

## Appendix: why this fits our stack

- No build step: registry + render loop are plain JS in `index.html`; the editor
  is plain JS in the dashboard. Consistent with the vanilla-HTML architecture.
- No schema migration churn: everything rides in the existing
  `storefront_content` JSONB — `initSchema` already creates the column.
- Reuses existing machinery: appearance tokens, the email-capture popup→code
  flow, `is_featured`, and the merge-on-PUT persistence pattern.
