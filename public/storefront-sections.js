/* ============================================================
   STOREFRONT SECTIONS — shared registry
   ------------------------------------------------------------
   THE single catalog of storefront section types. Loaded by:
     • index.html   — buyer storefront; uses label + schema + render
     • dashboard.html — Page layout editor; uses label + schema
     • server.js    — require()s it for the type allowlist on PUT

   Previously this lived in three hand-maintained copies which had
   already drifted (the editor never exposed hero CTAs, grid columns,
   or carousel autoplay). Add a type ONCE, here, and all three follow.

   Each entry declares:
     • label  — human name, shown in the editor
     • schema — editable settings; DRIVES the editor form automatically
     • render — (config, ctx) => HTML string, built from theme tokens only

   Schema field-type vocabulary (the editor implements each):
     text · textarea · richtext · image · link · select ·
     toggle · number · color · collection · repeater

   SECURITY: render() output is injected as innerHTML, so every
   config-supplied value must pass through esc(). URL-bearing values are
   ALSO scheme-checked server-side (server.js _safeUrl) before storage —
   escaping alone does not neutralize `javascript:` in an href.
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof window !== 'undefined') {
    root.SECTION_REGISTRY    = api.SECTION_REGISTRY;
    root.SECTION_TYPES       = api.SECTION_TYPES;
    root.SECTION_TYPE_ORDER  = api.SECTION_TYPE_ORDER;
    root.COLLECTION_OPTIONS  = api.COLLECTION_OPTIONS;
    root.legacyToSections    = api.legacyToSections;
    root._ssEsc              = api.esc;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

var esc = function (s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};

// Product-source options for section `source` fields. Only "all" and "featured"
// exist today (they map to existing product state); seller-defined collections
// are design-doc §8 / Phase 3 merchandising and slot in here without a schema
// change — sections are forward-compatible with `collection:<id>` / `tag:<slug>`.
var COLLECTION_OPTIONS = [
  { value: 'all',      label: 'All products' },
  { value: 'featured', label: 'Featured products' },
];

var SECTION_REGISTRY = {
  hero: {
    label: 'Hero',
    schema: [
      { key: 'eyebrow', type: 'text',     label: 'Eyebrow' },
      { key: 'title',   type: 'richtext', label: 'Headline' },
      { key: 'subtext', type: 'textarea', label: 'Subtext' },
      { key: 'cta1',    type: 'link',     label: 'Primary button' },
      { key: 'cta2',    type: 'link',     label: 'Secondary button' },
      { key: 'image',   type: 'image',    label: 'Background image' },
    ],
    // Reproduces the static .hero exactly when config is empty. A
    // seller-supplied title is escaped (plain text); only the built-in default
    // is trusted HTML (<br><em>), matching the old applyHomepage() path.
    render: function (c) {
      c = c || {};
      var eyebrow = (c.eyebrow && c.eyebrow.trim()) || 'New arrivals · Free shipping always';
      var titleRaw = (c.title && c.title.trim());
      var title = titleRaw ? esc(titleRaw) : 'Shop smarter,<br><em>live better.</em>';
      var subtext = (c.subtext && c.subtext.trim()) || 'Curated products from independent sellers — free shipping on every single order, no minimums.';
      var cta1 = (c.cta1 && c.cta1.label) || 'Shop now';
      var cta2 = (c.cta2 && c.cta2.label) || 'New arrivals';
      var bg = c.image
        ? ' style="background-image:linear-gradient(rgba(15,15,26,0.55),rgba(15,15,26,0.55)),url(\'' + esc(c.image) + '\');background-size:cover;background-position:center"'
        : '';
      return '<div class="hero"' + bg + '>\n' +
'    <div class="hero-eyebrow" id="heroEyebrow">' + esc(eyebrow) + '</div>\n' +
'    <h1 id="heroTitle">' + title + '</h1>\n' +
'    <p class="hero-sub" id="heroSub">' + esc(subtext) + '</p>\n' +
'    <div class="hero-actions">\n' +
'      <button class="btn-hero primary" id="heroCta1" onclick="navTo(\'shop\')">' + esc(cta1) + '</button>\n' +
'      <button class="btn-hero secondary" id="heroCta2" onclick="navTo(\'shop\')">' + esc(cta2) + '</button>\n' +
'    </div>\n' +
'    <div class="hero-stats">\n' +
'      <div><div class="hero-stat-val">500+</div><div class="hero-stat-label">Products</div></div>\n' +
'      <div><div class="hero-stat-val">Free</div><div class="hero-stat-label">Shipping always</div></div>\n' +
'      <div><div class="hero-stat-val">4.9★</div><div class="hero-stat-label">Avg. rating</div></div>\n' +
'    </div>\n' +
'  </div>';
    },
  },

  category_tiles: {
    label: 'Category tiles',
    schema: [
      { key: 'heading', type: 'text', label: 'Heading' },
      { key: 'tiles', type: 'repeater', label: 'Tiles', max: 12, fields: [
        { key: 'label',    type: 'text',  label: 'Label' },
        { key: 'image',    type: 'image', label: 'Image URL' },
        { key: 'category', type: 'text',  label: 'Category (e.g. clothing) — filters the grid' },
        { key: 'href',     type: 'text',  label: 'Or a link URL (/path or https://…)' },
      ] },
    ],
    // Macy's-style department grid. A tile with no image falls back to a tinted
    // panel so a half-configured tile still looks deliberate. Renders nothing
    // when there are no tiles, so an empty section leaves no gap on the page.
    //
    // Two ways to make a tile clickable, and they are NOT interchangeable:
    //   • category — filters the product_grid in place (hydrateTileLinks wires
    //     the click; data-cat is read there). This is the common case.
    //   • href     — a real URL for anything else.
    // `category` is a separate key on purpose: the server scheme-checks every
    // URL-bearing key (_safeUrl), so a bare token like "clothing" typed into
    // href is silently dropped on save — which is exactly the trap the old
    // "or a category" hint in this schema led sellers into. category wins if
    // both are set.
    render: function (c) {
      c = c || {};
      var tiles = Array.isArray(c.tiles) ? c.tiles.filter(function (t) {
        return t && ((t.label && t.label.trim()) || t.image);
      }) : [];
      if (!tiles.length) return '';
      var heading = (c.heading && c.heading.trim());
      var cards = tiles.map(function (t) {
        var label = esc((t.label || '').trim());
        var bg = t.image
          ? ' style="background-image:linear-gradient(rgba(15,15,26,0.30),rgba(15,15,26,0.50)),url(\'' + esc(t.image) + '\');background-size:cover;background-position:center"'
          : '';
        var inner = '<span class="ss-tile-label">' + label + '</span>';
        var cls = 'ss-tile' + (t.image ? '' : ' ss-tile--plain');
        var cat  = (t.category || '').trim();
        var href = (t.href || '').trim();
        if (cat) {
          return '<a class="' + cls + '" href="#" data-cat="' + esc(cat) + '"' + bg + '>' + inner + '</a>';
        }
        return href
          ? '<a class="' + cls + '" href="' + esc(href) + '"' + bg + '>' + inner + '</a>'
          : '<div class="' + cls + '"' + bg + '>' + inner + '</div>';
      }).join('');
      return '<section class="ss-tiles-section">' +
        (heading ? '<h2 class="ss-section-hd">' + esc(heading) + '</h2>' : '') +
        '<div class="ss-tiles">' + cards + '</div></section>';
    },
  },

  featured_carousel: {
    label: 'Featured carousel',
    schema: [
      { key: 'heading',  type: 'text',       label: 'Heading' },
      { key: 'source',   type: 'collection', label: 'Products', default: 'featured' },
      { key: 'autoplay', type: 'toggle',     label: 'Auto-scroll', default: true },
    ],
    // Renders the rail shell; the track is filled by renderFeatured() at
    // hydration. data-autoplay is read there to decide whether to auto-advance.
    render: function (c) {
      c = c || {};
      var heading = (c.heading && c.heading.trim()) || 'Featured';
      var autoplay = c.autoplay === false ? 'false' : 'true';
      return '<section class="featured-rail" id="featuredRail" data-autoplay="' + autoplay + '" hidden>\n' +
'    <div class="featured-rail-hd">\n' +
'      <h2 id="featuredTitle">' + esc(heading) + '</h2>\n' +
'      <span class="featured-rail-hint">Hover to pause</span>\n' +
'    </div>\n' +
'    <div class="featured-track" id="featuredTrack"></div>\n' +
'  </section>';
    },
  },

  product_grid: {
    label: 'Product grid',
    schema: [
      { key: 'source',      type: 'collection', label: 'Products', default: 'all' },
      { key: 'showFilters', type: 'toggle',     label: 'Category tabs', default: true },
      { key: 'columns',     type: 'number',     label: 'Columns (2–6, blank = auto)', min: 2, max: 6 },
    ],
    // Reproduces the static .cat-strip + .shop-section. #homeGrid is filled by
    // renderGrid() at hydration. Categories are still hard-coded; seller-defined
    // collections are design-doc §8.
    render: function (c) {
      c = c || {};
      // data-cat mirrors each tab's category so category_tiles can light up the
      // matching tab when a tile filters the grid (see hydrateTileLinks).
      var filters = c.showFilters === false ? '' : '<div class="cat-strip">\n' +
'    <div class="cat-strip-inner" id="homeCatStrip">\n' +
'      <div class="cat-tab active" data-cat="all" onclick="setHomeCat(\'all\',this)">All</div>\n' +
'      <div class="cat-tab" data-cat="clothing" onclick="setHomeCat(\'clothing\',this)">Clothing</div>\n' +
'      <div class="cat-tab" data-cat="accessories" onclick="setHomeCat(\'accessories\',this)">Accessories</div>\n' +
'      <div class="cat-tab" data-cat="home" onclick="setHomeCat(\'home\',this)">Home & Living</div>\n' +
'      <div class="cat-tab" data-cat="beauty" onclick="setHomeCat(\'beauty\',this)">Beauty</div>\n' +
'    </div>\n' +
'  </div>\n' +
'  ';
      var cols = parseInt(c.columns, 10);
      var gridStyle = (cols >= 2 && cols <= 6)
        ? ' style="grid-template-columns:repeat(' + cols + ',minmax(0,1fr))"'
        : '';
      return filters + '<div class="shop-section">\n' +
'    <div class="shop-toolbar">\n' +
'      <span class="results-count" id="homeCount">12 products</span>\n' +
'      <select class="sort-select" onchange="setHomeSort(this.value)">\n' +
'        <option value="default">Featured</option>\n' +
'        <option value="price-asc">Price: low to high</option>\n' +
'        <option value="price-desc">Price: high to low</option>\n' +
'        <option value="rating">Top rated</option>\n' +
'        <option value="newest">Newest</option>\n' +
'      </select>\n' +
'    </div>\n' +
'    <div class="products-grid" id="homeGrid"' + gridStyle + '></div>\n' +
'  </div>';
    },
  },

  promo_banner: {
    label: 'Promo banner',
    schema: [
      { key: 'text',        type: 'text',   label: 'Text' },
      { key: 'countdownTo', type: 'text',   label: 'Countdown to (ISO date, e.g. 2026-12-25T00:00:00Z)' },
      { key: 'link',        type: 'link',   label: 'Link' },
      { key: 'style',       type: 'select', label: 'Style', options: ['solid', 'outline'], default: 'solid' },
    ],
    // Newegg-style deal bar with an optional live countdown (hydrated by
    // hydratePromoCountdowns). Renders nothing if there's no text and no
    // countdown, so an empty banner never leaves a bar on the page.
    render: function (c) {
      c = c || {};
      var text = esc((c.text || '').trim());
      var until = (c.countdownTo || '').trim();
      if (!text && !until) return '';
      var cls = c.style === 'outline' ? 'ss-promo ss-promo--outline' : 'ss-promo ss-promo--solid';
      var cd = until ? '<span class="ss-promo-countdown" data-until="' + esc(until) + '"></span>' : '';
      var inner = (text ? '<span class="ss-promo-text">' + text + '</span>' : '') + cd;
      var url = (c.link && c.link.url) ? esc(c.link.url) : '';
      return url
        ? '<a class="' + cls + '" href="' + url + '">' + inner + '</a>'
        : '<div class="' + cls + '">' + inner + '</div>';
    },
  },

  image_with_text: {
    label: 'Image with text',
    schema: [
      { key: 'image',     type: 'image',    label: 'Image' },
      { key: 'heading',   type: 'text',     label: 'Heading' },
      { key: 'body',      type: 'textarea', label: 'Body text' },
      { key: 'cta',       type: 'link',     label: 'Button' },
      { key: 'imageSide', type: 'select',   label: 'Image side', options: ['left', 'right'], default: 'left' },
    ],
    // Editorial split block. Degrades sensibly: text-only if there's no image,
    // image-only if there's no copy; renders nothing when both are empty.
    render: function (c) {
      c = c || {};
      var heading = (c.heading || '').trim();
      var body = (c.body || '').trim();
      var img = (c.image || '').trim();
      if (!heading && !body && !img) return '';
      var side = c.imageSide === 'right' ? ' ss-iwt--right' : '';
      var media = img
        ? '<div class="ss-iwt-media" style="background-image:url(\'' + esc(img) + '\')"></div>'
        : '';
      var btn = (c.cta && c.cta.label && c.cta.label.trim())
        ? (c.cta.url
            ? '<a class="ss-iwt-btn" href="' + esc(c.cta.url) + '">' + esc(c.cta.label) + '</a>'
            : '<button class="ss-iwt-btn" onclick="navTo(\'shop\')">' + esc(c.cta.label) + '</button>')
        : '';
      var copy = '<div class="ss-iwt-copy">' +
        (heading ? '<h2 class="ss-section-hd">' + esc(heading) + '</h2>' : '') +
        (body ? '<p class="ss-iwt-body">' + esc(body) + '</p>' : '') +
        btn + '</div>';
      return '<section class="ss-iwt' + side + '">' + media + copy + '</section>';
    },
  },

  newsletter: {
    label: 'Newsletter signup',
    schema: [
      { key: 'headline',    type: 'text',     label: 'Headline' },
      { key: 'subtext',     type: 'textarea', label: 'Subtext' },
      { key: 'buttonLabel', type: 'text',     label: 'Button label' },
    ],
    // Inline twin of the email-capture popup — posts to the same
    // /api/store/subscribe endpoint, so the seller's existing discount-percent
    // setting and one-time-code emailing apply unchanged. Wired by the inline
    // onsubmit below (no hydration step needed); the discount % is NOT
    // configurable here on purpose, so both entry points can't disagree about
    // what's on offer.
    render: function (c) {
      c = c || {};
      var headline = (c.headline && c.headline.trim()) || 'Get the good stuff first';
      var subtext = (c.subtext && c.subtext.trim()) || 'Join our list for early access to new arrivals and members-only deals.';
      var btn = (c.buttonLabel && c.buttonLabel.trim()) || 'Sign up';
      return '<section class="ss-news">' +
        '<h2 class="ss-section-hd">' + esc(headline) + '</h2>' +
        '<p class="ss-news-sub">' + esc(subtext) + '</p>' +
        '<form class="ss-news-form" onsubmit="return submitNewsletterSection(event,this)">' +
          '<input type="email" class="ss-news-input" name="email" required placeholder="you@email.com" aria-label="Email address">' +
          '<button type="submit" class="ss-news-btn">' + esc(btn) + '</button>' +
        '</form>' +
        '<div class="ss-news-msg" hidden></div>' +
      '</section>';
    },
  },
};

// Order shown in the editor's "Add section" picker.
var SECTION_TYPE_ORDER = [
  'hero', 'category_tiles', 'featured_carousel', 'product_grid',
  'promo_banner', 'image_with_text', 'newsletter',
];

// Allowed types — the render loop and the server's PUT validator both use this.
var SECTION_TYPES = Object.keys(SECTION_REGISTRY);

/* The default layout, seeded from the legacy flat hero fields.
   ------------------------------------------------------------
   A store that has never used the page-builder keeps its hero in
   content.heroTitle / heroImage / … . Both the storefront (rendering a store
   with no `sections`) and the dashboard editor (showing "Default layout") have
   to turn those flat fields into the same section list — and they each had
   their OWN copy. The storefront's mapped the legacy values across; the
   editor's returned `config:{}`. So the editor showed a seller's customized
   hero as blank, and the first Publish wrote those empty configs over it,
   silently reverting the storefront to stock copy and dropping the uploaded
   hero image. One definition, used by both, is the only thing that keeps them
   from drifting apart again. */
function legacyToSections(sc) {
  sc = sc || {};
  return [
    { type: 'hero', config: {
      eyebrow: sc.heroEyebrow,
      title:   sc.heroTitle,
      subtext: sc.heroSubtext,
      cta1:    sc.heroCta1 ? { label: sc.heroCta1 } : undefined,
      cta2:    sc.heroCta2 ? { label: sc.heroCta2 } : undefined,
      image:   sc.heroImage || '',
    } },
    { type: 'featured_carousel', config: {} },
    { type: 'product_grid',      config: { showFilters: true } },
  ];
}

return {
  SECTION_REGISTRY: SECTION_REGISTRY,
  SECTION_TYPES: SECTION_TYPES,
  SECTION_TYPE_ORDER: SECTION_TYPE_ORDER,
  COLLECTION_OPTIONS: COLLECTION_OPTIONS,
  legacyToSections: legacyToSections,
  esc: esc,
};
});
