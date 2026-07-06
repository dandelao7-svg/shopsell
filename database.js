/* ============================================================
   SHOPSELL — DATABASE.JS  (Postgres edition)

   What this file does:
   - Connects to a Postgres database via the DATABASE_URL env var
     (Railway sets this automatically when you reference Postgres)
   - Auto-creates the schema on app startup (no manual migrations)
   - Exposes the same function names the rest of the app uses
     (drop-in replacement for the old in-memory database.js)

   Tables managed:
   - sellers
   - products
   - orders
   - customers
   - stripe_keys
   - shipments  (new — used by the Shipping History page)

   ============================================================ */

'use strict';

const { Pool } = require('pg');

// ── CONNECTION ───────────────────────────────────────────────
// Railway sets DATABASE_URL automatically when Postgres is referenced.
// SSL is required for Railway's managed Postgres in production.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

pool.on('error', (err) => {
  console.error('Postgres pool error:', err);
});

// ── SCHEMA AUTO-MIGRATION ────────────────────────────────────
// Runs on startup. Safe to run repeatedly — uses CREATE TABLE IF NOT EXISTS.
async function initSchema() {
  if (!process.env.DATABASE_URL) {
    console.warn('⚠ DATABASE_URL is not set. Database operations will fail.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // SELLERS
    await client.query(`
      CREATE TABLE IF NOT EXISTS sellers (
        id                     SERIAL PRIMARY KEY,
        first_name             TEXT NOT NULL,
        last_name              TEXT NOT NULL,
        email                  TEXT NOT NULL UNIQUE,
        password_hash          TEXT NOT NULL,
        phone                  TEXT,
        store_name             TEXT NOT NULL,
        store_slug             TEXT NOT NULL UNIQUE,
        plan                   TEXT NOT NULL DEFAULT 'starter',
        stripe_customer_id     TEXT,
        stripe_subscription_id TEXT,
        subscription_status    TEXT,
        store_active           BOOLEAN NOT NULL DEFAULT TRUE,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sellers_email ON sellers (email);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sellers_slug ON sellers (store_slug);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sellers_stripe_customer ON sellers (stripe_customer_id);`);

    // Forward-compat: where buyers ship returns to. Stored as a JSONB blob
    // so we can extend (e.g. residential flag, instructions) without migrating.
    await client.query(`ALTER TABLE sellers ADD COLUMN IF NOT EXISTS return_address JSONB;`);

    // PRODUCTS
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id               SERIAL PRIMARY KEY,
        seller_id        INTEGER NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
        name             TEXT NOT NULL,
        description      TEXT,
        category         TEXT,
        brand            TEXT,
        price            NUMERIC(10,2) NOT NULL,
        compare_at_price NUMERIC(10,2),
        cost_per_item    NUMERIC(10,2),
        sku              TEXT NOT NULL,
        quantity         INTEGER NOT NULL DEFAULT 0,
        weight           NUMERIC(10,3),
        variants         JSONB DEFAULT '[]'::jsonb,
        status           TEXT NOT NULL DEFAULT 'active',
        image_urls       JSONB DEFAULT '[]'::jsonb,
        rating           NUMERIC(3,2),
        returnable          BOOLEAN NOT NULL DEFAULT TRUE,
        return_window_days  INTEGER NOT NULL DEFAULT 30,
        restocking_fee_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (seller_id, sku)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_products_seller ON products (seller_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_products_status ON products (status);`);

    // Forward-compat: existing databases won't have the return-rule columns
    // until we ALTER them in.
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS returnable          BOOLEAN NOT NULL DEFAULT TRUE;`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS return_window_days  INTEGER NOT NULL DEFAULT 30;`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS restocking_fee_pct  NUMERIC(5,2) NOT NULL DEFAULT 0;`);

    // ORDERS
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id                 SERIAL PRIMARY KEY,
        seller_id          INTEGER NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
        store_slug         TEXT,
        customer_email     TEXT,
        customer_info      JSONB,
        items              JSONB NOT NULL DEFAULT '[]'::jsonb,
        subtotal           NUMERIC(10,2),
        tax                NUMERIC(10,2),
        total              NUMERIC(10,2) NOT NULL,
        status             TEXT NOT NULL DEFAULT 'pending',
        payment_intent_id  TEXT,
        tracking_number    TEXT,
        tracking_carrier   TEXT,
        paid_at            TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders (seller_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_payment_intent ON orders (payment_intent_id);`);

    // STRIPE KEYS (per-seller saved Stripe credentials)
    await client.query(`
      CREATE TABLE IF NOT EXISTS stripe_keys (
        seller_id        INTEGER PRIMARY KEY REFERENCES sellers(id) ON DELETE CASCADE,
        publishable_key  TEXT NOT NULL,
        secret_key       TEXT NOT NULL,
        webhook_secret   TEXT,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // CARRIER ACCOUNTS (per-seller UPS/FedEx/USPS credentials — bring-your-own-account)
    // Secrets live in `credentials` as an AES-256-GCM ciphertext (see lib/crypto.js);
    // account_number is non-secret and shown masked in the UI.
    await client.query(`
      CREATE TABLE IF NOT EXISTS carrier_accounts (
        seller_id      INTEGER NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
        carrier        TEXT NOT NULL,                        -- 'ups' | 'fedex' | 'usps'
        account_number TEXT,                                 -- non-secret (UPS/FedEx)
        credentials    TEXT NOT NULL,                        -- encrypted secrets JSON
        status         TEXT NOT NULL DEFAULT 'unverified',   -- unverified | verified | invalid
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (seller_id, carrier)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_carrier_accounts_seller ON carrier_accounts (seller_id);`);

    // SHIPMENTS — used by the Shipping History page
    await client.query(`
      CREATE TABLE IF NOT EXISTS shipments (
        id               SERIAL PRIMARY KEY,
        seller_id        INTEGER REFERENCES sellers(id) ON DELETE CASCADE,
        order_id         INTEGER REFERENCES orders(id) ON DELETE SET NULL,
        tracking_number  TEXT NOT NULL UNIQUE,
        carrier          TEXT NOT NULL,
        service_code     TEXT,
        service_name     TEXT,
        from_name        TEXT,
        from_addr        TEXT,
        from_city        TEXT,
        from_state       TEXT,
        from_zip         TEXT,
        to_name          TEXT,
        to_company       TEXT,
        to_addr          TEXT,
        to_addr2         TEXT,
        to_city          TEXT,
        to_state         TEXT,
        to_zip           TEXT,
        to_phone         TEXT,
        to_email         TEXT,
        residential      BOOLEAN DEFAULT FALSE,
        weight           TEXT,
        total_charge     NUMERIC(10,2),
        currency         TEXT DEFAULT 'USD',
        ref              TEXT,
        label_image      TEXT,
        label_url        TEXT,
        transaction_id   TEXT,
        status           TEXT NOT NULL DEFAULT 'created',
        voided_at        TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_shipments_seller ON shipments (seller_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_shipments_tracking ON shipments (tracking_number);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_shipments_created ON shipments (created_at DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments (status);`);

    // RETURNS — buyer-initiated return requests
    await client.query(`
      CREATE TABLE IF NOT EXISTS returns (
        id               SERIAL PRIMARY KEY,
        order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        seller_id        INTEGER NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
        customer_email   TEXT NOT NULL,
        items            JSONB NOT NULL DEFAULT '[]'::jsonb,
        reason           TEXT,
        status           TEXT NOT NULL DEFAULT 'label_issued',
        carrier          TEXT,
        tracking_number  TEXT,
        label_image      TEXT,
        label_url        TEXT,
        transaction_id   TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_returns_order ON returns (order_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_returns_seller ON returns (seller_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_returns_created ON returns (created_at DESC);`);

    // CUSTOMERS — derived from orders, but we keep an aggregated table for the customers page
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id            SERIAL PRIMARY KEY,
        seller_id     INTEGER NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
        email         TEXT NOT NULL,
        first_name    TEXT,
        last_name     TEXT,
        phone         TEXT,
        total_orders  INTEGER NOT NULL DEFAULT 0,
        total_spent   NUMERIC(12,2) NOT NULL DEFAULT 0,
        last_order_at TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (seller_id, email)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_customers_seller ON customers (seller_id);`);

    await client.query('COMMIT');
    console.log('✓ Database schema ready');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('✗ Schema init failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

// Kick off schema init on module load. Don't block, but log errors.
// The purge below waits for this to complete before running.
const schemaReady = initSchema().catch(err => {
  console.error('Schema init error:', err);
  throw err;
});

// ── HELPERS ──────────────────────────────────────────────────
// Convert snake_case DB rows to camelCase JS objects (matches old API)
function camelize(row) {
  if (!row) return row;
  const out = {};
  for (const k of Object.keys(row)) {
    const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    out[camel] = row[k];
  }
  return out;
}

function camelizeAll(rows) {
  return (rows || []).map(camelize);
}

// ── SELLERS ──────────────────────────────────────────────────
async function createSeller(data) {
  const { rows } = await pool.query(
    `INSERT INTO sellers
       (first_name, last_name, email, password_hash, phone,
        store_name, store_slug, plan, stripe_customer_id, stripe_subscription_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      data.firstName, data.lastName, data.email, data.passwordHash, data.phone,
      data.storeName, data.storeSlug, data.plan,
      data.stripeCustomerId, data.stripeSubscriptionId,
    ]
  );
  return camelize(rows[0]);
}

async function getSellerByEmail(email) {
  const { rows } = await pool.query(
    `SELECT * FROM sellers WHERE email = $1 LIMIT 1`, [email]
  );
  return camelize(rows[0]);
}

async function getSellerById(id) {
  const { rows } = await pool.query(
    `SELECT * FROM sellers WHERE id = $1 LIMIT 1`, [id]
  );
  return camelize(rows[0]);
}

async function getSellerBySlug(slug) {
  const { rows } = await pool.query(
    `SELECT * FROM sellers WHERE store_slug = $1 LIMIT 1`, [slug]
  );
  return camelize(rows[0]);
}

async function getSellerByStripeCustomerId(stripeCustomerId) {
  const { rows } = await pool.query(
    `SELECT * FROM sellers WHERE stripe_customer_id = $1 LIMIT 1`,
    [stripeCustomerId]
  );
  return camelize(rows[0]);
}

async function updateSeller(id, fields) {
  const map = {
    plan:               'plan',
    subscriptionStatus: 'subscription_status',
    storeActive:        'store_active',
  };
  const sets = [];
  const vals = [];
  let i = 1;
  for (const k of Object.keys(fields)) {
    if (map[k]) {
      sets.push(`${map[k]} = $${i++}`);
      vals.push(fields[k]);
    }
  }
  if (!sets.length) return getSellerById(id);
  sets.push(`updated_at = NOW()`);
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE sellers SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    vals
  );
  return camelize(rows[0]);
}

// ── PRODUCTS ─────────────────────────────────────────────────
async function getActiveProducts(storeSlug) {
  const { rows } = await pool.query(
    `SELECT p.* FROM products p
       JOIN sellers s ON s.id = p.seller_id
      WHERE s.store_slug = $1 AND p.status = 'active'
      ORDER BY p.created_at DESC`,
    [storeSlug]
  );
  return camelizeAll(rows);
}

async function getProductsBySeller(sellerId) {
  const { rows } = await pool.query(
    `SELECT * FROM products WHERE seller_id = $1 ORDER BY created_at DESC`,
    [sellerId]
  );
  return camelizeAll(rows);
}

async function getProductCountBySeller(sellerId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM products WHERE seller_id = $1`,
    [sellerId]
  );
  return rows[0]?.c || 0;
}

async function checkSKUExists(sellerId, sku) {
  const { rows } = await pool.query(
    `SELECT 1 FROM products WHERE seller_id = $1 AND sku = $2 LIMIT 1`,
    [sellerId, sku]
  );
  return rows.length > 0;
}

async function createProduct(data) {
  const { rows } = await pool.query(
    `INSERT INTO products
       (seller_id, name, description, category, brand,
        price, compare_at_price, cost_per_item, sku, quantity,
        weight, variants, status, image_urls,
        returnable, return_window_days, restocking_fee_pct)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      data.sellerId, data.name, data.description, data.category, data.brand,
      data.price, data.compareAtPrice, data.costPerItem, data.sku, data.quantity,
      data.weight,
      JSON.stringify(data.variants || []),
      data.status || 'active',
      JSON.stringify(data.imageUrls || []),
      data.returnable !== undefined ? !!data.returnable : true,
      Number.isFinite(parseInt(data.returnWindowDays)) ? parseInt(data.returnWindowDays) : 30,
      Number.isFinite(parseFloat(data.restockingFeePct)) ? parseFloat(data.restockingFeePct) : 0,
    ]
  );
  return camelize(rows[0]);
}

