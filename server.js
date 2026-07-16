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
const cryptoLib    = require('./lib/crypto');
const { mergeLabels } = require('./lib/labelmerge');
const shopify      = require('./lib/shopify');
const amazon       = require('./lib/amazon');
const ebay         = require('./lib/ebay');
const etsy         = require('./lib/etsy');
const tiktok       = require('./lib/tiktok');
const walmart      = require('./lib/walmart');
const crypto       = require('crypto');
const dns          = require('dns').promises;

// ── CUSTOM DOMAINS / STOREFRONT ROUTING ───────────────────────
// Every seller gets <slug>.PLATFORM_DOMAIN for free; they can also connect
// their own domain (served once verified via a DNS TXT challenge). Custom
// domains are pointed at CUSTOM_DOMAIN_TARGET with a CNAME.
const PLATFORM_DOMAIN       = (process.env.PLATFORM_DOMAIN || 'nextlao.com').toLowerCase();
const CUSTOM_DOMAIN_TARGET  = process.env.CUSTOM_DOMAIN_TARGET || `shop.${PLATFORM_DOMAIN}`;
const RESERVED_SUBDOMAINS   = new Set(['www', 'shop', 'app', 'api', 'admin', 'mail', 'dashboard', 'static', 'assets', 'cdn',
  // NextLao product + system subdomains — never available as a seller store slug.
  'shopsell', 'audit', 'handyman', 'help', 'docs', 'blog', 'status', 'support', 'staging']);

// Resolve which store a request belongs to, from its hostname. This is the
// single mechanism behind both subdomains and bring-your-own custom domains.
async function resolveStoreByHost(rawHost) {
  if (!rawHost) return null;
  const host = String(rawHost).toLowerCase().replace(/:\d+$/, '');

  // 1) Verified custom domain (match the apex form; www.x.com → x.com).
  const apex = host.replace(/^www\./, '');
  const byDomain = await db.getSellerByCustomDomain(apex);
  if (byDomain && byDomain.customDomainVerified && byDomain.storeActive) return byDomain;

  // 2) Platform subdomain: <slug>.PLATFORM_DOMAIN
  if (host.endsWith('.' + PLATFORM_DOMAIN)) {
    const sub = host.slice(0, host.length - PLATFORM_DOMAIN.length - 1);
    if (sub && !sub.includes('.') && !RESERVED_SUBDOMAINS.has(sub)) {
      const bySlug = await db.getSellerBySlug(sub);
      if (bySlug) return bySlug;
    }
  }
  return null;
}

function normalizeDomain(input) {
  return String(input || '').toLowerCase().trim()
    .replace(/^https?:\/\//, '')   // strip protocol
    .replace(/\/.*$/, '')          // strip path
    .replace(/:\d+$/, '')          // strip port
    .replace(/^www\./, '');        // store the apex form
}
const DOMAIN_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

// Shape the seller-facing domain status + the DNS records they must add.
function domainStatus(seller) {
  return {
    slug:           seller.storeSlug,
    previewUrl:     `https://${seller.storeSlug}.${PLATFORM_DOMAIN}`,
    platformDomain: PLATFORM_DOMAIN,
    customDomain:   seller.customDomain || null,
    verified:       !!seller.customDomainVerified,
    dns: seller.customDomain ? {
      cname: { host: 'www', type: 'CNAME', value: CUSTOM_DOMAIN_TARGET },
      txt:   { host: `_nextlao-verify.${seller.customDomain}`, type: 'TXT', value: seller.customDomainToken || '' },
    } : null,
  };
}

// Fail loud at startup if secrets can't be encrypted — we never want to
// silently store carrier/Stripe credentials in plaintext.
if (!cryptoLib.isConfigured()) {
  console.warn('⚠ ENCRYPTION_KEY is not set or invalid. Credential routes will reject saves until it is configured (64 hex chars).');
}

// ── CARRIER CREDENTIALS (per-seller BYOA) ─────────────────────
const CARRIER_FIELDS = {
  ups:   ['clientId', 'clientSecret', 'accountNumber'],
  fedex: ['apiKey', 'secretKey', 'accountNumber'],
  usps:  ['apiKey'],
};

function maskAccount(acct) {
  if (!acct) return null;
  const s = String(acct);
  return s.length <= 4 ? '••' + s.slice(-2) : '••••' + s.slice(-4);
}

// Load + decrypt a seller's stored credentials for a carrier.
async function loadSellerCarrierCreds(sellerId, carrier) {
  const row = await db.getCarrierAccount(sellerId, carrier);
  if (!row) return null;
  try {
    const secrets = cryptoLib.decrypt(row.credentials);
    return { ...secrets, accountNumber: row.accountNumber || secrets.accountNumber };
  } catch (e) {
    console.error(`Failed to decrypt ${carrier} creds for seller ${sellerId}:`, e.message);
    return null;
  }
}

function carrierNotConnected(res, carrier, verb = 'shipping') {
  return res.status(400).json({
    error: `Connect your ${String(carrier).toUpperCase()} account in Settings before ${verb}.`,
    carrierSetupRequired: true,
    carrier,
  });
}

// Load + decrypt a seller's stored credentials for a sales channel, merged
// with the non-secret shop domain. Returns null if not connected.
async function loadChannelCreds(sellerId, channel) {
  const row = await db.getChannelConnection(sellerId, channel);
  if (!row) return null;
  let secrets;
  try {
    secrets = cryptoLib.decrypt(row.credentials);
  } catch (e) {
    console.error(`Failed to decrypt ${channel} creds for seller ${sellerId}:`, e.message);
    return null;
  }
  const creds = { ...secrets, shopDomain: row.shopDomain || secrets.shopDomain };
  // Shopify offline tokens now expire; renew before use (and persist the roll).
  if (channel === 'shopify') return ensureFreshShopifyToken(sellerId, creds);
  // eBay user tokens expire in ~2h; renew before use.
  if (channel === 'ebay') return ensureFreshEbayToken(sellerId, creds);
  // Etsy access tokens expire in ~1h; renew before use (+ attach the keystring).
  if (channel === 'etsy') return ensureFreshEtsyToken(sellerId, creds);
  // TikTok tokens expire; renew before use (+ attach app_key/app_secret for signing).
  if (channel === 'tiktok') return ensureFreshTikTokToken(sellerId, creds);
  return creds;
}

// Build the encrypted-at-rest Shopify creds blob from a token response,
// stamping absolute expiry timestamps so we can tell when to refresh.
function shopifyCredsFromToken(tok, shopDomain) {
  const now = Date.now();
  return {
    shopDomain,
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken || null,
    accessTokenExpiresAt:  tok.expiresIn ? now + tok.expiresIn * 1000 : null,
    refreshTokenExpiresAt: tok.refreshTokenExpiresIn ? now + tok.refreshTokenExpiresIn * 1000 : null,
  };
}

// Return Shopify creds with a valid access token. Expiring offline tokens are
// short-lived, so refresh (rotating the refresh token) shortly before expiry
// and persist the new pair. Returns the creds unchanged when there's nothing
// to refresh (legacy non-expiring token), or null when refresh fails and the
// seller must reconnect (refresh token expired).
async function ensureFreshShopifyToken(sellerId, creds) {
  const SKEW_MS = 2 * 60 * 1000; // renew ~2 min before expiry
  if (!creds.refreshToken || !creds.accessTokenExpiresAt) return creds;     // legacy/non-expiring
  if (Date.now() < creds.accessTokenExpiresAt - SKEW_MS) return creds;      // still valid
  const cfg = shopifyAppConfig();
  if (!cfg.configured) return creds;
  try {
    const tok = await shopify.refreshOfflineToken(creds.shopDomain, {
      apiKey: cfg.apiKey, apiSecret: cfg.apiSecret, refreshToken: creds.refreshToken,
    });
    const fresh = shopifyCredsFromToken(tok, creds.shopDomain);
    await db.saveChannelConnection(sellerId, 'shopify', {
      shopDomain: creds.shopDomain, credentials: cryptoLib.encrypt(fresh), status: 'verified',
    });
    return fresh;
  } catch (e) {
    console.error(`Shopify token refresh failed for seller ${sellerId}:`, e.message);
    return null; // refresh token likely expired → seller must reconnect
  }
}

// Build the encrypted-at-rest eBay creds blob, stamping absolute expiry
// timestamps. eBay refresh tokens don't rotate, so we preserve the existing
// refresh token + its expiry across access-token renewals.
function ebayCredsFromToken(tok, prev = {}) {
  const now = Date.now();
  return {
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken || prev.refreshToken || null,
    accessTokenExpiresAt:  tok.expiresIn ? now + tok.expiresIn * 1000 : null,
    refreshTokenExpiresAt: tok.refreshTokenExpiresIn ? now + tok.refreshTokenExpiresIn * 1000 : (prev.refreshTokenExpiresAt || null),
    username: prev.username || null,
  };
}

// Return eBay creds with a valid access token, refreshing shortly before expiry
// and persisting the new access token. Returns creds unchanged when nothing to
// refresh, or null when the refresh token has lapsed (seller must reconnect).
async function ensureFreshEbayToken(sellerId, creds) {
  const SKEW_MS = 2 * 60 * 1000; // renew ~2 min before expiry
  if (!creds.refreshToken || !creds.accessTokenExpiresAt) return creds;
  if (Date.now() < creds.accessTokenExpiresAt - SKEW_MS) return creds;
  const cfg = ebayAppConfig();
  if (!cfg.configured) return creds;
  try {
    const tok = await ebay.refreshUserToken({
      clientId: cfg.apiKey, clientSecret: cfg.apiSecret, refreshToken: creds.refreshToken, scopes: EBAY_SCOPES,
    });
    const fresh = ebayCredsFromToken(tok, creds);
    await db.saveChannelConnection(sellerId, 'ebay', {
      shopDomain: creds.shopDomain, credentials: cryptoLib.encrypt(fresh), status: 'verified',
    });
    return { ...fresh, shopDomain: creds.shopDomain };
  } catch (e) {
    console.error(`eBay token refresh failed for seller ${sellerId}:`, e.message);
    return null; // refresh token likely expired → seller must reconnect
  }
}

// Build the encrypted-at-rest Etsy creds blob. Etsy tokens are short-lived
// (~1h); we stamp the access-token expiry and keep the resolved shop id/name.
function etsyCredsFromToken(tok, prev = {}) {
  const now = Date.now();
  return {
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken || prev.refreshToken || null,
    accessTokenExpiresAt: tok.expiresIn ? now + tok.expiresIn * 1000 : null,
    shopId: prev.shopId || null,
    shopName: prev.shopName || null,
  };
}

// Return Etsy creds with a valid access token and the app keystring attached
// (every Etsy request needs the keystring as the x-api-key header). Refresh
// shortly before expiry and persist; null when the refresh token has lapsed.
async function ensureFreshEtsyToken(sellerId, creds) {
  const SKEW_MS = 2 * 60 * 1000;
  const cfg = etsyAppConfig();
  const withKey = (c) => ({ ...c, keystring: cfg.keystring });
  if (!creds.refreshToken || !creds.accessTokenExpiresAt) return withKey(creds);
  if (Date.now() < creds.accessTokenExpiresAt - SKEW_MS) return withKey(creds);
  if (!cfg.configured) return withKey(creds);
  try {
    const tok = await etsy.refreshAccessToken({ keystring: cfg.keystring, refreshToken: creds.refreshToken });
    const fresh = etsyCredsFromToken(tok, creds);
    await db.saveChannelConnection(sellerId, 'etsy', {
      shopDomain: creds.shopDomain, credentials: cryptoLib.encrypt(fresh), status: 'verified',
    });
    return withKey({ ...fresh, shopDomain: creds.shopDomain });
  } catch (e) {
    console.error(`Etsy token refresh failed for seller ${sellerId}:`, e.message);
    return null; // refresh token likely expired → seller must reconnect
  }
}

// Build the encrypted-at-rest TikTok creds blob. Keeps the resolved shop cipher
// and stamps absolute token expiries.
function tiktokCredsFromToken(tok, prev = {}) {
  return {
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken || prev.refreshToken || null,
    accessTokenExpiresAt: tok.accessTokenExpiresAt || null,
    refreshTokenExpiresAt: tok.refreshTokenExpiresAt || prev.refreshTokenExpiresAt || null,
    shopId: prev.shopId || null,
    shopCipher: prev.shopCipher || null,
    shopName: prev.shopName || null,
  };
}

// Return TikTok creds with a valid access token and the app_key/app_secret
// attached (every signed request needs them). Refresh shortly before expiry and
// persist; null when the refresh token has lapsed (seller must reconnect).
async function ensureFreshTikTokToken(sellerId, creds) {
  const SKEW_MS = 5 * 60 * 1000; // TikTok is strict on skew; renew early
  const cfg = tiktokAppConfig();
  const withKey = (c) => ({ ...c, appKey: cfg.appKey, appSecret: cfg.appSecret });
  if (!creds.refreshToken || !creds.accessTokenExpiresAt) return withKey(creds);
  if (Date.now() < creds.accessTokenExpiresAt - SKEW_MS) return withKey(creds);
  if (!cfg.configured) return withKey(creds);
  try {
    const tok = await tiktok.refreshToken({ appKey: cfg.appKey, appSecret: cfg.appSecret, refreshToken: creds.refreshToken });
    const fresh = tiktokCredsFromToken(tok, creds);
    await db.saveChannelConnection(sellerId, 'tiktok', {
      shopDomain: creds.shopDomain, credentials: cryptoLib.encrypt(fresh), status: 'verified',
    });
    return withKey({ ...fresh, shopDomain: creds.shopDomain });
  } catch (e) {
    console.error(`TikTok token refresh failed for seller ${sellerId}:`, e.message);
    return null; // refresh token likely expired → seller must reconnect
  }
}

const CARRIER_DISPLAY = { ups: 'UPS', fedex: 'FedEx', usps: 'USPS' };

// Push tracking back to the source channel as a fulfillment. Best-effort: a
// channel failure must never break a label purchase. No-op for non-channel
// orders or when the channel isn't connected.
async function pushChannelFulfillment(sellerId, order, { trackingNumber, carrier }) {
  if (!order || !order.externalId || !trackingNumber) return { skipped: 'not a channel order' };
  const channel = order.channel;
  if (!['shopify', 'amazon', 'ebay', 'etsy', 'tiktok', 'walmart'].includes(channel)) return { skipped: `channel ${channel}` };
  try {
    const creds = await loadChannelCreds(sellerId, channel);
    if (!creds) return { ok: false, channel, error: 'channel not connected (reconnect needed)' };
    const carrierName = CARRIER_DISPLAY[carrier] || carrier;
    if (channel === 'shopify') {
      await shopify.createFulfillment(creds, order.externalId, { trackingNumber, carrierName });
    } else if (channel === 'ebay') {
      await ebay.createFulfillment(creds, order, { trackingNumber, carrierName });
    } else if (channel === 'etsy') {
      await etsy.createFulfillment(creds, order, { trackingNumber, carrierName });
    } else if (channel === 'tiktok') {
      await tiktok.createFulfillment(creds, order, { trackingNumber, carrierName });
    } else if (channel === 'walmart') {
      await walmart.createFulfillment(creds, order, { trackingNumber, carrierName });
    } else {
      await amazon.confirmShipment(creds, order, { trackingNumber, carrierName });
    }
    console.log(`${channel} fulfillment pushed for order ${order.id} (${trackingNumber}).`);
    return { ok: true, channel };
  } catch (e) {
    console.error(`${channel} fulfillment push failed for order ${order.id}:`, e.message);
    return { ok: false, channel, error: e.message };
  }
}

// Upsert one mapped channel order (dedupe by external id). Shared by manual
// sync and the webhook receiver. Returns 'imported' | 'skipped'.
async function importChannelOrder(sellerId, channel, mapped) {
  const existing = await db.getOrderByExternalId(sellerId, channel, mapped.externalId);
  if (existing) return 'skipped';
  await db.createOrder({
    sellerId, channel,
    externalId:          mapped.externalId,
    externalOrderNumber: mapped.externalOrderNumber,
    customerEmail:       mapped.customerEmail,
    customerInfo:        mapped.customerInfo,
    items:               mapped.items,
    subtotal:            mapped.subtotal,
    tax:                 mapped.tax,
    total:               mapped.total,
    status:              'processing', // already paid on the channel → ready to ship
  });
  return 'imported';
}

// Public HTTPS webhook callback for a seller's channel. Requires ALLOWED_ORIGIN
// (the deployed https origin) — returns null if it isn't set, so callers skip
// registration and fall back to manual sync.
function channelWebhookUrl(sellerId) {
  const base = (process.env.ALLOWED_ORIGIN || '').replace(/\/$/, '');
  if (!/^https:\/\//.test(base)) return null;
  return `${base}/api/webhooks/shopify/${sellerId}`;
}

// Shopify public-app OAuth config (your one set of app creds, server-side).
const SHOPIFY_SCOPES = 'read_orders,write_merchant_managed_fulfillment_orders';
function shopifyAppConfig() {
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  const base = (process.env.ALLOWED_ORIGIN || '').replace(/\/$/, '');
  const redirectUri = /^https:\/\//.test(base) ? `${base}/api/channels/shopify/callback` : null;
  return { apiKey, apiSecret, redirectUri, configured: !!(apiKey && apiSecret && redirectUri) };
}

// eBay OAuth config (your one app: App ID / Cert ID / RuName, server-side).
// The callback URL <ALLOWED_ORIGIN>/api/channels/ebay/callback must be
// registered against the RuName in the eBay developer portal.
const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
].join(' ');
function ebayAppConfig() {
  const apiKey = process.env.EBAY_API_KEY;       // App ID (client_id)
  const apiSecret = process.env.EBAY_API_SECRET; // Cert ID (client_secret)
  const ruName = process.env.EBAY_RU_NAME;       // redirect_uri value in OAuth
  const base = (process.env.ALLOWED_ORIGIN || '').replace(/\/$/, '');
  const callbackUrl = /^https:\/\//.test(base) ? `${base}/api/channels/ebay/callback` : null;
  return { apiKey, apiSecret, ruName, callbackUrl, configured: !!(apiKey && apiSecret && ruName) };
}

// Etsy OpenAPI v3 OAuth config (PKCE public client — the keystring is the
// client_id AND the x-api-key header; no client secret). Register the callback
// <ALLOWED_ORIGIN>/api/channels/etsy/callback in the Etsy app settings.
const ETSY_SCOPES = 'transactions_r transactions_w';
function etsyAppConfig() {
  const keystring = process.env.ETSY_KEYSTRING; // API key (client_id + x-api-key)
  const base = (process.env.ALLOWED_ORIGIN || '').replace(/\/$/, '');
  const redirectUri = /^https:\/\//.test(base) ? `${base}/api/channels/etsy/callback` : null;
  return { keystring, redirectUri, configured: !!(keystring && redirectUri) };
}

// TikTok Shop Open API config (your one app: app_key + app_secret, server-side).
// Register the callback <ALLOWED_ORIGIN>/api/channels/tiktok/callback as the
// app's redirect URL in the TikTok Shop Partner Center.
function tiktokAppConfig() {
  const appKey = process.env.TIKTOK_APP_KEY;
  const appSecret = process.env.TIKTOK_APP_SECRET;
  const base = (process.env.ALLOWED_ORIGIN || '').replace(/\/$/, '');
  const callbackUrl = /^https:\/\//.test(base) ? `${base}/api/channels/tiktok/callback` : null;
  return { appKey, appSecret, callbackUrl, configured: !!(appKey && appSecret) };
}

// eBay Marketplace Account Deletion notification config. The endpoint URL used
// in the challenge hash must exactly match what's registered in the eBay portal
// (paste this endpoint there verbatim). Token: 32–80 chars [A-Za-z0-9_-].
function ebayDeletionConfig() {
  const verificationToken = process.env.EBAY_VERIFICATION_TOKEN || '';
  const base = (process.env.ALLOWED_ORIGIN || '').replace(/\/$/, '');
  const endpoint = /^https:\/\//.test(base) ? `${base}/api/webhooks/ebay/account-deletion` : null;
  return { verificationToken, endpoint, configured: !!(verificationToken && endpoint) };
}

// ── STRIPE KEYS (encrypted at rest) ──────────────────────────
async function persistStripeKeys(sellerId, { publishableKey, secretKey, webhookSecret }) {
  await db.saveStripeKeys(sellerId, {
    publishableKey,
    secretKey:     cryptoLib.encrypt(secretKey),
    webhookSecret: webhookSecret ? cryptoLib.encrypt(webhookSecret) : null,
  });
}

async function loadStripeKeys(sellerId) {
  const config = await db.getStripeKeys(sellerId);
  if (!config) return null;
  const dec = (v) => {
    if (!v) return v;
    try { return cryptoLib.decrypt(v); } catch { return v; } // legacy plaintext
  };
  return { ...config, secretKey: dec(config.secretKey), webhookSecret: dec(config.webhookSecret) };
}

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

// IMPORTANT: stripe + shopify webhooks need the raw body for HMAC verification —
// must come BEFORE express.json().
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use('/api/webhooks/shopify', express.raw({ type: 'application/json' }));

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

// Root: a seller host (custom domain or <slug>.PLATFORM_DOMAIN) serves that
// seller's storefront; the platform domain (apex / reserved subdomain like
// shopsell.nextlao.com / the Railway app host) serves the ShopSell marketing site.
app.get('/', async (req, res) => {
  try {
    // Explicit ?store=<slug> serves the storefront on ANY host — used by the
    // dashboard "View store" preview and works before a seller's subdomain /
    // custom domain is set up. The storefront JS reads the slug from ?store=.
    if (req.query.store) return res.sendFile(path.join(__dirname, 'index.html'));
    const seller = await resolveStoreByHost(req.hostname);
    if (seller) return res.sendFile(path.join(__dirname, 'index.html'));
    // No seller: the bare platform apex (nextlao.com / www.nextlao.com) shows the
    // NextLao umbrella; everything else (shopsell.nextlao.com, the Railway app
    // host, other reserved subdomains) shows the ShopSell marketing site.
    const host = String(req.hostname || '').toLowerCase().replace(/^www\./, '');
    if (host === PLATFORM_DOMAIN) return res.sendFile(path.join(__dirname, 'nextlao.html'));
    return res.sendFile(path.join(__dirname, 'landing.html'));
  } catch (e) {
    return res.sendFile(path.join(__dirname, 'landing.html'));
  }
});

// Serve seller signup page
app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'signup.html'));
});

