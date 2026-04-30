/* ============================================================
   SHOPSELL — DATABASE.JS
   SQLite database layer using better-sqlite3
   
   WHY SQLITE:
   - Zero setup — no separate database server needed
   - Perfect for Railway deployment (file-based)
   - Handles thousands of orders with no issues
   - Easy to migrate to PostgreSQL later if needed
   
   TABLES:
   - sellers        — seller accounts + subscription info
   - products       — product catalog per seller
   - orders         — customer orders
   - order_items    — line items per order
   - customers      — customer records per seller
   - stripe_configs — encrypted Stripe keys per seller
   ============================================================ */

'use strict';

const Database = require('better-sqlite3');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');

// ── DATABASE FILE LOCATION ────────────────────────────────────
// On Railway: use /data volume for persistence (set in railway.toml)
// Locally: creates shopsell.db in the project root
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'shopsell.db');

// Ensure directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode — much faster for concurrent reads/writes
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── ENCRYPTION FOR SENSITIVE DATA ─────────────────────────────
// Stripe secret keys are encrypted before storing in DB
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // Must be 32 bytes (64 hex chars)

function encrypt(text) {
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY not set in environment');
  const iv         = crypto.randomBytes(16);
  const key        = Buffer.from(ENCRYPTION_KEY, 'hex');
  const cipher     = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted  = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(encryptedText) {
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY not set in environment');
  const [ivHex, encHex] = encryptedText.split(':');
  const iv              = Buffer.from(ivHex, 'hex');
  const key             = Buffer.from(ENCRYPTION_KEY, 'hex');
  const decipher        = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted       = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

/* ============================================================
   ── CREATE TABLES ────────────────────────────────────────────
   Runs once on startup — safe to run multiple times (IF NOT EXISTS)
   ============================================================ */

db.exec(`
  -- SELLERS TABLE
  CREATE TABLE IF NOT EXISTS sellers (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    firstName             TEXT    NOT NULL,
    lastName              TEXT    NOT NULL,
    email                 TEXT    NOT NULL UNIQUE,
    passwordHash          TEXT    NOT NULL,
    phone                 TEXT,
    storeName             TEXT    NOT NULL,
    storeSlug             TEXT    NOT NULL UNIQUE,
    plan                  TEXT    NOT NULL DEFAULT 'starter', -- starter | growth | pro
    stripeCustomerId      TEXT,   -- YOUR Stripe: for billing seller
    stripeSubscriptionId  TEXT,   -- YOUR Stripe: seller's subscription
    stripeAccountId       TEXT,   -- SELLER'S Stripe: to receive customer payments
    subscriptionStatus    TEXT    DEFAULT 'trialing',
    storeActive           INTEGER DEFAULT 1,
    createdAt             TEXT    DEFAULT (datetime('now')),
    updatedAt             TEXT    DEFAULT (datetime('now'))
  );

  -- PRODUCTS TABLE
  CREATE TABLE IF NOT EXISTS products (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    sellerId        INTEGER NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    name            TEXT    NOT NULL,
    description     TEXT,
    category        TEXT    NOT NULL,
    brand           TEXT,
    price           REAL    NOT NULL,
    compareAtPrice  REAL,
    costPerItem     REAL,
    sku             TEXT    NOT NULL,
    quantity        INTEGER DEFAULT 0,
    weight          REAL,
    variants        TEXT    DEFAULT '[]', -- JSON array
    status          TEXT    DEFAULT 'active', -- active | draft | archived
    imageUrls       TEXT    DEFAULT '[]', -- JSON array of image URLs
    rating          REAL    DEFAULT 0,
    reviewCount     INTEGER DEFAULT 0,
    featured        INTEGER DEFAULT 0,
    createdAt       TEXT    DEFAULT (datetime('now')),
    updatedAt       TEXT    DEFAULT (datetime('now')),
    UNIQUE(sellerId, sku)
  );

  -- ORDERS TABLE
  CREATE TABLE IF NOT EXISTS orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    sellerId        INTEGER NOT NULL REFERENCES sellers(id),
    storeSlug       TEXT    NOT NULL,
    status          TEXT    DEFAULT 'pending',
    -- pending | processing | shipped | delivered | cancelled | refunded | payment_failed
    customerEmail   TEXT    NOT NULL,
    customerInfo    TEXT    DEFAULT '{}', -- JSON: name, address, phone
    subtotal        REAL    NOT NULL,
    tax             REAL    DEFAULT 0,
    total           REAL    NOT NULL,
    paymentIntentId TEXT,
    trackingNumber  TEXT,
    trackingCarrier TEXT,
    paidAt          TEXT,
    shippedAt       TEXT,
    deliveredAt     TEXT,
    createdAt       TEXT    DEFAULT (datetime('now')),
    updatedAt       TEXT    DEFAULT (datetime('now'))
  );

  -- ORDER ITEMS TABLE
  CREATE TABLE IF NOT EXISTS order_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    orderId     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    productId   INTEGER REFERENCES products(id),
    name        TEXT    NOT NULL,  -- snapshot name at time of order
    price       REAL    NOT NULL,  -- snapshot price at time of order
    qty         INTEGER NOT NULL,
    variant     TEXT
  );

  -- CUSTOMERS TABLE
  -- A "customer" is per-seller — same buyer can exist in multiple sellers' lists
  CREATE TABLE IF NOT EXISTS customers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    sellerId      INTEGER NOT NULL REFERENCES sellers(id),
    email         TEXT    NOT NULL,
    firstName     TEXT,
    lastName      TEXT,
    phone         TEXT,
    totalOrders   INTEGER DEFAULT 0,
    totalSpent    REAL    DEFAULT 0,
    firstOrderAt  TEXT,
    lastOrderAt   TEXT,
    createdAt     TEXT    DEFAULT (datetime('now')),
    UNIQUE(sellerId, email)
  );

  -- STRIPE CONFIGS TABLE
  -- Stores each seller's own Stripe keys (encrypted)
  CREATE TABLE IF NOT EXISTS stripe_configs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    sellerId         INTEGER NOT NULL UNIQUE REFERENCES sellers(id),
    publishableKey   TEXT    NOT NULL,
    secretKeyEnc     TEXT    NOT NULL, -- encrypted with ENCRYPTION_KEY
    webhookSecretEnc TEXT,             -- encrypted with ENCRYPTION_KEY
    mode             TEXT    DEFAULT 'test', -- test | live
    updatedAt        TEXT    DEFAULT (datetime('now'))
  );

  -- INDEXES for fast lookups
  CREATE INDEX IF NOT EXISTS idx_products_seller ON products(sellerId);
  CREATE INDEX IF NOT EXISTS idx_products_slug   ON products(sellerId, status);
  CREATE INDEX IF NOT EXISTS idx_orders_seller   ON orders(sellerId);
  CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(sellerId, status);
  CREATE INDEX IF NOT EXISTS idx_customers_seller ON customers(sellerId);
`);

console.log('Database initialized:', DB_PATH);

/* ============================================================
   ── SELLER FUNCTIONS ─────────────────────────────────────────
   ============================================================ */

function createSeller(data) {
  const stmt = db.prepare(`
    INSERT INTO sellers (firstName, lastName, email, passwordHash, phone, storeName, storeSlug, plan, stripeCustomerId, stripeSubscriptionId)
    VALUES (@firstName, @lastName, @email, @passwordHash, @phone, @storeName, @storeSlug, @plan, @stripeCustomerId, @stripeSubscriptionId)
  `);
  const result = stmt.run(data);
  return getSellerById(result.lastInsertRowid);
}

function getSellerById(id) {
  return db.prepare('SELECT * FROM sellers WHERE id = ?').get(id);
}

function getSellerByEmail(email) {
  return db.prepare('SELECT * FROM sellers WHERE email = ?').get(email);
}

function getSellerBySlug(slug) {
  return db.prepare('SELECT * FROM sellers WHERE storeSlug = ? AND storeActive = 1').get(slug);
}

function getSellerByStripeCustomerId(customerId) {
  return db.prepare('SELECT * FROM sellers WHERE stripeCustomerId = ?').get(customerId);
}

function updateSeller(id, data) {
  const fields = Object.keys(data).map(k => `${k} = @${k}`).join(', ');
  const stmt   = db.prepare(`UPDATE sellers SET ${fields}, updatedAt = datetime('now') WHERE id = @id`);
  stmt.run({ ...data, id });
  return getSellerById(id);
}

/* ============================================================
   ── PRODUCT FUNCTIONS ────────────────────────────────────────
   ============================================================ */

function createProduct(data) {
  const stmt = db.prepare(`
    INSERT INTO products
      (sellerId, name, description, category, brand, price, compareAtPrice,
       costPerItem, sku, quantity, weight, variants, status, imageUrls)
    VALUES
      (@sellerId, @name, @description, @category, @brand, @price, @compareAtPrice,
       @costPerItem, @sku, @quantity, @weight, @variants, @status, @imageUrls)
  `);
  const result = stmt.run({
    ...data,
    variants:  JSON.stringify(data.variants  || []),
    imageUrls: JSON.stringify(data.imageUrls || []),
  });
  return getProductById(result.lastInsertRowid);
}

function getProductById(id) {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  return row ? parseProduct(row) : null;
}

function getActiveProducts(storeSlug) {
  const seller = getSellerBySlug(storeSlug);
  if (!seller) return [];
  const rows = db.prepare(`
    SELECT * FROM products
    WHERE sellerId = ? AND status = 'active' AND quantity > 0
    ORDER BY featured DESC, createdAt DESC
  `).all(seller.id);
  return rows.map(parseProduct);
}

function getProductsBySeller(sellerId) {
  const rows = db.prepare(`
    SELECT * FROM products WHERE sellerId = ? ORDER BY createdAt DESC
  `).all(sellerId);
  return rows.map(parseProduct);
}

function getProductCountBySeller(sellerId) {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM products WHERE sellerId = ? AND status != 'archived'
  `).get(sellerId);
  return row.count;
}

function checkSKUExists(sellerId, sku) {
  const row = db.prepare('SELECT id FROM products WHERE sellerId = ? AND sku = ?').get(sellerId, sku);
  return !!row;
}

function updateProduct(id, data) {
  const allowed = ['name','description','category','brand','price','compareAtPrice',
                   'costPerItem','sku','quantity','weight','variants','status','imageUrls','featured'];
  const updates = {};
  allowed.forEach(k => {
    if (data[k] !== undefined) {
      updates[k] = Array.isArray(data[k]) ? JSON.stringify(data[k]) : data[k];
    }
  });
  if (!Object.keys(updates).length) return getProductById(id);
  const fields = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE products SET ${fields}, updatedAt = datetime('now') WHERE id = @id`).run({ ...updates, id });
  return getProductById(id);
}

function deleteProduct(id) {
  db.prepare("UPDATE products SET status = 'archived', updatedAt = datetime('now') WHERE id = ?").run(id);
}

function decrementStock(productId, qty) {
  db.prepare(`
    UPDATE products SET quantity = MAX(0, quantity - ?), updatedAt = datetime('now') WHERE id = ?
  `).run(qty, productId);
}

function parseProduct(row) {
  return {
    ...row,
    variants:  JSON.parse(row.variants  || '[]'),
    imageUrls: JSON.parse(row.imageUrls || '[]'),
  };
}

/* ============================================================
   ── ORDER FUNCTIONS ──────────────────────────────────────────
   ============================================================ */

const createOrderTransaction = db.transaction((data) => {
  // Create the order
  const orderStmt = db.prepare(`
    INSERT INTO orders (sellerId, storeSlug, status, customerEmail, customerInfo, subtotal, tax, total)
    VALUES (@sellerId, @storeSlug, @status, @customerEmail, @customerInfo, @subtotal, @tax, @total)
  `);
  const orderResult = orderStmt.run({
    ...data,
    customerInfo: JSON.stringify(data.customerInfo || {}),
  });
  const orderId = orderResult.lastInsertRowid;

  // Create order items
  const itemStmt = db.prepare(`
    INSERT INTO order_items (orderId, productId, name, price, qty, variant)
    VALUES (@orderId, @productId, @name, @price, @qty, @variant)
  `);
  for (const item of data.items) {
    itemStmt.run({
      orderId,
      productId: item.productId || item.id,
      name:      item.name,
      price:     item.price,
      qty:       item.qty,
      variant:   item.variant || null,
    });
  }

  // Upsert customer record
  const existingCustomer = db.prepare(`
    SELECT * FROM customers WHERE sellerId = ? AND email = ?
  `).get(data.sellerId, data.customerEmail);

  if (existingCustomer) {
    db.prepare(`
      UPDATE customers
      SET totalOrders = totalOrders + 1,
          totalSpent  = totalSpent + ?,
          lastOrderAt = datetime('now')
      WHERE id = ?
    `).run(data.total, existingCustomer.id);
  } else {
    db.prepare(`
      INSERT INTO customers (sellerId, email, totalOrders, totalSpent, firstOrderAt, lastOrderAt)
      VALUES (?, ?, 1, ?, datetime('now'), datetime('now'))
    `).run(data.sellerId, data.customerEmail, data.total);
  }

  return getOrderById(orderId);
});

function createOrder(data) {
  return createOrderTransaction(data);
}

function getOrderById(id) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE orderId = ?').all(id);
  return {
    ...order,
    customerInfo: JSON.parse(order.customerInfo || '{}'),
    items,
  };
}

