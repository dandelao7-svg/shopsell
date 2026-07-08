'use strict';

// TikTok Shop Open API integration (per-seller OAuth token + HMAC-signed calls).
// Sellers authorize the app; we store the access/refresh tokens + the shop's
// `cipher` (encrypted). Orders come from the Order API; buying a label pushes a
// package with tracking back to TikTok.
//
// TikTok Shop specifics vs the other channels:
//  - TWO hosts: business API on open-api.tiktokglobalshop.com (every request is
//    HMAC-signed); OAuth/token on auth.tiktok-shops.com (unsigned, query-only).
//  - Every business request needs app_key + timestamp(sec) + sign in the query,
//    the access token in the `x-tts-access-token` HEADER, and (except on
//    /authorization/* and /seller/*) the shop's `shop_cipher` in the query.
//  - Signature: HMAC-SHA256, key=app_secret, over
//    app_secret + path + Σ(sortedKey+value) + rawBody + app_secret  (body only
//    for non-GET, non-multipart). access_token / sign are excluded from signing.
//  - Fulfillment is resolve-provider → create-package-with-tracking.

const crypto = require('crypto');
const nodeFetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const API_HOST  = 'https://open-api.tiktokglobalshop.com';
const AUTH_HOST = 'https://auth.tiktok-shops.com';
const VERSION   = '202309';

function nowSec() { return Math.floor(Date.now() / 1000); }

// Compute the `sign` query param. `query` is every query param we'll send
// (app_key, timestamp, shop_cipher, page_size, …); bodyString is the exact JSON
// string transmitted (or '' for GET). Path is version-prefixed, no host/query.
function sign(path, query, bodyString, appSecret, method) {
  const params = { ...query };
  delete params.sign; delete params.access_token; delete params['x-tts-access-token'];
  let s = path;
  for (const k of Object.keys(params).sort()) {
    if (Array.isArray(params[k])) continue;     // arrays are skipped in signing
    s += k + params[k];                          // {key}{value}, no separator
  }
  if (method.toUpperCase() !== 'GET') s += bodyString || ''; // append raw body
  s = appSecret + s + appSecret;                 // wrap both ends
  return crypto.createHmac('sha256', appSecret).update(s, 'utf8').digest('hex');
}

