'use strict';

// Walmart Marketplace API (v3) integration — self-authorization model.
// The seller creates API keys in Walmart Seller Center → Developer Portal and
// pastes their Client ID + Client Secret. Auth is OAuth client-credentials:
// exchange the key pair for a short-lived (~15 min) bearer access token, sent as
// the WM_SEC.ACCESS_TOKEN header. Orders come from the Orders API (released =
// ready to ship); buying a label pushes a shipping update (tracking) back.
//
// NOTE: built to the documented v3 spec; verify end-to-end against a live
// Walmart seller account (endpoints/field casing occasionally shift). The order
// fetch uses /orders/released (orders released to the seller for fulfillment).

const crypto = require('crypto');
const nodeFetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const API_BASE  = 'https://marketplace.walmartapis.com';
const TOKEN_URL = `${API_BASE}/v3/token`;
const SVC_NAME  = 'Walmart Marketplace';

// Carriers Walmart recognizes by name; anything else is sent as otherCarrier.
// Our internal carrier display is 'UPS' | 'FedEx' | 'USPS'.
const KNOWN_CARRIERS = new Set(['UPS', 'USPS', 'FedEx', 'DHL', 'OnTrac']);

function basicAuth(clientId, clientSecret) {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

// ── Access token (cached per client id/secret; ~15 min TTL) ────
const _tokenCache = new Map(); // `${clientId}:${clientSecret}` -> { token, exp }
async function getAccessToken(creds) {
  if (!creds.clientId || !creds.clientSecret) {
    throw new Error('Walmart credentials incomplete (need client id and client secret).');
  }
  const key = `${creds.clientId}:${creds.clientSecret}`;
  const cached = _tokenCache.get(key);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;

  const res = await nodeFetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': basicAuth(creds.clientId, creds.clientSecret),
      'WM_SVC.NAME': SVC_NAME,
      'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Walmart login failed (${res.status})${data.error_description ? ': ' + data.error_description : ''}`);
  }
  _tokenCache.set(key, { token: data.access_token, exp: Date.now() + (data.expires_in || 900) * 1000 });
  return data.access_token;
}

// Call a Walmart Marketplace API path with the required headers + a fresh token.
async function wmFetch(creds, path, { method = 'GET', body } = {}) {
  const token = await getAccessToken(creds);
  return nodeFetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'WM_SEC.ACCESS_TOKEN': token,
      'WM_SVC.NAME': SVC_NAME,
      'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
      'Accept': 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

// Verify creds: token exchange proves the key pair; a lightweight orders call
// proves the account has Marketplace API access.
async function verifyConnection(creds) {
  await getAccessToken(creds); // throws on bad client id/secret
  const res = await wmFetch(creds, '/v3/orders/released?limit=1');
  if (res.status === 401 || res.status === 403) {
    throw new Error('Authenticated, but this account lacks Marketplace Orders access — check your Walmart app permissions.');
  }
  if (!res.ok) throw new Error(`Walmart returned ${res.status} verifying access.`);
  return { ok: true };
}

// Pull orders released for fulfillment (i.e. ready to ship), hydrated with items
// + address. Paginates via the API's nextCursor. Capped by maxOrders.
async function fetchUnfulfilledOrders(creds, { createdStartDate, maxOrders = 100 } = {}) {
  const startDate = createdStartDate ||
    new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const collected = [];
  // First page uses filter params; later pages use the returned cursor, which
  // Walmart hands back as a ready-made query string (starting with '?').
  let path = `/v3/orders/released?createdStartDate=${startDate}&limit=100`;
  let guard = 0;
  do {
    const res = await wmFetch(creds, path);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Walmart getOrders failed (${res.status}): ${data.error?.[0]?.description || ''}`);
    collected.push(...(data.list?.elements?.order || []));
    const cursor = data.list?.meta?.nextCursor || null;
    path = cursor ? `/v3/orders/released${cursor}` : null;
    guard++;
  } while (path && collected.length < maxOrders && guard < 20);

  return collected.slice(0, maxOrders).map(mapWalmartOrder);
}

function chargeAmount(charge) {
  return parseFloat(charge?.chargeAmount?.amount) || 0;
}

function mapWalmartOrder(o) {
  const addr = o.shippingInfo?.postalAddress || {};
  const nameParts = (addr.name || '').split(' ');
  const lines = o.orderLines?.orderLine || [];

  let subtotal = 0, tax = 0, shipping = 0;
  const items = lines.map(li => {
    const charges = li.charges?.charge || [];
    let unit = 0;
    for (const c of charges) {
      const amt = chargeAmount(c);
      const type = (c.chargeType || '').toUpperCase();
      if (type === 'PRODUCT') { unit += amt; subtotal += amt; }
      else if (type === 'SHIPPING') { shipping += amt; }
      else if (type.includes('TAX')) { tax += amt; }
      if (c.tax) tax += parseFloat(c.tax.taxAmount?.amount) || 0;
    }
    const qty = parseInt(li.orderLineQuantity?.amount, 10) || 1;
    return {
      name:           li.item?.productName || li.item?.sku || 'Item',
      sku:            li.item?.sku || '',
      qty,
      price:          qty ? unit / qty : unit,
      weight:         null,
      productId:      null,
      externalItemId: li.lineNumber,   // Walmart line number — needed to ship
    };
  });

  const country = (addr.country || 'US').toUpperCase() === 'USA' ? 'US' : (addr.country || 'US');
  return {
    externalId:          o.purchaseOrderId,
    externalOrderNumber: o.customerOrderId || o.purchaseOrderId,
    customerEmail:       o.customerEmailId || '',
    customerInfo: {
      firstName: nameParts[0] || '',
      lastName:  nameParts.slice(1).join(' ') || '',
      name:      addr.name || '',
      company:   '',
      phone:     o.shippingInfo?.phone || '',
      address1:  addr.address1 || '',
      address2:  addr.address2 || '',
      city:      addr.city || '',
      state:     addr.state || '',
      zip:       addr.postalCode || '',
      country,
      email:     o.customerEmailId || '',
    },
    items,
    subtotal,
    tax,
    total: subtotal + tax + shipping,
  };
}

// Push tracking back as a "Shipped" status + tracking on every line of the
// order. Requires each item's Walmart lineNumber (stored as externalItemId).
async function createFulfillment(creds, order, { trackingNumber, carrierName }) {
  const lines = (order.items || []).filter(it => it.externalItemId != null);
  if (!lines.length) throw new Error('No Walmart order lines to confirm.');

  const carrier = String(carrierName || '').toUpperCase() === 'FEDEX' ? 'FedEx' : carrierName;
  const carrierField = KNOWN_CARRIERS.has(carrier) ? { carrier } : { otherCarrier: carrierName };

  const orderLine = lines.map(it => ({
    lineNumber: String(it.externalItemId),
    orderLineStatuses: {
      orderLineStatus: [{
        status: 'Shipped',
        statusQuantity: { unitOfMeasurement: 'EACH', amount: String(it.qty || 1) },
        trackingInfo: {
          shipDateTime: Date.now(),
          carrierName: carrierField,
          methodCode: 'Standard',
          trackingNumber,
        },
      }],
    },
  }));

  const res = await wmFetch(creds, `/v3/orders/${encodeURIComponent(order.externalId)}/shipping`, {
    method: 'POST',
    body: { orderShipment: { orderLines: { orderLine } } },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Walmart shipping update failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return { ok: true };
}

module.exports = {
  verifyConnection, fetchUnfulfilledOrders, mapWalmartOrder, createFulfillment,
};
