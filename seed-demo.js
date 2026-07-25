#!/usr/bin/env node
/* ============================================================
   seed-demo.js — create/refresh the public demo store.
   ------------------------------------------------------------
     node seed-demo.js          # create or refresh the demo store
     node seed-demo.js --wipe   # delete its products first, then reseed

   Builds a fully-populated storefront at /?store=demo (and
   demo.<PLATFORM_DOMAIN>) so prospects can see a finished store, and so
   storefront changes can be eyeballed against real content.

   IDEMPOTENT: safe to re-run. The seller is matched by slug and updated
   rather than duplicated; products are matched by SKU and updated in place.

   DELIBERATELY NOT A REAL ACCOUNT:
     • password_hash is a random non-matching hash — nobody can log in as it,
       and there is no password to leak. Refresh content by re-running this.
     • no Stripe customer/subscription — it never bills and buyer checkout on
       it will (correctly) report that payment is not configured.
     • plan is set so it is excluded from operator metrics (see isDemoSeller
       in server.js).
   Images are SELF-HOSTED under public/demo/ — see public/demo/CREDITS.md.
   ============================================================ */
require('dotenv').config();
const crypto = require('crypto');
const db = require('./database');
const { SLUG, EMAIL, PRODUCTS, FEATURED, SECTIONS, STOREFRONT_CONTENT } = require('./demo-content');

const WIPE = process.argv.includes('--wipe');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Point it at the target database first.');
    process.exit(1);
  }
  await db.initSchema();

  // ── seller ──
  let seller = await db.getSellerBySlug(SLUG);
  if (seller) {
    console.log(`Found existing demo seller #${seller.id} — refreshing.`);
    await db.updateSeller(seller.id, { storeName: 'Northwind Supply' });
  } else {
    const existingEmail = await db.getSellerByEmail(EMAIL);
    if (existingEmail) {
      console.error(`A seller already uses ${EMAIL} but its slug is "${existingEmail.storeSlug}", not "${SLUG}". Refusing to guess — resolve by hand.`);
      process.exit(1);
    }
    seller = await db.createSeller({
      firstName: 'Northwind', lastName: 'Supply',
      email: EMAIL,
      // Random hash: no known password, so this account cannot be logged into.
      passwordHash: '$2b$12$' + crypto.randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 53),
      phone: null,
      storeName: 'Northwind Supply',
      storeSlug: SLUG,
      plan: 'demo',                    // excluded from operator metrics
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
    console.log(`Created demo seller #${seller.id}.`);
  }

  // ── products (match by SKU so re-runs update rather than duplicate) ──
  if (WIPE) {
    const existing = await db.getProductsBySeller(seller.id);
    for (const p of existing) await db.deleteProduct(p.id);
    console.log(`Wiped ${existing.length} existing demo product(s).`);
  }

  const current = await db.getProductsBySeller(seller.id);
  const bySku = new Map(current.map(p => [p.sku, p]));
  let created = 0, updated = 0;

  for (const p of PRODUCTS) {
    const fields = {
      name: p.name,
      description: p.description,
      category: p.category,
      price: p.price,
      compareAtPrice: p.compareAtPrice,
      quantity: 25,
      imageUrls: [`/demo/${p.img}.jpg`],
      status: 'active',
      weight: 1,
      isFeatured: FEATURED.has(p.sku),
    };
    const existing = bySku.get(p.sku);
    if (existing) {
      await db.updateProduct(existing.id, fields);
      updated++;
    } else {
      const row = await db.createProduct({ sellerId: seller.id, sku: p.sku, ...fields });
      // createProduct has no is_featured parameter; set it via the update path.
      if (fields.isFeatured) await db.updateProduct(row.id, { isFeatured: true });
      created++;
    }
  }
  console.log(`Products: ${created} created, ${updated} updated.`);

  // ── storefront content + published layout ──
  await db.setSellerStorefrontContent(seller.id, STOREFRONT_CONTENT);
  console.log(`Storefront content + ${SECTIONS.length}-section layout published.`);

  console.log(`\nDone. Visit /?store=${SLUG} (or ${SLUG}.${process.env.PLATFORM_DOMAIN || 'nextlao.com'}).`);
  process.exit(0);
}

// Only seed when run directly. To read the content without touching the
// database, require ./demo-content instead — this file pulls in the pg pool.
if (require.main === module) {
  main().catch(err => { console.error('Seed failed:', err); process.exit(1); });
}