// Signed business-API request. creds: { appKey, appSecret, accessToken, shopCipher }.
// `action` is the path tail (e.g. 'orders/search' or `orders/${id}/packages`).
// shop_cipher is attached automatically unless the category is exempt.
async function ttRequest(creds, method, category, action, { query = {}, body = null } = {}) {
  const path = `/${category}/${VERSION}/${action}`;
  const cipherExempt = category === 'authorization' || category === 'seller';
  const q = { app_key: creds.appKey, timestamp: nowSec(), ...query };
  if (!cipherExempt && creds.shopCipher) q.shop_cipher = creds.shopCipher;
  const bodyString = body != null ? JSON.stringify(body) : '';
  q.sign = sign(path, q, bodyString, creds.appSecret, method);

  const url = `${API_HOST}${path}?${new URLSearchParams(q).toString()}`;
  const res = await nodeFetch(url, {
    method,
    headers: {
      'x-tts-access-token': creds.accessToken,
      'Content-Type': 'application/json',
    },
    body: method.toUpperCase() === 'GET' ? undefined : bodyString,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 0) {
    throw new Error(`TikTok ${category}/${action} failed (${res.status}, code ${data.code})${data.message ? ': ' + data.message : ''}`);
  }
  return data.data || {};
}

// ── OAuth / tokens (unsigned, AUTH host) ──────────────────────
// Seller consent URL; TikTok redirects to the app's registered URL with
// ?code=<auth_code>&state=<state>.
function buildInstallUrl({ appKey, state }) {
  const p = new URLSearchParams({ app_key: appKey, state });
  return `${AUTH_HOST}/oauth/authorize?${p.toString()}`;
}

function normalizeToken(data) {
  // *_expire_in are absolute Unix seconds; guard in case a duration is returned.
  const toMs = (v) => (v ? (v > 1e9 ? v * 1000 : Date.now() + v * 1000) : null);
  return {
    accessToken:           data.access_token,
    refreshToken:          data.refresh_token || null,
    accessTokenExpiresAt:  toMs(data.access_token_expire_in),
    refreshTokenExpiresAt: toMs(data.refresh_token_expire_in),
    sellerName:            data.seller_name || null,
  };
}

async function tokenCall(pathQuery) {
  const res = await nodeFetch(`${AUTH_HOST}${pathQuery}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 0 || !data.data?.access_token) {
    throw new Error(`TikTok token call failed (${res.status}, code ${data.code})${data.message ? ': ' + data.message : ''}`);
  }
  return normalizeToken(data.data);
}

async function getToken({ appKey, appSecret, authCode }) {
  const q = new URLSearchParams({ app_key: appKey, app_secret: appSecret, auth_code: authCode, grant_type: 'authorized_code' });
  return tokenCall(`/api/v2/token/get?${q.toString()}`);
}

async function refreshToken({ appKey, appSecret, refreshToken }) {
  const q = new URLSearchParams({ app_key: appKey, app_secret: appSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
  return tokenCall(`/api/v2/token/refresh?${q.toString()}`);
}

// ── Shop resolution ───────────────────────────────────────────
// List the seller's authorized shops; the `cipher` is the shop_cipher used on
// every subsequent order/fulfillment call. Returns the first shop.
async function getShop(creds) {
  const data = await ttRequest(creds, 'GET', 'authorization', 'shops');
  const shop = (data.shops || [])[0];
  if (!shop || !shop.cipher) throw new Error('No authorized TikTok shop found for this account.');
  return { shopId: shop.id, shopCipher: shop.cipher, shopName: shop.name || '' };
}

async function verifyConnection(creds) {
  const shop = await getShop(creds);
  return { ok: true, ...shop };
}

// ── Orders ────────────────────────────────────────────────────
// Pull AWAITING_SHIPMENT orders, paginated via next_page_token. Returns RAW
// TikTok order objects (search already returns full order bodies).
async function fetchUnfulfilledOrders(creds, { maxPages = 10, pageSize = 50 } = {}) {
  const orders = [];
  let pageToken = '';
  for (let page = 0; page < maxPages; page++) {
    const query = { page_size: pageSize };
    if (pageToken) query.page_token = pageToken;
    const data = await ttRequest(creds, 'POST', 'order', 'orders/search', {
      query, body: { order_status: 'AWAITING_SHIPMENT' },
    });
    orders.push(...(data.orders || []));
    pageToken = data.next_page_token || '';
    if (!pageToken) break;
  }
  return orders;
}

// Map a TikTok order to our canonical order shape. TikTok returns ONE line_item
// per unit, so we aggregate by sku for display while keeping every line_item id
// (needed to ship). No item weight → weight null (batch default applies).
function mapTikTokOrder(o) {
  const addr = o.recipient_address || {};
  const nameParts = (addr.name || '').split(' ');
  const groups = new Map();
  for (const li of (o.line_items || [])) {
    const key = li.seller_sku || li.sku_id || li.product_name || li.id;
    const g = groups.get(key) || {
      name: li.product_name || li.sku_name || 'Item',
      sku: li.seller_sku || '',
      qty: 0,
      price: parseFloat(li.sale_price) || 0,
      weight: null,
      productId: null,
      externalItemIds: [],
    };
    g.qty += 1;
    g.externalItemIds.push(li.id);
    groups.set(key, g);
  }
  const pay = o.payment || {};
  return {
    externalId:          String(o.id),
    externalOrderNumber: `#${o.id}`,
    customerEmail:       '',
    customerInfo: {
      firstName: nameParts[0] || '',
      lastName:  nameParts.slice(1).join(' ') || '',
      name:      addr.name || '',
      company:   '',
      phone:     addr.phone_number || '',
      address1:  addr.first_line_address || '',
      address2:  addr.second_line_address || '',
      city:      addr.city || '',
      state:     addr.state || '',
      zip:       addr.postal_code || addr.zipcode || '',
      country:   addr.region_code || 'US',
      email:     '',
    },
    items: [...groups.values()],
    subtotal: parseFloat(pay.sub_total) || 0,
    tax:      parseFloat(pay.tax) || 0,
    total:    parseFloat(pay.total_amount) || 0,
  };
}

// ── Fulfillment push-back ─────────────────────────────────────
// Resolve a shipping_provider_id for the order, preferring one whose name
// matches our carrier ('UPS'|'FedEx'|'USPS'); fall back to the first eligible.
async function resolveShippingProviderId(creds, orderId, carrierName) {
  const data = await ttRequest(creds, 'POST', 'fulfillment', `orders/${orderId}/shipping_services/query`, { body: {} });
  const services = data.shipping_services || data.available_shipping_services || [];
  const want = String(carrierName || '').toLowerCase();
  const match = services.find(s => String(s.shipping_provider_name || '').toLowerCase().includes(want));
  const chosen = match || services[0];
  if (!chosen || !chosen.shipping_provider_id) throw new Error('No eligible TikTok shipping provider for this order.');
  return chosen.shipping_provider_id;
}

// Mark the order shipped by creating a package with the tracking number.
async function createFulfillment(creds, order, { trackingNumber, carrierName }) {
  const lineItemIds = (order.items || [])
    .flatMap(i => i.externalItemIds || (i.externalItemId ? [i.externalItemId] : []));
  if (!lineItemIds.length) throw new Error('No TikTok line-item ids to fulfill.');
  const shippingProviderId = await resolveShippingProviderId(creds, order.externalId, carrierName);
  await ttRequest(creds, 'POST', 'fulfillment', `orders/${order.externalId}/packages`, {
    body: {
      tracking_number: trackingNumber,
      shipping_provider_id: shippingProviderId,
      order_line_item_ids: lineItemIds,
    },
  });
  return { ok: true };
}

module.exports = {
  sign, buildInstallUrl, getToken, refreshToken, getShop, verifyConnection,
  fetchUnfulfilledOrders, mapTikTokOrder, createFulfillment,
  API_HOST, AUTH_HOST, VERSION,
};
