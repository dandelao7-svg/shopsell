'use strict';

// Shopify Admin API integration (custom-app access token, per seller).
// Sellers create a custom app in their Shopify admin, grant read_orders +
// write_merchant_managed_fulfillment_orders, and paste the Admin API token.

const API_VERSION = '2025-01';
const GRAMS_PER_OZ = 28.3495;
const nodeFetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// Normalize a shop domain to "<store>.myshopify.com" (strip protocol/path).
function normalizeShopDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (d && !d.includes('.')) d = `${d}.myshopify.com`;
  return d;
}

async function shopifyFetch(shopDomain, accessToken, path, opts = {}) {
  const url = `https://${shopDomain}/admin/api/${API_VERSION}${path}`;
  const res = await nodeFetch(url, {
    ...opts,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  return res;
}

// Verify creds by fetching the shop. Returns { ok, shopName } or throws.
async function verifyConnection({ shopDomain, accessToken }) {
  const domain = normalizeShopDomain(shopDomain);
  if (!domain) throw new Error('A Shopify store domain is required.');
  if (!accessToken) throw new Error('An Admin API access token is required.');
  const res = await shopifyFetch(domain, accessToken, '/shop.json');
  if (res.status === 401 || res.status === 403) {
    throw new Error('Shopify rejected the token — check the token and that it has read_orders access.');
  }
  if (!res.ok) throw new Error(`Shopify returned ${res.status} for ${domain}.`);
  const data = await res.json();
  return { ok: true, shopName: data?.shop?.name || domain, domain };
}

// Pull unfulfilled, open orders (paginated via the Link header). Capped so a
// huge backlog can't run away on a manual sync.
async function fetchUnfulfilledOrders({ shopDomain, accessToken }, { maxPages = 10 } = {}) {
  const domain = normalizeShopDomain(shopDomain);
  let path = '/orders.json?status=open&fulfillment_status=unfulfilled&limit=250';
  const orders = [];
  for (let page = 0; page < maxPages && path; page++) {
    const res = await shopifyFetch(domain, accessToken, path);
    if (!res.ok) {
      // Surface Shopify's own explanation — a 403 here is usually either a
      // missing read_orders scope or missing Protected Customer Data Access,
      // and only the body says which.
      const detail = await res.text().catch(() => '');
      throw new Error(`Shopify orders fetch failed (${res.status})${detail ? ': ' + detail.slice(0, 300) : ''}`);
    }
    const data = await res.json();
    orders.push(...(data.orders || []));
    // Follow the Link: <...>; rel="next" cursor if present.
    const link = res.headers.get('link') || res.headers.get('Link') || '';
    const next = /<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/.exec(link);
    path = next ? `/orders.json?limit=250&page_info=${next[1]}` : null;
  }
  return orders;
}

// Map a Shopify order to our order shape. Item weights come back in grams and
// are converted to OUNCES to match how our own product weights are stored.
function mapShopifyOrder(o) {
  const sa = o.shipping_address || o.billing_address || {};
  const items = (o.line_items || []).map(li => ({
    name:      li.title + (li.variant_title ? ` — ${li.variant_title}` : ''),
    sku:       li.sku || '',
    qty:       li.quantity || 1,
    price:     parseFloat(li.price) || 0,
    weight:    li.grams ? +(li.grams / GRAMS_PER_OZ).toFixed(2) : null, // ounces
    productId: null, // Shopify product, not one of ours
  }));
  return {
    externalId:          String(o.id),
    externalOrderNumber: o.name || `#${o.order_number || o.id}`,
    customerEmail:       o.email || o.contact_email || '',
    customerInfo: {
      firstName: sa.first_name || '',
      lastName:  sa.last_name || '',
      name:      sa.name || [sa.first_name, sa.last_name].filter(Boolean).join(' '),
      company:   sa.company || '',
      phone:     sa.phone || o.phone || '',
      address1:  sa.address1 || '',
      address2:  sa.address2 || '',
      city:      sa.city || '',
      state:     sa.province_code || sa.province || '',
      zip:       sa.zip || '',
      country:   sa.country_code || 'US',
      email:     o.email || '',
    },
    items,
    subtotal: parseFloat(o.subtotal_price ?? o.total_price) || 0,
    tax:      parseFloat(o.total_tax) || 0,
    total:    parseFloat(o.total_price) || 0,
  };
}

// Mark a Shopify order fulfilled with tracking (Fulfillment Orders API).
// carrierName: 'UPS' | 'FedEx' | 'USPS' (Shopify recognizes these).
async function createFulfillment({ shopDomain, accessToken }, shopifyOrderId, { trackingNumber, carrierName, trackingUrl }) {
  const domain = normalizeShopDomain(shopDomain);

  // 1. Find the order's open fulfillment orders (what we're allowed to fulfill).
  const foRes = await shopifyFetch(domain, accessToken, `/orders/${shopifyOrderId}/fulfillment_orders.json`);
  if (!foRes.ok) throw new Error(`Could not load fulfillment orders (${foRes.status}).`);
  const foData = await foRes.json();
  const open = (foData.fulfillment_orders || []).filter(fo => ['open', 'in_progress'].includes(fo.status));
  if (!open.length) throw new Error('No open fulfillment orders (already fulfilled?).');

  // 2. Create the fulfillment with tracking, notifying the customer.
  const body = {
    fulfillment: {
      line_items_by_fulfillment_order: open.map(fo => ({ fulfillment_order_id: fo.id })),
      tracking_info: {
        number:  trackingNumber,
        company: carrierName || undefined,
        url:     trackingUrl || undefined,
      },
      notify_customer: true,
    },
  };
  const res = await shopifyFetch(domain, accessToken, '/fulfillments.json', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Shopify fulfillment failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return { ok: true };
}

const crypto = require('crypto');

// ── OAuth (public app install) ────────────────────────────────
// Build the merchant consent URL. Omitting grant_options[] yields a permanent
// offline access token.
function buildInstallUrl(shop, { apiKey, scopes, redirectUri, state }) {
  const domain = normalizeShopDomain(shop);
  const p = new URLSearchParams({ client_id: apiKey, scope: scopes, redirect_uri: redirectUri, state });
  return `https://${domain}/admin/oauth/authorize?${p.toString()}`;
}

// Verify the OAuth callback query: HMAC-SHA256 (hex) of the sorted params
// (minus hmac/signature) with the app secret.
function verifyOAuthHmac(query, apiSecret) {
  const { hmac, signature, ...rest } = query;
  if (!hmac || !apiSecret) return false;
  const message = Object.keys(rest).sort()
    .map(k => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`).join('&');
  const digest = crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
  const a = Buffer.from(digest), b = Buffer.from(String(hmac));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Normalize a token-endpoint response into our token shape. Expiring offline
// tokens carry expires_in + a rotating refresh_token (+ its own lifetime);
// legacy non-expiring tokens carry none of these (fields come back null).
function normalizeTokenResponse(data, domain, fallbackRefresh) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || fallbackRefresh || null,
    expiresIn: data.expires_in || null,                          // seconds
    refreshTokenExpiresIn: data.refresh_token_expires_in || null, // seconds
    scope: data.scope,
    domain,
  };
}

// Exchange the authorization code for an EXPIRING offline access token.
// `expiring: 1` is required — Shopify no longer accepts non-expiring offline
// tokens on the Admin API. The response includes a refresh_token used to renew
// the access token without further merchant interaction.
async function exchangeCodeForToken(shop, { apiKey, apiSecret, code }) {
  const domain = normalizeShopDomain(shop);
  const res = await nodeFetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code, expiring: 1 }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Token exchange failed (${res.status}).`);
  return normalizeTokenResponse(data, domain);
}

// Renew an expiring offline access token using its refresh token. Refresh
// tokens ROTATE — the response carries a new access token AND a new refresh
// token, both of which the caller must persist.
async function refreshOfflineToken(shop, { apiKey, apiSecret, refreshToken }) {
  const domain = normalizeShopDomain(shop);
  const res = await nodeFetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: apiKey, client_secret: apiSecret,
      grant_type: 'refresh_token', refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Token refresh failed (${res.status}).`);
  return normalizeTokenResponse(data, domain, refreshToken);
}

// Verify a webhook came from Shopify: HMAC-SHA256 of the raw body with the
// app's API secret, base64, compared constant-time to the header.
function verifyWebhookHmac(rawBody, hmacHeader, apiSecret) {
  if (!hmacHeader || !apiSecret) return false;
  const digest = crypto.createHmac('sha256', apiSecret)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '', 'utf8'))
    .digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(hmacHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Register the orders/create webhook if one for this address doesn't already
// exist. Returns the webhook id (existing or new). Idempotent.
async function ensureOrderWebhook({ shopDomain, accessToken }, callbackUrl) {
  const domain = normalizeShopDomain(shopDomain);
  const listRes = await shopifyFetch(domain, accessToken, '/webhooks.json?topic=orders/create&limit=250');
  if (listRes.ok) {
    const { webhooks = [] } = await listRes.json();
    const found = webhooks.find(w => w.address === callbackUrl);
    if (found) return found.id;
  }
  const res = await shopifyFetch(domain, accessToken, '/webhooks.json', {
    method: 'POST',
    body: JSON.stringify({ webhook: { topic: 'orders/create', address: callbackUrl, format: 'json' } }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Could not register webhook (${res.status}): ${t.slice(0, 200)}`);
  }
  const { webhook } = await res.json();
  return webhook?.id || null;
}

// Remove any orders/create webhooks pointing at our address (disconnect cleanup).
async function removeOrderWebhooks({ shopDomain, accessToken }, callbackUrl) {
  const domain = normalizeShopDomain(shopDomain);
  const listRes = await shopifyFetch(domain, accessToken, '/webhooks.json?topic=orders/create&limit=250');
  if (!listRes.ok) return;
  const { webhooks = [] } = await listRes.json();
  for (const w of webhooks) {
    if (!callbackUrl || w.address === callbackUrl) {
      await shopifyFetch(domain, accessToken, `/webhooks/${w.id}.json`, { method: 'DELETE' }).catch(() => {});
    }
  }
}

// Read-only diagnostic: report the scopes the stored token was actually GRANTED
// plus (optionally) a given order's fulfillment orders. Distinguishes a missing
// write_merchant_managed_fulfillment_orders grant (fulfillment push 403s) from
// an order that simply has nothing open to fulfill. No writes, no side effects.
async function diagnoseFulfillment({ shopDomain, accessToken }, shopifyOrderId) {
  const domain = normalizeShopDomain(shopDomain);

  // Granted scopes live at /admin/oauth/access_scopes.json (NOT version-prefixed).
  const scopeRes = await nodeFetch(`https://${domain}/admin/oauth/access_scopes.json`, {
    headers: { 'X-Shopify-Access-Token': accessToken },
  });
  const scopeBody = await scopeRes.text();
  let grantedScopes = null;
  try { grantedScopes = (JSON.parse(scopeBody).access_scopes || []).map(s => s.handle); } catch {}

  const out = {
    shopDomain: domain,
    scopeStatus: scopeRes.status,
    grantedScopes,
    hasFulfillmentScope: Array.isArray(grantedScopes)
      && grantedScopes.includes('write_merchant_managed_fulfillment_orders'),
    rawScopeBody: grantedScopes ? undefined : scopeBody.slice(0, 300),
  };

  if (shopifyOrderId) {
    const foRes = await shopifyFetch(domain, accessToken, `/orders/${shopifyOrderId}/fulfillment_orders.json`);
    const foBody = await foRes.text();
    out.fulfillmentOrders = { status: foRes.status };
    try {
      const fos = JSON.parse(foBody).fulfillment_orders || [];
      out.fulfillmentOrders.all = fos.map(fo => ({ id: fo.id, status: fo.status }));
      out.fulfillmentOrders.openCount = fos.filter(fo => ['open', 'in_progress'].includes(fo.status)).length;
    } catch {
      out.fulfillmentOrders.rawBody = foBody.slice(0, 300);
    }
  }
  return out;
}

module.exports = {
  normalizeShopDomain, verifyConnection, fetchUnfulfilledOrders, mapShopifyOrder,
  createFulfillment, verifyWebhookHmac, ensureOrderWebhook, removeOrderWebhooks, API_VERSION,
  buildInstallUrl, verifyOAuthHmac, exchangeCodeForToken, refreshOfflineToken,
  diagnoseFulfillment,
};
