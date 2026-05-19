/* ============================================================
   SHOPSELL — SERVER.JS
   Node.js + Express backend
   
   WHAT THIS FILE DOES:
   - Serves index.html (buyer store) and dashboard.html (seller)
   - Handles all API routes for products, orders, customers
   - Processes Stripe payments (buyer checkout)
   - Manages Stripe subscriptions (seller monthly billing)
   - Handles seller authentication (signup, login, JWT)
   - Listens for Stripe webhook events
   
   TO RUN LOCALLY:
     npm install
     cp .env.example .env   (then fill in your keys)
     node server.js
   
   TO DEPLOY ON RAILWAY:
     See README.md for step-by-step instructions.
   ============================================================ */

'use strict';

// Load local .env file (no-op on Railway, where env vars come from the platform)
require('dotenv').config();

// ── DEPENDENCIES ──────────────────────────────────────────────
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const stripe       = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path         = require('path');
const PDFDocument  = require('pdfkit');
const db           = require('./database');
const carriers     = require('./carriers');
const emailService = require('./email');

const app  = express();
const PORT = process.env.PORT || 3000;

// Trust Railway's proxy — required for rate limiting to work correctly
app.set('trust proxy', 1);

// ── SECURITY MIDDLEWARE ───────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "https://js.stripe.com", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      frameSrc:      ["https://js.stripe.com"],
      connectSrc:    ["'self'", "https://api.stripe.com"],
      imgSrc:        ["'self'", "data:", "https:"],
      styleSrc:      ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
      fontSrc:       ["'self'", "https://fonts.gstatic.com"],
    },
  },
}));

// IMPORTANT: stripe webhooks need raw body — must come BEFORE express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// Parse JSON for all other routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS — only allow your own domain in production
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── RATE LIMITING ─────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please slow down.' },
});

app.use('/api/auth', authLimiter);
app.use('/api',      apiLimiter);

// ── SERVE STATIC FILES ────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Serve the buyer storefront
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve seller signup page
app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'signup.html'));
});

// Serve seller login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

// Serve the seller dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Serve the shipping suite
app.get('/shipping', (req, res) => {
  res.sendFile(path.join(__dirname, 'shipping.html'));
});

// Serve the buyer-facing returns portal
app.get('/returns', (req, res) => {
  res.sendFile(path.join(__dirname, 'returns.html'));
});

// ── AUTH MIDDLEWARE ───────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.seller = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// ── MODULE ACCESS MIDDLEWARE ──────────────────────────────────
function requirePlan(...allowedPlans) {
  return (req, res, next) => {
    if (!allowedPlans.includes(req.seller.plan)) {
      return res.status(403).json({
        error: `This feature requires a ${allowedPlans.join(' or ')} plan.`,
        upgradeRequired: true,
      });
    }
    next();
  };
}

/* ============================================================
   ── AUTH ROUTES ──────────────────────────────────────────────
   POST /api/auth/signup   — create seller account
   POST /api/auth/login    — seller login
   GET  /api/auth/me       — get current seller info
   ============================================================ */

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { firstName, lastName, email, password, phone, storeName, storeSlug, plan } = req.body;

    if (!firstName || !lastName || !email || !password || !storeName || !storeSlug || !plan) {
      return res.status(400).json({ error: 'All required fields must be filled in.' });
    }

    const existing = await db.getSellerByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const stripeCustomer = await stripe.customers.create({
      email,
      name: `${firstName} ${lastName}`,
      phone,
      metadata: { storeName, storeSlug, plan },
    });

    const PLAN_PRICE_IDS = {
      starter: process.env.STRIPE_PRICE_STARTER,
      growth:  process.env.STRIPE_PRICE_GROWTH,
      pro:     process.env.STRIPE_PRICE_PRO,
    };

    const subscription = await stripe.subscriptions.create({
      customer:          stripeCustomer.id,
      items:             [{ price: PLAN_PRICE_IDS[plan] }],
      trial_period_days: 14,
      metadata:          { sellerId: storeSlug },
    });

    const seller = await db.createSeller({
      firstName,
      lastName,
      email,
      passwordHash,
      phone,
      storeName,
      storeSlug,
      plan,
      stripeCustomerId:     stripeCustomer.id,
      stripeSubscriptionId: subscription.id,
    });

    const token = jwt.sign(
      { sellerId: seller.id, email: seller.email, plan: seller.plan },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'Account created! Your 14-day free trial has started.',
      token,
      seller: {
        id:        seller.id,
        firstName: seller.firstName,
        lastName:  seller.lastName,
        email:     seller.email,
        storeName: seller.storeName,
        storeSlug: seller.storeSlug,
        plan:      seller.plan,
        trialEnd:  subscription.trial_end,
      },
    });

  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const seller = await db.getSellerByEmail(email);
    if (!seller) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const passwordMatch = await bcrypt.compare(password, seller.passwordHash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const subscription = await stripe.subscriptions.retrieve(seller.stripeSubscriptionId);
    const isActive = ['active', 'trialing'].includes(subscription.status);
    if (!isActive) {
      return res.status(403).json({
        error: 'Your subscription is inactive. Please update your billing.',
        subscriptionStatus: subscription.status,
      });
    }

    const token = jwt.sign(
      { sellerId: seller.id, email: seller.email, plan: seller.plan },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      seller: {
        id:        seller.id,
        firstName: seller.firstName,
        lastName:  seller.lastName,
        email:     seller.email,
        storeName: seller.storeName,
        storeSlug: seller.storeSlug,
        plan:      seller.plan,
      },
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const seller = await db.getSellerById(req.seller.sellerId);
    if (!seller) return res.status(404).json({ error: 'Seller not found.' });
    res.json({
      id:        seller.id,
      firstName: seller.firstName,
      lastName:  seller.lastName,
      email:     seller.email,
      storeName: seller.storeName,
      storeSlug: seller.storeSlug,
      plan:      seller.plan,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load account.' });
  }
});

/* ============================================================
   ── PRODUCTS ROUTES ──────────────────────────────────────────
   GET    /api/products            — buyer: get all active products
   GET    /api/seller/products     — seller: get all their products
   POST   /api/seller/products     — seller: create product
   PUT    /api/seller/products/:id — seller: update product
   DELETE /api/seller/products/:id — seller: delete product
   ============================================================ */

app.get('/api/products', async (req, res) => {
  try {
    const { storeSlug, category, sort, search } = req.query;

    if (!storeSlug) {
      return res.status(400).json({ error: 'storeSlug is required.' });
    }

    let products = await db.getActiveProducts(storeSlug);

    if (category && category !== 'all') {
      products = products.filter(p => p.category === category);
    }

    if (search) {
      const q = search.toLowerCase();
      products = products.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
      );
    }

    if (sort === 'price-asc')  products.sort((a,b) => a.price - b.price);
    if (sort === 'price-desc') products.sort((a,b) => b.price - a.price);
    if (sort === 'rating')     products.sort((a,b) => b.rating - a.rating);
    if (sort === 'newest')     products.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(products);
  } catch (err) {
    console.error('Get products error:', err);
    res.status(500).json({ error: 'Failed to load products.' });
  }
});

