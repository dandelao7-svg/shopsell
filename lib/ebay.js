'use strict';

// eBay Sell API integration (per-seller OAuth user token).
// Sellers connect via the authorization-code grant; we store the resulting
// user access token + long-lived refresh token (encrypted). Orders come from
// the Fulfillment API; buying a label pushes a shipping fulfillment back.
//
// eBay quirks vs Shopify:
//  - OAuth `redirect_uri` is the app's RuName, NOT the literal callback URL
//    (the real URL is mapped to the RuName in the eBay developer portal).
//  - Refresh tokens do NOT rotate — a refresh returns only a new access token,
//    so the same refresh token is reused until it lapses (~18 months).
//  - Order items carry a lineItemId (needed to push a fulfillment), not weight.

const API_BASE     = 'https://api.ebay.com';
const OAUTH_AUTHZ  = 'https://auth.ebay.com/oauth2/authorize';
const TOKEN_URL    = 'https://api.ebay.com/identity/v1/oauth2/token';
const IDENTITY_URL = 'https://apiz.ebay.com/commerce/identity/v1/user/';
const DEFAULT_MARKETPLACE = 'EBAY_US';

const nodeFetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

function basicAuth(clientId, clientSecret) {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

async function ebayFetch(accessToken, path, opts = {}) {
  return nodeFetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': DEFAULT_MARKETPLACE,
      ...(opts.headers || {}),
    },
  });
}

// ── OAuth ─────────────────────────────────────────────────────
// Consent URL. Note `redirect_uri` is the RuName, and scopes are space-joined.
function buildInstallUrl({ clientId, scopes, ruName, state }) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: ruName,
    response_type: 'code',
    scope: scopes,
    state,
  });
  return `${OAUTH_AUTHZ}?${p.toString()}`;
}

function normalizeToken(data, fallbackRefresh) {
  return {
    accessToken:           data.access_token,
    refreshToken:          data.refresh_token || fallbackRefresh || null,
    expiresIn:             data.expires_in || null,                 // seconds (~7200)
    refreshTokenExpiresIn: data.refresh_token_expires_in || null,   // seconds (~18 months)
    scope:                 data.scope,
  };
}

// Exchange the authorization code for a user access + refresh token.
async function exchangeCodeForToken({ clientId, clientSecret, ruName, code }) {
  const res = await nodeFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Authorization': basicAuth(clientId, clientSecret), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: ruName }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`eBay token exchange failed (${res.status})${data.error_description ? ': ' + data.error_description : ''}`);
  }
  return normalizeToken(data);
}

// Renew a user access token. eBay refresh tokens do NOT rotate, so we carry the
// existing refresh token forward (the response omits it).
async function refreshUserToken({ clientId, clientSecret, refreshToken, scopes }) {
  const res = await nodeFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Authorization': basicAuth(clientId, clientSecret), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, scope: scopes }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`eBay token refresh failed (${res.status})${data.error_description ? ': ' + data.error_description : ''}`);
  }
  return normalizeToken(data, refreshToken);
}