async function getProductById(id) {
  const { rows } = await pool.query(
    `SELECT * FROM products WHERE id = $1 LIMIT 1`, [id]
  );
  return camelize(rows[0]);
}

async function updateProduct(id, fields) {
  const map = {
    name:             'name',
    description:      'description',
    category:         'category',
    brand:            'brand',
    price:            'price',
    compareAtPrice:   'compare_at_price',
    costPerItem:      'cost_per_item',
    sku:              'sku',
    quantity:         'quantity',
    weight:           'weight',
    variants:         'variants',
    status:           'status',
    imageUrls:        'image_urls',
    returnable:       'returnable',
    returnWindowDays: 'return_window_days',
    restockingFeePct: 'restocking_fee_pct',
  };
  const sets = [];
  const vals = [];
  let i = 1;
  for (const k of Object.keys(fields)) {
    if (map[k]) {
      sets.push(`${map[k]} = $${i++}`);
      const v = (k === 'variants' || k === 'imageUrls')
        ? JSON.stringify(fields[k] || [])
        : fields[k];
      vals.push(v);
    }
  }
  if (!sets.length) return getProductById(id);
  sets.push(`updated_at = NOW()`);
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE products SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    vals
  );
  return camelize(rows[0]);
}

async function deleteProduct(id) {
  await pool.query(`DELETE FROM products WHERE id = $1`, [id]);
}

