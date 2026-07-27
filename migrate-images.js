#!/usr/bin/env node
/* ============================================================
   MIGRATE-IMAGES.JS — inline base64 images → hosted /img/ URLs

   Product photos, store logos and hero images used to be stored as base64
   `data:` URIs inside products.image_urls and sellers.storefront_content.
   They now live as bytes in the `images` table and are referenced by the
   path `/img/<id>`. This script converts whatever is already stored.

   Usage:
     node migrate-images.js              # convert everything
     node migrate-images.js --dry-run    # report what WOULD change, touch nothing

   Safe to run more than once: it only ever looks at values starting with
   `data:image/`, and a converted row no longer matches. If it dies partway
   through, run it again — the rows it already finished are simply skipped.

   Needs DATABASE_URL, same as the server. To run against production, point it
   at Railway's DATABASE_PUBLIC_URL.
   ============================================================ */

'use strict';

const db = require('./database');

const DRY_RUN = process.argv.includes('--dry-run');

const DATA_URL_RE = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i;

const stats = { products: 0, sellers: 0, images: 0, bytes: 0, skipped: 0, failed: 0 };

/* Convert one value. Returns the value unchanged if it isn't an inline image,
   so callers can map over a mixed array without special-casing. */
async function convert(value, sellerId, label) {
  if (typeof value !== 'string') return value;
  const m = DATA_URL_RE.exec(value.trim());
  if (!m) return value;                       // already a URL or path — leave it

  const mime = m[1].toLowerCase();
  if (!db.IMAGE_MIMES.includes(mime)) {
    console.warn(`  ! ${label}: unsupported type ${mime} — left as-is`);
    stats.skipped++;
    return value;
  }

  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length) {
    console.warn(`  ! ${label}: decoded to zero bytes — left as-is`);
    stats.skipped++;
    return value;
  }

  const kb = (buffer.length / 1024).toFixed(0);
  if (DRY_RUN) {
    console.log(`  · ${label}: would store ${kb}KB ${mime}`);
    stats.images++;
    stats.bytes += buffer.length;
    return value;
  }

  const img = await db.createImage({ sellerId, mime, buffer });
  console.log(`  ✓ ${label}: ${kb}KB ${mime} → ${img.path}`);
  stats.images++;
  stats.bytes += buffer.length;
  return img.path;
}

async function migrateProducts() {
  const rows = await db.listProductsWithInlineImages();
  console.log(`\nProducts with inline images: ${rows.length}`);

  for (const p of rows) {
    console.log(`\nProduct #${p.id} (seller ${p.sellerId}) — ${p.imageUrls.length} image(s)`);
    const converted = [];
    let changed = false;

    for (let i = 0; i < p.imageUrls.length; i++) {
      try {
        const next = await convert(p.imageUrls[i], p.sellerId, `image ${i + 1}`);
        if (next !== p.imageUrls[i]) changed = true;
        converted.push(next);
      } catch (err) {
        // Keep the original so nothing is lost, and keep going — one bad image
        // must not strand the rest of the catalogue.
        console.error(`  ✗ image ${i + 1} failed: ${err.message}`);
        stats.failed++;
        converted.push(p.imageUrls[i]);
      }
    }

    if (changed && !DRY_RUN) {
      await db.setProductImageUrls(p.id, converted);
      stats.products++;
    } else if (changed) {
      stats.products++;
    }
  }
}

async function migrateStorefronts() {
  const rows = await db.listSellersWithInlineStorefrontImages();
  console.log(`\nStorefronts with inline images: ${rows.length}`);

  for (const s of rows) {
    console.log(`\nSeller #${s.id}`);
    const content = { ...s.content };
    let changed = false;

    for (const key of ['logoUrl', 'heroImage']) {
      if (typeof content[key] !== 'string' || !content[key]) continue;
      try {
        const next = await convert(content[key], s.id, key);
        if (next !== content[key]) { content[key] = next; changed = true; }
      } catch (err) {
        console.error(`  ✗ ${key} failed: ${err.message}`);
        stats.failed++;
      }
    }

    if (changed && !DRY_RUN) {
      await db.setSellerStorefrontContent(s.id, content);
      stats.sellers++;
    } else if (changed) {
      stats.sellers++;
    }
  }
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Point it at your database and try again.');
    process.exit(1);
  }

  console.log(DRY_RUN
    ? '── DRY RUN — nothing will be written ──'
    : '── Migrating inline images to hosted URLs ──');

  try {
    const before = await db.countImages();
    console.log(`images table currently holds ${before.count} image(s), ${(before.totalBytes / 1048576).toFixed(2)}MB`);

    await migrateProducts();
    await migrateStorefronts();

    console.log('\n────────────────────────────────');
    console.log(`${DRY_RUN ? 'Would move' : 'Moved'} ${stats.images} image(s), ${(stats.bytes / 1048576).toFixed(2)}MB`);
    console.log(`  products updated: ${stats.products}`);
    console.log(`  storefronts updated: ${stats.sellers}`);
    if (stats.skipped) console.log(`  skipped (left inline): ${stats.skipped}`);
    if (stats.failed)  console.log(`  FAILED (left inline): ${stats.failed}`);
    if (DRY_RUN) console.log('\nRe-run without --dry-run to apply.');
    process.exit(stats.failed ? 1 : 0);
  } catch (err) {
    console.error('\nMigration failed:', err.message);
    process.exit(1);
  }
})();