// Serve seller login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'reset-password.html'));
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

// Serve the platform privacy policy (public; used as the privacy-policy URL for
// sales-channel app registrations, e.g. the eBay RuName).
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'privacy.html'));
});

// Public seller guide / user manual — a shareable link (noindex; for beta
// testers and onboarding, not meant to be a Google-indexed marketing page).
app.get('/guide', (req, res) => {
  res.sendFile(path.join(__dirname, 'guide.html'));
});

// robots.txt — let crawlers index public pages, keep the app/API out of search.
// Served per-host so the Sitemap line matches whatever domain is being crawled.
app.get('/robots.txt', (req, res) => {
  const base = `https://${req.hostname}`;
  res.type('text/plain').send(
`User-agent: *
Disallow: /api/
Disallow: /dashboard
Disallow: /shipping
Disallow: /login
Disallow: /signup
Disallow: /reset-password

Sitemap: ${base}/sitemap.xml
`);
});

// sitemap.xml — the public pages for this host. (Per-store product URLs are a
// future enhancement; this gets the brand/marketing pages discoverable now.)
app.get('/sitemap.xml', (req, res) => {
  const base = `https://${req.hostname}`;
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${base}/`,        priority: '1.0' },
    { loc: `${base}/privacy`, priority: '0.3' },
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>${u.priority}</priority></url>`).join('\n') +
    `\n</urlset>\n`;
  res.type('application/xml').send(xml);
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
    // Reject buyer tokens — they share the same JWT_SECRET but must not
    // satisfy seller-only routes. Existing seller tokens have no `type` claim
    // (legacy), so only reject when type is explicitly 'buyer'.
    if (decoded.type === 'buyer') {
      return res.status(401).json({ error: 'Seller account required.' });
    }
    req.seller = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

function requireBuyerAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Please sign in to continue.' });
  }
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'buyer' || !decoded.buyerId) {
      return res.status(401).json({ error: 'Buyer account required.' });
    }
    req.buyer = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
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

    const pwErr = passwordPolicyError(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

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

    // Report subscription status but DON'T block login on it — a seller must be
    // able to log in to fix their billing (blocking login there is a deadlock).
    // Feature-gating by subscription belongs inside the app, not at the door.
    let subscriptionStatus = 'none';
    let subscriptionActive = false;
    try {
      if (seller.stripeSubscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(seller.stripeSubscriptionId);
        subscriptionStatus = subscription.status;
        subscriptionActive = ['active', 'trialing'].includes(subscription.status);
      }
    } catch (e) {
      console.warn(`Subscription lookup failed for seller ${seller.id} at login:`, e.message);
    }

    const token = jwt.sign(
      { sellerId: seller.id, email: seller.email, plan: seller.plan },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      subscriptionStatus,
      subscriptionActive,
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

// Request a password-reset link. Always responds generically so it never
// reveals whether an email has an account.
app.post('/api/auth/forgot-password', async (req, res) => {
  const generic = { message: 'If an account exists for that email, a reset link is on its way.' };
  try {
    const email = String(req.body.email || '').trim();
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const seller = await db.getSellerByEmail(email);
    if (seller) {
      // Store only a HASH of the token; email the raw token in the link.
      const rawToken  = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expires   = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await db.updateSeller(seller.id, { resetToken: tokenHash, resetTokenExpires: expires });

      const base = (process.env.ALLOWED_ORIGIN || '').replace(/\/$/, '');
      const resetUrl = `${base}/reset-password?token=${rawToken}`;
      const result = await emailService.sendPasswordReset({
        toEmail: seller.email, firstName: seller.firstName, resetUrl,
      });
      // Bootstrap fallback: if email isn't configured, log the link so the
      // operator can retrieve it from the server logs.
      if (result.skipped) console.log(`[password-reset] email not sent (Resend unconfigured). Link for ${seller.email}: ${resetUrl}`);
    }
    res.json(generic);
  } catch (err) {
    console.error('Forgot-password error:', err);
    res.json(generic); // still generic on failure
  }
});

// Complete a reset with the token + a new password.
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and new password are required.' });
    const pwErr = passwordPolicyError(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const seller = await db.getSellerByResetToken(tokenHash);
    if (!seller) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });

    const passwordHash = await bcrypt.hash(password, 10);
    await db.updateSeller(seller.id, { passwordHash, resetToken: null, resetTokenExpires: null });
    res.json({ message: 'Password updated. You can now log in.' });
  } catch (err) {
    console.error('Reset-password error:', err);
    res.status(500).json({ error: 'Could not reset password. Please try again.' });
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
      phone:     seller.phone,
      storeName: seller.storeName,
      storeSlug: seller.storeSlug,
      plan:      seller.plan,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load account.' });
  }
});