async function decrementStock(productId, qty) {
  await pool.query(
    `UPDATE products SET quantity = GREATEST(0, quantity - $1), updated_at = NOW()
       WHERE id = $2`,
    [qty, productId]
  );
}

// ── ORDERS ───────────────────────────────────────────────────
async function createOrder(data) {
  const { rows } = await pool.query(
    `INSERT INTO orders
       (seller_id, store_slug, customer_email, items, subtotal, tax, total, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      data.sellerId, data.storeSlug, data.customerEmail,
      JSON.stringify(data.items || []),
      data.subtotal, data.tax, data.total,
      data.status || 'pending',
    ]
  );
  return camelize(rows[0]);
}

async function getOrderById(id) {
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE id = $1 LIMIT 1`, [id]
  );
  return camelize(rows[0]);
}

async function getOrderByPaymentIntentId(paymentIntentId) {
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE payment_intent_id = $1 LIMIT 1`, [paymentIntentId]
  );
  return camelize(rows[0]);
}

async function updateOrder(id, fields) {
  const map = {
    status:           'status',
    paymentIntentId:  'payment_intent_id',
    customerInfo:     'customer_info',
    customerEmail:    'customer_email',
    paidAt:           'paid_at',
    trackingNumber:   'tracking_number',
    trackingCarrier:  'tracking_carrier',
  };
  const sets = [];
  const vals = [];
  let i = 1;
  for (const k of Object.keys(fields)) {
    if (map[k] && fields[k] !== undefined) {
      sets.push(`${map[k]} = $${i++}`);
      const v = (k === 'customerInfo')
        ? JSON.stringify(fields[k] || null)
        : fields[k];
      vals.push(v);
    }
  }
  if (!sets.length) return getOrderById(id);
  sets.push(`updated_at = NOW()`);
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE orders SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    vals
  );
  return camelize(rows[0]);
}

async function getOrdersBySeller(sellerId, since) {
  if (since) {
    const { rows } = await pool.query(
      `SELECT * FROM orders
         WHERE seller_id = $1 AND created_at >= $2
         ORDER BY created_at DESC`,
      [sellerId, since]
    );
    return camelizeAll(rows);
  }
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE seller_id = $1 ORDER BY created_at DESC`,
    [sellerId]
  );
  return camelizeAll(rows);
}

