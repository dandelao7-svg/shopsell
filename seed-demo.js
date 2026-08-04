#!/usr/bin/env node
/* ============================================================
   seed-demo.js — create/refresh the public demo store.
   ------------------------------------------------------------
     node seed-demo.js                    # create or refresh the demo store
     node seed-demo.js --wipe             # delete its products first, then reseed
     node seed-demo.js --remove           # delete the demo store entirely
     node seed-demo.js --db "postgres://…" # pass the connection string inline
                                          # (otherwise DATABASE_URL from .env)

   On Railway pass the PUBLIC url (DATABASE_PUBLIC_URL, or Postgres → Connect →
   Public Network). The default DATABASE_URL points at postgres.railway.internal,
   which only resolves from inside Railway's own network.

   NOTE: an inline --db value lands in your shell history and is visible in the
   process list. Prefer it for a one-off run from your own machine; use .env on
   anything shared.

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

// ── --db must be handled BEFORE ./database is required ──
// database.js builds its pg Pool from process.env.DATABASE_URL at require time,
// so setting it afterwards would be ignored and the script would connect to
// whatever .env held (or nothing). Accepts `--db <url>` and `--db=<url>`.
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

// Never print the connection string — it carries the database password, and
// this output tends to get pasted into chats and issues.
function redactDbUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? u.username + ':***@' : ''}${u.host}${u.pathname}`;
  } catch { return '(unparseable connection string)'; }
}

const db = require('./database');
const { SLUG, EMAIL, PRODUCTS, FEATURED, SECTIONS, STOREFRONT_CONTENT } = require('./demo-content');

const WIPE   = process.argv.includes('--wipe');
const REMOVE = process.argv.includes('--remove');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('No database connection string.');
    console.error('Either pass one:   node seed-demo.js --db "postgresql://user:pass@host:port/db"');
    console.error('or set DATABASE_URL in .env.');
    console.error('\nOn Railway use the PUBLIC url (DATABASE_PUBLIC_URL, or Postgres → Connect →');
    console.error('Public Network). The default DATABASE_URL points at postgres.railway.internal,');
    console.error('which only resolves from inside Railway.');
    process.exit(1);
  }
  console.log(`Connecting to ${redactDbUrl(process.env.DATABASE_URL)}`);

  // database.js kicks off initSchema() on require and exports the promise;
  // there is no callable initSchema. Awaiting it both guarantees the tables
  // exist and surfaces connection failures here, where they can be explained.
  try {
    await db.schemaReady;
  } catch (err) {
    console.error(`\nCould not connect: ${err.message}`);
    if (/railway\.internal/i.test(process.env.DATABASE_URL)) {
      console.error('\nThat is Railway\'s INTERNAL host — it only resolves inside Railway\'s network.');
      console.error('Use DATABASE_PUBLIC_URL instead (Postgres service → Variables, or Connect →');
      console.error('Public Network); it looks like ...proxy.rlwy.net:PORT.');
    } else if (/ENOTFOUND|EAI_AGAIN/i.test(err.message)) {
      console.error('\nHostname did not resolve — check the host in the connection string.');
    } else if (/ETIMEDOUT|ECONNREFUSED/i.test(err.message)) {
      console.error('\nReachable host but no answer — check the port, and that you copied the');
      console.error('PUBLIC connection string rather than the internal one.');
    } else if (/password|authentication/i.test(err.message)) {
      console.error('\nThe host answered but rejected the credentials — re-copy the URL in full;');
      console.error('the password often contains characters that break on a partial copy.');
    }
    process.exit(1);
  }

  // ── --remove: delete the demo store entirely, then stop ──
  // db.deleteDemoSeller carries a plan = 'demo' guard in its own SQL, so this
  // cannot delete a real seller even if the slug were pointed somewhere odd.
  if (REMOVE) {
    const existing = await db.getSellerBySlug(SLUG);
    if (!existing) {
      console.log(`No store with slug "${SLUG}" — nothing to remove.`);
      process.exit(0);
    }
    if (existing.plan !== 'demo') {
      console.error(`Refusing to remove: seller #${existing.id} has slug "${SLUG}" but plan "${existing.plan}", not "demo".`);
      console.error('That is not the seeded demo store. Resolve by hand.');
      process.exit(1);
    }
    const removed = await db.deleteDemoSeller(SLUG);
    console.log(removed
      ? `Removed demo seller #${existing.id} and all its rows (products, orders, settings cascade).`
      : 'Nothing removed.');
    console.log('The images under public/demo/ are untouched — delete them separately if you want them gone.');
    process.exit(0);
  }

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
      options:  p.options  || [],
      variants: p.variants || [],
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
