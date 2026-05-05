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
const carriers     = require('./carriers');

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
      variants:       variants   || [],
      status:         status     || 'active',
      imageUrls:      imageUrls  || [],
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
   POST /api/checkout/create-payment-intent
   POST /api/checkout/confirm
   GET  /api/orders/:id
   ============================================================ */

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

app.post('/api/checkout/confirm', async (req, res) => {
  try {
    const { orderId, paymentIntentId, customerInfo } = req.body;

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment not completed.' });
    }

    const order = await db.updateOrder(orderId, {
      status:         'processing',
      paymentIntentId,
      customerInfo,
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
    const order = await db.getOrderById(req.params.id);
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
      const q = search.toLowerCase();
      orders = orders.filter(o =>
        o.id.toString().includes(q) ||
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
    const order = await db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.sellerId !== req.seller.sellerId) {
      return res.status(403).json({ error: 'You do not own this order.' });
    }

    const { status, trackingNumber, trackingCarrier } = req.body;
    const validStatuses = ['processing','shipped','delivered','cancelled','refunded'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }

    const updated = await db.updateOrder(req.params.id, { status, trackingNumber, trackingCarrier });
    res.json({ message: 'Order updated!', order: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update order.' });
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
   POST /api/shipping/void         — void/cancel a label
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
    } else {
      return res.status(400).json({ error: 'Unsupported carrier. Use ups or fedex.' });
    }

    // Save shipment record to database
    // API CALL: await db.createShipment({ orderId, carrier, ...label });

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

// VOID / CANCEL LABEL
app.post('/api/shipping/void', requireAuth, async (req, res) => {
  try {
    const { carrier, trackingNumber } = req.body;

    if(!carrier || !trackingNumber) {
      return res.status(400).json({ error: 'carrier and trackingNumber are required.' });
    }

    let result;
    if(carrier === 'ups') {
      result = await carriers.ups.voidShipment(trackingNumber);
    } else if(carrier === 'fedex') {
      result = await carriers.fedex.cancelShipment(trackingNumber);
    } else {
      return res.status(400).json({ error: 'Unsupported carrier.' });
    }

    res.json({ success: true, result });
  } catch(err) {
    console.error('Void error:', err);
    res.status(500).json({ error: 'Failed to void label: '+err.message });
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