// ── CUSTOMERS ────────────────────────────────────────────────
async function getCustomersBySeller(sellerId) {
  const { rows } = await pool.query(
    `SELECT * FROM customers WHERE seller_id = $1 ORDER BY last_order_at DESC NULLS LAST`,
    [sellerId]
  );
  return camelizeAll(rows);
}

// ── STRIPE KEYS ──────────────────────────────────────────────
async function saveStripeKeys(sellerId, { publishableKey, secretKey, webhookSecret }) {
  await pool.query(
    `INSERT INTO stripe_keys (seller_id, publishable_key, secret_key, webhook_secret)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (seller_id) DO UPDATE
       SET publishable_key = EXCLUDED.publishable_key,
           secret_key      = EXCLUDED.secret_key,
           webhook_secret  = EXCLUDED.webhook_secret,
           updated_at      = NOW()`,
    [sellerId, publishableKey, secretKey, webhookSecret || null]
  );
}

async function getStripeKeys(sellerId) {
  const { rows } = await pool.query(
    `SELECT * FROM stripe_keys WHERE seller_id = $1 LIMIT 1`,
    [sellerId]
  );
  return camelize(rows[0]);
}

// ── CARRIER ACCOUNTS (per-seller BYOA credentials) ───────────
// `credentials` is stored/returned as opaque ciphertext — encryption and
// decryption happen in the route layer (lib/crypto.js), never here.
async function saveCarrierAccount(sellerId, carrier, { accountNumber, credentials, status }) {
  const { rows } = await pool.query(
    `INSERT INTO carrier_accounts (seller_id, carrier, account_number, credentials, status)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (seller_id, carrier) DO UPDATE
       SET account_number = EXCLUDED.account_number,
           credentials    = EXCLUDED.credentials,
           status         = EXCLUDED.status,
           updated_at     = NOW()
     RETURNING *`,
    [sellerId, carrier, accountNumber || null, credentials, status || 'unverified']
  );
  return camelize(rows[0]);
}

