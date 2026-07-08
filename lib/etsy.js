'use strict';

// Etsy Open API v3 integration (per-seller OAuth user token, PKCE).
// Sellers connect via authorization-code + PKCE (no client secret); we store
// the resulting access token + refresh token (encrypted) and the resolved
// shop_id. Orders are Etsy "receipts"; buying a label posts tracking back.
//
// Etsy quirks vs Shopify/eBay:
//  - OAuth is PKCE (code_verifier/code_challenge), no client secret. The app's
//    keystring is the client_id AND the required `x-api-key` header on EVERY
//    request (alongside the Bearer token).
//  - The access token is "<user_id>.<token>" — the numeric prefix is the user.
//  - Orders live under a shop_id, resolved once at connect via the user id.
//  - Money is an { amount, divisor, currency_code } object (value=amount/divisor).

const crypto = require('crypto');
const nodeFetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const API         = 'https://api.etsy.com/v3/application';
const TOKEN_URL   = 'https://api.etsy.com/v3/public/oauth/token';
const CONNECT_URL = 'https://www.etsy.com/oauth/connect';

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function money(m) {
  return m && m.amount != null && m.divisor ? m.amount / m.divisor : 0;
}
// user_id is the prefix of "<user_id>.<token>".
function userIdFromToken(accessToken) {
  return String(accessToken || '').split('.')[0];
}

async function etsyFetch({ keystring, accessToken }, path, opts = {}) {
  return nodeFetch(`${API}${path}`, {
    ...opts,
    headers: {
      'x-api-key': keystring,
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

// ── OAuth (PKCE) ──────────────────────────────────────────────
// A fresh verifier/challenge pair per install. The verifier must be stored
// (we ride it in the signed state JWT) to complete the token exchange.
function generatePkce() {
  const codeVerifier = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function buildInstallUrl({ keystring, scopes, redirectUri, state, codeChallenge }) {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: keystring,
    redirect_uri: redirectUri,
    scope: scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${CONNECT_URL}?${p.toString()}`;
}

function normalizeToken(data, fallbackRefresh) {
  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token || fallbackRefresh || null,
    expiresIn:    data.expires_in || null, // seconds (~3600)
  };
}

async function exchangeCodeForToken({ keystring, redirectUri, code, codeVerifier }) {
  const res = await nodeFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: keystring,
      redirect_uri: redirectUri, code, code_verifier: codeVerifier,
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Etsy token exchange failed (${res.status})${data.error_description ? ': ' + data.error_description : ''}`);
  }
  return normalizeToken(data);
}

async function refreshAccessToken({ keystring, refreshToken }) {
  const res = await nodeFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: keystring, refresh_token: refreshToken,
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Etsy token refresh failed (${res.status})${data.error_description ? ': ' + data.error_description : ''}`);
  }
  return normalizeToken(data, refreshToken);
}

// Resolve the seller's shop from the token's user id. Returns { shopId, shopName }.
async function getShop({ keystring, accessToken }) {
  const userId = userIdFromToken(accessToken);
  if (!userId) throw new Error('Could not read the Etsy user id from the token.');
  const res = await etsyFetch({ keystring, accessToken }, `/users/${userId}/shops`);
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Etsy shop lookup failed (${res.status})${t ? ': ' + t.slice(0, 200) : ''}`);
  }
  const d = await res.json();
  // getShopByOwnerUserId returns the shop object directly (some responses wrap
  // it in results[]); handle both.
  const shop = Array.isArray(d.results) ? d.results[0] : d;
  if (!shop || !shop.shop_id) throw new Error('No Etsy shop found for this account.');
  return { shopId: shop.shop_id, shopName: shop.shop_name || '' };
}

async function verifyConnection(creds) {
  if (!creds.accessToken) throw new Error('An Etsy access token is required.');
  const { shopId, shopName } = await getShop(creds);
  return { ok: true, shopId, shopName };
}

// ── Orders (receipts) ─────────────────────────────────────────
// Pull paid, unshipped receipts, paginated by offset. Returns RAW receipts.
async function fetchUnshippedReceipts(creds, { maxPages = 10, limit = 100 } = {}) {
  const receipts = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const res = await etsyFetch(creds, `/shops/${creds.shopId}/receipts?was_paid=true&was_shipped=false&limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Etsy receipts fetch failed (${res.status})${detail ? ': ' + detail.slice(0, 300) : ''}`);
    }
    const data = await res.json();
    const batch = data.results || [];
    receipts.push(...batch);
    offset += batch.length;
    if (batch.length < limit || offset >= (data.count || 0)) break;
  }
  return receipts;
}

// Map an Etsy receipt to our canonical order shape. Etsy doesn't return item
// weight (weight null → label flow uses the batch default). Push-back is
// per-receipt, so items need no external id.
function mapEtsyReceipt(r) {
  const nameParts = (r.name || '').split(' ');
  const items = (r.transactions || []).map(t => ({
    name:      t.title || 'Item',
    sku:       t.sku || '',
    qty:       t.quantity || 1,
    price:     money(t.price),
    weight:    null,
    productId: null,
  }));
  return {
    externalId:          String(r.receipt_id),
    externalOrderNumber: `#${r.receipt_id}`,
    customerEmail:       r.buyer_email || '',
    customerInfo: {
      firstName: nameParts[0] || '',
      lastName:  nameParts.slice(1).join(' ') || '',
      name:      r.name || '',
      company:   '',
      phone:     '',
      address1:  r.first_line || '',
      address2:  r.second_line || '',
      city:      r.city || '',
      state:     r.state || '',
      zip:       r.zip || '',
      country:   r.country_iso || 'US',
      email:     r.buyer_email || '',
    },
    items,
    subtotal: money(r.subtotal),
    tax:      money(r.total_tax_cost),
    total:    money(r.grandtotal),
  };
}

// ── Fulfillment push-back ─────────────────────────────────────
// Mark the receipt shipped with tracking. carrierName ('UPS'|'FedEx'|'USPS')
// maps to Etsy's lowercase carrier slug; send_bcc emails the buyer.
async function createFulfillment(creds, order, { trackingNumber, carrierName }) {
  const res = await etsyFetch(creds, `/shops/${creds.shopId}/receipts/${encodeURIComponent(order.externalId)}/tracking`, {
    method: 'POST',
    body: JSON.stringify({
      tracking_code: trackingNumber,
      carrier_name:  String(carrierName || '').toLowerCase(), // 'ups' | 'fedex' | 'usps'
      send_bcc:      true,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Etsy fulfillment failed (${res.status})${t ? ': ' + t.slice(0, 200) : ''}`);
  }
  return { ok: true };
}

module.exports = {
  generatePkce, buildInstallUrl, exchangeCodeForToken, refreshAccessToken,
  getShop, verifyConnection, fetchUnshippedReceipts, mapEtsyReceipt, createFulfillment,
  API,
};