// Update the seller's own store profile (name, contact email, phone, store
// name). The store slug is immutable here — it drives storefront URLs, custom
// domains, and Stripe/channel metadata, so it stays read-only.
app.put('/api/seller/settings', requireAuth, async (req, res) => {
  try {
    const { firstName, lastName, email, phone, storeName } = req.body || {};

    const fields = {};
    if (firstName !== undefined) {
      if (!String(firstName).trim()) return res.status(400).json({ error: 'First name cannot be empty.' });
      fields.firstName = String(firstName).trim();
    }
    if (lastName !== undefined) {
      if (!String(lastName).trim()) return res.status(400).json({ error: 'Last name cannot be empty.' });
      fields.lastName = String(lastName).trim();
    }
    if (storeName !== undefined) {
      if (!String(storeName).trim()) return res.status(400).json({ error: 'Store name cannot be empty.' });
      fields.storeName = String(storeName).trim();
    }
    if (phone !== undefined) {
      fields.phone = String(phone).trim() || null;
    }
    if (email !== undefined) {
      const e = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
        return res.status(400).json({ error: 'Enter a valid email address.' });
      }
      // Email is UNIQUE — reject if another seller already uses it.
      const existing = await db.getSellerByEmail(e);
      if (existing && existing.id !== req.seller.sellerId) {
        return res.status(409).json({ error: 'That email is already in use by another account.' });
      }
      fields.email = e;
    }

    if (!Object.keys(fields).length) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const updated = await db.updateSeller(req.seller.sellerId, fields);
    res.json({
      message:   'Settings saved!',
      firstName: updated.firstName,
      lastName:  updated.lastName,
      email:     updated.email,
      phone:     updated.phone,
      storeName: updated.storeName,
      storeSlug: updated.storeSlug,
    });
  } catch (err) {
    console.error('Update settings error:', err);
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

/* ============================================================
   ── BUYER AUTH ROUTES ────────────────────────────────────────
   POST /api/buyer/signup   — create buyer account (auto-links past orders)
   POST /api/buyer/login    — buyer login
   GET  /api/buyer/me       — current buyer info
   GET  /api/buyer/orders   — buyer's order history (across all stores)
   ============================================================ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Password policy (shared by seller signup/reset and buyer register): 8+ chars
// with at least one uppercase, one lowercase, one number, and one special char.
// Returns a human-readable error naming what's missing, or null if it passes.
// Function declaration so it hoists and is callable from routes defined above.
function passwordPolicyError(pw) {
  const s = String(pw == null ? '' : pw);
  const missing = [];
  if (s.length < 8)          missing.push('at least 8 characters');
  if (!/[A-Z]/.test(s))      missing.push('an uppercase letter');
  if (!/[a-z]/.test(s))      missing.push('a lowercase letter');
  if (!/[0-9]/.test(s))      missing.push('a number');
  if (!/[^A-Za-z0-9]/.test(s)) missing.push('a special character');
  return missing.length ? `Password needs ${missing.join(', ')}.` : null;
}

app.post('/api/buyer/signup', async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body || {};
    const normEmail = (email || '').trim().toLowerCase();
    if (!normEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    if (!EMAIL_RE.test(normEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const pwErr = passwordPolicyError(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const existing = await db.getBuyerByEmail(normEmail);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const buyer = await db.createBuyer({
      email:      normEmail,
      passwordHash,
      firstName:  (firstName || '').trim() || null,
      lastName:   (lastName  || '').trim() || null,
    });

    // Retroactively link any prior guest orders made with this email.
    const linkedCount = await db.linkOrdersByEmail(buyer.id, normEmail);

    const token = jwt.sign(
      { buyerId: buyer.id, email: buyer.email, type: 'buyer' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      message: linkedCount > 0
        ? `Welcome! We found ${linkedCount} past order${linkedCount === 1 ? '' : 's'} and added them to your account.`
        : 'Account created!',
      token,
      buyer: {
        id:        buyer.id,
        email:     buyer.email,
        firstName: buyer.firstName,
        lastName:  buyer.lastName,
      },
      linkedOrders: linkedCount,
    });
  } catch (err) {
    console.error('Buyer signup error:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

app.post('/api/buyer/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normEmail = (email || '').trim().toLowerCase();
    if (!normEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const buyer = await db.getBuyerByEmail(normEmail);
    if (!buyer) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const ok = await bcrypt.compare(password, buyer.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = jwt.sign(
      { buyerId: buyer.id, email: buyer.email, type: 'buyer' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      buyer: {
        id:        buyer.id,
        email:     buyer.email,
        firstName: buyer.firstName,
        lastName:  buyer.lastName,
      },
    });
  } catch (err) {
    console.error('Buyer login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.get('/api/buyer/me', requireBuyerAuth, async (req, res) => {
  try {
    const buyer = await db.getBuyerById(req.buyer.buyerId);
    if (!buyer) return res.status(404).json({ error: 'Buyer not found.' });
    res.json({
      id:        buyer.id,
      email:     buyer.email,
      firstName: buyer.firstName,
      lastName:  buyer.lastName,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load account.' });
  }
});

app.get('/api/buyer/orders', requireBuyerAuth, async (req, res) => {
  try {
    const orders = await db.getOrdersByBuyer(req.buyer.buyerId);
    res.json({ orders });
  } catch (err) {
    console.error('Buyer orders error:', err);
    res.status(500).json({ error: 'Failed to load orders.' });
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

// Resolve the store for the current hostname (custom domain or subdomain).
// The storefront calls this when there's no ?store= slug in the URL.
app.get('/api/store/resolve', async (req, res) => {
  try {
    const seller = await resolveStoreByHost(req.hostname);
    if (!seller) return res.status(404).json({ error: 'No store is set up for this address.' });
    res.json({ slug: seller.storeSlug, storeName: seller.storeName });
  } catch (err) {
    console.error('Store resolve error:', err);
    res.status(500).json({ error: 'Failed to resolve store.' });
  }
});

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

/* ============================================================
   ── PRODUCT REVIEWS ──────────────────────────────────────────
   GET  /api/products/:id/reviews    — public: summary + list
   POST /api/products/:id/reviews    — buyer: add/update own review
   ============================================================ */

app.get('/api/products/:id/reviews', async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!Number.isInteger(productId)) return res.status(400).json({ error: 'Invalid product.' });
    const [summary, reviews] = await Promise.all([
      db.getReviewSummary(productId),
      db.getReviewsByProduct(productId),
    ]);
    // Only expose safe fields — never buyer id/email.
    res.json({
      summary,
      reviews: reviews.map(r => ({
        id: r.id, author: r.authorName, rating: r.rating,
        title: r.title, body: r.body, verified: r.verified, createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    console.error('Get reviews error:', err);
    res.status(500).json({ error: 'Failed to load reviews.' });
  }
});

app.post('/api/products/:id/reviews', requireBuyerAuth, async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!Number.isInteger(productId)) return res.status(400).json({ error: 'Invalid product.' });

    const product = await db.getProductById(productId);
    if (!product) return res.status(404).json({ error: 'Product not found.' });

    const rating = parseInt(req.body.rating, 10);
    if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Please give a rating from 1 to 5 stars.' });
    const title = String(req.body.title || '').trim().slice(0, 120);
    const body  = String(req.body.body  || '').trim().slice(0, 2000);

    // Display name = first name + last initial (privacy-friendly).
    const buyer = await db.getBuyerById(req.buyer.buyerId);
    const authorName = buyer
      ? `${buyer.firstName || 'Buyer'}${buyer.lastName ? ' ' + buyer.lastName[0] + '.' : ''}`
      : 'Buyer';

    const verified = await db.buyerHasPurchased(req.buyer.buyerId, req.buyer.email, productId);

    const review = await db.upsertReview({
      productId, sellerId: product.sellerId, buyerId: req.buyer.buyerId,
      authorName, rating, title, body, verified,
    });
    await db.recomputeProductRating(productId);

    res.status(201).json({
      message: 'Thanks for your review!',
      review: { id: review.id, author: review.authorName, rating: review.rating,
                title: review.title, body: review.body, verified: review.verified, createdAt: review.createdAt },
    });
  } catch (err) {
    console.error('Post review error:', err);
    res.status(500).json({ error: 'Failed to submit review.' });
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

function slugifyOpt(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Normalize product options + variants from client input into a trusted shape.
// Returns { options, variants } — each variant gets a stable id + title. A
// product with no valid options is "simple" (empty options/variants).
function normalizeVariants(rawOptions, rawVariants) {
  const options = [];
  if (Array.isArray(rawOptions)) {
    for (const o of rawOptions.slice(0, 3)) {            // cap at 3 option types
      const name = String(o && o.name || '').trim();
      const values = Array.isArray(o && o.values)
        ? [...new Set(o.values.map(v => String(v).trim()).filter(Boolean))].slice(0, 50)
        : [];
      if (name && values.length) options.push({ name, values });
    }
  }
  if (!options.length) return { options: [], variants: [] };

  const variants = [];
  const seen = new Set();
  if (Array.isArray(rawVariants)) {
    for (const v of rawVariants) {
      const optMap = {};
      let ok = true;
      for (const opt of options) {
        const val = v && v.options ? String(v.options[opt.name] == null ? '' : v.options[opt.name]).trim() : '';
        if (!val || !opt.values.includes(val)) { ok = false; break; }
        optMap[opt.name] = val;
      }
      if (!ok) continue;
      const title = options.map(o => optMap[o.name]).join(' / ');
      let id = slugifyOpt(options.map(o => optMap[o.name]).join('-')) || ('v' + variants.length);
      while (seen.has(id)) id += '-x';
      seen.add(id);
      variants.push({
        id,
        options:  optMap,
        title,
        price:    Math.max(0, Number(v.price) || 0),
        sku:      String(v.sku || '').trim(),
        quantity: Math.max(0, parseInt(v.quantity, 10) || 0),
      });
    }
  }
  return { options, variants };
}

app.post('/api/seller/products', requireAuth, async (req, res) => {
  try {
    const {
      name, description, category, brand,
      price, compareAtPrice, costPerItem,
      sku, quantity, weight,
      length, width, height,
      status, imageUrls,
      returnable, returnWindowDays, restockingFeePct,
    } = req.body;

    const { options, variants } = normalizeVariants(req.body.options, req.body.variants);

    if (!name || !category || !sku) {
      return res.status(400).json({ error: 'Name, category, and SKU are required.' });
    }
    if (!variants.length && !(parseFloat(price) > 0)) {
      return res.status(400).json({ error: 'Price is required for a product without variants.' });
    }

    // With variants, the product-level price/quantity are derived from them
    // (price shown = lowest variant; quantity = sum of variant stock).
    const effPrice = variants.length ? Math.min(...variants.map(v => v.price)) : parseFloat(price);
    const effQty   = variants.length ? variants.reduce((s, v) => s + v.quantity, 0) : (parseInt(quantity) || 0);

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
      price:          effPrice,
      compareAtPrice: compareAtPrice ? parseFloat(compareAtPrice) : null,
      costPerItem:    costPerItem    ? parseFloat(costPerItem)    : null,
      sku,
      quantity:       effQty,
      weight:         weight ? parseFloat(weight) : null,
      length:         length ? parseFloat(length) : null,
      width:          width  ? parseFloat(width)  : null,
      height:         height ? parseFloat(height) : null,
      options:          options,
      variants:         variants,
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
    const body = { ...req.body };
    // Dimensions are optional NUMERICs — coerce '' / undefined to null so the
    // UPDATE doesn't try to cast an empty string.
    for (const dim of ['length', 'width', 'height']) {
      if (dim in body) body[dim] = (body[dim] === '' || body[dim] == null) ? null : Number(body[dim]);
    }
    // When options/variants are being edited, normalize them and re-derive the
    // product-level price/quantity from the variants.
    if (body.options !== undefined || body.variants !== undefined) {
      const { options, variants } = normalizeVariants(body.options, body.variants);
      body.options = options;
      body.variants = variants;
      if (variants.length) {
        body.price = Math.min(...variants.map(v => v.price));
        body.quantity = variants.reduce((s, v) => s + v.quantity, 0);
      }
    }
    const updated = await db.updateProduct(req.params.id, body);
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

    // Buyer checkout runs on the SELLER's own Stripe account — return THEIR
    // publishable key so the storefront confirms against the right account.
    const stripeConfig = await loadStripeKeys(seller.id);

    const content = (await db.getSellerStorefrontContent(seller.id)) || {};
    // contactEmail falls back to the seller's account email so the Contact link
    // always works even before the seller customizes it.
    const storefrontContent = {
      about:        content.about        || '',
      faq:          content.faq          || '',
      privacy:      content.privacy      || '',
      terms:        content.terms        || '',
      contactEmail: content.contactEmail || seller.email || '',
    };

    res.json({
      publishableKey:  stripeConfig?.publishableKey || '',
      paymentsEnabled: !!(stripeConfig && stripeConfig.publishableKey && stripeConfig.secretKey),
      storeName:       seller.storeName,
      storeSlug:       seller.storeSlug,
      storefrontContent,
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

    // Buyer payments settle into the SELLER's own connected Stripe account —
    // never the platform's. If the seller hasn't connected Stripe, they can't
    // take payments yet.
    const stripeConfig = await loadStripeKeys(seller.id);
    if (!stripeConfig || !stripeConfig.secretKey) {
      return res.status(400).json({ error: 'This store isn’t accepting payments yet.', paymentSetupRequired: true });
    }
    const sellerStripe = require('stripe')(stripeConfig.secretKey);

    let subtotal = 0;
    const verifiedItems = [];
    for (const item of cartItems) {
      const product = await db.getProductById(item.productId);
      if (!product || product.sellerId !== seller.id) {
        return res.status(400).json({ error: `Product not found: ${item.productId}` });
      }

      // Resolve the chosen variant (if this product has any) so price and stock
      // come from the variant, not the product-level aggregate.
      let unitPrice    = Number(product.price);
      let available    = Number(product.quantity);
      let variantId    = null;
      let variantTitle = null;
      const variants = Array.isArray(product.variants) ? product.variants : [];
      if (variants.length) {
        const v = variants.find(x => String(x.id) === String(item.variantId));
        if (!v) return res.status(400).json({ error: `Please choose an option for "${product.name}".` });
        unitPrice    = Number(v.price);
        available    = Number(v.quantity);
        variantId    = v.id;
        variantTitle = v.title;
      }

      if (available < item.qty) {
        return res.status(400).json({ error: `"${product.name}${variantTitle ? ' — ' + variantTitle : ''}" is out of stock.` });
      }
      subtotal += unitPrice * item.qty;
      verifiedItems.push({
        productId: item.productId,
        qty:       item.qty,
        price:     unitPrice,
        name:      product.name,
        variantId,
        variantTitle,
      });
    }

    // Tax is destination-based, so it can't be known until the buyer enters a
    // ship-to address. The PaymentIntent is created at subtotal here and its
    // amount is finalized by /api/checkout/calculate-tax (Stripe Tax) before
    // the buyer confirms payment.
    const total = Math.round(subtotal * 100);

    const order = await db.createOrder({
      sellerId:      seller.id,
      storeSlug,
      customerEmail,
      items:         verifiedItems,
      subtotal,
      tax:           0,
      total:         subtotal,
      status:        'pending',
    });

    // receipt_email must be a valid address or omitted entirely — Stripe
    // 400s on empty strings. The buyer often hasn't typed it yet when the
    // PaymentElement mounts, so the email is captured on /confirm.
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

    const paymentIntent = await sellerStripe.paymentIntents.create(piPayload);

    // Persist the PI id now so calculate-tax can update its amount before confirm.
    await db.updateOrder(order.id, { paymentIntentId: paymentIntent.id });

    res.json({
      clientSecret:   paymentIntent.client_secret,
      publishableKey: stripeConfig.publishableKey, // storefront confirms against the seller's account
      orderId:        order.id,
      subtotal:       subtotal.toFixed(2),
      tax:            '0.00',
      total:          (total / 100).toFixed(2),
    });

  } catch (err) {
    console.error('Payment intent error:', err);
    res.status(500).json({ error: 'Failed to initialize payment.' });
  }
});

// Validate a discount code against an in-progress order and store it on the
// order. The storefront then re-runs calculate-tax so tax + total reflect the
// discount. Sending an empty code clears any applied discount.
app.post('/api/checkout/apply-discount', async (req, res) => {
  try {
    const { orderId, code } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId is required.' });

    const order = await db.getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.status !== 'pending') {
      return res.status(400).json({ error: 'This order can no longer be modified.' });
    }

    const raw = String(code || '').trim();
    if (!raw) {
      await db.updateOrder(orderId, { discountCode: null, discountAmount: 0 });
      return res.json({ applied: false, discountAmount: '0.00' });
    }

    const d = await db.getDiscountByCode(order.sellerId, raw);
    if (!d || !d.active) return res.status(404).json({ error: 'That code isn’t valid.' });
    if (d.expiresAt && new Date(d.expiresAt) < new Date()) {
      return res.status(400).json({ error: 'That code has expired.' });
    }
    if (d.maxUses != null && d.usedCount >= d.maxUses) {
      return res.status(400).json({ error: 'That code has reached its usage limit.' });
    }

    const subtotal = Number(order.subtotal) || 0;
    const minSub   = Number(d.minSubtotal) || 0;
    if (subtotal < minSub) {
      return res.status(400).json({ error: `Spend at least $${minSub.toFixed(2)} to use this code.` });
    }

    let discount = d.type === 'fixed' ? Number(d.value) : subtotal * (Number(d.value) / 100);
    discount = Math.min(subtotal, Math.round(discount * 100) / 100); // cap at subtotal, round to cents

    await db.updateOrder(orderId, { discountCode: d.code, discountAmount: discount });

    res.json({
      applied:        true,
      code:           d.code,
      type:           d.type,
      value:          Number(d.value),
      discountAmount: discount.toFixed(2),
    });
  } catch (err) {
    console.error('Apply discount error:', err);
    res.status(500).json({ error: 'Failed to apply discount.' });
  }
});

// Finalize sales tax for an in-progress order using Stripe Tax on the SELLER's
// account, then bump the PaymentIntent amount to match. Called from checkout
// once the buyer has entered a ship-to address, and again just before confirm.
// If the seller hasn't set up Stripe Tax, we fall back to $0 tax (never a made-
// up rate) and flag it, so checkout still works.
app.post('/api/checkout/calculate-tax', async (req, res) => {
  try {
    const { orderId, address } = req.body;
    if (!orderId || !address) {
      return res.status(400).json({ error: 'orderId and address are required.' });
    }

    const order = await db.getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.status !== 'pending') {
      return res.status(400).json({ error: 'This order can no longer be modified.' });
    }

    const stripeConfig = await loadStripeKeys(order.sellerId);
    if (!stripeConfig || !stripeConfig.secretKey) {
      return res.status(400).json({ error: 'Store payment configuration is missing.' });
    }
    const sellerStripe = require('stripe')(stripeConfig.secretKey);

    const subtotal    = Number(order.subtotal) || 0;
    const discount    = Number(order.discountAmount) || 0;
    const discounted  = Math.max(0, subtotal - discount);   // taxable goods total
    const discountedC = Math.round(discounted * 100);
    // Spread the discount across line items so Stripe Tax is computed on the
    // amount the buyer actually pays for goods.
    const factor      = subtotal > 0 ? discounted / subtotal : 1;
    const items       = Array.isArray(order.items) ? order.items : [];

    // Attempt a real Stripe Tax calculation. Any failure (Stripe Tax not
    // enabled, no origin address / registrations, unsupported region) falls
    // through to zero tax rather than blocking the sale.
    let taxC = 0, totalC = discountedC, calculationId = null, taxApplied = false, reason = null;
    try {
      const calc = await sellerStripe.tax.calculations.create({
        currency: 'usd',
        line_items: items.map((it, idx) => ({
          amount:       Math.max(0, Math.round((Number(it.price) || 0) * (Number(it.qty) || 0) * 100 * factor)),
          reference:    String(it.productId || it.name || ('item-' + idx)),
          tax_behavior: 'exclusive',
        })),
        customer_details: {
          address: {
            line1:       address.address1 || address.line1 || '',
            city:        address.city || '',
            state:       address.state || '',
            postal_code: address.zip || address.postal_code || '',
            country:     address.country || 'US',
          },
          address_source: 'shipping',
        },
      });
      taxC          = calc.tax_amount_exclusive;
      totalC        = discountedC + taxC;   // goods (after discount) + tax
      calculationId = calc.id;
      taxApplied    = true;
    } catch (taxErr) {
      reason = taxErr.message;
      console.warn(`Stripe Tax unavailable for seller ${order.sellerId}; charging $0 tax. Reason: ${taxErr.message}`);
    }

    // Keep the PaymentIntent amount in sync with the taxed total.
    if (order.paymentIntentId) {
      try {
        await sellerStripe.paymentIntents.update(order.paymentIntentId, { amount: totalC });
      } catch (piErr) {
        console.error('Failed to update PaymentIntent amount for tax:', piErr.message);
        return res.status(500).json({ error: 'Could not update payment total.' });
      }
    }

    await db.updateOrder(orderId, {
      tax:              taxC / 100,
      total:            totalC / 100,
      taxCalculationId: calculationId || undefined,
    });

    res.json({
      subtotal:   subtotal.toFixed(2),
      discount:   discount.toFixed(2),
      tax:        (taxC / 100).toFixed(2),
      total:      (totalC / 100).toFixed(2),
      taxApplied,
      reason,
    });
  } catch (err) {
    console.error('Calculate tax error:', err);
    res.status(500).json({ error: 'Failed to calculate tax.' });
  }
});

app.post('/api/checkout/confirm', async (req, res) => {
  try {
    const { orderId, paymentIntentId, customerInfo } = req.body;

    // The payment lives in the seller's own Stripe account, so we must verify
    // it with the seller's key — the platform key can't see it.
    const existingOrder = await db.getOrderById(orderId);
    if (!existingOrder) return res.status(404).json({ error: 'Order not found.' });

    const stripeConfig = await loadStripeKeys(existingOrder.sellerId);
    if (!stripeConfig || !stripeConfig.secretKey) {
      return res.status(400).json({ error: 'Store payment configuration is missing.' });
    }
    const sellerStripe = require('stripe')(stripeConfig.secretKey);

    const paymentIntent = await sellerStripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment not completed.' });
    }
    if (String(paymentIntent.metadata?.orderId) !== String(orderId)) {
      return res.status(400).json({ error: 'Payment does not match this order.' });
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

    // If this email matches an existing buyer account, link the order to it —
    // even for guest checkouts. Covers the case where a buyer has an account
    // but checked out without logging in.
    if (realEmail) {
      const buyer = await db.getBuyerByEmail(realEmail.toLowerCase());
      if (buyer) await db.linkOrdersByEmail(buyer.id, realEmail);
    }

    for (const item of order.items) {
      if (item.variantId) await db.decrementVariantStock(item.productId, item.variantId, item.qty);
      else                await db.decrementStock(item.productId, item.qty);
    }

    // Record the Stripe Tax transaction (for the seller's tax reporting) from
    // the calculation made at checkout. Best-effort; never blocks confirmation.
    if (order.taxCalculationId) {
      sellerStripe.tax.transactions.createFromCalculation({
        calculation: order.taxCalculationId,
        reference:   `SS-${order.id}`,
      }).catch(txErr => console.error('Tax transaction record failed:', txErr.message));
    }

    // Count the discount-code redemption now that the order is paid. Best-effort.
    if (order.discountCode) {
      db.incrementDiscountUse(order.sellerId, order.discountCode)
        .catch(e => console.error('Discount usage increment failed:', e.message));
    }

    // Roll this order up into the seller's customer records — but only on the
    // first confirm (existingOrder was still 'pending') so a retried confirm
    // can't double-count. Best-effort.
    if (existingOrder.status === 'pending') {
      const ci = order.customerInfo || {};
      db.upsertCustomerFromOrder({
        sellerId:  order.sellerId,
        email:     realEmail || order.customerEmail,
        firstName: ci.firstName,
        lastName:  ci.lastName,
        phone:     ci.phone,
        amount:    order.total,
      }).catch(e => console.error('Customer upsert failed:', e.message));
    }

    // Fire confirmation emails without blocking the response — a mail failure
    // must never break a paid checkout. No-op if RESEND_API_KEY is unset.
    (async () => {
      try {
        const seller = await db.getSellerById(order.sellerId);
        const storeName = seller?.storeName || 'ShopSell';
        const ship = order.customerInfo || {};
        const buyerName = [ship.firstName, ship.lastName].filter(Boolean).join(' ') || null;

        if (realEmail) {
          await emailService.sendOrderConfirmationToBuyer({
            toEmail:         realEmail,
            orderNumber:     `SS-${order.id}`,
            storeName,
            items:           order.items,
            subtotal:        order.subtotal,
            discount:        order.discountAmount,
            tax:             order.tax,
            total:           order.total,
            shippingAddress: ship,
          });
        }
        if (seller?.email) {
          await emailService.sendNewOrderToSeller({
            toEmail:     seller.email,
            orderNumber: `SS-${order.id}`,
            storeName,
            buyerName,
            buyerEmail:  realEmail,
            items:       order.items,
            total:       order.total,
          });
        }
      } catch (e) {
        console.error('Order confirmation email failed:', e.message);
      }
    })();

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

    const wasShipped = order.status === 'shipped';
    const updated = await db.updateOrder(orderId, { status, trackingNumber, trackingCarrier });

    // Notify the buyer only on the transition INTO "shipped" — not on every
    // re-save of an already-shipped order. Non-blocking; no-op without RESEND.
    if (updated.status === 'shipped' && !wasShipped) {
      const toEmail = updated.customerEmail || updated.customerInfo?.email || null;
      if (toEmail) {
        (async () => {
          try {
            const seller = await db.getSellerById(order.sellerId);
            await emailService.sendShippingNotificationToBuyer({
              toEmail,
              orderNumber:     `SS-${updated.id}`,
              storeName:       seller?.storeName || 'ShopSell',
              carrier:         updated.trackingCarrier,
              trackingNumber:  updated.trackingNumber,
              items:           updated.items,
              shippingAddress: updated.customerInfo || {},
            });
          } catch (e) {
            console.error('Shipping notification email failed:', e.message);
          }
        })();
      }
    }

    res.json({ message: 'Order updated!', order: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update order.' });
  }
});

// Issue a full refund for an order on the SELLER's own Stripe account, then
// mark it refunded. (Stripe also fires charge.refunded to the seller webhook,
// which sets the same status — idempotent.)
app.post('/api/seller/orders/:id/refund', requireAuth, async (req, res) => {
  try {
    const orderId = normalizeOrderId(req.params.id);
    if (orderId === null) return res.status(404).json({ error: 'Order not found.' });
    const order = await db.getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.sellerId !== req.seller.sellerId) {
      return res.status(403).json({ error: 'You do not own this order.' });
    }
    if (order.status === 'refunded') {
      return res.status(400).json({ error: 'This order has already been refunded.' });
    }
    if (!order.paymentIntentId) {
      return res.status(400).json({ error: 'This order has no captured payment to refund.' });
    }
    if (!['processing', 'shipped', 'delivered'].includes(order.status)) {
      return res.status(400).json({ error: 'This order can’t be refunded in its current state.' });
    }

    const stripeConfig = await loadStripeKeys(order.sellerId);
    if (!stripeConfig || !stripeConfig.secretKey) {
      return res.status(400).json({ error: 'Store payment configuration is missing.' });
    }
    const sellerStripe = require('stripe')(stripeConfig.secretKey);

    try {
      await sellerStripe.refunds.create({ payment_intent: order.paymentIntentId });
    } catch (refErr) {
      console.error('Stripe refund error:', refErr.message);
      return res.status(400).json({ error: 'Stripe could not process the refund: ' + refErr.message });
    }

    const updated = await db.updateOrder(orderId, { status: 'refunded' });
    res.json({ message: 'Refund issued.', order: updated });
  } catch (err) {
    console.error('Refund error:', err);
    res.status(500).json({ error: 'Failed to issue refund.' });
  }
});

// PACKING SLIP PDF — 8.5x11 printable slip for the warehouse
// Gather the data a packing slip needs for one order (SKUs live on products).
async function loadPackingSlipData(order) {
  const seller = await db.getSellerById(order.sellerId);
  const items = Array.isArray(order.items) ? order.items : [];
  const products = await Promise.all(
    items.map(it => it.productId ? db.getProductById(it.productId).catch(() => null) : null)
  );
  // Prefer the product SKU; fall back to the item's own SKU (imported orders).
  const skuByIdx = products.map((p, i) => p?.sku || items[i]?.sku || '');
  return { seller, items, skuByIdx };
}

// Draw one packing slip onto the current page of an open pdfkit doc. Does NOT
// add pages or end the doc — the caller manages that (so batch slips can add a
// page between orders). Assumes the cursor is at the top of a fresh page.
function drawPackingSlipPage(doc, { order, seller, items, skuByIdx }) {
  const ship = order.customerInfo || {};
  const fullName = [ship.firstName, ship.lastName].filter(Boolean).join(' ')
    || ship.name || order.customerEmail || '';

  // ── Header ─────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#000').text(seller?.storeName || 'ShopSell', { continued: false });
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

  const totalQty = items.reduce((s, it) => s + (parseInt(it.qty || it.quantity) || 0), 0);
  doc.font('Helvetica-Bold').fontSize(11)
     .text(`Total items: ${totalQty}`, 54, y + 12, { width: 504, align: 'right' });

  // ── Footer ─────────────────────────────────────────────────
  doc.font('Helvetica').fontSize(10).fillColor('#888')
     .text('Thank you for your order!', 54, 720, { width: 504, align: 'center' });
}

app.get('/api/seller/orders/:id/packing-slip.pdf', requireAuth, async (req, res) => {
  try {
    const orderId = normalizeOrderId(req.params.id);
    if (orderId === null) return res.status(404).json({ error: 'Order not found.' });
    const order = await db.getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.sellerId !== req.seller.sellerId) {
      return res.status(403).json({ error: 'You do not own this order.' });
    }

    const { seller, items, skuByIdx } = await loadPackingSlipData(order);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="packing-slip-SS-${order.id}.pdf"`);

    const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
    doc.pipe(res);
    drawPackingSlipPage(doc, { order, seller, items, skuByIdx });
    doc.end();

  } catch (err) {
    console.error('Packing slip error:', err);
    if (res.headersSent) return res.end();
    res.status(500).json({ error: 'Failed to generate packing slip.' });
  }
});

// BATCH PACKING SLIPS — one PDF, a slip per order (tenant-scoped).
app.post('/api/seller/packing-slips.pdf', requireAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.orderIds) ? req.body.orderIds : null;
    if (!ids || !ids.length) return res.status(400).json({ error: 'orderIds (non-empty array) is required.' });

    // Load + ownership-filter first so we can 404 cleanly before streaming.
    const orders = [];
    for (const raw of ids) {
      const oid = normalizeOrderId(raw);
      if (oid === null) continue;
      const order = await db.getOrderById(oid);
      if (order && order.sellerId === req.seller.sellerId) orders.push(order);
    }
    if (!orders.length) return res.status(404).json({ error: 'No matching orders found.' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="packing-slips-${orders.length}.pdf"`);
    const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
    doc.pipe(res);
    for (let i = 0; i < orders.length; i++) {
      if (i > 0) doc.addPage();
      const { seller, items, skuByIdx } = await loadPackingSlipData(orders[i]);
      drawPackingSlipPage(doc, { order: orders[i], seller, items, skuByIdx });
    }
    doc.end();
  } catch (err) {
    console.error('Batch packing slips error:', err);
    if (res.headersSent) return res.end();
    res.status(500).json({ error: 'Failed to generate packing slips.' });
  }
});

// PICK LIST — aggregate every line item across the selected orders into one
// SKU/name → total-qty sheet for warehouse picking.
app.post('/api/seller/pick-list.pdf', requireAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.orderIds) ? req.body.orderIds : null;
    if (!ids || !ids.length) return res.status(400).json({ error: 'orderIds (non-empty array) is required.' });

    const orders = [];
    for (const raw of ids) {
      const oid = normalizeOrderId(raw);
      if (oid === null) continue;
      const order = await db.getOrderById(oid);
      if (order && order.sellerId === req.seller.sellerId) orders.push(order);
    }
    if (!orders.length) return res.status(404).json({ error: 'No matching orders found.' });

    // Aggregate by product (fall back to name when there's no productId).
    const agg = new Map();
    for (const order of orders) {
      const items = Array.isArray(order.items) ? order.items : [];
      for (const it of items) {
        const key = it.productId != null ? `p:${it.productId}` : `n:${it.sku || it.name || 'Item'}`;
        const qty = parseInt(it.qty || it.quantity) || 0;
        if (!agg.has(key)) agg.set(key, { productId: it.productId ?? null, name: it.name || 'Item', qty: 0, sku: it.sku || '' });
        agg.get(key).qty += qty;
      }
    }
    // Resolve SKUs once per distinct product.
    await Promise.all([...agg.values()].map(async row => {
      if (row.productId != null) {
        const p = await db.getProductById(row.productId).catch(() => null);
        if (p) row.sku = p.sku || '';
      }
    }));
    const rows = [...agg.values()].sort((a, b) => (a.sku || a.name).localeCompare(b.sku || b.name));
    const seller = await db.getSellerById(req.seller.sellerId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="pick-list-${orders.length}-orders.pdf"`);
    const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
    doc.pipe(res);

    doc.font('Helvetica-Bold').fontSize(20).text(seller?.storeName || 'ShopSell');
    doc.moveUp();
    doc.font('Helvetica-Bold').fontSize(16).text('PICK LIST', { align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor('#555')
       .text(`${orders.length} order${orders.length === 1 ? '' : 's'}`, { align: 'right' });
    doc.fillColor('#000').moveDown(2);

    const tableTop = doc.y;
    const col = { pick: 54, item: 96, sku: 400, qty: 500 };
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#888');
    doc.text('✓', col.pick, tableTop);
    doc.text('ITEM', col.item, tableTop);
    doc.text('SKU', col.sku, tableTop);
    doc.text('QTY', col.qty, tableTop, { width: 50, align: 'right' });
    doc.fillColor('#000');
    doc.moveTo(54, tableTop + 14).lineTo(558, tableTop + 14).strokeColor('#ccc').stroke();

    let y = tableTop + 22;
    doc.font('Helvetica').fontSize(11);
    let totalUnits = 0;
    for (const row of rows) {
      if (y > 700) { doc.addPage(); y = 54; }
      doc.rect(col.pick, y - 1, 12, 12).strokeColor('#999').stroke(); // pick checkbox
      const nameHeight = doc.heightOfString(row.name, { width: 290 });
      doc.fillColor('#000').text(row.name, col.item, y, { width: 290 });
      doc.text(row.sku || '—', col.sku, y);
      doc.font('Helvetica-Bold').text(String(row.qty), col.qty, y, { width: 50, align: 'right' });
      doc.font('Helvetica');
      totalUnits += row.qty;
      y += Math.max(nameHeight, 16) + 8;
    }
    doc.moveTo(54, y).lineTo(558, y).strokeColor('#ccc').stroke();
    doc.font('Helvetica-Bold').fontSize(11)
       .text(`${rows.length} SKUs · ${totalUnits} units to pick`, 54, y + 12, { width: 504, align: 'right' });

    doc.end();
  } catch (err) {
    console.error('Pick list error:', err);
    if (res.headersSent) return res.end();
    res.status(500).json({ error: 'Failed to generate pick list.' });
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

    if (!cryptoLib.isConfigured()) {
      return res.status(500).json({ error: 'Server is missing ENCRYPTION_KEY — cannot store keys securely. Contact the administrator.' });
    }

    try {
      const testStripe = require('stripe')(secretKey);
      await testStripe.balance.retrieve();
    } catch (stripeErr) {
      return res.status(400).json({ error: 'Stripe rejected these keys. Double-check them in your Stripe dashboard.' });
    }

    await persistStripeKeys(req.seller.sellerId, { publishableKey, secretKey, webhookSecret });
    res.json({ message: 'Stripe keys saved and verified!' });
  } catch (err) {
    console.error('Save Stripe keys error:', err);
    res.status(500).json({ error: 'Failed to save keys.' });
  }
});

app.get('/api/seller/stripe/keys', requireAuth, async (req, res) => {
  try {
    const config = await loadStripeKeys(req.seller.sellerId);
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
    const config = await loadStripeKeys(req.seller.sellerId);
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
    const config = await loadStripeKeys(req.seller.sellerId);
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
   ── SELLER CARRIER ACCOUNT ROUTES (bring-your-own-account) ────
   GET    /api/seller/carriers            — connection status per carrier
   POST   /api/seller/carriers/:carrier   — save + verify credentials
   POST   /api/seller/carriers/:carrier/test — re-test saved credentials
   DELETE /api/seller/carriers/:carrier   — disconnect a carrier
   Secrets are encrypted at rest and never returned to the client.
   ============================================================ */

app.get('/api/seller/carriers', requireAuth, async (req, res) => {
  try {
    const rows = await db.getCarrierAccounts(req.seller.sellerId);
    const out = { ups: { connected: false }, fedex: { connected: false }, usps: { connected: false } };
    for (const r of rows) {
      if (!out[r.carrier]) continue;
      out[r.carrier] = {
        connected: true,
        status: r.status,
        accountNumberMasked: maskAccount(r.accountNumber),
        updatedAt: r.updatedAt,
      };
    }
    res.json(out);
  } catch (err) {
    console.error('Get carriers error:', err);
    res.status(500).json({ error: 'Failed to load carrier accounts.' });
  }
});

app.post('/api/seller/carriers/:carrier', requireAuth, async (req, res) => {
  try {
    const carrier = (req.params.carrier || '').toLowerCase();
    const fields  = CARRIER_FIELDS[carrier];
    if (!fields) {
      return res.status(400).json({ error: 'Unsupported carrier. Use ups, fedex, or usps.' });
    }
    if (!cryptoLib.isConfigured()) {
      return res.status(500).json({ error: 'Server is missing ENCRYPTION_KEY — cannot store credentials securely. Contact the administrator.' });
    }

    const missing = fields.filter(f => !req.body[f] || !String(req.body[f]).trim());
    if (missing.length) {
      return res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}.` });
    }

    let accountNumber = null;
    let secrets = {};
    if (carrier === 'ups') {
      accountNumber = String(req.body.accountNumber).trim();
      secrets = { clientId: String(req.body.clientId).trim(), clientSecret: String(req.body.clientSecret).trim() };
    } else if (carrier === 'fedex') {
      accountNumber = String(req.body.accountNumber).trim();
      secrets = { apiKey: String(req.body.apiKey).trim(), secretKey: String(req.body.secretKey).trim() };
    } else { // usps (Shippo)
      secrets = { apiKey: String(req.body.apiKey).trim() };
    }

    const credentials = cryptoLib.encrypt(secrets);
    await db.saveCarrierAccount(req.seller.sellerId, carrier, { accountNumber, credentials, status: 'unverified' });

    const test   = await carriers.testCarrierCreds(carrier, { ...secrets, accountNumber });
    const status = test.ok ? 'verified' : 'invalid';
    await db.setCarrierAccountStatus(req.seller.sellerId, carrier, status);

    res.json({
      connected: true,
      status,
      verified: test.ok,
      accountNumberMasked: maskAccount(accountNumber),
      ...(test.ok ? {} : { warning: `Saved, but the carrier rejected these credentials: ${test.error}` }),
    });
  } catch (err) {
    console.error('Save carrier creds error:', err);
    res.status(500).json({ error: 'Failed to save carrier credentials: ' + err.message });
  }
});

