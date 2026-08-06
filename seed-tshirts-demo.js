#!/usr/bin/env node
/* ============================================================
   seed-tshirts-demo.js — a dedicated t-shirt demo store for the pitch.
   ------------------------------------------------------------
     node seed-tshirts-demo.js                  # create or refresh
     node seed-tshirts-demo.js --wipe           # delete its products first
     node seed-tshirts-demo.js --remove         # delete the store entirely
     node seed-tshirts-demo.js --db "postgres://…"

   Produces /?store=tees (and tees.<PLATFORM_DOMAIN>) with five
   variant-based t-shirt designs — sizes S/M/L/XL × 2-3 colors each. Every
   variant carries its own /img/<id> photo so the storefront modal swaps the
   picture when a shopper picks a color. Deliberately not a real account.

   IDEMPOTENT: matches by slug + sku, updates in place. Photos are
   regenerated + re-uploaded on every run — they're only a few KB each,
   so this stays cheap even after many reseeds.
   ============================================================ */
require('dotenv').config();
const crypto = require('crypto');
const zlib   = require('zlib');

// --db handling — must run before requiring ./database, same as seed-demo.js.
function readDbFlag(argv) {
  const i = argv.findIndex(a => a === '--db' || a.startsWith('--db='));
  if (i === -1) return null;
  const val = argv[i].startsWith('--db=') ? argv[i].slice(5) : argv[i + 1];
  if (!val || val.startsWith('--')) {
    console.error('--db needs a connection string, e.g. --db "postgresql://user:pass@host:port/db"');
    process.exit(1);
  }
  return val;
}
const dbFlag = readDbFlag(process.argv);
if (dbFlag) process.env.DATABASE_URL = dbFlag;

function redactDbUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? u.username + ':***@' : ''}${u.host}${u.pathname}`;
  } catch { return '(unparseable)'; }
}

const WIPE    = process.argv.includes('--wipe');
const REMOVE  = process.argv.includes('--remove');
const PREVIEW = process.argv.includes('--preview');

if (!PREVIEW && !process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL in .env or pass --db "postgres://…" (or --preview to render sample PNGs without a DB).');
  process.exit(1);
}

// Only pull in the DB layer when we actually need it — --preview stays offline.
const db = PREVIEW ? null : require('./database');

// --- Store identity ---
const SLUG       = 'tees';
const EMAIL      = 'demo-tees@nextlao.com';
const STORE_NAME = 'Coastline Print Co';

// --- Designs ---
// Each has an accent color + a shape drawn inside a "print zone" rectangle,
// so the designs look visually distinct even at low fidelity.
const DESIGNS = [
  { sku:'SUNSET', name:'Sunset Fade Tee',   price:28, accent:[234, 109, 48], shape:'stripes',
    description:'Hand-drawn sunset fade in soft-hand water-based ink. Ringspun cotton, garment-washed for a lived-in feel from the first day.' },
  { sku:'WAVE',   name:'Coastal Wave Tee',  price:30, accent:[ 58, 110, 165], shape:'wave',
    description:'Long shadows and pier posts printed across the chest. 100% combed cotton — soft, breathable, hangs beautifully.' },
  { sku:'RIDGE',  name:'Ridgeline Tee',     price:32, accent:[ 90, 140,  90], shape:'peaks',
    description:'Mountain silhouette against a wide horizon. Screen printed on a mid-weight ringspun tee.' },
  { sku:'BOLD',   name:'Vintage Bold Tee',  price:30, accent:[230, 195,  60], shape:'block',
    description:'A bold logo panel — the classic band-shirt cut. True to size, holds shape wash after wash.' },
  { sku:'PALM',   name:'Palm Grove Tee',    price:28, accent:[ 70, 160, 140], shape:'dots',
    description:'Little palm-grove circles in a repeat print. Featherweight cotton for warm weather.' },
];

// --- Colors ---
const COLORS = [
  { name:'Black',   rgb:[ 23,  20,  18] },
  { name:'White',   rgb:[240, 235, 230] },
  { name:'Navy',    rgb:[ 30,  40,  70] },
];
const SIZES = ['S','M','L','XL'];

// --- Minimal PNG encoder for solid + patterned images ---
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xFF];
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// Build an RGB pixel buffer. `paint(x, y)` returns [r,g,b] for each pixel.
function makePng(w, h, paint) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;   // 8-bit RGB
  const scan = Buffer.alloc(1 + w * 3);
  const raw = Buffer.alloc(h * scan.length);
  for (let y = 0; y < h; y++) {
    scan[0] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      scan[1 + x*3]     = r;
      scan[1 + x*3 + 1] = g;
      scan[1 + x*3 + 2] = b;
    }
    scan.copy(raw, y * scan.length);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// A t-shirt mockup: full canvas in shirt color, a centered "print zone"
// with the design accent, and a shape inside the print zone that differs per
// design so the five designs look distinct.
function tshirtMockup(shirtRgb, design) {
  const W = 600, H = 600;
  // print zone bounds (centered)
  const px = 180, py = 200, pw = 240, ph = 180;
  // accent border ring
  const bx = px - 6, by = py - 6, bw = pw + 12, bh = ph + 12;
  const [sr, sg, sb] = shirtRgb;
  const [ar, ag, ab] = design.accent;
  // a mid-tone between shirt + accent for subtle secondary marks
  const mr = ((sr + ar) >> 1), mg = ((sg + ag) >> 1), mb = ((sb + ab) >> 1);

  function inPrintZone(x, y) { return x >= px && x < px + pw && y >= py && y < py + ph; }
  function inBorder(x, y)    { return x >= bx && x < bx + bw && y >= by && y < by + bh && !inPrintZone(x, y); }

  return makePng(W, H, (x, y) => {
    if (inBorder(x, y)) return design.accent;   // thin ring
    if (!inPrintZone(x, y)) return shirtRgb;
    // Inside the print zone — draw a shape per design.
    const rx = x - px, ry = y - py;    // relative to print zone
    switch (design.shape) {
      case 'stripes': {
        // Horizontal bars in accent
        const band = Math.floor(ry / 24);
        return band % 2 === 0 ? design.accent : shirtRgb;
      }
      case 'wave': {
        // Sine wave in accent
        const cy = ph / 2;
        const yWave = cy + Math.sin(rx * 0.06) * 30;
        return Math.abs(ry - yWave) < 8 ? design.accent : shirtRgb;
      }
      case 'peaks': {
        // Two triangular peaks
        const base = ph - 10;
        const peak1 = 30, peak2 = 60;
        const p1cx = pw * 0.35, p1w = 100;
        const p2cx = pw * 0.65, p2w = 130;
        const inTri = (cx, hw, top) => {
          const distX = Math.abs(rx - cx);
          if (distX > hw) return false;
          const topY = base - top;
          const yBoundary = base - (top * (1 - distX / hw));
          return ry >= yBoundary && ry <= base;
        };
        if (inTri(p1cx, p1w / 2, base - peak1)) return design.accent;
        if (inTri(p2cx, p2w / 2, base - peak2)) return design.accent;
        return shirtRgb;
      }
      case 'block': {
        // Solid inner block in accent
        const ix = 40, iy = 40, iw = pw - 80, ih = ph - 80;
        if (rx >= ix && rx < ix + iw && ry >= iy && ry < iy + ih) return design.accent;
        return shirtRgb;
      }
      case 'dots': {
        // Grid of dots
        const step = 32, r = 10;
        for (let dy = 20; dy < ph; dy += step) {
          for (let dx = 20; dx < pw; dx += step) {
            const d2 = (rx - dx) * (rx - dx) + (ry - dy) * (ry - dy);
            if (d2 <= r * r) return design.accent;
          }
        }
        return shirtRgb;
      }
    }
    return shirtRgb;
  });
}

async function runPreview() {
  const fs   = require('fs');
  const path = require('path');
  const out  = path.join(__dirname, 'test-import', 'tshirt-preview');
  fs.mkdirSync(out, { recursive: true });
  // One preview per design × color so you can eyeball the whole grid.
  for (const d of DESIGNS) {
    for (const c of COLORS) {
      const png = tshirtMockup(c.rgb, d);
      fs.writeFileSync(path.join(out, `${d.sku.toLowerCase()}-${c.name.toLowerCase()}.png`), png);
    }
  }
  console.log(`Wrote ${DESIGNS.length * COLORS.length} preview PNGs to ${out}`);
  process.exit(0);
}

async function main() {
  if (PREVIEW) return runPreview();
  console.log('Connecting to', redactDbUrl(process.env.DATABASE_URL));
  await db.initSchema();

  let seller = await db.getSellerBySlug(SLUG);

  if (REMOVE) {
    if (!seller) { console.log('No demo seller found — nothing to remove.'); process.exit(0); }
    const products = await db.getProductsBySeller(seller.id);
    for (const p of products) await db.deleteProduct(p.id);
    console.log(`Removed ${products.length} product(s). Delete the seller row manually if you want it gone entirely.`);
    process.exit(0);
  }

  if (!seller) {
    seller = await db.createSeller({
      email: EMAIL,
      passwordHash: '$2b$12$' + crypto.randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 53),
      phone: null,
      storeName: STORE_NAME,
      storeSlug: SLUG,
      plan: 'demo',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
    console.log(`Created seller #${seller.id} (${STORE_NAME}).`);
  } else {
    console.log(`Found existing seller #${seller.id} (${STORE_NAME}).`);
  }

  if (WIPE) {
    const existing = await db.getProductsBySeller(seller.id);
    for (const p of existing) await db.deleteProduct(p.id);
    console.log(`Wiped ${existing.length} existing product(s).`);
  }

  const existing = await db.getProductsBySeller(seller.id);
  const bySku    = new Map(existing.map(p => [p.sku, p]));
  let created = 0, updated = 0;

  for (const d of DESIGNS) {
    // Some designs use only Black+White, others include Navy — mix things up a
    // little so it looks like a real catalog.
    const colors = d.sku === 'PALM' || d.sku === 'BOLD'
      ? [COLORS[0], COLORS[1]]
      : COLORS;

    // Generate + upload one photo per (design, color). Used both as the
    // product-level gallery AND as the per-variant image so the modal swaps
    // photos when the buyer picks a color.
    const colorPath = {};
    for (const c of colors) {
      const png = tshirtMockup(c.rgb, d);
      const img = await db.createImage({
        sellerId:     seller.id,
        mime:         'image/png',
        buffer:       png,
        originalName: `${d.sku.toLowerCase()}-${c.name.toLowerCase()}.png`,
      });
      colorPath[c.name] = img.path;
    }

    const options = [
      { name:'Size',  values: SIZES },
      { name:'Color', values: colors.map(c => c.name) },
    ];
    const variants = [];
    for (const c of colors) {
      for (const s of SIZES) {
        variants.push({
          options:  { Size: s, Color: c.name },
          price:    d.price + (s === 'XL' ? 3 : 0),
          sku:      `${d.sku}-${c.name[0]}-${s}`,
          quantity: 8,
          image:    colorPath[c.name],
        });
      }
    }

    const gallery = colors.map(c => colorPath[c.name]);
    const rowFields = {
      name:        d.name,
      description: d.description,
      category:    'clothing',
      price:       Math.min(...variants.map(v => v.price)),
      quantity:    variants.reduce((n, v) => n + v.quantity, 0),
      weight:      6,
      imageUrls:   gallery,
      status:      'active',
      options,
      variants,
    };

    const existingRow = bySku.get(d.sku);
    if (existingRow) {
      await db.updateProduct(existingRow.id, rowFields);
      updated++;
    } else {
      await db.createProduct({ sellerId: seller.id, sku: d.sku, ...rowFields });
      created++;
    }
  }

  // Feature the first three so the homepage carousel has something to show.
  const refreshed = await db.getProductsBySeller(seller.id);
  const featureSkus = new Set(['SUNSET', 'WAVE', 'RIDGE']);
  for (const p of refreshed) {
    await db.updateProduct(p.id, { isFeatured: featureSkus.has(p.sku) });
  }

  console.log(`Products: ${created} created, ${updated} updated.`);
  console.log(`\nDone. Visit /?store=${SLUG} (or ${SLUG}.${process.env.PLATFORM_DOMAIN || 'nextlao.com'}).`);
  process.exit(0);
}

if (require.main === module) {
  main().catch(err => { console.error('Seed failed:', err); process.exit(1); });
}