async function getCarrierAccount(sellerId, carrier) {
  const { rows } = await pool.query(
    `SELECT * FROM carrier_accounts WHERE seller_id = $1 AND carrier = $2 LIMIT 1`,
    [sellerId, carrier]
  );
  return camelize(rows[0]);
}

async function getCarrierAccounts(sellerId) {
  const { rows } = await pool.query(
    `SELECT * FROM carrier_accounts WHERE seller_id = $1`,
    [sellerId]
  );
  return camelizeAll(rows);
}

async function setCarrierAccountStatus(sellerId, carrier, status) {
  const { rows } = await pool.query(
    `UPDATE carrier_accounts SET status = $3, updated_at = NOW()
       WHERE seller_id = $1 AND carrier = $2
       RETURNING *`,
    [sellerId, carrier, status]
  );
  return camelize(rows[0]);
}

async function deleteCarrierAccount(sellerId, carrier) {
  await pool.query(
    `DELETE FROM carrier_accounts WHERE seller_id = $1 AND carrier = $2`,
    [sellerId, carrier]
  );
}

// ── SHIPMENTS (Shipping History) ─────────────────────────────
async function createShipment(data) {
  const { rows } = await pool.query(
    `INSERT INTO shipments
       (seller_id, order_id, tracking_number, carrier, service_code, service_name,
        from_name, from_addr, from_city, from_state, from_zip,
        to_name, to_company, to_addr, to_addr2, to_city, to_state, to_zip,
        to_phone, to_email, residential, weight, total_charge, currency,
        ref, label_image, label_url, transaction_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,
             $7,$8,$9,$10,$11,
             $12,$13,$14,$15,$16,$17,$18,
             $19,$20,$21,$22,$23,$24,
             $25,$26,$27,$28,$29)
     ON CONFLICT (tracking_number) DO NOTHING
     RETURNING *`,
    [
      data.sellerId || null, data.orderId || null,
      data.trackingNumber, data.carrier, data.serviceCode || null, data.serviceName || null,
      data.fromName, data.fromAddr, data.fromCity, data.fromState, data.fromZip,
      data.toName, data.toCompany, data.toAddr, data.toAddr2, data.toCity, data.toState, data.toZip,
      data.toPhone, data.toEmail, !!data.residential, data.weight,
      data.totalCharge, data.currency || 'USD',
      data.ref, data.labelImage, data.labelUrl, data.transactionId,
      data.status || 'created',
    ]
  );
  return camelize(rows[0]);
}

async function getShipmentByTracking(trackingNumber) {
  const { rows } = await pool.query(
    `SELECT * FROM shipments WHERE tracking_number = $1 LIMIT 1`,
    [trackingNumber]
  );
  return camelize(rows[0]);
}