app.get('/api/seller/products', requireAuth, async (req, res) => {
  try {
    const products = await db.getProductsBySeller(req.seller.sellerId);
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load products.' });
  }
});

app.post('/api/seller/products', requireAuth, async (req, res) => {
  try {
    const {
      name, description, category, brand,
      price, compareAtPrice, costPerItem,
      sku, quantity, weight, variants,
      status, imageUrls,
      returnable, returnWindowDays, restockingFeePct,
    } = req.body;

    if (!name || !category || !price || !sku) {
      return res.status(400).json({ error: 'Name, category, price, and SKU are required.' });
    }

    const productCount = await db.getProductCountBySeller(req.seller.sellerId);
    const PLAN_LIMITS  = { starter: 50, growth: 500, pro: Infinity };
    const limit        = PLAN_LIMITS[req.seller.plan] || 50;

    if (productCount >= limit) {
      return res.status(403).json({
        error: `Your ${req.seller.plan} plan allows up to ${limit} products. Upgrade to add more.`,
        upgradeRequired: true,
      });
    }

    const skuExists = await db.checkSKUExists(req.seller.sellerId, sku);
    if (skuExists) {
      return res.status(409).json({ error: `SKU "${sku}" already exists. Use a unique SKU.` });
    }

    const product = await db.createProduct({
      sellerId:       req.seller.sellerId,
      name,
      description,
      category,
      brand,
      price:          parseFloat(price),
      compareAtPrice: compareAtPrice ? parseFloat(compareAtPrice) : null,
      costPerItem:    costPerItem    ? parseFloat(costPerItem)    : null,
      sku,
      quantity:       parseInt(quantity) || 0,
      weight:         weight ? parseFloat(weight) : null,
      variants:         variants   || [],
      status:           status     || 'active',
      imageUrls:        imageUrls  || [],
      returnable:       returnable,
      returnWindowDays: returnWindowDays,
      restockingFeePct: restockingFeePct,
    });

    res.status(201).json({ message: 'Product created!', product });
  } catch (err) {
    console.error('Create product error:', err);
    res.status(500).json({ error: 'Failed to create product.' });
  }
});