function getOrdersBySeller(sellerId, since = null) {
  let query = 'SELECT * FROM orders WHERE sellerId = ?';
  const params = [sellerId];
  if (since) {
    query += ' AND createdAt >= ?';
    params.push(since.toISOString());
  }
  query += ' ORDER BY createdAt DESC';

  const orders = db.prepare(query).all(...params);
  return orders.map(o => {
    const items = db.prepare('SELECT * FROM order_items WHERE orderId = ?').all(o.id);
    return { ...o, customerInfo: JSON.parse(o.customerInfo || '{}'), items };
  });
}

function updateOrder(id, data) {
  const allowed = ['status','paymentIntentId','customerInfo','paidAt','shippedAt','deliveredAt','trackingNumber','trackingCarrier'];
  const updates = {};
  allowed.forEach(k => {
    if (data[k] !== undefined) {
      updates[k] = typeof data[k] === 'object' && data[k] !== null
        ? JSON.stringify(data[k])
        : data[k];
    }
  });
  if (!Object.keys(updates).length) return getOrderById(id);
  const fields = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE orders SET ${fields}, updatedAt = datetime('now') WHERE id = @id`).run({ ...updates, id });
  return getOrderById(id);
}

/* ============================================================
   ── CUSTOMER FUNCTIONS ───────────────────────────────────────
   ============================================================ */

function getCustomersBySeller(sellerId) {
  return db.prepare(`
    SELECT * FROM customers WHERE sellerId = ? ORDER BY totalSpent DESC
  `).all(sellerId);
}

/* ============================================================
   ── STRIPE CONFIG FUNCTIONS ──────────────────────────────────
   ============================================================ */

function saveStripeKeys(sellerId, { publishableKey, secretKey, webhookSecret }) {
  const secretKeyEnc     = encrypt(secretKey);
  const webhookSecretEnc = webhookSecret ? encrypt(webhookSecret) : null;
  const mode             = publishableKey.includes('_test_') ? 'test' : 'live';

  const existing = db.prepare('SELECT id FROM stripe_configs WHERE sellerId = ?').get(sellerId);

  if (existing) {
    db.prepare(`
      UPDATE stripe_configs
      SET publishableKey = ?, secretKeyEnc = ?, webhookSecretEnc = ?, mode = ?, updatedAt = datetime('now')
      WHERE sellerId = ?
    `).run(publishableKey, secretKeyEnc, webhookSecretEnc, mode, sellerId);
  } else {
    db.prepare(`
      INSERT INTO stripe_configs (sellerId, publishableKey, secretKeyEnc, webhookSecretEnc, mode)
      VALUES (?, ?, ?, ?, ?)
    `).run(sellerId, publishableKey, secretKeyEnc, webhookSecretEnc, mode);
  }
}

function getStripeKeys(sellerId) {
  const row = db.prepare('SELECT * FROM stripe_configs WHERE sellerId = ?').get(sellerId);
  if (!row) return null;
  return {
    publishableKey:  row.publishableKey,
    secretKey:       decrypt(row.secretKeyEnc),
    webhookSecret:   row.webhookSecretEnc ? decrypt(row.webhookSecretEnc) : null,
    mode:            row.mode,
  };
}

/* ============================================================
   ── EXPORTS ──────────────────────────────────────────────────
   ============================================================ */

module.exports = {
  // Sellers
  createSeller,
  getSellerById,
  getSellerByEmail,
  getSellerBySlug,
  getSellerByStripeCustomerId,
  updateSeller,

  // Products
  createProduct,
  getProductById,
  getActiveProducts,
  getProductsBySeller,
  getProductCountBySeller,
  checkSKUExists,
  updateProduct,
  deleteProduct,
  decrementStock,

  // Orders
  createOrder,
  getOrderById,
  getOrdersBySeller,
  updateOrder,

  // Customers
  getCustomersBySeller,

  // Stripe
  saveStripeKeys,
  getStripeKeys,
};