async function getShipmentsBySeller(sellerId, opts = {}) {
  const limit  = Math.min(parseInt(opts.limit)  || 200, 1000);
  const offset = parseInt(opts.offset) || 0;
  const { rows } = await pool.query(
    `SELECT * FROM shipments
       WHERE seller_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
    [sellerId, limit, offset]
  );
  return camelizeAll(rows);
}

// Used by the history page when no auth is available — returns recent shipments
// regardless of seller. Useful while the auth wiring is being completed.
async function getRecentShipments(opts = {}) {
  const limit  = Math.min(parseInt(opts.limit)  || 200, 1000);
  const offset = parseInt(opts.offset) || 0;
  const { rows } = await pool.query(
    `SELECT * FROM shipments
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return camelizeAll(rows);
}

async function markShipmentVoided(trackingNumber, action) {
  const status = action === 'refund_requested' ? 'refund_requested' : 'voided';
  const { rows } = await pool.query(
    `UPDATE shipments
       SET status = $1, voided_at = NOW()
       WHERE tracking_number = $2
       RETURNING *`,
    [status, trackingNumber]
  );
  return camelize(rows[0]);
}

// ── RETURNS ──────────────────────────────────────────────────
async function getSellerReturnAddress(sellerId) {
  const { rows } = await pool.query(
    `SELECT return_address FROM sellers WHERE id = $1 LIMIT 1`,
    [sellerId]
  );
  return rows[0]?.return_address || null;
}

async function setSellerReturnAddress(sellerId, address) {
  await pool.query(
    `UPDATE sellers SET return_address = $1, updated_at = NOW() WHERE id = $2`,
    [address ? JSON.stringify(address) : null, sellerId]
  );
}

async function createReturn(data) {
  const { rows } = await pool.query(
    `INSERT INTO returns
       (order_id, seller_id, customer_email, items, reason, status,
        carrier, tracking_number, label_image, label_url, transaction_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      data.orderId, data.sellerId, data.customerEmail,
      JSON.stringify(data.items || []),
      data.reason || null,
      data.status || 'label_issued',
      data.carrier || null,
      data.trackingNumber || null,
      data.labelImage || null,
      data.labelUrl || null,
      data.transactionId || null,
    ]
  );
  return camelize(rows[0]);
}

async function getReturnsByOrder(orderId) {
  const { rows } = await pool.query(
    `SELECT * FROM returns WHERE order_id = $1 ORDER BY created_at DESC`,
    [orderId]
  );
  return camelizeAll(rows);
}

// Purge shipments older than N days (UPS stops tracking after 120 days anyway)
async function purgeOldShipments(retentionDays = 120) {
  const { rowCount } = await pool.query(
    `DELETE FROM shipments
       WHERE created_at < NOW() - ($1 || ' days')::interval`,
    [retentionDays]
  );
  if (rowCount > 0) console.log(`Purged ${rowCount} old shipments (>${retentionDays} days)`);
  return rowCount;
}

// Run a purge on app startup (after schema is ready), then once a day after that
schemaReady
  .then(() => purgeOldShipments(120))
  .catch(err => console.error('Initial purge error:', err));

setInterval(() => {
  purgeOldShipments(120).catch(err => console.error('Daily purge error:', err));
}, 24 * 60 * 60 * 1000);

// ── EXPORTS ──────────────────────────────────────────────────
module.exports = {
  // Sellers
  createSeller,
  getSellerByEmail,
  getSellerById,
  getSellerBySlug,
  getSellerByStripeCustomerId,
  updateSeller,

  // Products
  getActiveProducts,
  getProductsBySeller,
  getProductCountBySeller,
  checkSKUExists,
  createProduct,
  getProductById,
  updateProduct,
  deleteProduct,
  decrementStock,

  // Orders
  createOrder,
  getOrderById,
  getOrderByPaymentIntentId,
  updateOrder,
  getOrdersBySeller,

  // Customers
  getCustomersBySeller,

  // Stripe keys
  saveStripeKeys,
  getStripeKeys,

  // Carrier accounts (per-seller BYOA credentials)
  saveCarrierAccount,
  getCarrierAccount,
  getCarrierAccounts,
  setCarrierAccountStatus,
  deleteCarrierAccount,

  // Shipments (Shipping History)
  createShipment,
  getShipmentByTracking,
  getShipmentsBySeller,
  getRecentShipments,
  markShipmentVoided,
  purgeOldShipments,

  // Returns
  getSellerReturnAddress,
  setSellerReturnAddress,
  createReturn,
  getReturnsByOrder,

  // Internal — exposed in case anything needs raw access
  pool,
};
