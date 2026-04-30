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

// ── DEPENDENCIES ──────────────────────────────────────────────
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const stripe       = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path         = require('path');
const db           = require('./database');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── SECURITY MIDDLEWARE ───────────────────────────────────────
// helmet sets secure HTTP headers automatically
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "https://js.stripe.com", "'unsafe-inline'"],
      frameSrc:   ["https://js.stripe.com"],
      connectSrc: ["'self'", "https://api.stripe.com"],
      imgSrc:     ["'self'", "data:", "https:"],
      styleSrc:   ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
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
// Prevents brute-force attacks on login/signup
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                   // 20 attempts per window
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,            // 100 requests per minute per IP
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

// Serve the seller dashboard (protected — auth check happens client-side,
// real protection is on all /api/seller/* routes via requireAuth middleware)
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
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
    req.seller = decoded; // { sellerId, email, plan }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// ── MODULE ACCESS MIDDLEWARE ──────────────────────────────────
// Check if seller's plan includes a given module
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
   POST /api/auth/logout   — invalidate token (client-side)
   GET  /api/auth/me       — get current seller info
   ============================================================ */

// SIGNUP — creates seller account + Stripe customer for subscription billing
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { firstName, lastName, email, password, phone, storeName, storeSlug, plan } = req.body;

    // Validate required fields
    if (!firstName || !lastName || !email || !password || !storeName || !storeSlug || !plan) {
      return res.status(400).json({ error: 'All required fields must be filled in.' });
    }

    // Check email not already registered
    const existing = await db.getSellerByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Hash password — NEVER store plain text passwords
    const passwordHash = await bcrypt.hash(password, 12);

    // Create Stripe customer for subscription billing
    // This is YOUR Stripe account (platform) — NOT the seller's Stripe account
    const stripeCustomer = await stripe.customers.create({
      email,
      name: `${firstName} ${lastName}`,
      phone,
      metadata: { storeName, storeSlug, plan },
    });

    // Map plan name to Stripe Price ID
    // Create these Price IDs in your Stripe Dashboard → Products
    const PLAN_PRICE_IDS = {
      starter: process.env.STRIPE_PRICE_STARTER, // $79/mo
      growth:  process.env.STRIPE_PRICE_GROWTH,  // $119/mo
      pro:     process.env.STRIPE_PRICE_PRO,      // $149/mo
    };

    // Create subscription with 14-day trial
    const subscription = await stripe.subscriptions.create({
      customer:       stripeCustomer.id,
      items:          [{ price: PLAN_PRICE_IDS[plan] }],
      trial_period_days: 14,
      metadata:       { sellerId: storeSlug },
    });

    // Save seller to database
    const seller = await db.createSeller({
      firstName,
      lastName,
      email,
      passwordHash,
      phone,
      storeName,
      storeSlug,
      plan,
      stripeCustomerId:   stripeCustomer.id,
      stripeSubscriptionId: subscription.id,
    });

    // Issue JWT token
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