app.post('/api/seller/carriers/:carrier/test', requireAuth, async (req, res) => {
  try {
    const carrier = (req.params.carrier || '').toLowerCase();
    if (!CARRIER_FIELDS[carrier]) {
      return res.status(400).json({ error: 'Unsupported carrier.' });
    }
    const creds = await loadSellerCarrierCreds(req.seller.sellerId, carrier);
    if (!creds) {
      return res.status(400).json({ error: 'No credentials saved for this carrier yet.' });
    }
    const test   = await carriers.testCarrierCreds(carrier, creds);
    const status = test.ok ? 'verified' : 'invalid';
    await db.setCarrierAccountStatus(req.seller.sellerId, carrier, status);
    res.json({ success: test.ok, status, ...(test.ok ? {} : { error: test.error }) });
  } catch (err) {
    console.error('Test carrier creds error:', err);
    res.status(500).json({ error: 'Failed to test carrier credentials: ' + err.message });
  }
});

app.delete('/api/seller/carriers/:carrier', requireAuth, async (req, res) => {
  try {
    const carrier = (req.params.carrier || '').toLowerCase();
    if (!CARRIER_FIELDS[carrier]) {
      return res.status(400).json({ error: 'Unsupported carrier.' });
    }
    await db.deleteCarrierAccount(req.seller.sellerId, carrier);
    res.json({ message: `${carrier.toUpperCase()} disconnected.` });
  } catch (err) {
    console.error('Delete carrier error:', err);
    res.status(500).json({ error: 'Failed to disconnect carrier.' });
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
   ── SELLER STOREFRONT CONTENT ────────────────────────────────
   GET /api/seller/storefront-content
   PUT /api/seller/storefront-content
   Powers the footer pages on the buyer storefront (About / FAQ /
   Privacy / Terms / contact email). Stored as JSONB so new fields
   can be added without a migration.
   ============================================================ */

app.get('/api/seller/storefront-content', requireAuth, async (req, res) => {
  try {
    const content = (await db.getSellerStorefrontContent(req.seller.sellerId)) || {};
    res.json({
      content: {
        about:        content.about        || '',
        faq:          content.faq          || '',
        privacy:      content.privacy      || '',
        terms:        content.terms        || '',
        contactEmail: content.contactEmail || '',
      },
    });
  } catch (err) {
    console.error('Get storefront content error:', err);
    res.status(500).json({ error: 'Failed to load storefront content.' });
  }
});

app.put('/api/seller/storefront-content', requireAuth, async (req, res) => {
  try {
    const { about, faq, privacy, terms, contactEmail } = req.body || {};
    const trim = (v) => (typeof v === 'string' ? v.trim() : '');
    const email = trim(contactEmail);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Contact email is not a valid email address.' });
    }
    const content = {
      about:        trim(about),
      faq:          trim(faq),
      privacy:      trim(privacy),
      terms:        trim(terms),
      contactEmail: email,
    };
    await db.setSellerStorefrontContent(req.seller.sellerId, content);
    res.json({ message: 'Storefront content saved.', content });
  } catch (err) {
    console.error('Save storefront content error:', err);
    res.status(500).json({ error: 'Failed to save storefront content.' });
  }
});

/* ============================================================
   ── CUSTOM DOMAIN ROUTES (SELLER) ────────────────────────────
   GET/PUT/DELETE /api/seller/domain · POST /api/seller/domain/verify
   ============================================================ */

app.get('/api/seller/domain', requireAuth, async (req, res) => {
  try {
    const seller = await db.getSellerById(req.seller.sellerId);
    res.json(domainStatus(seller));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load domain settings.' });
  }
});

app.put('/api/seller/domain', requireAuth, async (req, res) => {
  const domain = normalizeDomain(req.body.domain);
  if (!domain || !DOMAIN_RE.test(domain)) {
    return res.status(400).json({ error: 'Enter a valid domain, like yourstore.com.' });
  }
  if (domain === PLATFORM_DOMAIN || domain.endsWith('.' + PLATFORM_DOMAIN)) {
    return res.status(400).json({ error: `Connect your own domain — not a ${PLATFORM_DOMAIN} address.` });
  }
  try {
    const token  = 'nextlao-verify-' + crypto.randomBytes(16).toString('hex');
    const seller = await db.setSellerCustomDomain(req.seller.sellerId, domain, token);
    res.json(domainStatus(seller));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That domain is already connected to another store.' });
    console.error('Set custom domain error:', err);
    res.status(500).json({ error: 'Failed to save domain.' });
  }
});

app.post('/api/seller/domain/verify', requireAuth, async (req, res) => {
  try {
    const seller = await db.getSellerById(req.seller.sellerId);
    if (!seller.customDomain) return res.status(400).json({ error: 'Add a domain first.' });

    // Ownership check: a TXT record at _nextlao-verify.<domain> holding our token.
    let records = [];
    try {
      records = (await dns.resolveTxt('_nextlao-verify.' + seller.customDomain)).flat().map(s => String(s).trim());
    } catch (dnsErr) {
      return res.status(400).json({ verified: false, error: 'Couldn’t find the verification record yet. Add the TXT record, then try again in a few minutes.' });
    }
    if (!records.includes(seller.customDomainToken)) {
      return res.status(400).json({ verified: false, error: 'The verification record doesn’t match yet. DNS can take a few minutes to propagate — try again shortly.' });
    }

    const updated = await db.setCustomDomainVerified(req.seller.sellerId, true);
    res.json({ verified: true, message: 'Domain verified!', ...domainStatus(updated) });
  } catch (err) {
    console.error('Verify domain error:', err);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

app.delete('/api/seller/domain', requireAuth, async (req, res) => {
  try {
    await db.clearSellerCustomDomain(req.seller.sellerId);
    res.json({ message: 'Custom domain removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove domain.' });
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
   ── DISCOUNT CODE ROUTES (SELLER) ────────────────────────────
   GET/POST/PUT/DELETE /api/seller/discounts
   ============================================================ */

// Normalize + validate a discount payload. Returns { data } or { error }.
function validateDiscountInput(body) {
  const code = String(body.code || '').trim().toUpperCase();
  if (!code) return { error: 'Code is required.' };
  if (!/^[A-Z0-9_-]{2,40}$/.test(code)) {
    return { error: 'Code must be 2–40 letters, numbers, dashes or underscores.' };
  }
  const type  = body.type === 'fixed' ? 'fixed' : 'percentage';
  const value = Number(body.value);
  if (!Number.isFinite(value) || value <= 0) return { error: 'Value must be a positive number.' };
  if (type === 'percentage' && value > 100) return { error: 'A percentage discount can’t exceed 100%.' };

  let minSubtotal = 0;
  if (body.minSubtotal != null && body.minSubtotal !== '') {
    minSubtotal = Number(body.minSubtotal);
    if (!Number.isFinite(minSubtotal) || minSubtotal < 0) return { error: 'Minimum subtotal must be 0 or more.' };
  }
  let maxUses = null;
  if (body.maxUses != null && body.maxUses !== '') {
    maxUses = parseInt(body.maxUses, 10);
    if (!Number.isInteger(maxUses) || maxUses < 1) return { error: 'Usage limit must be a positive whole number.' };
  }
  let expiresAt = null;
  if (body.expiresAt) {
    const d = new Date(body.expiresAt);
    if (isNaN(d.getTime())) return { error: 'Expiry date is invalid.' };
    expiresAt = d;
  }
  const active = body.active !== false && body.active !== 'false';
  return { data: { code, type, value, minSubtotal, maxUses, expiresAt, active } };
}

app.get('/api/seller/discounts', requireAuth, async (req, res) => {
  try {
    const discounts = await db.getDiscountsBySeller(req.seller.sellerId);
    res.json({ discounts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load discounts.' });
  }
});

app.post('/api/seller/discounts', requireAuth, async (req, res) => {
  const v = validateDiscountInput(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const discount = await db.createDiscount(req.seller.sellerId, v.data);
    res.status(201).json({ discount });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'You already have a code with that name.' });
    console.error('Create discount error:', err);
    res.status(500).json({ error: 'Failed to create discount.' });
  }
});

app.put('/api/seller/discounts/:id', requireAuth, async (req, res) => {
  try {
    const existing = await db.getDiscountById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Discount not found.' });
    if (existing.sellerId !== req.seller.sellerId) {
      return res.status(403).json({ error: 'You do not own this discount.' });
    }
    const v = validateDiscountInput(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const discount = await db.updateDiscount(existing.id, v.data);
    res.json({ discount });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'You already have a code with that name.' });
    res.status(500).json({ error: 'Failed to update discount.' });
  }
});

app.delete('/api/seller/discounts/:id', requireAuth, async (req, res) => {
  try {
    const existing = await db.getDiscountById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Discount not found.' });
    if (existing.sellerId !== req.seller.sellerId) {
      return res.status(403).json({ error: 'You do not own this discount.' });
    }
    await db.deleteDiscount(existing.id);
    res.json({ message: 'Discount deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete discount.' });
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

    // Count only paid orders as revenue — not pending (unpaid) or cancelled.
    // NUMERIC columns come back as strings, so coerce with Number() throughout.
    const PAID = ['processing', 'shipped', 'delivered'];
    const orders = (await db.getOrdersBySeller(req.seller.sellerId, since))
      .filter(o => PAID.includes(o.status));

    const revenue    = orders.reduce((s, o) => s + Number(o.total || 0), 0);
    const orderCount = orders.length;
    const avgOrder   = orderCount ? revenue / orderCount : 0;
    const customers  = new Set(orders.map(o => (o.customerEmail || '').toLowerCase()).filter(Boolean)).size;

    // Revenue by product category (for the donut) — map productId → category.
    const catByProduct = {};
    (await db.getProductsBySeller(req.seller.sellerId)).forEach(pr => { catByProduct[pr.id] = pr.category || 'other'; });
    const byCategory = {};
    orders.forEach(o => (o.items || []).forEach(item => {
      const cat = catByProduct[item.productId] || 'other';
      byCategory[cat] = (byCategory[cat] || 0) + (Number(item.price) || 0) * (Number(item.qty) || 0);
    }));

    const byDay = {};
    orders.forEach(o => {
      const day = new Date(o.createdAt).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] || 0) + Number(o.total || 0);
    });

    const productTotals = {};
    orders.forEach(o => {
      (o.items || []).forEach(item => {
        const key = item.productId == null ? item.name : item.productId;
        if (!productTotals[key]) productTotals[key] = { name: item.name, qty: 0, revenue: 0 };
        productTotals[key].qty     += Number(item.qty) || 0;
        productTotals[key].revenue += (Number(item.price) || 0) * (Number(item.qty) || 0);
      });
    });

    const topProducts = Object.values(productTotals)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    res.json({ period, days, revenue, orderCount, avgOrder, customers, byDay, byCategory, topProducts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load analytics.' });
  }
});

/* ============================================================
   ── STRIPE WEBHOOKS ──────────────────────────────────────────
   - POST /api/stripe/webhook            → PLATFORM account events
     (seller subscriptions/invoices), verified with the platform secret.
   - POST /api/stripe/webhook/:storeSlug → each SELLER's account events
     (buyer payments/refunds/disputes), verified with that seller's own
     signing secret. Sellers register this URL in their Stripe dashboard.
   ============================================================ */

// Buyer-payment events now happen inside each seller's own Stripe account.
// This handler is scoped to a specific seller — it only touches that seller's orders.
async function handleBuyerPaymentEvent(event, sellerId) {
  const orderBelongsToSeller = async (orderId) => {
    if (!orderId) return null;
    const order = await db.getOrderById(orderId);
    if (!order || order.sellerId !== sellerId) {
      console.warn(`Webhook: order ${orderId} missing or not owned by seller ${sellerId}; ignoring.`);
      return null;
    }
    return order;
  };

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      if (await orderBelongsToSeller(pi.metadata?.orderId)) {
        await db.updateOrder(pi.metadata.orderId, {
          status: 'processing', paymentIntentId: pi.id, paidAt: new Date(),
        });
        console.log(`Order ${pi.metadata.orderId} marked as paid (seller ${sellerId})`);
      }
      break;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      if (await orderBelongsToSeller(pi.metadata?.orderId)) {
        await db.updateOrder(pi.metadata.orderId, { status: 'payment_failed' });
        console.log(`Order ${pi.metadata.orderId} payment failed (seller ${sellerId})`);
      }
      break;
    }
    case 'charge.refunded': {
      const charge = event.data.object;
      let order = await orderBelongsToSeller(charge.metadata?.orderId);
      if (!order && charge.payment_intent) {
        const o = await db.getOrderByPaymentIntentId(charge.payment_intent);
        if (o && o.sellerId === sellerId) order = o;
        else if (o) console.warn(`Webhook: refund order ${o.id} not owned by seller ${sellerId}; ignoring.`);
      }
      if (order) {
        await db.updateOrder(order.id, { status: 'refunded' });
        console.log(`Order ${order.id} refunded (seller ${sellerId})`);
      }
      break;
    }
    case 'charge.dispute.created': {
      const dispute = event.data.object;
      console.warn(`Chargeback filed (seller ${sellerId}):`, dispute.id, 'Amount:', dispute.amount);
      break;
    }
    default:
      console.log(`Seller webhook: unhandled event ${event.type} (seller ${sellerId})`);
      break;
  }
}

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

  console.log(`Stripe webhook (platform): ${event.type}`);

  try {
    switch (event.type) {

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

// PER-SELLER BUYER WEBHOOK — verified with the seller's own signing secret.
// The seller registers  https://<your-domain>/api/stripe/webhook/<storeSlug>
// in their Stripe dashboard and pastes the resulting signing secret into the
// dashboard (stored encrypted). Raw body is preserved by the express.raw
// middleware mounted on the /api/stripe/webhook prefix.
app.post('/api/stripe/webhook/:storeSlug', async (req, res) => {
  const slug = req.params.storeSlug;

  const seller = await db.getSellerBySlug(slug);
  if (!seller) return res.status(404).send('Unknown store.');

  const config = await loadStripeKeys(seller.id);
  if (!config || !config.webhookSecret) {
    return res.status(400).send('This store has no webhook signing secret configured.');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.webhookSecret);
  } catch (err) {
    console.error(`Seller webhook signature verification failed (${slug}):`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`Stripe webhook (store ${slug}): ${event.type}`);
  try {
    await handleBuyerPaymentEvent(event, seller.id);
  } catch (err) {
    console.error(`Error processing seller webhook ${event.type} (${slug}):`, err);
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
app.get('/api/shipping/carriers/test', requireAuth, async (req, res) => {
  try {
    const results = {};
    for (const carrier of ['ups', 'fedex', 'usps']) {
      const creds = await loadSellerCarrierCreds(req.seller.sellerId, carrier);
      if (!creds) { results[carrier] = false; continue; }
      const test = await carriers.testCarrierCreds(carrier, creds);
      results[carrier] = test.ok;
      if (!test.ok) results[`${carrier}Error`] = test.error;
    }
    res.json(results);
  } catch(err) {
    res.status(500).json({ error: 'Carrier test failed: '+err.message });
  }
});

/* ============================================================
   ── SHIPPING AUTOMATION RULES (CRUD) ─────────────────────────
   IF (weight/value/destination) THEN (carrier/service/box).
   Applied by the batch flow's 'rules' strategy.
   ============================================================ */

// Validate + normalize a rule payload from the client.
function normalizeRulePayload(body) {
  const c = body.conditions || {};
  const a = body.action || {};
  const num = v => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
  if (!body.name || !String(body.name).trim()) throw new Error('Rule name is required.');
  if (!['ups', 'fedex', 'usps'].includes(a.carrier)) throw new Error('Rule action needs a valid carrier.');
  if (!a.service) throw new Error('Rule action needs a service.');
  return {
    name:     String(body.name).trim().slice(0, 80),
    priority: body.priority == null ? 100 : parseInt(body.priority, 10) || 100,
    enabled:  body.enabled !== false,
    conditions: {
      weightMin: num(c.weightMin),
      weightMax: num(c.weightMax),
      valueMin:  num(c.valueMin),
      valueMax:  num(c.valueMax),
      states:    Array.isArray(c.states) ? c.states.filter(Boolean).map(s => String(s).toUpperCase()) : [],
      destinationType: ['domestic', 'international'].includes(c.destinationType) ? c.destinationType : 'any',
    },
    action: {
      carrier: a.carrier,
      service: String(a.service),
      boxSize: a.boxSize ? String(a.boxSize).slice(0, 40) : null, // built-in key or preset id/name
    },
  };
}

app.get('/api/seller/automation-rules', requireAuth, async (req, res) => {
  try {
    const rules = await db.getAutomationRulesBySeller(req.seller.sellerId);
    res.json({ rules });
  } catch (err) {
    console.error('List automation rules error:', err);
    res.status(500).json({ error: 'Failed to load automation rules.' });
  }
});

app.post('/api/seller/automation-rules', requireAuth, async (req, res) => {
  try {
    const rule = await db.createAutomationRule(req.seller.sellerId, normalizeRulePayload(req.body));
    res.json({ rule });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/seller/automation-rules/:id', requireAuth, async (req, res) => {
  try {
    const existing = await db.getAutomationRuleById(parseInt(req.params.id, 10));
    if (!existing || existing.sellerId !== req.seller.sellerId) {
      return res.status(404).json({ error: 'Rule not found.' });
    }
    // Allow lightweight toggles (just { enabled }) without a full payload.
    const fields = ('enabled' in req.body && Object.keys(req.body).length === 1)
      ? { enabled: req.body.enabled !== false }
      : normalizeRulePayload(req.body);
    const rule = await db.updateAutomationRule(existing.id, fields);
    res.json({ rule });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/seller/automation-rules/:id', requireAuth, async (req, res) => {
  try {
    const existing = await db.getAutomationRuleById(parseInt(req.params.id, 10));
    if (!existing || existing.sellerId !== req.seller.sellerId) {
      return res.status(404).json({ error: 'Rule not found.' });
    }
    await db.deleteAutomationRule(existing.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete automation rule error:', err);
    res.status(500).json({ error: 'Failed to delete rule.' });
  }
});

/* ============================================================
   ── PACKAGE PRESETS ──────────────────────────────────────────
   Saved box profiles reused across Quick Ship / batch / rules.
   ============================================================ */
app.get('/api/seller/packages', requireAuth, async (req, res) => {
  try {
    const packages = await db.getPackagePresets(req.seller.sellerId);
    res.json({ packages });
  } catch (err) {
    console.error('List package presets error:', err);
    res.status(500).json({ error: 'Failed to load package presets.' });
  }
});

// Bulk replace (the settings UI edits a list then saves it all).
app.put('/api/seller/packages', requireAuth, async (req, res) => {
  try {
    const list = Array.isArray(req.body.packages) ? req.body.packages : null;
    if (!list) return res.status(400).json({ error: 'packages (array) is required.' });
    if (list.length > 50) return res.status(400).json({ error: 'Too many presets (max 50).' });
    const packages = await db.savePackagePresets(req.seller.sellerId, list);
    res.json({ packages });
  } catch (err) {
    console.error('Save package presets error:', err);
    res.status(500).json({ error: 'Failed to save package presets.' });
  }
});

/* ============================================================
   ── SHIP-FROM PROFILES ───────────────────────────────────────
   Named warehouse/ship-from addresses.
   ============================================================ */
app.get('/api/seller/ship-from', requireAuth, async (req, res) => {
  try {
    const profiles = await db.getShipFromProfiles(req.seller.sellerId);
    res.json({ profiles });
  } catch (err) {
    console.error('List ship-from profiles error:', err);
    res.status(500).json({ error: 'Failed to load ship-from profiles.' });
  }
});

app.put('/api/seller/ship-from', requireAuth, async (req, res) => {
  try {
    const list = Array.isArray(req.body.profiles) ? req.body.profiles : null;
    if (!list) return res.status(400).json({ error: 'profiles (array) is required.' });
    if (list.length > 50) return res.status(400).json({ error: 'Too many profiles (max 50).' });
    const profiles = await db.saveShipFromProfiles(req.seller.sellerId, list);
    res.json({ profiles });
  } catch (err) {
    console.error('Save ship-from profiles error:', err);
    res.status(500).json({ error: 'Failed to save ship-from profiles.' });
  }
});

/* ============================================================
   ── SALES CHANNELS (multi-channel order import) ──────────────
   Shopify: seller connects a custom-app Admin API token (BYOA,
   encrypted). Orders sync into the Orders page; tracking pushes
   back as a Shopify fulfillment when a label is bought.
   ============================================================ */

// List the seller's channel connections (never returns secrets).
app.get('/api/seller/channels', requireAuth, async (req, res) => {
  try {
    const rows = await db.getChannelConnections(req.seller.sellerId);
    const channels = rows.map(r => {
      // Shopify OAuth connections get real-time webhooks (verified with the
      // app secret) whenever the app is configured with a public https origin.
      const realtime = r.channel === 'shopify' && shopifyAppConfig().configured;
      return { channel: r.channel, shopDomain: r.shopDomain, status: r.status, lastSyncedAt: r.lastSyncedAt, realtime };
    });
    res.json({ channels });
  } catch (err) {
    console.error('List channels error:', err);
    res.status(500).json({ error: 'Failed to load channels.' });
  }
});

// Begin the Shopify OAuth install. Returns the consent URL for the browser to
// redirect to. The seller's identity + a nonce ride in a signed `state` (JWT)
// so the (unauthenticated) callback can map the install back to this account.
app.post('/api/seller/channels/shopify/install', requireAuth, async (req, res) => {
  try {
    const cfg = shopifyAppConfig();
    if (!cfg.configured) {
      return res.status(500).json({ error: 'Shopify app is not configured on this server (SHOPIFY_API_KEY / SHOPIFY_API_SECRET / ALLOWED_ORIGIN).' });
    }
    const shopDomain = shopify.normalizeShopDomain(req.body.shopDomain);
    if (!/\.myshopify\.com$/.test(shopDomain)) {
      return res.status(400).json({ error: 'Enter your <store>.myshopify.com domain.' });
    }
    const state = jwt.sign(
      { sellerId: req.seller.sellerId, shop: shopDomain, purpose: 'shopify_oauth', nonce: crypto.randomBytes(8).toString('hex') },
      process.env.JWT_SECRET, { expiresIn: '10m' }
    );
    const url = shopify.buildInstallUrl(shopDomain, {
      apiKey: cfg.apiKey, scopes: SHOPIFY_SCOPES, redirectUri: cfg.redirectUri, state,
    });
    res.json({ url });
  } catch (err) {
    console.error('Shopify install error:', err);
    res.status(500).json({ error: 'Could not start Shopify install.' });
  }
});

// OAuth callback (top-level browser redirect — NOT XHR, so no requireAuth; the
// seller is identified from the signed state). Verify → exchange → store →
// register webhook → bounce back to the app.
app.get('/api/channels/shopify/callback', async (req, res) => {
  const back = (ok) => res.redirect(`${(process.env.ALLOWED_ORIGIN || '').replace(/\/$/, '')}/shipping?shopify=${ok ? 'connected' : 'error'}`);
  try {
    const cfg = shopifyAppConfig();
    if (!cfg.configured) return back(false);

    const { code, shop, state, hmac } = req.query;
    if (!code || !shop || !state || !hmac) return back(false);
    if (!shopify.verifyOAuthHmac(req.query, cfg.apiSecret)) return back(false);

    // Decode + validate state (signature, purpose, and shop match).
    let claims;
    try { claims = jwt.verify(state, process.env.JWT_SECRET); } catch (e) { return back(false); }
    const shopDomain = shopify.normalizeShopDomain(shop);
    if (claims.purpose !== 'shopify_oauth' || claims.shop !== shopDomain) return back(false);

    const tok = await shopify.exchangeCodeForToken(shopDomain, {
      apiKey: cfg.apiKey, apiSecret: cfg.apiSecret, code,
    });

    const credentials = cryptoLib.encrypt(shopifyCredsFromToken(tok, shopDomain));
    await db.saveChannelConnection(claims.sellerId, 'shopify', { shopDomain, credentials, status: 'verified' });

    // Register the orders/create webhook (verified later with the app secret).
    const callbackUrl = channelWebhookUrl(claims.sellerId);
    if (callbackUrl) {
      await shopify.ensureOrderWebhook({ shopDomain, accessToken: tok.accessToken }, callbackUrl).catch(e =>
        console.error('Shopify webhook registration failed:', e.message));
    }
    back(true);
  } catch (err) {
    console.error('Shopify callback error:', err.message);
    back(false);
  }
});

// Pull unfulfilled orders and upsert them (idempotent by external id).
app.post('/api/seller/channels/shopify/sync', requireAuth, async (req, res) => {
  try {
    const creds = await loadChannelCreds(req.seller.sellerId, 'shopify');
    if (!creds) return res.status(400).json({ error: 'Connect a Shopify store first.', channelSetupRequired: true });

    const shopifyOrders = await shopify.fetchUnfulfilledOrders(creds);
    let imported = 0, skipped = 0;
    for (const so of shopifyOrders) {
      const outcome = await importChannelOrder(req.seller.sellerId, 'shopify', shopify.mapShopifyOrder(so));
      if (outcome === 'imported') imported++; else skipped++;
    }
    await db.touchChannelSync(req.seller.sellerId, 'shopify');
    res.json({ imported, skipped, total: shopifyOrders.length });
  } catch (err) {
    console.error('Shopify sync error:', err);
    res.status(502).json({ error: 'Sync failed: ' + err.message });
  }
});

// Read-only diagnostic for the fulfillment push-back. Reports the granted
// scopes on the stored token and (with ?orderId=<local id>) that order's open
// fulfillment orders — no writes. Lets us tell a missing-scope 403 apart from an
// order that has nothing left to fulfill, without buying a label.
app.get('/api/seller/channels/shopify/diagnose', requireAuth, async (req, res) => {
  try {
    const creds = await loadChannelCreds(req.seller.sellerId, 'shopify');
    if (!creds) return res.status(400).json({ error: 'Connect a Shopify store first.' });
    let externalId = null;
    const oid = normalizeOrderId(req.query.orderId);
    if (oid !== null) {
      const ord = await db.getOrderById(oid);
      if (ord && ord.sellerId === req.seller.sellerId && ord.channel === 'shopify') externalId = ord.externalId;
    }
    const result = await shopify.diagnoseFulfillment(creds, externalId);
    res.json({ ...result, localOrderId: oid, externalId });
  } catch (err) {
    console.error('Shopify diagnose error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.delete('/api/seller/channels/shopify', requireAuth, async (req, res) => {
  try {
    // Remove the registered webhook before dropping the creds (best-effort).
    const creds = await loadChannelCreds(req.seller.sellerId, 'shopify');
    const callbackUrl = channelWebhookUrl(req.seller.sellerId);
    if (creds && callbackUrl) {
      await shopify.removeOrderWebhooks(creds, callbackUrl).catch(() => {});
    }
    await db.deleteChannelConnection(req.seller.sellerId, 'shopify');
    res.json({ success: true });
  } catch (err) {
    console.error('Disconnect channel error:', err);
    res.status(500).json({ error: 'Failed to disconnect.' });
  }
});

// Connect an Amazon store (self-authorized private SP-API app). Creds:
// clientId, clientSecret, refreshToken (+ marketplace, region).
app.post('/api/seller/channels/amazon', requireAuth, async (req, res) => {
  try {
    if (!cryptoLib.isConfigured()) {
      return res.status(500).json({ error: 'Server encryption is not configured; cannot store credentials.' });
    }
    const { clientId, clientSecret, refreshToken, marketplace = 'US', region = 'na' } = req.body;
    if (!clientId || !clientSecret || !refreshToken) {
      return res.status(400).json({ error: 'client id, client secret, and refresh token are required.' });
    }
    const creds = { clientId, clientSecret, refreshToken, marketplace, region };
    await amazon.verifyConnection(creds); // throws on bad creds / missing access
    const credentials = cryptoLib.encrypt(creds);
    await db.saveChannelConnection(req.seller.sellerId, 'amazon', {
      shopDomain: `${String(marketplace).toUpperCase()} · ${String(region).toUpperCase()}`,
      credentials, status: 'verified',
    });
    res.json({ message: `Connected to Amazon (${String(marketplace).toUpperCase()}).` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/seller/channels/amazon/sync', requireAuth, async (req, res) => {
  try {
    const creds = await loadChannelCreds(req.seller.sellerId, 'amazon');
    if (!creds) return res.status(400).json({ error: 'Connect an Amazon store first.', channelSetupRequired: true });

    const orders = await amazon.fetchUnfulfilledOrders(creds);
    let imported = 0, skipped = 0, noAddress = 0;
    for (const mapped of orders) {
      if (!mapped.customerInfo.address1) noAddress++;
      const outcome = await importChannelOrder(req.seller.sellerId, 'amazon', mapped);
      if (outcome === 'imported') imported++; else skipped++;
    }
    await db.touchChannelSync(req.seller.sellerId, 'amazon');
    res.json({ imported, skipped, total: orders.length, noAddress });
  } catch (err) {
    console.error('Amazon sync error:', err);
    res.status(502).json({ error: 'Sync failed: ' + err.message });
  }
});

app.delete('/api/seller/channels/amazon', requireAuth, async (req, res) => {
  try {
    await db.deleteChannelConnection(req.seller.sellerId, 'amazon');
    res.json({ success: true });
  } catch (err) {
    console.error('Disconnect amazon error:', err);
    res.status(500).json({ error: 'Failed to disconnect.' });
  }
});

/* ── Walmart Marketplace (self-authorized, client-credentials) ─────
   Mirrors Amazon: the seller pastes their Client ID + Client Secret from the
   Walmart Developer Portal; we verify, store encrypted, then sync/push. */

// Connect a Walmart Marketplace account. Creds: clientId, clientSecret.
app.post('/api/seller/channels/walmart', requireAuth, async (req, res) => {
  try {
    if (!cryptoLib.isConfigured()) {
      return res.status(500).json({ error: 'Server encryption is not configured; cannot store credentials.' });
    }
    const clientId     = (req.body.clientId || '').trim();
    const clientSecret = (req.body.clientSecret || '').trim();
    if (!clientId || !clientSecret) {
      return res.status(400).json({ error: 'Client ID and Client Secret are required.' });
    }
    const creds = { clientId, clientSecret };
    await walmart.verifyConnection(creds); // throws on bad creds / missing access
    const credentials = cryptoLib.encrypt(creds);
    await db.saveChannelConnection(req.seller.sellerId, 'walmart', {
      shopDomain: 'Walmart Marketplace', credentials, status: 'verified',
    });
    res.json({ message: 'Connected to Walmart Marketplace.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/seller/channels/walmart/sync', requireAuth, async (req, res) => {
  try {
    const creds = await loadChannelCreds(req.seller.sellerId, 'walmart');
    if (!creds) return res.status(400).json({ error: 'Connect a Walmart account first.', channelSetupRequired: true });

    const orders = await walmart.fetchUnfulfilledOrders(creds);
    let imported = 0, skipped = 0;
    for (const mapped of orders) {
      const outcome = await importChannelOrder(req.seller.sellerId, 'walmart', mapped);
      if (outcome === 'imported') imported++; else skipped++;
    }
    await db.touchChannelSync(req.seller.sellerId, 'walmart');
    res.json({ imported, skipped, total: orders.length });
  } catch (err) {
    console.error('Walmart sync error:', err);
    res.status(502).json({ error: 'Sync failed: ' + err.message });
  }
});

app.delete('/api/seller/channels/walmart', requireAuth, async (req, res) => {
  try {
    await db.deleteChannelConnection(req.seller.sellerId, 'walmart');
    res.json({ success: true });
  } catch (err) {
    console.error('Disconnect walmart error:', err);
    res.status(500).json({ error: 'Failed to disconnect.' });
  }
});

/* ── eBay (OAuth user token) ──────────────────────────────────
   Mirrors Shopify: install → consent → callback → store → sync/push. The
   seller's identity rides in a signed `state` JWT so the (unauthenticated)
   callback can map the install back to this account. */

// Begin the eBay OAuth install. Returns the consent URL to redirect to.
app.post('/api/seller/channels/ebay/install', requireAuth, async (req, res) => {
  try {
    const cfg = ebayAppConfig();
    if (!cfg.configured) {
      return res.status(500).json({ error: 'eBay app is not configured on this server (EBAY_API_KEY / EBAY_API_SECRET / EBAY_RU_NAME).' });
    }
    const state = jwt.sign(
      { sellerId: req.seller.sellerId, purpose: 'ebay_oauth', nonce: crypto.randomBytes(8).toString('hex') },
      process.env.JWT_SECRET, { expiresIn: '10m' }
    );
    const url = ebay.buildInstallUrl({ clientId: cfg.apiKey, scopes: EBAY_SCOPES, ruName: cfg.ruName, state });
    res.json({ url });
  } catch (err) {
    console.error('eBay install error:', err);
    res.status(500).json({ error: 'Could not start eBay install.' });
  }
});

// OAuth callback (top-level browser redirect — identified from the signed
// state; eBay doesn't sign the callback, so the state JWT is the trust anchor).
app.get('/api/channels/ebay/callback', async (req, res) => {
  const back = (ok) => res.redirect(`${(process.env.ALLOWED_ORIGIN || '').replace(/\/$/, '')}/shipping?ebay=${ok ? 'connected' : 'error'}`);
  try {
    const cfg = ebayAppConfig();
    if (!cfg.configured) return back(false);
    const { code, state } = req.query;
    if (!code || !state) return back(false);

    let claims;
    try { claims = jwt.verify(state, process.env.JWT_SECRET); } catch (e) { return back(false); }
    if (claims.purpose !== 'ebay_oauth') return back(false);

    const tok = await ebay.exchangeCodeForToken({ clientId: cfg.apiKey, clientSecret: cfg.apiSecret, ruName: cfg.ruName, code });
    const ident = await ebay.getSellerIdentity(tok.accessToken);
    const creds = ebayCredsFromToken(tok, { username: ident?.username || null });
    await db.saveChannelConnection(claims.sellerId, 'ebay', {
      shopDomain: ident?.username || 'eBay', credentials: cryptoLib.encrypt(creds), status: 'verified',
    });
    back(true);
  } catch (err) {
    console.error('eBay callback error:', err.message);
    back(false);
  }
});

// Pull unfulfilled orders and upsert them (idempotent by external id).
app.post('/api/seller/channels/ebay/sync', requireAuth, async (req, res) => {
  try {
    const creds = await loadChannelCreds(req.seller.sellerId, 'ebay');
    if (!creds) return res.status(400).json({ error: 'Connect an eBay account first.', channelSetupRequired: true });

    const ebayOrders = await ebay.fetchUnfulfilledOrders(creds);
    let imported = 0, skipped = 0;
    for (const eo of ebayOrders) {
      const outcome = await importChannelOrder(req.seller.sellerId, 'ebay', ebay.mapEbayOrder(eo));
      if (outcome === 'imported') imported++; else skipped++;
    }
    await db.touchChannelSync(req.seller.sellerId, 'ebay');
    res.json({ imported, skipped, total: ebayOrders.length });
  } catch (err) {
    console.error('eBay sync error:', err);
    res.status(502).json({ error: 'Sync failed: ' + err.message });
  }
});

app.delete('/api/seller/channels/ebay', requireAuth, async (req, res) => {
  try {
    await db.deleteChannelConnection(req.seller.sellerId, 'ebay');
    res.json({ success: true });
  } catch (err) {
    console.error('Disconnect ebay error:', err);
    res.status(500).json({ error: 'Failed to disconnect.' });
  }
});

/* ── Etsy (OAuth + PKCE) ──────────────────────────────────────
   Like eBay, but PKCE: the per-install code_verifier rides in the signed
   `state` JWT so the callback can complete the token exchange. */

app.post('/api/seller/channels/etsy/install', requireAuth, async (req, res) => {
  try {
    const cfg = etsyAppConfig();
    if (!cfg.configured) {
      return res.status(500).json({ error: 'Etsy app is not configured on this server (ETSY_KEYSTRING / ALLOWED_ORIGIN).' });
    }
    const { codeVerifier, codeChallenge } = etsy.generatePkce();
    const state = jwt.sign(
      { sellerId: req.seller.sellerId, purpose: 'etsy_oauth', codeVerifier, nonce: crypto.randomBytes(8).toString('hex') },
      process.env.JWT_SECRET, { expiresIn: '10m' }
    );
    const url = etsy.buildInstallUrl({ keystring: cfg.keystring, scopes: ETSY_SCOPES, redirectUri: cfg.redirectUri, state, codeChallenge });
    res.json({ url });
  } catch (err) {
    console.error('Etsy install error:', err);
    res.status(500).json({ error: 'Could not start Etsy install.' });
  }
});

app.get('/api/channels/etsy/callback', async (req, res) => {
  const back = (ok) => res.redirect(`${(process.env.ALLOWED_ORIGIN || '').replace(/\/$/, '')}/shipping?etsy=${ok ? 'connected' : 'error'}`);
  try {
    const cfg = etsyAppConfig();
    if (!cfg.configured) return back(false);
    const { code, state } = req.query;
    if (!code || !state) return back(false);

    let claims;
    try { claims = jwt.verify(state, process.env.JWT_SECRET); } catch (e) { return back(false); }
    if (claims.purpose !== 'etsy_oauth' || !claims.codeVerifier) return back(false);

    const tok = await etsy.exchangeCodeForToken({
      keystring: cfg.keystring, redirectUri: cfg.redirectUri, code, codeVerifier: claims.codeVerifier,
    });
    const shop = await etsy.getShop({ keystring: cfg.keystring, accessToken: tok.accessToken });
    const creds = etsyCredsFromToken(tok, shop);
    await db.saveChannelConnection(claims.sellerId, 'etsy', {
      shopDomain: shop.shopName || 'Etsy shop', credentials: cryptoLib.encrypt(creds), status: 'verified',
    });
    back(true);
  } catch (err) {
    console.error('Etsy callback error:', err.message);
    back(false);
  }
});

app.post('/api/seller/channels/etsy/sync', requireAuth, async (req, res) => {
  try {
    const creds = await loadChannelCreds(req.seller.sellerId, 'etsy');
    if (!creds) return res.status(400).json({ error: 'Connect an Etsy shop first.', channelSetupRequired: true });

    const receipts = await etsy.fetchUnshippedReceipts(creds);
    let imported = 0, skipped = 0;
    for (const r of receipts) {
      const outcome = await importChannelOrder(req.seller.sellerId, 'etsy', etsy.mapEtsyReceipt(r));
      if (outcome === 'imported') imported++; else skipped++;
    }
    await db.touchChannelSync(req.seller.sellerId, 'etsy');
    res.json({ imported, skipped, total: receipts.length });
  } catch (err) {
    console.error('Etsy sync error:', err);
    res.status(502).json({ error: 'Sync failed: ' + err.message });
  }
});

app.delete('/api/seller/channels/etsy', requireAuth, async (req, res) => {
  try {
    await db.deleteChannelConnection(req.seller.sellerId, 'etsy');
    res.json({ success: true });
  } catch (err) {
    console.error('Disconnect etsy error:', err);
    res.status(500).json({ error: 'Failed to disconnect.' });
  }
});

/* ── TikTok Shop (OAuth + HMAC-signed API) ────────────────────
   Seller consent returns ?code=<auth_code>&state=<jwt> to the callback (the
   redirect URL is registered in the TikTok Shop Partner Center). We exchange
   the code, resolve the shop cipher, and store it all encrypted. */

app.post('/api/seller/channels/tiktok/install', requireAuth, async (req, res) => {
  try {
    const cfg = tiktokAppConfig();
    if (!cfg.configured) {
      return res.status(500).json({ error: 'TikTok app is not configured on this server (TIKTOK_APP_KEY / TIKTOK_APP_SECRET).' });
    }
    const state = jwt.sign(
      { sellerId: req.seller.sellerId, purpose: 'tiktok_oauth', nonce: crypto.randomBytes(8).toString('hex') },
      process.env.JWT_SECRET, { expiresIn: '10m' }
    );
    res.json({ url: tiktok.buildInstallUrl({ appKey: cfg.appKey, state }) });
  } catch (err) {
    console.error('TikTok install error:', err);
    res.status(500).json({ error: 'Could not start TikTok install.' });
  }
});

app.get('/api/channels/tiktok/callback', async (req, res) => {
  const back = (ok) => res.redirect(`${(process.env.ALLOWED_ORIGIN || '').replace(/\/$/, '')}/shipping?tiktok=${ok ? 'connected' : 'error'}`);
  try {
    const cfg = tiktokAppConfig();
    if (!cfg.configured) return back(false);
    const { code, state } = req.query;
    if (!code || !state) return back(false);

    let claims;
    try { claims = jwt.verify(state, process.env.JWT_SECRET); } catch (e) { return back(false); }
    if (claims.purpose !== 'tiktok_oauth') return back(false);

    const tok = await tiktok.getToken({ appKey: cfg.appKey, appSecret: cfg.appSecret, authCode: code });
    const shop = await tiktok.getShop({ appKey: cfg.appKey, appSecret: cfg.appSecret, accessToken: tok.accessToken });
    const creds = tiktokCredsFromToken(tok, shop);
    await db.saveChannelConnection(claims.sellerId, 'tiktok', {
      shopDomain: shop.shopName || 'TikTok shop', credentials: cryptoLib.encrypt(creds), status: 'verified',
    });
    back(true);
  } catch (err) {
    console.error('TikTok callback error:', err.message);
    back(false);
  }
});

app.post('/api/seller/channels/tiktok/sync', requireAuth, async (req, res) => {
  try {
    const creds = await loadChannelCreds(req.seller.sellerId, 'tiktok');
    if (!creds) return res.status(400).json({ error: 'Connect a TikTok shop first.', channelSetupRequired: true });

    const ttOrders = await tiktok.fetchUnfulfilledOrders(creds);
    let imported = 0, skipped = 0;
    for (const o of ttOrders) {
      const outcome = await importChannelOrder(req.seller.sellerId, 'tiktok', tiktok.mapTikTokOrder(o));
      if (outcome === 'imported') imported++; else skipped++;
    }
    await db.touchChannelSync(req.seller.sellerId, 'tiktok');
    res.json({ imported, skipped, total: ttOrders.length });
  } catch (err) {
    console.error('TikTok sync error:', err);
    res.status(502).json({ error: 'Sync failed: ' + err.message });
  }
});

app.delete('/api/seller/channels/tiktok', requireAuth, async (req, res) => {
  try {
    await db.deleteChannelConnection(req.seller.sellerId, 'tiktok');
    res.json({ success: true });
  } catch (err) {
    console.error('Disconnect tiktok error:', err);
    res.status(500).json({ error: 'Failed to disconnect.' });
  }
});

/* eBay MARKETPLACE ACCOUNT DELETION endpoint (public, no auth — eBay calls it).
   GET  ?challenge_code=…  → prove ownership by echoing the SHA-256 challenge.
   POST                    → a buyer/seller closed their eBay account; ack fast.
   eBay requires this (or an exemption) before a production app can call the
   Sell APIs. Register this exact URL + the verification token in the portal. */
app.get('/api/webhooks/ebay/account-deletion', (req, res) => {
  const cfg = ebayDeletionConfig();
  const challengeCode = req.query.challenge_code;
  if (!challengeCode) return res.status(400).json({ error: 'Missing challenge_code.' });
  if (!cfg.configured) {
    console.error('eBay deletion challenge received but EBAY_VERIFICATION_TOKEN / ALLOWED_ORIGIN not set.');
    return res.status(500).json({ error: 'Endpoint not configured.' });
  }
  const challengeResponse = ebay.accountDeletionChallengeResponse(
    String(challengeCode), cfg.verificationToken, cfg.endpoint
  );
  res.status(200).json({ challengeResponse });
});

app.post('/api/webhooks/ebay/account-deletion', (req, res) => {
  // We don't retain eBay buyer PII beyond imported order records, so there's
  // nothing to purge on account closure — acknowledge so eBay marks it handled.
  // (Signature verification via eBay's public key can be added later; a 2xx ack
  // is what the notification pipeline requires.)
  try {
    const userId = req.body?.notification?.data?.userId || req.body?.notification?.data?.username || 'unknown';
    console.log(`eBay account-deletion notification received (userId=${userId}).`);
  } catch { /* ignore malformed body */ }
  res.sendStatus(200);
});

// SHOPIFY WEBHOOK RECEIVER — Shopify POSTs orders/create here. Raw body is
// preserved by the express.raw middleware on /api/webhooks/shopify. Public-app
// webhooks are signed with the app's single API secret, so we verify with that.
app.post('/api/webhooks/shopify/:sellerId', async (req, res) => {
  try {
    const sellerId = parseInt(req.params.sellerId, 10);
    if (!Number.isInteger(sellerId)) return res.status(404).end();

    const appSecret = process.env.SHOPIFY_API_SECRET;
    if (!appSecret) return res.status(401).end();

    // req.body is a Buffer here (raw). Verify before trusting anything.
    const hmac = req.headers['x-shopify-hmac-sha256'];
    if (!shopify.verifyWebhookHmac(req.body, hmac, appSecret)) {
      return res.status(401).end();
    }
    const creds = await loadChannelCreds(sellerId, 'shopify');
    if (!creds) return res.status(401).end();
    // Defense-in-depth: the shop domain must match the connected store.
    const shopHeader = String(req.headers['x-shopify-shop-domain'] || '').toLowerCase();
    if (creds.shopDomain && shopHeader && shopHeader !== creds.shopDomain) {
      return res.status(401).end();
    }

    // Ack fast; import after responding so a slow DB write can't cause retries.
    res.status(200).end();

    try {
      const so = JSON.parse(req.body.toString('utf8'));
      const outcome = await importChannelOrder(sellerId, 'shopify', shopify.mapShopifyOrder(so));
      await db.touchChannelSync(sellerId, 'shopify');
      console.log(`Shopify webhook: order ${so.name || so.id} → ${outcome} (seller ${sellerId}).`);
    } catch (e) {
      console.error('Shopify webhook import failed:', e.message);
    }
  } catch (err) {
    console.error('Shopify webhook error:', err.message);
    if (!res.headersSent) res.status(500).end();
  }
});

// RATE SHOPPING — compare live rates across ALL of the seller's connected
// carriers for one package/route. Queries each connected carrier in parallel
// (Promise.allSettled) so one carrier erroring never sinks the others; returns
// the combined rate list sorted cheapest-first plus any per-carrier errors.
app.post('/api/shipping/rates', requireAuth, async (req, res) => {
  try {
    const { shipper, recipient, package: pkg } = req.body;
    if (!shipper || !recipient || !pkg) {
      return res.status(400).json({ error: 'shipper, recipient, and package are required.' });
    }

    // Which carriers has this seller actually connected?
    const accounts  = await db.getCarrierAccounts(req.seller.sellerId);
    const connected = (accounts || [])
      .map(a => a.carrier)
      .filter(c => ['ups', 'fedex', 'usps'].includes(c));

    if (connected.length === 0) {
      return res.status(400).json({
        error: 'Connect at least one carrier account in Settings to compare rates.',
        carrierSetupRequired: true,
      });
    }

    const settled = await Promise.allSettled(connected.map(async carrier => {
      const creds = await loadSellerCarrierCreds(req.seller.sellerId, carrier);
      if (!creds) throw new Error('credentials unavailable');
      return carriers.getRates(carrier, { shipper, recipient, package: pkg }, creds);
    }));

    const rates  = [];
    const errors = [];
    settled.forEach((result, i) => {
      const carrier = connected[i];
      if (result.status === 'fulfilled') {
        rates.push(...result.value);
      } else {
        console.error(`Rate lookup failed for ${carrier}:`, result.reason?.message);
        errors.push({ carrier, error: result.reason?.message || 'Rate lookup failed' });
      }
    });

    // Cheapest first — the whole point of rate shopping.
    rates.sort((a, b) => a.totalCharge - b.totalCharge);

    res.json({ rates, errors, cheapest: rates[0] || null });
  } catch (err) {
    console.error('Rate shopping error:', err);
    res.status(500).json({ error: 'Failed to fetch rates: ' + err.message });
  }
});

// Buy a single label from a normalized service string, mapping to each
// carrier's own createShipment signature. Shared by the batch flow.
// TODO: migrate the single-label /api/shipping/label route onto this helper too.
async function buyCarrierLabel(carrier, creds, { shipper, recipient, package: pkg, service, orderId }) {
  const client = carriers.buildCarrier(carrier, creds);
  if (carrier === 'ups') {
    return client.createShipment({ shipper, recipient, package: pkg, serviceCode: service || '03', labelFormat: 'GIF', reference: orderId });
  }
  if (carrier === 'fedex') {
    return client.createShipment({ shipper, recipient, package: pkg, serviceType: service || 'FEDEX_GROUND', labelFormat: 'PDF', reference: orderId });
  }
  // usps (Shippo)
  return client.createShipment({ shipper, recipient, package: pkg, serviceToken: service || 'usps_priority', reference: orderId });
}

// Standard box presets → [length, width, height] in inches. Used when an
// automation rule specifies a box size.
const BOX_DIMS = { small: [8,6,4], medium: [12,9,6], large: [18,14,10], xlarge: [24,18,12] };

// Find the first enabled automation rule whose conditions all match this order.
// ctx: { weight (lb), value ($), state, country }. `rules` must be pre-sorted
// by priority. A missing condition field is a wildcard. Returns the rule or null.
function matchAutomationRule(rules, ctx) {
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    const c = rule.conditions || {};
    if (c.weightMin != null && ctx.weight < Number(c.weightMin)) continue;
    if (c.weightMax != null && ctx.weight > Number(c.weightMax)) continue;
    if (c.valueMin  != null && ctx.value  < Number(c.valueMin))  continue;
    if (c.valueMax  != null && ctx.value  > Number(c.valueMax))  continue;
    if (Array.isArray(c.states) && c.states.length && !c.states.includes(ctx.state)) continue;
    if (c.destinationType === 'domestic'     && ctx.country !== 'US') continue;
    if (c.destinationType === 'international' && ctx.country === 'US') continue;
    return rule;
  }
  return null;
}

// BATCH LABELS — buy labels for many orders in one pass. This is the
// ShipStation batch workflow, built on the rate-shopping engine.
//   strategy 'cheapest' → rate-shop each order across all connected carriers,
//                         buy the cheapest service.
//   strategy 'fixed'    → buy the same carrier + service for every order.
//   strategy 'rules'    → apply the seller's automation rules per order;
//                         orders with no matching rule fall back to cheapest.
// Orders are processed with limited concurrency; each order succeeds or fails
// independently and reports its own result.
app.post('/api/shipping/batch', requireAuth, async (req, res) => {
  try {
    const { orderIds, strategy = 'cheapest', carrier, service, shipper, package: pkg } = req.body;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ error: 'orderIds (non-empty array) is required.' });
    }
    if (!shipper) {
      return res.status(400).json({ error: 'shipper (ship-from address) is required.' });
    }
    if (strategy === 'fixed' && (!carrier || !service)) {
      return res.status(400).json({ error: 'carrier and service are required for the fixed-service strategy.' });
    }

    const sellerId = req.seller.sellerId;
    const defaultPkg = pkg || { weight: 1, length: 12, width: 9, height: 4 };

    // Automation rules (only loaded for the 'rules' strategy), pre-sorted by priority.
    const rules = strategy === 'rules'
      ? (await db.getAutomationRulesBySeller(sellerId)).filter(r => r.enabled !== false)
      : [];

    // Resolve a rule's boxSize to [L,W,H]: a built-in size key, or a saved
    // package preset (by id or name). Presets loaded once per batch.
    const presets = strategy === 'rules' ? await db.getPackagePresets(sellerId) : [];
    const resolveBoxDims = (boxSize) => {
      if (!boxSize) return null;
      if (BOX_DIMS[boxSize]) return BOX_DIMS[boxSize];
      const p = presets.find(x => String(x.id) === String(boxSize) || x.name === boxSize);
      return p ? [Number(p.length), Number(p.width), Number(p.height)] : null;
    };

    // Which carriers are connected? (cheapest strategy rate-shops across these.)
    const accounts  = await db.getCarrierAccounts(sellerId);
    const connected = (accounts || []).map(a => a.carrier).filter(c => ['ups','fedex','usps'].includes(c));
    if (connected.length === 0) {
      return res.status(400).json({ error: 'Connect at least one carrier account before buying labels.', carrierSetupRequired: true });
    }

    // Cache decrypted creds per carrier for the whole batch.
    const credCache = {};
    const credsFor = async (c) => {
      if (!(c in credCache)) credCache[c] = await loadSellerCarrierCreds(sellerId, c);
      return credCache[c];
    };

    // Per-order weight = sum of each line's product weight × qty, in POUNDS.
    // Product weights are stored in OUNCES (the product form is labelled oz), so
    // convert to lbs for the carrier APIs. Products are cached across the batch
    // since orders often share items. Returns 0 when no product has a weight set
    // so the caller can fall back to the batch default.
    const OZ_PER_LB = 16;
    const productCache = {};
    async function computeOrderWeight(order) {
      const items = Array.isArray(order.items) ? order.items : [];
      let totalOz = 0;
      for (const it of items) {
        let oz = 0;
        if (it.weight != null && Number.isFinite(Number(it.weight))) {
          // Imported orders (e.g. Shopify) carry per-item weight (oz) directly.
          oz = Number(it.weight);
        } else if (it.productId) {
          if (!(it.productId in productCache)) {
            productCache[it.productId] = await db.getProductById(it.productId).catch(() => null);
          }
          const p = productCache[it.productId];
          oz = p && p.weight != null ? Number(p.weight) : 0;
        }
        if (Number.isFinite(oz)) totalOz += oz * (Number(it.qty) || 1);
      }
      return totalOz / OZ_PER_LB;
    }

    // Per-order dimensions from the product — only meaningful for a single-item,
    // single-qty order (you can't just add box dimensions together). Returns
    // [L,W,H] or null so the caller keeps the batch default for multi-item orders.
    async function computeOrderDims(order) {
      const items = Array.isArray(order.items) ? order.items : [];
      if (items.length !== 1) return null;
      const it = items[0];
      if (!it.productId || (Number(it.qty) || 1) !== 1) return null;
      if (!(it.productId in productCache)) {
        productCache[it.productId] = await db.getProductById(it.productId).catch(() => null);
      }
      const p = productCache[it.productId];
      if (p && p.length != null && p.width != null && p.height != null) {
        return [Number(p.length), Number(p.width), Number(p.height)];
      }
      return null;
    }

    async function processOrder(orderId) {
      const result = { orderId, success: false };
      try {
        const order = await db.getOrderById(orderId);
        if (!order)                       throw new Error('Order not found');
        if (order.sellerId !== sellerId)  throw new Error('Order does not belong to this seller');

        const ci = order.customerInfo || {};
        const recipient = {
          name:        [ci.firstName, ci.lastName].filter(Boolean).join(' ') || ci.name || order.customerEmail || 'Recipient',
          company:     ci.company || undefined,
          phone:       ci.phone || '5550000000',
          address1:    ci.address1,
          address2:    ci.address2 || undefined,
          city:        ci.city,
          state:       ci.state,
          zip:         ci.zip,
          country:     ci.country || 'US',
          email:       ci.email || order.customerEmail || '',
          residential: ci.residential !== false, // buyer addresses are residential by default
        };
        if (!recipient.address1 || !recipient.city || !recipient.zip) {
          throw new Error('Order is missing a complete shipping address');
        }

        // Weigh this specific order from its line items; fall back to the batch
        // default when no product weights are set. For single-item orders, also
        // auto-size the box from the product's dimensions when it has them.
        const orderWeight = await computeOrderWeight(order);
        const orderDims   = await computeOrderDims(order);
        const pkgForOrder = { ...defaultPkg, weight: orderWeight > 0 ? orderWeight : defaultPkg.weight };
        if (orderDims) { pkgForOrder.length = orderDims[0]; pkgForOrder.width = orderDims[1]; pkgForOrder.height = orderDims[2]; }

        // Pick carrier + service for this order.
        let chosenCarrier = carrier, chosenService = service;
        let appliedRule = null;

        // Automation rules: first matching rule sets carrier/service (+box).
        if (strategy === 'rules') {
          const ctx = {
            weight:  pkgForOrder.weight,
            value:   Number(order.total) || 0,
            state:   recipient.state,
            country: recipient.country,
          };
          const rule = matchAutomationRule(rules, ctx);
          if (rule) {
            chosenCarrier = rule.action?.carrier;
            chosenService = rule.action?.service;
            appliedRule   = rule.name;
            const dims = resolveBoxDims(rule.action?.boxSize);
            if (dims) { pkgForOrder.length = dims[0]; pkgForOrder.width = dims[1]; pkgForOrder.height = dims[2]; }
          }
        }

        // Rate-shop when asked for cheapest, or when a rule didn't resolve a carrier.
        if (strategy === 'cheapest' || (strategy === 'rules' && !chosenCarrier)) {
          const rated = await Promise.allSettled(connected.map(async c => {
            const creds = await credsFor(c);
            if (!creds) throw new Error('credentials unavailable');
            return carriers.getRates(c, { shipper, recipient, package: pkgForOrder }, creds);
          }));
          const all = rated.flatMap(r => r.status === 'fulfilled' ? r.value : []);
          all.sort((a, b) => a.totalCharge - b.totalCharge);
          if (!all.length) throw new Error('No rates returned from any carrier');
          chosenCarrier = all[0].carrier;
          chosenService = all[0].serviceCode;
          if (strategy === 'rules') appliedRule = 'No rule matched → cheapest';
        }

        const creds = await credsFor(chosenCarrier);
        if (!creds) throw new Error(`${chosenCarrier.toUpperCase()} account not connected`);

        const label = await buyCarrierLabel(chosenCarrier, creds, {
          shipper, recipient, package: pkgForOrder, service: chosenService, orderId,
        });

        // Persist the shipment + mark the order shipped (best-effort).
        try {
          await db.createShipment({
            sellerId, orderId: Number.isFinite(parseInt(orderId)) ? parseInt(orderId) : null,
            trackingNumber: label.trackingNumber, carrier: chosenCarrier,
            serviceCode: label.serviceCode || chosenService || null, serviceName: label.serviceName || null,
            fromName: shipper.name || '', fromAddr: shipper.address1 || '', fromCity: shipper.city || '',
            fromState: shipper.state || '', fromZip: shipper.zip || '',
            toName: recipient.name, toCompany: recipient.company || '', toAddr: recipient.address1,
            toAddr2: recipient.address2 || '', toCity: recipient.city, toState: recipient.state,
            toZip: recipient.zip, toPhone: recipient.phone, toEmail: recipient.email,
            residential: !!recipient.residential, weight: String(pkgForOrder.weight || ''),
            totalCharge: label.totalCharge || null, currency: label.currency || 'USD',
            ref: String(orderId), labelImage: label.labelImage || null, labelUrl: label.labelUrl || null,
            transactionId: label.transactionId || null, status: 'created',
          });
          await db.updateOrder(orderId, { status: 'shipped', trackingNumber: label.trackingNumber, trackingCarrier: chosenCarrier });
        } catch (dbErr) {
          console.error(`Batch: DB write failed for order ${orderId} (label still valid):`, dbErr.message);
        }

        // Push tracking back to the source channel (e.g. Shopify) — best-effort.
        await pushChannelFulfillment(sellerId, order, { trackingNumber: label.trackingNumber, carrier: chosenCarrier });

        result.success       = true;
        result.carrier       = chosenCarrier;
        result.service       = label.serviceName || chosenService;
        result.appliedRule   = appliedRule;
        result.weight        = pkgForOrder.weight;
        result.weightSource  = orderWeight > 0 ? 'items' : 'default';
        result.trackingNumber= label.trackingNumber;
        result.totalCharge   = label.totalCharge || null;
        result.currency      = label.currency || 'USD';
        result.labelImage    = label.labelImage || null;
        result.labelUrl      = label.labelUrl || null;
      } catch (err) {
        result.error = err.message;
      }
      return result;
    }

    // Limited concurrency so we don't hammer the carrier APIs.
    const CONCURRENCY = 3;
    const results = [];
    for (let i = 0; i < orderIds.length; i += CONCURRENCY) {
      const slice = orderIds.slice(i, i + CONCURRENCY);
      results.push(...await Promise.all(slice.map(processOrder)));
    }

    const succeeded = results.filter(r => r.success);
    const totalSpend = succeeded.reduce((sum, r) => sum + (parseFloat(r.totalCharge) || 0), 0);

    res.json({
      results,
      summary: {
        total:     results.length,
        succeeded: succeeded.length,
        failed:    results.length - succeeded.length,
        totalSpend: totalSpend.toFixed(2),
      },
    });
  } catch (err) {
    console.error('Batch labels error:', err);
    res.status(500).json({ error: 'Batch failed: ' + err.message });
  }
});

// MERGE LABELS — combine many purchased labels into one printable PDF.
// Takes tracking numbers, looks each label up in THIS seller's shipments
// (tenant-scoped; never trusts client-supplied URLs → no SSRF), and merges
// UPS GIFs + FedEx/USPS PDFs into a single 4×6-per-page document.
app.post('/api/shipping/labels/merge', requireAuth, async (req, res) => {
  try {
    const { trackingNumbers } = req.body;
    if (!Array.isArray(trackingNumbers) || trackingNumbers.length === 0) {
      return res.status(400).json({ error: 'trackingNumbers (non-empty array) is required.' });
    }

    const sources = [];
    for (const tn of trackingNumbers) {
      const ship = await db.getShipmentByTracking(tn);
      if (!ship || ship.sellerId !== req.seller.sellerId) continue; // skip unknown / other sellers
      if (!ship.labelImage && !ship.labelUrl) continue;             // nothing to print
      sources.push({ labelImage: ship.labelImage, labelUrl: ship.labelUrl, label: tn });
    }

    if (sources.length === 0) {
      return res.status(404).json({ error: 'No printable labels found for those tracking numbers.' });
    }

    const { pdf, merged, errors } = await mergeLabels(sources);
    if (merged === 0) {
      return res.status(502).json({ error: 'Could not build any labels.', details: errors });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="labels.pdf"');
    if (errors.length) res.setHeader('X-Merge-Warnings', String(errors.length));
    res.send(pdf);
  } catch (err) {
    console.error('Label merge error:', err);
    res.status(500).json({ error: 'Failed to merge labels: ' + err.message });
  }
});

// CREATE SHIPPING LABEL
app.post('/api/shipping/label', requireAuth, async (req, res) => {
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

    if (!['ups', 'fedex', 'usps'].includes(carrier)) {
      return res.status(400).json({ error: 'Unsupported carrier. Use ups, fedex, or usps.' });
    }

    // Bring-your-own-account: the label is created with THIS seller's own
    // carrier credentials, so the charge lands on their account, never the
    // platform's. No credentials = no shipping.
    const creds = await loadSellerCarrierCreds(req.seller.sellerId, carrier);
    if (!creds) return carrierNotConnected(res, carrier);
    const client = carriers.buildCarrier(carrier, creds);

    // Build billing info
    const billingInfo = billing || { type: '01' };

    // Create label with appropriate carrier
    let label;
    if(carrier === 'ups') {
      label = await client.createShipment({
        shipper, recipient,
        package: pkg,
        serviceCode: serviceCode || '03',
        labelFormat: labelFormat || 'GIF',
        reference: orderId,
        billing: billingInfo,
      });
    } else if(carrier === 'fedex') {
      label = await client.createShipment({
        shipper, recipient,
        package: pkg,
        serviceType: serviceType || 'FEDEX_GROUND',
        labelFormat: labelFormat || 'PDF',
        reference: orderId,
        billing: billingInfo,
      });
    } else { // usps
      label = await client.createShipment({
        shipper, recipient,
        package: pkg,
        serviceToken: serviceType || 'usps_priority',
        reference: orderId,
      });
    }

    // Save shipment record to the database for the Shipping History page.
    // We capture the full from/to addresses + label image so the history page
    // can reprint, void, and email customers without re-calling the carrier API.
    try {
      await db.createShipment({
        sellerId:       req.seller.sellerId,               // attribute to the logged-in seller
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

    // Post-label bookkeeping for a real/imported order: mark it shipped (so it
    // leaves the "awaiting label" tab — mirrors the batch flow) and, if it came
    // from a sales channel, push tracking back. Both best-effort; the label is
    // already valid and must not be undone by a bookkeeping failure.
    let channelPush = null;
    try {
      const oid = normalizeOrderId(orderId);
      if (oid !== null) {
        const ord = await db.getOrderById(oid);
        if (ord && ord.sellerId === req.seller.sellerId) {
          await db.updateOrder(oid, { status: 'shipped', trackingNumber: label.trackingNumber, trackingCarrier: carrier })
            .catch(e => console.error('Order status update failed (label still valid):', e.message));
          channelPush = await pushChannelFulfillment(req.seller.sellerId, ord, { trackingNumber: label.trackingNumber, carrier });
        }
      }
    } catch (e) { channelPush = { ok: false, error: e.message }; }

    console.log(`Label created: ${carrier.toUpperCase()} ${label.trackingNumber} for order ${orderId}`);
    res.json({ success: true, label, channelPush });

  } catch(err) {
    console.error('Create label error:', err);
    res.status(500).json({ error: 'Failed to create label: '+err.message });
  }
});

// CREATE RETURN LABEL
app.post('/api/shipping/return-label', requireAuth, async (req, res) => {
  try {
    const { carrier = 'ups', returnId, sellerAddress, customerAddress, pkg } = req.body;

    if(!sellerAddress || !customerAddress) {
      return res.status(400).json({ error: 'sellerAddress and customerAddress are required.' });
    }

    const creds = await loadSellerCarrierCreds(req.seller.sellerId, carrier);
    if (!creds) return carrierNotConnected(res, carrier);

    const label = await carriers.createReturnLabel(carrier, {
      shipper:   sellerAddress,   // Where it goes back to
      recipient: customerAddress, // Customer sending it back
      package:   pkg || { weight: 2, length: 12, width: 9, height: 4 },
      reference: `RETURN-${returnId}`,
    }, creds);

    console.log(`Return label created: ${carrier.toUpperCase()} ${label.trackingNumber}`);
    res.json({ success: true, label });

  } catch(err) {
    console.error('Return label error:', err);
    res.status(500).json({ error: 'Failed to create return label: '+err.message });
  }
});

// LIST RETURNS — real return requests buyers created via the /returns portal.
// Read-only: the prepaid label is auto-issued the moment the buyer submits
// (see POST /api/returns), so there is no "approve to generate a label" step.
app.get('/api/shipping/returns', requireAuth, async (req, res) => {
  try {
    const rows = await db.getReturnsBySeller(req.seller.sellerId);
    const returns = rows.map(r => {
      const info = r.orderCustomerInfo || {};
      const name = [info.firstName, info.lastName].filter(Boolean).join(' ')
        || info.name || r.customerEmail || 'Customer';
      const items = Array.isArray(r.items) ? r.items : [];
      const refund = items.reduce((sum, it) =>
        sum + (parseFloat(it.price) || 0) * (parseInt(it.qty) || 0), 0);
      return {
        id:             r.id,
        returnNumber:   `RET-${String(r.id).padStart(4, '0')}`,
        orderNumber:    `SS-${r.orderId}`,
        customerName:   name,
        customerEmail:  r.customerEmail,
        items,
        itemSummary:    items.map(it => `${it.name} × ${it.qty}`).join(', '),
        reason:         r.reason || '',
        refundAmount:   refund,
        status:         r.status,
        carrier:        r.carrier,
        trackingNumber: r.trackingNumber,
        labelUrl:       r.labelUrl,
        createdAt:      r.createdAt,
      };
    });
    res.json({ returns });
  } catch (err) {
    console.error('List returns error:', err);
    res.status(500).json({ error: 'Failed to load returns.' });
  }
});

// Update a return's status (seller marks it received / refunded / etc.).
app.patch('/api/shipping/returns/:id', requireAuth, async (req, res) => {
  try {
    const allowed = ['label_issued', 'in_transit', 'received', 'refunded', 'closed'];
    const { status } = req.body || {};
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }
    const updated = await db.updateReturnStatus(
      parseInt(req.params.id, 10), req.seller.sellerId, status);
    if (!updated) return res.status(404).json({ error: 'Return not found.' });
    res.json({ success: true, status: updated.status });
  } catch (err) {
    console.error('Update return error:', err);
    res.status(500).json({ error: 'Failed to update return.' });
  }
});

// TRACK SHIPMENT
app.get('/api/shipping/track/:carrier/:tracking', requireAuth, async (req, res) => {
  try {
    const { carrier, tracking } = req.params;
    const creds = await loadSellerCarrierCreds(req.seller.sellerId, carrier);
    if (!creds) return carrierNotConnected(res, carrier, 'tracking');
    const result = await carriers.track(carrier, tracking, creds);
    res.json(result);
  } catch(err) {
    console.error('Track error:', err);
    res.status(500).json({ error: 'Tracking failed: '+err.message });
  }
});

// SCHEDULE UPS PICKUP
app.post('/api/shipping/pickup', requireAuth, async (req, res) => {
  try {
    const { pickupDate, earliestTime, latestTime, address, packageCount, totalWeight } = req.body;

    if(!pickupDate || !address) {
      return res.status(400).json({ error: 'pickupDate and address are required.' });
    }

    const creds = await loadSellerCarrierCreds(req.seller.sellerId, 'ups');
    if (!creds) return carrierNotConnected(res, 'ups', 'scheduling a pickup');
    const ups = carriers.buildCarrier('ups', creds);

    const result = await ups.schedulePickup({
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
app.post('/api/shipping/validate-address', requireAuth, async (req, res) => {
  try {
    const { address1, city, state, zip } = req.body;
    if(!address1 || !city || !state || !zip) {
      return res.status(400).json({ error: 'Address fields required.' });
    }

    // Address validation runs against the seller's own UPS credentials.
    // If UPS isn't connected, don't block shipping — just skip validation.
    const creds = await loadSellerCarrierCreds(req.seller.sellerId, 'ups');
    if (!creds) {
      return res.json({ valid: true, message: 'Validation unavailable (UPS not connected) — proceeding.' });
    }
    const ups = carriers.buildCarrier('ups', creds);
    const token = await ups.getAccessToken();
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

    const apiRes = await nodeFetch(`${ups.apiUrl}/api/addressvalidation/v2/1`, {
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
app.post('/api/shipping/verify-account', requireAuth, async (req, res) => {
  try {
    const { accountNumber, zip } = req.body;
    if(!accountNumber) return res.status(400).json({ error: 'Account number required.' });

    // Verify using the seller's OWN connected UPS credentials — they must
    // connect UPS first. Account verification is a rate-shop against that account.
    const creds = await loadSellerCarrierCreds(req.seller.sellerId, 'ups');
    if (!creds) {
      return res.json({ valid: false, message: 'Connect your UPS account in Settings first.', carrierSetupRequired: true });
    }
    const ups = carriers.buildCarrier('ups', creds);
    const token = await ups.getAccessToken();
    const nodeFetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

    // Try a minimal rate-shop call to verify the account exists
    const res2 = await nodeFetch(`${ups.apiUrl}/api/rating/v2403/Shop`, {
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
app.post('/api/shipping/void', requireAuth, async (req, res) => {
  try {
    const { carrier, trackingNumber, transactionId } = req.body;

    if (!carrier || !trackingNumber) {
      return res.status(400).json({ error: 'carrier and trackingNumber are required.' });
    }

    // Ownership check: only let a seller void a label that belongs to them.
    const existing = await db.getShipmentByTracking(trackingNumber);
    if (!existing) {
      return res.status(404).json({ error: 'Shipment not found.' });
    }
    if (existing.sellerId !== req.seller.sellerId) {
      return res.status(403).json({ error: 'You do not own this shipment.' });
    }

    if (!['ups', 'fedex', 'usps'].includes(carrier)) {
      return res.status(400).json({ error: 'Unsupported carrier. Use ups, fedex, or usps.' });
    }

    // Void against the seller's own carrier credentials.
    const creds = await loadSellerCarrierCreds(req.seller.sellerId, carrier);
    if (!creds) return carrierNotConnected(res, carrier, 'voiding a label');
    const client = carriers.buildCarrier(carrier, creds);

    let result;

    if (carrier === 'ups') {
      result = await client.voidShipment(trackingNumber);
      result.carrier      = 'ups';
      result.action       = 'voided';
      result.userMessage  = 'UPS label voided. No charge applied since package was never scanned.';

    } else if (carrier === 'fedex') {
      result = await client.cancelShipment(trackingNumber);
      result.carrier      = 'fedex';
      result.action       = 'cancelled';
      result.userMessage  = 'FedEx label cancelled. No charge applied since package was never scanned.';

    } else { // usps
      // USPS via Shippo: requires the transactionId from when the label was created.
      // Shippo charges immediately on label purchase — refund is requested from USPS.
      if (!transactionId) {
        return res.status(400).json({
          error: 'USPS refunds require a transactionId. Pass the Shippo transactionId from when the label was created.'
        });
      }
      result = await client.refundLabel(transactionId);
      result.carrier      = 'usps';
      result.action       = 'refund_requested';
      result.userMessage  = 'Refund requested through Shippo. USPS reviews unused labels — refund typically issued in 14-21 days if approved.';
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

app.get('/api/shipping/history', requireAuth, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 200, 1000);
    const offset = parseInt(req.query.offset) || 0;

    // Scoped to the logged-in seller so one tenant never sees another's shipments.
    const shipments = await db.getShipmentsBySeller(req.seller.sellerId, { limit, offset });

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

    // Return label is created on the SELLER's own carrier account (the buyer
    // pays nothing, and it never bills the platform). If the seller hasn't
    // connected this carrier, we can't generate the label.
    const carrierCreds = await loadSellerCarrierCreds(order.sellerId, carrier);
    if (!carrierCreds) {
      return res.status(400).json({
        error: 'This seller has not connected a shipping carrier yet, so a return label cannot be generated. Please contact them directly.',
      });
    }

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
    }, carrierCreds);

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

// Health check for the platform (Railway healthcheckPath). Verifies the DB is
// actually reachable, not just that the process is up — returns 503 if the
// Postgres pool can't answer, so the platform holds traffic off a broken deploy.
app.get('/health', async (req, res) => {
  try {
    await db.pool.query('SELECT 1');
    res.json({
      status:    'ok',
      db:        'ok',
      timestamp: new Date().toISOString(),
      env:       process.env.NODE_ENV || 'development',
    });
  } catch (err) {
    res.status(503).json({
      status:    'degraded',
      db:        'unreachable',
      timestamp: new Date().toISOString(),
      env:       process.env.NODE_ENV || 'development',
    });
  }
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

// Wait for the schema to be created/migrated before accepting traffic, so a
// cold boot against a fresh Postgres never serves requests against missing
// tables. If schema init fails, exit non-zero and let the platform restart us
// with backoff rather than run in a broken state.
db.schemaReady
  .then(() => {
    app.listen(PORT, () => {
      console.log(`
╔══════════════════════════════════════════╗
║   ShopSell Server running on port ${PORT}   ║
║   ENV: ${(process.env.NODE_ENV||'development').padEnd(34)}║
║   Stripe: ${process.env.STRIPE_SECRET_KEY ? 'Connected ✓' : 'NOT CONNECTED ✗'.padEnd(30)}║
╚══════════════════════════════════════════╝
  `);
    });
  })
  .catch(err => {
    console.error('Fatal: schema initialization failed, not starting server.', err);
    process.exit(1);
  });

module.exports = app;