app.put('/api/seller/products/:id', requireAuth, async (req, res) => {
  try {
    const product = await db.getProductById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    if (product.sellerId !== req.seller.sellerId) {
      return res.status(403).json({ error: 'You do not own this product.' });
    }
    const updated = await db.updateProduct(req.params.id, req.body);
    res.json({ message: 'Product updated!', product: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update product.' });
  }
});

app.delete('/api/seller/products/:id', requireAuth, async (req, res) => {
  try {
    const product = await db.getProductById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    if (product.sellerId !== req.seller.sellerId) {
      return res.status(403).json({ error: 'You do not own this product.' });
    }
    await db.deleteProduct(req.params.id);
    res.json({ message: 'Product deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete product.' });
  }
});

/* ============================================================
   ── PAYMENT ROUTES (BUYER CHECKOUT) ─────────────────────────
   GET  /api/checkout/config        — public Stripe pk + store name
   POST /api/checkout/create-payment-intent
   POST /api/checkout/confirm
   GET  /api/orders/:id
   ============================================================ */

app.get('/api/checkout/config', async (req, res) => {
  try {
    const { storeSlug } = req.query;
    if (!storeSlug) return res.status(400).json({ error: 'storeSlug is required.' });

    const seller = await db.getSellerBySlug(storeSlug);
    if (!seller) return res.status(404).json({ error: 'Store not found.' });

    res.json({
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
      storeName:      seller.storeName,
      storeSlug:      seller.storeSlug,
    });
  } catch (err) {
    console.error('Checkout config error:', err);
    res.status(500).json({ error: 'Failed to load checkout config.' });
  }
});

app.post('/api/checkout/create-payment-intent', async (req, res) => {
  try {
    const { cartItems, storeSlug, customerEmail } = req.body;

    if (!cartItems || !cartItems.length) {
      return res.status(400).json({ error: 'Cart is empty.' });
    }

    const seller = await db.getSellerBySlug(storeSlug);
    if (!seller) return res.status(404).json({ error: 'Store not found.' });

    let subtotal = 0;
    const verifiedItems = [];
    for (const item of cartItems) {
      const product = await db.getProductById(item.productId);
      if (!product || product.sellerId !== seller.id) {
        return res.status(400).json({ error: `Product not found: ${item.productId}` });
      }
      if (product.quantity < item.qty) {
        return res.status(400).json({ error: `"${product.name}" is out of stock.` });
      }
      subtotal += product.price * item.qty;
      verifiedItems.push({ ...item, price: product.price, name: product.name });
    }

    const tax   = subtotal * 0.08;
    const total = Math.round((subtotal + tax) * 100);

    const order = await db.createOrder({
      sellerId:      seller.id,
      storeSlug,
      customerEmail,
      items:         verifiedItems,
      subtotal,
      tax,
      total:         subtotal + tax,
      status:        'pending',
    });

    // receipt_email must be a valid address or omitted entirely — Stripe
    // 400s on empty strings. The buyer often hasn't typed it yet when the
    // PaymentElement mounts, so the email is captured on /confirm.
    //
    // Card-only for now: Link/wallets will get re-enabled once the storefront
    // properly supports the saved-card flow. Without this, Stripe Link
    // hijacks checkout with an SMS-code challenge for any returning shopper.
    const piPayload = {
      amount:               total,
      currency:             'usd',
      payment_method_types: ['card'],
      metadata: {
        orderId:   order.id,
        storeSlug,
        sellerId:  seller.id,
      },
    };
    if (customerEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      piPayload.receipt_email = customerEmail;
    }

    const paymentIntent = await stripe.paymentIntents.create(piPayload);

    res.json({
      clientSecret: paymentIntent.client_secret,
      orderId:      order.id,
      total:        (total / 100).toFixed(2),
    });

  } catch (err) {
    console.error('Payment intent error:', err);
    res.status(500).json({ error: 'Failed to initialize payment.' });
  }
});

app.post('/api/checkout/confirm', async (req, res) => {
  try {
    const { orderId, paymentIntentId, customerInfo } = req.body;

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment not completed.' });
    }

    // The payment intent was created before the buyer typed their email,
    // so the order's customer_email is stale. Persist the real email here
    // so /returns lookups (which match by email) work.
    const realEmail = (customerInfo && customerInfo.email) ? String(customerInfo.email).trim() : null;

    const order = await db.updateOrder(orderId, {
      status:         'processing',
      paymentIntentId,
      customerInfo,
      customerEmail:  realEmail || undefined,
      paidAt:         new Date(),
    });

    for (const item of order.items) {
      await db.decrementStock(item.productId, item.qty);
    }

    res.json({
      message:     'Order confirmed!',
      orderNumber: `SS-${order.id}`,
      total:       order.total,
    });

  } catch (err) {
    console.error('Confirm order error:', err);
    res.status(500).json({ error: 'Failed to confirm order.' });
  }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    const orderId = normalizeOrderId(req.params.id);
    if (orderId === null) return res.status(404).json({ error: 'Order not found.' });
    const order = await db.getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    res.json({
      id:                order.id,
      status:            order.status,
      total:             order.total,
      items:             order.items.map(i => ({ name: i.name, qty: i.qty, price: i.price })),
      createdAt:         order.createdAt,
      estimatedDelivery: '3–5 business days',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load order.' });
  }
});

/* ============================================================
   ── SELLER ORDERS ROUTES ─────────────────────────────────────
   GET   /api/seller/orders
   PATCH /api/seller/orders/:id
   ============================================================ */

app.get('/api/seller/orders', requireAuth, async (req, res) => {
  try {
    const { status, search, page = 1, limit = 50 } = req.query;
    let orders = await db.getOrdersBySeller(req.seller.sellerId);

    if (status && status !== 'all') {
      orders = orders.filter(o => o.status === status);
    }
    if (search) {
      const q = String(search).toLowerCase();
      // Scanned barcodes ("SS8") and human refs ("SS-8", "#8") both resolve via normalizeOrderId.
      const scannedId = normalizeOrderId(search);
      orders = orders.filter(o =>
        (scannedId !== null && o.id === scannedId) ||
        o.customerInfo?.email?.toLowerCase().includes(q) ||
        o.customerInfo?.firstName?.toLowerCase().includes(q)
      );
    }

    const start = (page - 1) * limit;
    const paged = orders.slice(start, start + parseInt(limit));

    res.json({ orders: paged, total: orders.length, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load orders.' });
  }
});

app.patch('/api/seller/orders/:id', requireAuth, async (req, res) => {
  try {
    const orderId = normalizeOrderId(req.params.id);
    if (orderId === null) return res.status(404).json({ error: 'Order not found.' });
    const order = await db.getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.sellerId !== req.seller.sellerId) {
      return res.status(403).json({ error: 'You do not own this order.' });
    }

    const { status, trackingNumber, trackingCarrier } = req.body;
    const validStatuses = ['processing','shipped','delivered','cancelled','refunded'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }

    const updated = await db.updateOrder(orderId, { status, trackingNumber, trackingCarrier });
    res.json({ message: 'Order updated!', order: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update order.' });
  }
});

// PACKING SLIP PDF — 8.5x11 printable slip for the warehouse
app.get('/api/seller/orders/:id/packing-slip.pdf', requireAuth, async (req, res) => {
  try {
    const orderId = normalizeOrderId(req.params.id);
    if (orderId === null) return res.status(404).json({ error: 'Order not found.' });
    const order = await db.getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.sellerId !== req.seller.sellerId) {
      return res.status(403).json({ error: 'You do not own this order.' });
    }

    const seller = await db.getSellerById(order.sellerId);

    // Look up SKUs for each line item. Items in the DB only carry name+price;
    // SKU lives on the product. Misses (deleted products) just render blank.
    const items = Array.isArray(order.items) ? order.items : [];
    const products = await Promise.all(
      items.map(it => it.productId ? db.getProductById(it.productId).catch(() => null) : null)
    );
    const skuByIdx = products.map(p => p?.sku || '');

    const ship = order.customerInfo || {};
    const fullName = [ship.firstName, ship.lastName].filter(Boolean).join(' ')
      || ship.name
      || order.customerEmail
      || '';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="packing-slip-SS-${order.id}.pdf"`
    );

    const doc = new PDFDocument({ size: 'LETTER', margin: 54 }); // 0.75" margins
    doc.pipe(res);

    // ── Header ─────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(20).text(seller?.storeName || 'ShopSell', { continued: false });
    doc.moveUp();
    doc.font('Helvetica-Bold').fontSize(16).text('PACKING SLIP', { align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor('#555');
    doc.text(`Order #SS-${order.id}`, { align: 'right' });
    const paid = order.paidAt ? new Date(order.paidAt) : new Date(order.createdAt);
    doc.text(`Date: ${paid.toLocaleDateString('en-US')}`, { align: 'right' });
    doc.fillColor('#000');

    doc.moveDown(2);

    // ── Ship-to block ──────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#888').text('SHIP TO');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(12).fillColor('#000');
    if (fullName) doc.text(fullName);
    if (ship.company) doc.text(ship.company);
    if (ship.address1 || ship.address) doc.text(ship.address1 || ship.address);
    if (ship.address2) doc.text(ship.address2);
    const cityLine = [ship.city, ship.state].filter(Boolean).join(', ');
    const cityZip  = [cityLine, ship.zip || ship.postalCode].filter(Boolean).join(' ');
    if (cityZip) doc.text(cityZip);
    if (ship.country && ship.country !== 'US') doc.text(ship.country);
    if (order.customerEmail) {
      doc.fontSize(10).fillColor('#555').text(order.customerEmail);
      doc.fillColor('#000');
    }

    doc.moveDown(2);

    // ── Items table ────────────────────────────────────────────
    const tableTop = doc.y;
    const col = { item: 54, sku: 360, qty: 500 };

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#888');
    doc.text('ITEM',     col.item, tableTop);
    doc.text('SKU',      col.sku,  tableTop);
    doc.text('QTY',      col.qty,  tableTop, { width: 50, align: 'right' });
    doc.fillColor('#000');

    doc.moveTo(54, tableTop + 14).lineTo(558, tableTop + 14).strokeColor('#ccc').stroke();

    let y = tableTop + 22;
    doc.font('Helvetica').fontSize(11);
    items.forEach((it, idx) => {
      const name = it.name || `Product #${it.productId || ''}`;
      const sku  = skuByIdx[idx] || '—';
      const qty  = String(it.qty || it.quantity || 1);

      const nameHeight = doc.heightOfString(name, { width: 290 });
      doc.text(name, col.item, y, { width: 290 });
      doc.text(sku,  col.sku,  y);
      doc.text(qty,  col.qty,  y, { width: 50, align: 'right' });

      y += Math.max(nameHeight, 16) + 6;
    });

    doc.moveTo(54, y).lineTo(558, y).strokeColor('#ccc').stroke();

    // ── Totals (item count only — packing slips traditionally omit prices) ─
    const totalQty = items.reduce((s, it) => s + (parseInt(it.qty || it.quantity) || 0), 0);
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(11)
       .text(`Total items: ${totalQty}`, 54, y + 12, { width: 504, align: 'right' });

    // ── Footer ─────────────────────────────────────────────────
    doc.font('Helvetica').fontSize(10).fillColor('#888')
       .text('Thank you for your order!', 54, 720, { width: 504, align: 'center' });

    doc.end();

  } catch (err) {
    console.error('Packing slip error:', err);
    // If we already started streaming, we can't change headers — just end.
    if (res.headersSent) return res.end();
    res.status(500).json({ error: 'Failed to generate packing slip.' });
  }
});

/* ============================================================
   ── SELLER STRIPE SETUP ROUTES ───────────────────────────────
   POST /api/seller/stripe/keys
   GET  /api/seller/stripe/keys
   POST /api/seller/stripe/test
   GET  /api/seller/stripe/balance
   ============================================================ */

app.post('/api/seller/stripe/keys', requireAuth, async (req, res) => {
  try {
    const { publishableKey, secretKey, webhookSecret } = req.body;

    if (!publishableKey || !secretKey) {
      return res.status(400).json({ error: 'Both publishable key and secret key are required.' });
    }

    const validPK = publishableKey.startsWith('pk_test_') || publishableKey.startsWith('pk_live_');
    const validSK = secretKey.startsWith('sk_test_')     || secretKey.startsWith('sk_live_');

    if (!validPK || !validSK) {
      return res.status(400).json({ error: 'Invalid Stripe key format.' });
    }

    try {
      const testStripe = require('stripe')(secretKey);
      await testStripe.balance.retrieve();
    } catch (stripeErr) {
      return res.status(400).json({ error: 'Stripe rejected these keys. Double-check them in your Stripe dashboard.' });
    }

    await db.saveStripeKeys(req.seller.sellerId, { publishableKey, secretKey, webhookSecret });
    res.json({ message: 'Stripe keys saved and verified!' });
  } catch (err) {
    console.error('Save Stripe keys error:', err);
    res.status(500).json({ error: 'Failed to save keys.' });
  }
});

app.get('/api/seller/stripe/keys', requireAuth, async (req, res) => {
  try {
    const config = await db.getStripeKeys(req.seller.sellerId);
    if (!config) return res.json({ connected: false });
    res.json({
      connected:        true,
      publishableKey:   config.publishableKey,
      secretKeyMasked:  config.secretKey.slice(0,8)+'••••••••••••••••'+config.secretKey.slice(-4),
      webhookConfigured: !!config.webhookSecret,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load Stripe config.' });
  }
});

app.post('/api/seller/stripe/test', requireAuth, async (req, res) => {
  try {
    const config = await db.getStripeKeys(req.seller.sellerId);
    if (!config) return res.status(400).json({ error: 'No Stripe keys found. Add them first.' });

    const testStripe = require('stripe')(config.secretKey);
    const balance    = await testStripe.balance.retrieve();

    res.json({
      success:  true,
      message:  'Stripe connection successful!',
      mode:     config.secretKey.includes('_test_') ? 'test' : 'live',
      currency: balance.available[0]?.currency?.toUpperCase() || 'USD',
    });
  } catch (err) {
    res.status(400).json({ success: false, error: 'Connection failed: '+err.message });
  }
});

app.get('/api/seller/stripe/balance', requireAuth, async (req, res) => {
  try {
    const config = await db.getStripeKeys(req.seller.sellerId);
    if (!config) return res.status(400).json({ error: 'Stripe not connected.' });

    const sellerStripe = require('stripe')(config.secretKey);
    const balance      = await sellerStripe.balance.retrieve();

    res.json({
      available: balance.available.map(b => ({ amount: (b.amount/100).toFixed(2), currency: b.currency.toUpperCase() })),
      pending:   balance.pending.map(b   => ({ amount: (b.amount/100).toFixed(2), currency: b.currency.toUpperCase() })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve balance.' });
  }
});

/* ============================================================
   ── SELLER SUBSCRIPTION ROUTES ───────────────────────────────
   GET  /api/seller/subscription
   POST /api/seller/subscription/upgrade
   POST /api/seller/subscription/cancel
   ============================================================ */

app.get('/api/seller/subscription', requireAuth, async (req, res) => {
  try {
    const seller = await db.getSellerById(req.seller.sellerId);
    const sub    = await stripe.subscriptions.retrieve(seller.stripeSubscriptionId);

    res.json({
      status:            sub.status,
      plan:              seller.plan,
      trialEnd:          sub.trial_end         ? new Date(sub.trial_end * 1000)         : null,
      currentPeriodEnd:  sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load subscription.' });
  }
});

app.post('/api/seller/subscription/upgrade', requireAuth, async (req, res) => {
  try {
    const { newPlan } = req.body;
    const PLAN_PRICE_IDS = {
      starter: process.env.STRIPE_PRICE_STARTER,
      growth:  process.env.STRIPE_PRICE_GROWTH,
      pro:     process.env.STRIPE_PRICE_PRO,
    };

    if (!PLAN_PRICE_IDS[newPlan]) {
      return res.status(400).json({ error: 'Invalid plan.' });
    }

    const seller = await db.getSellerById(req.seller.sellerId);
    const sub    = await stripe.subscriptions.retrieve(seller.stripeSubscriptionId);

    await stripe.subscriptions.update(seller.stripeSubscriptionId, {
      items: [{ id: sub.items.data[0].id, price: PLAN_PRICE_IDS[newPlan] }],
      proration_behavior: 'create_prorations',
    });

    await db.updateSeller(req.seller.sellerId, { plan: newPlan });
    res.json({ message: `Plan upgraded to ${newPlan}!` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to upgrade plan.' });
  }
});

app.post('/api/seller/subscription/cancel', requireAuth, async (req, res) => {
  try {
    const seller = await db.getSellerById(req.seller.sellerId);
    await stripe.subscriptions.update(seller.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
    res.json({ message: 'Subscription will be cancelled at the end of your billing period.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel subscription.' });
  }
});

/* ============================================================
   ── SELLER RETURN ADDRESS ────────────────────────────────────
   GET /api/seller/return-address
   PUT /api/seller/return-address
   ============================================================ */

app.get('/api/seller/return-address', requireAuth, async (req, res) => {
  try {
    const addr = await db.getSellerReturnAddress(req.seller.sellerId);
    res.json({ address: addr });
  } catch (err) {
    console.error('Get return address error:', err);
    res.status(500).json({ error: 'Failed to load return address.' });
  }
});

app.put('/api/seller/return-address', requireAuth, async (req, res) => {
  try {
    const { name, address1, address2, city, state, zip, country, phone, residential } = req.body || {};
    if (!name || !address1 || !city || !state || !zip) {
      return res.status(400).json({ error: 'name, address1, city, state, and zip are required.' });
    }
    const addr = {
      name, address1, address2: address2 || '',
      city, state, zip,
      country: country || 'US',
      phone: phone || '',
      residential: !!residential,
    };
    await db.setSellerReturnAddress(req.seller.sellerId, addr);
    res.json({ message: 'Return address saved.', address: addr });
  } catch (err) {
    console.error('Save return address error:', err);
    res.status(500).json({ error: 'Failed to save return address.' });
  }
});

/* ============================================================
   ── CUSTOMER ROUTES ──────────────────────────────────────────
   GET /api/seller/customers
   ============================================================ */

app.get('/api/seller/customers', requireAuth, async (req, res) => {
  try {
    const customers = await db.getCustomersBySeller(req.seller.sellerId);
    res.json(customers);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load customers.' });
  }
});

/* ============================================================
   ── ANALYTICS ROUTES ─────────────────────────────────────────
   GET /api/seller/analytics
   ============================================================ */

app.get('/api/seller/analytics', requireAuth, async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    const days  = period === '7d' ? 7 : period === '90d' ? 90 : 30;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const orders = await db.getOrdersBySeller(req.seller.sellerId, since);

    const revenue    = orders.reduce((s,o) => s + o.total, 0);
    const orderCount = orders.length;
    const avgOrder   = orderCount ? revenue / orderCount : 0;

    const byDay = {};
    orders.forEach(o => {
      const day = new Date(o.createdAt).toISOString().slice(0,10);
      byDay[day] = (byDay[day] || 0) + o.total;
    });

    const productTotals = {};
    orders.forEach(o => {
      o.items.forEach(item => {
        if (!productTotals[item.productId]) {
          productTotals[item.productId] = { name: item.name, qty: 0, revenue: 0 };
        }
        productTotals[item.productId].qty     += item.qty;
        productTotals[item.productId].revenue += item.price * item.qty;
      });
    });

    const topProducts = Object.values(productTotals)
      .sort((a,b) => b.revenue - a.revenue)
      .slice(0,5);

    res.json({ revenue, orderCount, avgOrder, byDay, topProducts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load analytics.' });
  }
});

/* ============================================================
   ── STRIPE WEBHOOK ───────────────────────────────────────────
   POST /api/stripe/webhook
   ============================================================ */

app.post('/api/stripe/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`Stripe webhook: ${event.type}`);

  try {
    switch (event.type) {

      case 'payment_intent.succeeded': {
        const pi      = event.data.object;
        const orderId = pi.metadata?.orderId;
        if (orderId) {
          await db.updateOrder(orderId, {
            status:          'processing',
            paymentIntentId: pi.id,
            paidAt:          new Date(),
          });
          console.log(`Order ${orderId} marked as paid`);
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi      = event.data.object;
        const orderId = pi.metadata?.orderId;
        if (orderId) {
          await db.updateOrder(orderId, { status: 'payment_failed' });
          console.log(`Order ${orderId} payment failed`);
        }
        break;
      }

      case 'charge.refunded': {
        const charge  = event.data.object;
        const orderId = charge.metadata?.orderId;
        if (orderId) {
          await db.updateOrder(orderId, { status: 'refunded' });
          console.log(`Order ${orderId} refunded`);
        }
        break;
      }

      case 'charge.dispute.created': {
        const dispute = event.data.object;
        console.warn('Chargeback filed:', dispute.id, 'Amount:', dispute.amount);
        break;
      }

      case 'customer.subscription.updated': {
        const sub    = event.data.object;
        const seller = await db.getSellerByStripeCustomerId(sub.customer);
        if (seller) {
          await db.updateSeller(seller.id, { subscriptionStatus: sub.status });
          console.log(`Seller ${seller.email} subscription updated: ${sub.status}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub    = event.data.object;
        const seller = await db.getSellerByStripeCustomerId(sub.customer);
        if (seller) {
          await db.updateSeller(seller.id, {
            subscriptionStatus: 'cancelled',
            storeActive:        false,
          });
          console.log(`Seller ${seller.email} subscription cancelled`);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        console.log(`Subscription payment received: $${invoice.amount_paid / 100}`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const seller  = await db.getSellerByStripeCustomerId(invoice.customer);
        if (seller) {
          console.warn(`Seller ${seller.email} payment failed`);
        }
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error(`Error processing webhook ${event.type}:`, err);
  }

  res.json({ received: true });
});

/* ============================================================
   ── SHIPPING ROUTES ──────────────────────────────────────────
   POST /api/shipping/label        — create UPS/FedEx label
   POST /api/shipping/return-label — create return label
   GET  /api/shipping/track/:carrier/:tracking — track shipment
   POST /api/shipping/pickup       — schedule UPS pickup
   POST /api/shipping/void         — void/cancel/refund a label
   GET  /api/shipping/carriers/test — test carrier connections
   ============================================================ */

// TEST CARRIER CONNECTIONS
app.get('/api/shipping/carriers/test', async (req, res) => {
  try {
    const results = await carriers.testConnections();
    res.json(results);
  } catch(err) {
    res.status(500).json({ error: 'Carrier test failed: '+err.message });
  }
});

// CREATE SHIPPING LABEL
app.post('/api/shipping/label', async (req, res) => {
  try {
    const {
      carrier = 'ups',
      orderId,
      shipper,
      recipient,
      package: pkg,
      serviceCode,
      serviceType,
      labelFormat,
      billing,
    } = req.body;

    if(!shipper || !recipient || !pkg) {
      return res.status(400).json({ error: 'shipper, recipient, and package are required.' });
    }

    // Build billing info
    const billingInfo = billing || { type: '01' };

    // Create label with appropriate carrier
    let label;
    if(carrier === 'ups') {
      label = await carriers.ups.createShipment({
        shipper, recipient,
        package: pkg,
        serviceCode: serviceCode || '03',
        labelFormat: labelFormat || 'GIF',
        reference: orderId,
        billing: billingInfo,
      });
    } else if(carrier === 'fedex') {
      label = await carriers.fedex.createShipment({
        shipper, recipient,
        package: pkg,
        serviceType: serviceType || 'FEDEX_GROUND',
        labelFormat: labelFormat || 'PDF',
        reference: orderId,
        billing: billingInfo,
      });
    } else if(carrier === 'usps') {
      label = await carriers.usps.createShipment({
        shipper, recipient,
        package: pkg,
        serviceToken: serviceType || 'usps_priority',
        reference: orderId,
      });
    } else {
      return res.status(400).json({ error: 'Unsupported carrier. Use ups, fedex, or usps.' });
    }

    // Save shipment record to the database for the Shipping History page.
    // We capture the full from/to addresses + label image so the history page
    // can reprint, void, and email customers without re-calling the carrier API.
    try {
      await db.createShipment({
        sellerId:       null,                              // wire when auth is added
        orderId:        Number.isFinite(parseInt(orderId)) ? parseInt(orderId) : null,
        trackingNumber: label.trackingNumber,
        carrier,
        serviceCode:    label.serviceCode || serviceCode || serviceType || null,
        serviceName:    label.serviceName || null,
        fromName:       shipper.name || '',
        fromAddr:       shipper.address1 || shipper.address || '',
        fromCity:       shipper.city || '',
        fromState:      shipper.state || '',
        fromZip:        shipper.zip || shipper.postalCode || '',
        toName:         recipient.name || '',
        toCompany:      recipient.company || '',
        toAddr:         recipient.address1 || recipient.address || '',
        toAddr2:        recipient.address2 || '',
        toCity:         recipient.city || '',
        toState:        recipient.state || '',
        toZip:          recipient.zip || recipient.postalCode || '',
        toPhone:        recipient.phone || '',
        toEmail:        recipient.email || '',
        residential:    !!recipient.residential,
        weight:         (pkg && pkg.weight) ? String(pkg.weight) : '',
        totalCharge:    label.totalCharge || null,
        currency:       label.currency || 'USD',
        ref:            orderId || '',
        labelImage:     label.labelImage || null,
        labelUrl:       label.labelUrl   || null,
        transactionId:  label.transactionId || null,       // USPS / Shippo refunds need this
        status:         'created',
      });
    } catch(dbErr){
      // Don't fail the whole request if the DB write fails — the label is real.
      console.error('Shipment DB write failed (label still valid):', dbErr.message);
    }

    console.log(`Label created: ${carrier.toUpperCase()} ${label.trackingNumber} for order ${orderId}`);
    res.json({ success: true, label });

  } catch(err) {
    console.error('Create label error:', err);
    res.status(500).json({ error: 'Failed to create label: '+err.message });
  }
});

// CREATE RETURN LABEL
app.post('/api/shipping/return-label', async (req, res) => {
  try {
    const { carrier = 'ups', returnId, sellerAddress, customerAddress, pkg } = req.body;

    if(!sellerAddress || !customerAddress) {
      return res.status(400).json({ error: 'sellerAddress and customerAddress are required.' });
    }

    const label = await carriers.createReturnLabel(carrier, {
      shipper:   sellerAddress,   // Where it goes back to
      recipient: customerAddress, // Customer sending it back
      package:   pkg || { weight: 2, length: 12, width: 9, height: 4 },
      reference: `RETURN-${returnId}`,
    });

    console.log(`Return label created: ${carrier.toUpperCase()} ${label.trackingNumber}`);
    res.json({ success: true, label });

  } catch(err) {
    console.error('Return label error:', err);
    res.status(500).json({ error: 'Failed to create return label: '+err.message });
  }
});

// TRACK SHIPMENT
app.get('/api/shipping/track/:carrier/:tracking', async (req, res) => {
  try {
    const { carrier, tracking } = req.params;
    const result = await carriers.track(carrier, tracking);
    res.json(result);
  } catch(err) {
    console.error('Track error:', err);
    res.status(500).json({ error: 'Tracking failed: '+err.message });
  }
});

// SCHEDULE UPS PICKUP
app.post('/api/shipping/pickup', async (req, res) => {
  try {
    const { pickupDate, earliestTime, latestTime, address, packageCount, totalWeight } = req.body;

    if(!pickupDate || !address) {
      return res.status(400).json({ error: 'pickupDate and address are required.' });
    }

    const result = await carriers.ups.schedulePickup({
      pickupDate,
      earliestTime: earliestTime || '0900',
      latestTime:   latestTime   || '1700',
      address,
      packageCount: packageCount || 1,
      totalWeight:  totalWeight  || 10,
    });

    console.log(`UPS pickup scheduled: ${result.confirmationNumber} for ${pickupDate}`);
    res.json({ success: true, pickup: result });

  } catch(err) {
    console.error('Pickup error:', err);
    res.status(500).json({ error: 'Failed to schedule pickup: '+err.message });
  }
});

// ZIP CODE LOOKUP — covers all 42,000+ US ZIP codes
app.get('/api/shipping/zip-lookup', async (req, res) => {
  try {
    const { zip } = req.query;
    if(!zip || zip.length !== 5) return res.status(400).json({ error: 'Invalid ZIP code.' });

    const nodeFetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
    const response  = await nodeFetch(`https://api.zippopotam.us/us/${zip}`);

    if(!response.ok){
      return res.json({ city: null, state: null, error: 'ZIP code not found.' });
    }

    const data  = await response.json();
    const place = data.places?.[0];

    if(!place){
      return res.json({ city: null, state: null, error: 'ZIP code not found.' });
    }

    res.json({
      zip,
      city:  place['place name'],
      state: place['state abbreviation'],
      county: place['state'],
    });

  } catch(err) {
    console.error('ZIP lookup error:', err.message);
    res.status(500).json({ error: 'ZIP lookup failed.' });
  }
});

// VALIDATE ADDRESS
app.post('/api/shipping/validate-address', async (req, res) => {
  try {
    const { address1, city, state, zip } = req.body;
    if(!address1 || !city || !state || !zip) {
      return res.status(400).json({ error: 'Address fields required.' });
    }

    const token = await carriers.ups.getAccessToken();
    const nodeFetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

    const payload = {
      XAVRequest: {
        Request: {
          RequestOption: '3',
          TransactionReference: { CustomerContext: 'nextlao-addr-val' },
        },
        AddressKeyFormat: {
          AddressLine:        address1,
          PoliticalDivision2: city,
          PoliticalDivision1: state,
          PostcodePrimaryLow: zip,
          CountryCode:        'US',
        },
      },
    };

    const apiRes = await nodeFetch(`${carriers.ups.apiUrl}/api/addressvalidation/v2/1`, {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Content-Type':   'application/json',
        'transId':        `nextlao-addr-${Date.now()}`,
        'transactionSrc': 'nextlao',
      },
      body: JSON.stringify(payload),
    });

    if(!apiRes.ok){
      const errText = await apiRes.text();
      console.error('UPS Address Validation error:', errText);
      // Don't block shipping — return valid so label generation proceeds
      return res.json({ valid: true, message: 'Validation unavailable — proceeding.' });
    }

    const data      = await apiRes.json();
    const response  = data?.XAVResponse;
    const candidate = response?.Candidate?.[0]?.AddressKeyFormat;
    const quality   = response?.Candidate?.[0]?.AddressClassification?.Description;
    const noCandidates = response?.NoCandidatesIndicator;

    // No match found at all
    if(noCandidates || !candidate){
      return res.json({
        valid: false,
        message: 'Address not found. Please check the address and try again.',
      });
    }

    // Build suggestion from UPS response
    const suggestion = {
      address1: Array.isArray(candidate.AddressLine)
        ? candidate.AddressLine[0]
        : candidate.AddressLine,
      city:  candidate.PoliticalDivision2,
      state: candidate.PoliticalDivision1,
      zip:   candidate.PostcodePrimaryLow,
    };

    // Check for ambiguous indicator
    const isAmbiguous = !!response?.AmbiguousAddressIndicator;

    if(isAmbiguous){
      return res.json({
        valid: false,
        suggestion,
        message: 'Address is ambiguous — please verify.',
      });
    }

    // Good match
    return res.json({
      valid:   true,
      message: `Address verified ✓ (${quality || 'Valid'})`,
      suggestion,
    });

  } catch(err) {
    console.error('Address validation error:', err.message);
    // Never block shipping on validation errors
    res.json({ valid: true, message: 'Validation unavailable — proceeding.' });
  }
});

// VERIFY UPS ACCOUNT NUMBER
app.post('/api/shipping/verify-account', async (req, res) => {
  try {
    const { accountNumber, zip } = req.body;
    if(!accountNumber) return res.status(400).json({ error: 'Account number required.' });

    // Attempt to get a token using the platform credentials
    // UPS account verification is done by attempting to rate-shop with that account
    const token = await carriers.ups.getAccessToken();
    const nodeFetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

    // Try a minimal address validation call to verify the account exists
    const res2 = await nodeFetch(`${carriers.ups.apiUrl}/api/rating/v2403/Shop`, {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Content-Type':   'application/json',
        'transId':        `nextlao-verify-${Date.now()}`,
        'transactionSrc': 'nextlao',
      },
      body: JSON.stringify({
        RateRequest: {
          Request: { RequestOption: 'Shop' },
          Shipment: {
            Shipper: {
              ShipperNumber: accountNumber,
              Address: { PostalCode: zip||'90001', CountryCode:'US' },
            },
            ShipTo:   { Address: { PostalCode:'10001', CountryCode:'US' } },
            ShipFrom: { Address: { PostalCode: zip||'90001', CountryCode:'US' } },
            Package: {
              PackagingType: { Code:'02' },
              PackageWeight: { UnitOfMeasurement:{Code:'LBS'}, Weight:'1' },
            },
          },
        },
      }),
    });

    // If we get any response (even an error about the account), the account exists
    const data = await res2.json();
    const hasError = data?.response?.errors?.[0]?.code;

    // Error code 111210 = invalid account — all others mean account exists
    if(hasError === '111210'){
      return res.json({ valid: false, message: 'UPS account number not found.' });
    }

    res.json({ valid: true, message: `UPS account ${accountNumber} verified.` });

  } catch(err) {
    console.error('Verify account error:', err.message);
    // Return valid in demo/sandbox — let them proceed
    res.json({ valid: true, message: 'Account saved (sandbox mode).' });
  }
});

// VOID / CANCEL / REFUND LABEL
// Carrier-aware:
//   - UPS:   instant void, no charge if package never scanned
//   - FedEx: instant cancel, no charge if package never scanned
//   - USPS:  refund request through Shippo (charges immediately, refund in 14-21 days)
app.post('/api/shipping/void', async (req, res) => {
  try {
    const { carrier, trackingNumber, transactionId } = req.body;

    if (!carrier || !trackingNumber) {
      return res.status(400).json({ error: 'carrier and trackingNumber are required.' });
    }

    let result;

    if (carrier === 'ups') {
      result = await carriers.ups.voidShipment(trackingNumber);
      result.carrier      = 'ups';
      result.action       = 'voided';
      result.userMessage  = 'UPS label voided. No charge applied since package was never scanned.';

    } else if (carrier === 'fedex') {
      result = await carriers.fedex.cancelShipment(trackingNumber);
      result.carrier      = 'fedex';
      result.action       = 'cancelled';
      result.userMessage  = 'FedEx label cancelled. No charge applied since package was never scanned.';

    } else if (carrier === 'usps') {
      // USPS via Shippo: requires the transactionId from when the label was created.
      // Shippo charges immediately on label purchase — refund is requested from USPS.
      if (!transactionId) {
        return res.status(400).json({
          error: 'USPS refunds require a transactionId. Pass the Shippo transactionId from when the label was created.'
        });
      }
      result = await carriers.usps.refundLabel(transactionId);
      result.carrier      = 'usps';
      result.action       = 'refund_requested';
      result.userMessage  = 'Refund requested through Shippo. USPS reviews unused labels — refund typically issued in 14-21 days if approved.';

    } else {
      return res.status(400).json({ error: 'Unsupported carrier. Use ups, fedex, or usps.' });
    }

    // Update the shipment status in the database so the Shipping History
    // page reflects the new state. Don't fail the response if this errors.
    try {
      await db.markShipmentVoided(trackingNumber, result.action);
    } catch(dbErr){
      console.error('Shipment DB update failed (void at carrier still succeeded):', dbErr.message);
    }

    console.log(`Label ${result.action}: ${carrier.toUpperCase()} ${trackingNumber}`);
    res.json({ success: true, result });

  } catch (err) {
    console.error('Void/refund error:', err);
    res.status(500).json({ error: 'Failed to void/refund label: ' + err.message });
  }
});

/* ============================================================
   ── SHIPPING HISTORY ROUTES ──────────────────────────────────
   GET /api/shipping/history — list shipments for the history page
   ============================================================ */

app.get('/api/shipping/history', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 200, 1000);
    const offset = parseInt(req.query.offset) || 0;

    // When auth is wired into shipping routes, switch to getShipmentsBySeller(req.seller.sellerId, ...).
    // For now we return all recent shipments (acceptable while there's a single seller).
    const shipments = await db.getRecentShipments({ limit, offset });

    res.json({ shipments, total: shipments.length });
  } catch (err) {
    console.error('Get shipping history error:', err);
    res.status(500).json({ error: 'Failed to load shipping history: ' + err.message });
  }
});

/* ============================================================
   ── BUYER-FACING RETURNS ─────────────────────────────────────
   GET  /api/returns/eligible — check what items can be returned
   POST /api/returns          — create a return + generate label
   ============================================================ */

// Shared helper: load order + verify identity (by customer email).
// Returns { order, seller, error, status } shape so callers can short-circuit.
// Accepts "SS-123", "ss123", "#123", "123", or a scanned barcode like "SS8".
// Returns a positive integer order id, or null if nothing usable.
function normalizeOrderId(input) {
  if (input == null) return null;
  const digits = String(input).replace(/[^0-9]/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function loadOrderForBuyer(orderNumber, email) {
  if (!orderNumber || !email) {
    return { error: 'Order number and email are required.', status: 400 };
  }
  const orderId = normalizeOrderId(orderNumber);
  if (orderId === null) {
    return { error: 'Invalid order number.', status: 400 };
  }
  const order = await db.getOrderById(orderId);
  if (!order) return { error: 'Order not found.', status: 404 };

  const onFile = (order.customerEmail || order.customerInfo?.email || '').toLowerCase().trim();
  if (!onFile || onFile !== String(email).toLowerCase().trim()) {
    return { error: 'Order not found.', status: 404 }; // don't leak which side mismatched
  }
  const seller = await db.getSellerById(order.sellerId);
  return { order, seller };
}

// Sum quantities already returned for each productId across prior returns rows
async function alreadyReturnedByProduct(orderId) {
  const prior = await db.getReturnsByOrder(orderId);
  const tally = {};
  for (const r of prior) {
    for (const it of (r.items || [])) {
      const pid = String(it.productId);
      tally[pid] = (tally[pid] || 0) + (parseInt(it.qty) || 0);
    }
  }
  return tally;
}

// Build per-item eligibility based on product rules + paid date + prior returns
async function computeEligibility(order) {
  const tally = await alreadyReturnedByProduct(order.id);
  const paid = order.paidAt ? new Date(order.paidAt) : new Date(order.createdAt);
  const today = new Date();

  const out = await Promise.all((order.items || []).map(async (it) => {
    const product = it.productId ? await db.getProductById(it.productId).catch(() => null) : null;
    const purchasedQty = parseInt(it.qty || it.quantity) || 0;
    const returnedQty  = tally[String(it.productId)] || 0;
    const remainingQty = Math.max(0, purchasedQty - returnedQty);

    // Defaults match the schema defaults so legacy products are treated as returnable
    const returnable  = product ? !!product.returnable : true;
    const windowDays  = product ? (parseInt(product.returnWindowDays) || 30) : 30;
    const deadline    = new Date(paid.getTime() + windowDays * 86400000);
    const withinWindow = today <= deadline;

    let reason = null;
    let eligible = true;
    if (!returnable)            { eligible = false; reason = 'Final sale — not returnable.'; }
    else if (!withinWindow)     { eligible = false; reason = `Return window closed (${windowDays} days).`; }
    else if (remainingQty <= 0) { eligible = false; reason = 'Already returned.'; }

    return {
      productId:        it.productId,
      name:             it.name || (product ? product.name : `Product #${it.productId || ''}`),
      sku:              product?.sku || '',
      price:            it.price,
      purchasedQty,
      returnedQty,
      remainingQty,
      eligible,
      reason,
      returnable,
      windowDays,
      deadline:         deadline.toISOString(),
      restockingFeePct: product ? parseFloat(product.restockingFeePct) || 0 : 0,
    };
  }));

  return out;
}

app.get('/api/returns/eligible', async (req, res) => {
  try {
    const { orderNumber, email } = req.query;
    const lookup = await loadOrderForBuyer(orderNumber, email);
    if (lookup.error) return res.status(lookup.status).json({ error: lookup.error });

    const { order, seller } = lookup;
    const items = await computeEligibility(order);

    res.json({
      orderId:     order.id,
      orderNumber: `SS-${order.id}`,
      paidAt:      order.paidAt,
      storeName:   seller?.storeName || 'ShopSell',
      returnsEnabled: !!(await db.getSellerReturnAddress(order.sellerId)),
      items,
    });
  } catch (err) {
    console.error('Returns eligibility error:', err);
    res.status(500).json({ error: 'Failed to load return eligibility.' });
  }
});

app.post('/api/returns', async (req, res) => {
  try {
    const { orderNumber, email, items: requestedItems, reason } = req.body || {};
    if (!Array.isArray(requestedItems) || requestedItems.length === 0) {
      return res.status(400).json({ error: 'Select at least one item to return.' });
    }

    const lookup = await loadOrderForBuyer(orderNumber, email);
    if (lookup.error) return res.status(lookup.status).json({ error: lookup.error });

    const { order, seller } = lookup;

    const returnAddress = await db.getSellerReturnAddress(order.sellerId);
    if (!returnAddress) {
      return res.status(400).json({
        error: 'This seller has not configured a return address yet. Please contact them directly.',
      });
    }

    // Re-validate eligibility server-side — never trust the client.
    const eligibility = await computeEligibility(order);
    const eligibleByPid = {};
    eligibility.forEach(e => { eligibleByPid[String(e.productId)] = e; });

    const validated = [];
    for (const it of requestedItems) {
      const elig = eligibleByPid[String(it.productId)];
      if (!elig)            return res.status(400).json({ error: `Item not in order: ${it.productId}` });
      if (!elig.eligible)   return res.status(400).json({ error: `Item not eligible: ${elig.name} — ${elig.reason}` });
      const qty = parseInt(it.qty) || 0;
      if (qty <= 0)         return res.status(400).json({ error: `Invalid quantity for ${elig.name}` });
      if (qty > elig.remainingQty) {
        return res.status(400).json({ error: `Quantity for ${elig.name} exceeds remaining returnable (${elig.remainingQty}).` });
      }
      validated.push({ productId: it.productId, name: elig.name, qty, price: elig.price });
    }

    // Look up the outbound shipment so we can mirror carrier + package dims.
    // If none exists, fall back to UPS + a standard small box.
    const outbound = await db.pool.query(
      `SELECT carrier, weight FROM shipments
         WHERE order_id = $1 AND status NOT IN ('voided', 'refund_requested')
         ORDER BY created_at DESC LIMIT 1`,
      [order.id]
    ).then(r => r.rows[0]).catch(() => null);

    const carrier = (outbound?.carrier) || 'ups';
    const pkg = {
      weight: parseFloat(outbound?.weight) || 2,
      length: 12, width: 9, height: 4,
    };

    // The return label flows from the buyer (recipient on outbound) BACK to the seller.
    // So on the label: shipper = buyer's outbound ship-to address, recipient = seller's return address.
    const ship = order.customerInfo || {};
    const buyer = {
      name:     [ship.firstName, ship.lastName].filter(Boolean).join(' ') || ship.name || order.customerEmail || 'Customer',
      company:  ship.company || '',
      address1: ship.address1 || ship.address || '',
      address2: ship.address2 || '',
      city:     ship.city  || '',
      state:    ship.state || '',
      zip:      ship.zip   || ship.postalCode || '',
      country:  ship.country || 'US',
      phone:    ship.phone || '',
      email:    order.customerEmail || ship.email || '',
      residential: ship.residential !== false,
    };

    const label = await carriers.createReturnLabel(carrier, {
      shipper:     buyer,           // package travels FROM the buyer
      recipient:   returnAddress,   // TO the seller's return address
      package:     pkg,
      // Reference 1: human-readable order tag for visual reconciliation.
      // Reference 2: short order ID rendered as a Code 128 barcode by UPS
      // so receiving staff can scan instead of keying the order number.
      reference:        `Order SS-${order.id}`,
      barcodeReference: `SS-${order.id}`,
      // Match the outbound shipping module: ask UPS for a GIF and let the
      // frontend wrap it in an HTML page that prints at 1:1 via a hidden
      // iframe. The browser PDF viewer path was unreliable across drivers.
      labelFormat: 'GIF',
    });

    const returnRow = await db.createReturn({
      orderId:        order.id,
      sellerId:       order.sellerId,
      customerEmail:  order.customerEmail,
      items:          validated,
      reason:         (reason || '').slice(0, 500),
      status:         'label_issued',
      carrier:        label.carrier,
      trackingNumber: label.trackingNumber,
      labelImage:     label.labelImage,
      labelUrl:       label.labelUrl,
      transactionId:  label.transactionId || null,
    });

    console.log(`Return label issued for order ${order.id}: ${carrier.toUpperCase()} ${label.trackingNumber}`);

    // Fire emails to buyer + seller. Failures are logged but never block
    // the response — the label is real and the buyer already has it on screen.
    const buyerName = [ship.firstName, ship.lastName].filter(Boolean).join(' ') || ship.name || '';
    emailService.sendReturnLabelToBuyer({
      toEmail:        order.customerEmail,
      orderNumber:    `SS-${order.id}`,
      storeName:      seller?.storeName || 'ShopSell',
      carrier:        label.carrier,
      trackingNumber: label.trackingNumber,
      items:          validated,
      labelImage:     label.labelImage,
      labelUrl:       label.labelUrl,
      labelFormat:    label.labelFormat,
      returnAddress,
    }).catch(err => console.error('Buyer email failed:', err.message));

    if (seller?.email) {
      emailService.sendReturnNotificationToSeller({
        toEmail:        seller.email,
        orderNumber:    `SS-${order.id}`,
        buyerEmail:     order.customerEmail,
        buyerName,
        carrier:        label.carrier,
        trackingNumber: label.trackingNumber,
        items:          validated,
        reason:         reason || '',
        storeName:      seller.storeName || 'ShopSell',
      }).catch(err => console.error('Seller email failed:', err.message));
    }

    res.json({
      success:        true,
      returnId:       returnRow.id,
      orderNumber:    `SS-${order.id}`,
      storeName:      seller?.storeName || 'ShopSell',
      carrier:        label.carrier,
      trackingNumber: label.trackingNumber,
      labelImage:     label.labelImage,
      labelUrl:       label.labelUrl,
      labelFormat:    label.labelFormat || 'PDF',
    });

  } catch (err) {
    console.error('Create return error:', err);
    res.status(500).json({ error: 'Failed to create return: ' + err.message });
  }
});

/* ============================================================
   ── HEALTH CHECK ─────────────────────────────────────────────
   ============================================================ */

app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    env:       process.env.NODE_ENV || 'development',
  });
});

/* ============================================================
   ── 404 & ERROR HANDLERS ─────────────────────────────────────
   ============================================================ */

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'An unexpected error occurred.' });
});

/* ============================================================
   ── START SERVER ─────────────────────────────────────────────
   ============================================================ */

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   ShopSell Server running on port ${PORT}   ║
║   ENV: ${(process.env.NODE_ENV||'development').padEnd(34)}║
║   Stripe: ${process.env.STRIPE_SECRET_KEY ? 'Connected ✓' : 'NOT CONNECTED ✗'.padEnd(30)}║
╚══════════════════════════════════════════╝
  `);
});

module.exports = app;