// LOGIN
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

    // Check subscription is still active
    const subscription = await stripe.subscriptions.retrieve(seller.stripeSubscriptionId);
    const isActive = ['active', 'trialing'].includes(subscription.status);
    if (!isActive) {
      return res.status(403).json({
        error: 'Your subscription is inactive. Please update your billing at /dashboard#billing.',
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

// GET CURRENT SELLER
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
   GET    /api/products            — buyer: get all active products for a store
   GET    /api/seller/products     — seller: get all their products
   POST   /api/seller/products     — seller: create product
   PUT    /api/seller/products/:id — seller: update product
   DELETE /api/seller/products/:id — seller: delete product
   ============================================================ */

// GET products for buyer store (public — no auth required)
app.get('/api/products', async (req, res) => {
  try {
    const { storeSlug, category, sort, search } = req.query;

    if (!storeSlug) {
      return res.status(400).json({ error: 'storeSlug is required.' });
    }

    let products = await db.getActiveProducts(storeSlug);

    // Filter by category
    if (category && category !== 'all') {
      products = products.filter(p => p.category === category);
    }

    // Search
    if (search) {
      const q = search.toLowerCase();
      products = products.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
      );
    }

    // Sort
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

// GET seller's own products (auth required)
app.get('/api/seller/products', requireAuth, async (req, res) => {
  try {
    const products = await db.getProductsBySeller(req.seller.sellerId);
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load products.' });
  }
});

// CREATE product (auth required)
app.post('/api/seller/products', requireAuth, async (req, res) => {
  try {
    const {
      name, description, category, brand,
      price, compareAtPrice, costPerItem,
      sku, quantity, weight, variants,
      status, imageUrls,
    } = req.body;

    // Validate required fields
    if (!name || !category || !price || !sku) {
      return res.status(400).json({ error: 'Name, category, price, and SKU are required.' });
    }

    // Check plan product limits
    const productCount = await db.getProductCountBySeller(req.seller.sellerId);
    const PLAN_LIMITS = { starter: 50, growth: 500, pro: Infinity };
    const limit = PLAN_LIMITS[req.seller.plan] || 50;

    if (productCount >= limit) {
      return res.status(403).json({
        error: `Your ${req.seller.plan} plan allows up to ${limit} products. Upgrade to add more.`,
        upgradeRequired: true,
      });
    }

    // Check SKU is unique for this seller
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
      costPerItem:    costPerItem ? parseFloat(costPerItem) : null,
      sku,
      quantity:       parseInt(quantity) || 0,
      weight:         weight ? parseFloat(weight) : null,
      variants:       variants || [],
      status:         status || 'active',
      imageUrls:      imageUrls || [],
    });

    res.status(201).json({ message: 'Product created!', product });
  } catch (err) {
    console.error('Create product error:', err);
    res.status(500).json({ error: 'Failed to create product.' });
  }
});

// UPDATE product
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

// DELETE product
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
   POST /api/checkout/create-payment-intent — start Stripe payment
   POST /api/checkout/confirm               — confirm order after payment
   GET  /api/orders/:id                     — get order status
   ============================================================ */

// CREATE PAYMENT INTENT
// This is called when the buyer reaches the payment step.
// Returns a clientSecret that Stripe.js uses to complete the payment in the browser.
app.post('/api/checkout/create-payment-intent', async (req, res) => {
  try {
    const { cartItems, storeSlug, customerEmail } = req.body;

    if (!cartItems || !cartItems.length) {
      return res.status(400).json({ error: 'Cart is empty.' });
    }

    // Look up the seller for this store
    const seller = await db.getSellerBySlug(storeSlug);
    if (!seller) return res.status(404).json({ error: 'Store not found.' });

    // Get fresh product prices from DB — never trust client-side prices
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

    const tax    = subtotal * 0.08; // 8% tax — adjust per state
    const total  = Math.round((subtotal + tax) * 100); // Stripe uses cents

    // Create order record in DB with status 'pending'
    const order = await db.createOrder({
      sellerId:    seller.id,
      storeSlug,
      customerEmail,
      items:       verifiedItems,
      subtotal,
      tax,
      total:       subtotal + tax,
      status:      'pending',
    });

    // Create Stripe Payment Intent
    // The seller's Stripe account receives the money
    const paymentIntent = await stripe.paymentIntents.create({
      amount:   total,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      receipt_email: customerEmail,
      metadata: {
        orderId:   order.id,
        storeSlug,
        sellerId:  seller.id,
      },
      // Stripe Connect: route payment to seller's Stripe account
      // Uncomment when seller has connected their Stripe account:
      // transfer_data: { destination: seller.stripeAccountId },
      // application_fee_amount: Math.round(total * 0.02), // platform takes 2%
    });

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

// CONFIRM ORDER after successful payment
app.post('/api/checkout/confirm', async (req, res) => {
  try {
    const { orderId, paymentIntentId, customerInfo } = req.body;

    // Verify payment actually succeeded with Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment not completed.' });
    }

    // Update order status and save customer info
    const order = await db.updateOrder(orderId, {
      status:       'processing',
      paymentIntentId,
      customerInfo,
      paidAt:       new Date(),
    });

    // Deduct inventory
    for (const item of order.items) {
      await db.decrementStock(item.productId, item.qty);
    }

    // TODO: Send confirmation email to customer
    // await sendEmail(customerInfo.email, 'order-confirmation', { order });

    // TODO: Send new order notification to seller
    // await sendEmail(order.sellerEmail, 'new-order', { order });

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

// GET ORDER STATUS (for buyer tracking)
app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    // Only return safe fields to buyer — never expose seller internals
    res.json({
      id:          order.id,
      status:      order.status,
      total:       order.total,
      items:       order.items.map(i => ({ name: i.name, qty: i.qty, price: i.price })),
      createdAt:   order.createdAt,
      estimatedDelivery: '3–5 business days',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load order.' });
  }
});

/* ============================================================
   ── SELLER ORDERS ROUTES ─────────────────────────────────────
   GET   /api/seller/orders     — seller: view all their orders
   PATCH /api/seller/orders/:id — seller: update order status
   ============================================================ */

app.get('/api/seller/orders', requireAuth, async (req, res) => {
  try {
    const { status, search, page = 1, limit = 50 } = req.query;
    let orders = await db.getOrdersBySeller(req.seller.sellerId);

    if (status && status !== 'all') {
      orders = orders.filter(o => o.status === status);
    }
    if (search) {
      const q = search.toLowerCase();
      orders = orders.filter(o =>
        o.id.toString().includes(q) ||
        o.customerInfo?.email?.toLowerCase().includes(q) ||
        o.customerInfo?.firstName?.toLowerCase().includes(q)
      );
    }

    // Simple pagination
    const start  = (page - 1) * limit;
    const paged  = orders.slice(start, start + parseInt(limit));

    res.json({ orders: paged, total: orders.length, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load orders.' });
  }
});

app.patch('/api/seller/orders/:id', requireAuth, async (req, res) => {
  try {
    const order = await db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.sellerId !== req.seller.sellerId) {
      return res.status(403).json({ error: 'You do not own this order.' });
    }

    const { status, trackingNumber, trackingCarrier } = req.body;
    const validStatuses = ['processing', 'shipped', 'delivered', 'cancelled', 'refunded'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }

    const updated = await db.updateOrder(req.params.id, { status, trackingNumber, trackingCarrier });

    // TODO: Email customer when status changes to 'shipped'
    // if (status === 'shipped') await sendShippingEmail(order, trackingNumber, trackingCarrier);

    res.json({ message: 'Order updated!', order: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update order.' });
  }
});

/* ============================================================
   ── SELLER STRIPE SETUP ROUTES ───────────────────────────────
   POST /api/seller/stripe/keys     — save seller's Stripe keys
   GET  /api/seller/stripe/keys     — get seller's Stripe config (masked)
   POST /api/seller/stripe/test     — test seller's Stripe connection
   GET  /api/seller/stripe/balance  — get Stripe balance
   ============================================================ */

// SAVE STRIPE KEYS
// The seller enters their OWN Stripe keys so they can receive customer payments
app.post('/api/seller/stripe/keys', requireAuth, async (req, res) => {
  try {
    const { publishableKey, secretKey, webhookSecret } = req.body;

    if (!publishableKey || !secretKey) {
      return res.status(400).json({ error: 'Both publishable key and secret key are required.' });
    }

    // Validate key format
    const validPK = publishableKey.startsWith('pk_test_') || publishableKey.startsWith('pk_live_');
    const validSK = secretKey.startsWith('sk_test_')     || secretKey.startsWith('sk_live_');

    if (!validPK || !validSK) {
      return res.status(400).json({ error: 'Invalid Stripe key format. Keys should start with pk_ and sk_.' });
    }

    // Test the key before saving — try a simple Stripe API call
    try {
      const testStripe = require('stripe')(secretKey);
      await testStripe.balance.retrieve();
    } catch (stripeErr) {
      return res.status(400).json({ error: 'Stripe rejected these keys. Double-check them in your Stripe dashboard.' });
    }

    // Save keys — secretKey is stored encrypted (see database.js)
    await db.saveStripeKeys(req.seller.sellerId, {
      publishableKey,
      secretKey,    // database.js encrypts this before storing
      webhookSecret,
    });

    res.json({ message: 'Stripe keys saved and verified!' });
  } catch (err) {
    console.error('Save Stripe keys error:', err);
    res.status(500).json({ error: 'Failed to save keys.' });
  }
});

// GET STRIPE CONFIG (masked — never return secret key to frontend)
app.get('/api/seller/stripe/keys', requireAuth, async (req, res) => {
  try {
    const config = await db.getStripeKeys(req.seller.sellerId);
    if (!config) return res.json({ connected: false });
    res.json({
      connected:      true,
      publishableKey: config.publishableKey,
      secretKeyMasked: config.secretKey.slice(0,8)+'••••••••••••••••'+config.secretKey.slice(-4),
      webhookConfigured: !!config.webhookSecret,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load Stripe config.' });
  }
});

// TEST STRIPE CONNECTION
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

// GET STRIPE BALANCE
app.get('/api/seller/stripe/balance', requireAuth, async (req, res) => {
  try {
    const config = await db.getStripeKeys(req.seller.sellerId);
    if (!config) return res.status(400).json({ error: 'Stripe not connected.' });

    const sellerStripe = require('stripe')(config.secretKey);
    const balance      = await sellerStripe.balance.retrieve();

    res.json({
      available: balance.available.map(b => ({
        amount:   (b.amount / 100).toFixed(2),
        currency: b.currency.toUpperCase(),
      })),
      pending: balance.pending.map(b => ({
        amount:   (b.amount / 100).toFixed(2),
        currency: b.currency.toUpperCase(),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve balance.' });
  }
});

/* ============================================================
   ── SELLER SUBSCRIPTION ROUTES ───────────────────────────────
   GET  /api/seller/subscription       — get subscription status
   POST /api/seller/subscription/upgrade — upgrade plan
   POST /api/seller/subscription/cancel  — cancel subscription
   ============================================================ */

app.get('/api/seller/subscription', requireAuth, async (req, res) => {
  try {
    const seller = await db.getSellerById(req.seller.sellerId);
    const sub    = await stripe.subscriptions.retrieve(seller.stripeSubscriptionId);

    res.json({
      status:       sub.status,
      plan:         seller.plan,
      trialEnd:     sub.trial_end    ? new Date(sub.trial_end * 1000)    : null,
      currentPeriodEnd: sub.current_period_end
        ? new Date(sub.current_period_end * 1000) : null,
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

    // Update Stripe subscription to new price
    await stripe.subscriptions.update(seller.stripeSubscriptionId, {
      items: [{ id: sub.items.data[0].id, price: PLAN_PRICE_IDS[newPlan] }],
      proration_behavior: 'create_prorations', // charges/credits difference immediately
    });

    // Update plan in DB
    await db.updateSeller(req.seller.sellerId, { plan: newPlan });

    res.json({ message: `Plan upgraded to ${newPlan}!` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to upgrade plan.' });
  }
});

app.post('/api/seller/subscription/cancel', requireAuth, async (req, res) => {
  try {
    const seller = await db.getSellerById(req.seller.sellerId);

    // Cancel at end of billing period — seller keeps access until then
    await stripe.subscriptions.update(seller.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    res.json({ message: 'Subscription will be cancelled at the end of your billing period. You keep access until then.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel subscription.' });
  }
});

/* ============================================================
   ── CUSTOMER ROUTES ──────────────────────────────────────────
   GET /api/seller/customers — seller views their customer list
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
   GET /api/seller/analytics — revenue, orders, top products
   ============================================================ */

app.get('/api/seller/analytics', requireAuth, async (req, res) => {
  try {
    const { period = '30d' } = req.query;

    const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const orders = await db.getOrdersBySeller(req.seller.sellerId, since);

    const revenue     = orders.reduce((s,o) => s + o.total, 0);
    const orderCount  = orders.length;
    const avgOrder    = orderCount ? revenue / orderCount : 0;

    // Revenue by day
    const byDay = {};
    orders.forEach(o => {
      const day = new Date(o.createdAt).toISOString().slice(0,10);
      byDay[day] = (byDay[day] || 0) + o.total;
    });

    // Top products
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
   
   This endpoint receives events from Stripe and updates
   order and subscription status automatically.
   
   IMPORTANT: Register this URL in Stripe Dashboard →
   Developers → Webhooks → Add endpoint
   ============================================================ */

app.post('/api/stripe/webhook', async (req, res) => {
  const sig    = req.headers['stripe-signature'];
  let event;

  try {
    // Verify the event came from Stripe (not a fake request)
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

      // ── PAYMENT EVENTS ──────────────────────────────────────

      case 'payment_intent.succeeded': {
        // Customer payment went through
        const pi    = event.data.object;
        const orderId = pi.metadata?.orderId;
        if (orderId) {
          await db.updateOrder(orderId, {
            status:         'processing',
            paymentIntentId: pi.id,
            paidAt:         new Date(),
          });
          // TODO: Send confirmation email to customer
          // TODO: Send new order notification to seller
          console.log(`Order ${orderId} marked as paid`);
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        // Customer's payment failed
        const pi      = event.data.object;
        const orderId = pi.metadata?.orderId;
        if (orderId) {
          await db.updateOrder(orderId, { status: 'payment_failed' });
          // TODO: Email customer to retry payment
          console.log(`Order ${orderId} payment failed`);
        }
        break;
      }

      case 'charge.refunded': {
        // Refund issued
        const charge  = event.data.object;
        const orderId = charge.metadata?.orderId;
        if (orderId) {
          await db.updateOrder(orderId, { status: 'refunded' });
          console.log(`Order ${orderId} refunded`);
        }
        break;
      }

      case 'charge.dispute.created': {
        // Customer filed a chargeback — alert seller
        const dispute = event.data.object;
        console.warn('Chargeback filed:', dispute.id, 'Amount:', dispute.amount);
        // TODO: Email seller with dispute details and instructions
        break;
      }

      // ── SUBSCRIPTION EVENTS (platform billing — seller pays you) ──

      case 'customer.subscription.updated': {
        // Seller changed or renewed their plan
        const sub = event.data.object;
        const seller = await db.getSellerByStripeCustomerId(sub.customer);
        if (seller) {
          await db.updateSeller(seller.id, {
            subscriptionStatus: sub.status,
          });
          console.log(`Seller ${seller.email} subscription updated: ${sub.status}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        // Seller's subscription ended — deactivate their store
        const sub    = event.data.object;
        const seller = await db.getSellerByStripeCustomerId(sub.customer);
        if (seller) {
          await db.updateSeller(seller.id, {
            subscriptionStatus: 'cancelled',
            storeActive:        false,
          });
          // TODO: Email seller that their store has been deactivated
          console.log(`Seller ${seller.email} subscription cancelled — store deactivated`);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        // Monthly subscription payment from a seller succeeded
        const invoice = event.data.object;
        console.log(`Subscription payment received from customer: ${invoice.customer}, amount: $${invoice.amount_paid / 100}`);
        // TODO: Send receipt email to seller
        break;
      }

      case 'invoice.payment_failed': {
        // Seller's monthly payment failed — warn them
        const invoice = event.data.object;
        const seller  = await db.getSellerByStripeCustomerId(invoice.customer);
        if (seller) {
          console.warn(`Seller ${seller.email} payment failed — subscription at risk`);
          // TODO: Email seller to update their payment method
        }
        break;
      }

      default:
        // Unhandled event type — safe to ignore
        break;
    }
  } catch (err) {
    console.error(`Error processing webhook ${event.type}:`, err);
    // Still return 200 so Stripe doesn't retry
  }

  // Always return 200 to Stripe so it knows we received the event
  res.json({ received: true });
});

/* ============================================================
   ── HEALTH CHECK ─────────────────────────────────────────────
   GET /health — Railway uses this to know the server is running
   ============================================================ */

app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    env:       process.env.NODE_ENV || 'development',
  });
});

/* ============================================================
   ── 404 HANDLER ──────────────────────────────────────────────
   ============================================================ */

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

/* ============================================================
   ── GLOBAL ERROR HANDLER ─────────────────────────────────────
   ============================================================ */

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