// Best-effort seller identity for a friendly connection label. Returns null if
// the identity scope wasn't granted or the call fails — never throws.
async function getSellerIdentity(accessToken) {
  try {
    const res = await nodeFetch(IDENTITY_URL, { headers: { 'Authorization': `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const d = await res.json();
    const email = d.individualAccount?.email || d.businessAccount?.email || '';
    return { username: d.username || d.userId || '', email };
  } catch { return null; }
}

// Verify a token works by hitting the Fulfillment API. Returns { ok, username }.
async function verifyConnection({ accessToken }) {
  if (!accessToken) throw new Error('An eBay access token is required.');
  const res = await ebayFetch(accessToken, '/sell/fulfillment/v1/order?limit=1');
  if (res.status === 401 || res.status === 403) {
    const t = await res.text().catch(() => '');
    throw new Error(`eBay rejected the token — check that sell.fulfillment access was granted.${t ? ' ' + t.slice(0, 200) : ''}`);
  }
  if (!res.ok) throw new Error(`eBay returned ${res.status} verifying the connection.`);
  const ident = await getSellerIdentity(accessToken);
  return { ok: true, username: ident?.username || '' };
}

// ── Orders ────────────────────────────────────────────────────
// Pull unfulfilled, paid orders (NOT_STARTED + IN_PROGRESS), paginated by
// offset. Returns RAW eBay order objects; the caller maps them.
async function fetchUnfulfilledOrders({ accessToken }, { maxPages = 10, limit = 200 } = {}) {
  const filter = encodeURIComponent('orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}');
  const orders = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const res = await ebayFetch(accessToken, `/sell/fulfillment/v1/order?filter=${filter}&limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`eBay orders fetch failed (${res.status})${detail ? ': ' + detail.slice(0, 300) : ''}`);
    }
    const data = await res.json();
    const batch = data.orders || [];
    orders.push(...batch);
    offset += batch.length;
    if (!data.next || batch.length < limit || offset >= (data.total || 0)) break;
  }
  return orders;
}

// Map an eBay order to our canonical order shape. eBay doesn't return item
// weight, so weight is null (label flow falls back to the batch default). The
// lineItemId is stashed as externalItemId — the fulfillment push needs it.
function mapEbayOrder(o) {
  const shipTo = o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo || {};
  const addr   = shipTo.contactAddress || {};
  const nameParts = (shipTo.fullName || '').split(' ');
  const items = (o.lineItems || []).map(li => ({
    name:           li.title || li.sku || 'Item',
    sku:            li.sku || '',
    qty:            li.quantity || 1,
    price:          parseFloat(li.lineItemCost?.value) || 0,
    weight:         null,
    productId:      null,
    externalItemId: li.lineItemId, // needed to push a shipping fulfillment
  }));
  return {
    externalId:          String(o.orderId),
    externalOrderNumber: o.legacyOrderId ? `#${o.legacyOrderId}` : String(o.orderId),
    customerEmail:       shipTo.email || '',
    customerInfo: {
      firstName: nameParts[0] || '',
      lastName:  nameParts.slice(1).join(' ') || '',
      name:      shipTo.fullName || '',
      company:   '',
      phone:     shipTo.primaryPhone?.phoneNumber || '',
      address1:  addr.addressLine1 || '',
      address2:  addr.addressLine2 || '',
      city:      addr.city || '',
      state:     addr.stateOrProvince || '',
      zip:       addr.postalCode || '',
      country:   addr.countryCode || 'US',
      email:     shipTo.email || '',
    },
    items,
    subtotal: parseFloat(o.pricingSummary?.priceSubtotal?.value) || 0,
    tax:      parseFloat(o.pricingSummary?.tax?.value) || 0,
    total:    parseFloat(o.pricingSummary?.total?.value) || 0,
  };
}

// ── Fulfillment push-back ─────────────────────────────────────
// Create a shipping fulfillment (tracking) for the order's line items. Takes
// the whole order because eBay needs the lineItemIds. carrierName is a display
// carrier ('UPS' | 'FedEx' | 'USPS'), which is also eBay's shippingCarrierCode.
async function createFulfillment({ accessToken }, order, { trackingNumber, carrierName }) {
  const lineItems = (order.items || [])
    .filter(it => it.externalItemId)
    .map(it => ({ lineItemId: it.externalItemId, quantity: Number(it.qty) || 1 }));
  if (!lineItems.length) throw new Error('No eBay line-item ids to fulfill.');

  const body = {
    lineItems,
    shippedDate:         new Date().toISOString(),
    shippingCarrierCode: carrierName,   // 'UPS' | 'FedEx' | 'USPS'
    trackingNumber,
  };
  const res = await ebayFetch(accessToken, `/sell/fulfillment/v1/order/${encodeURIComponent(order.externalId)}/shipping_fulfillment`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`eBay fulfillment failed (${res.status})${t ? ': ' + t.slice(0, 200) : ''}`);
  }
  return { ok: true };
}

module.exports = {
  buildInstallUrl, exchangeCodeForToken, refreshUserToken, getSellerIdentity,
  verifyConnection, fetchUnfulfilledOrders, mapEbayOrder, createFulfillment,
  API_BASE, DEFAULT_MARKETPLACE,
};
