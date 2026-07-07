'use strict';

// Amazon Selling Partner API (SP-API) integration — self-authorization model.
// The seller registers a private SP-API app in Seller Central and pastes:
//   clientId, clientSecret (the LWA app creds) + refreshToken (per-seller).
// Auth is LWA only (no AWS SigV4 since 2023): exchange the refresh token for a
// short-lived access token and send it as x-amz-access-token.
//
// Buyer shipping addresses are restricted PII — fetched with a Restricted Data
// Token (RDT), which requires the app to hold PII/restricted-data approval.

const nodeFetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

// Regional SP-API hosts.
const REGIONS = {
  na: 'https://sellingpartnerapi-na.amazon.com',
  eu: 'https://sellingpartnerapi-eu.amazon.com',
  fe: 'https://sellingpartnerapi-fe.amazon.com',
};
// Common marketplace ids (extend as needed).
const MARKETPLACES = {
  US: 'ATVPDKIKX0DER', CA: 'A2EUQ1WTGCTBG2', MX: 'A1AM78C64UM0Y8',
  UK: 'A1F83G8C2ARO7P', DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH',
  IT: 'APJ6JRA9NG5V4', ES: 'A1RKKUPIHCS9HS', JP: 'A1VC38T7YXB528', AU: 'A39IBJ37TRP1C6',
};

function hostFor(creds) {
  return REGIONS[(creds.region || 'na').toLowerCase()] || REGIONS.na;
}

// ── LWA access token (cached per refresh token) ───────────────
const _tokenCache = new Map(); // refreshToken -> { token, exp }
async function getAccessToken(creds) {
  if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
    throw new Error('Amazon credentials incomplete (need client id, client secret, refresh token).');
  }
  const cached = _tokenCache.get(creds.refreshToken);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  const res = await nodeFetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Amazon login failed: ${data.error_description || data.error || res.status}`);
  _tokenCache.set(creds.refreshToken, { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 });
  return data.access_token;
}

// Call an SP-API path. `token` overrides the access token (used for RDT calls).
async function spFetch(creds, path, { method = 'GET', body, token } = {}) {
  const accessToken = token || await getAccessToken(creds);
  const res = await nodeFetch(`${hostFor(creds)}${path}`, {
    method,
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res;
}

// Verify creds: LWA token exchange + a lightweight authorized SP-API call.
async function verifyConnection(creds) {
  const mp = MARKETPLACES[(creds.marketplace || 'US').toUpperCase()];
  if (!mp) throw new Error(`Unsupported marketplace "${creds.marketplace}".`);
  await getAccessToken(creds); // proves client id/secret/refresh token
  const res = await spFetch(creds, '/sellers/v1/marketplaceParticipations');
  if (res.status === 403) throw new Error('Authorized, but the app lacks access to the Sellers API — check your app roles.');
  if (!res.ok) throw new Error(`SP-API returned ${res.status} verifying access.`);
  return { ok: true, marketplaceId: mp };
}

// Create a Restricted Data Token for specific resource paths (for PII).
async function createRdt(creds, restrictedResources) {
  const res = await spFetch(creds, '/tokens/2021-03-01/restrictedDataToken', {
    method: 'POST',
    body: { restrictedResources },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Could not get restricted data token (${res.status}): ${data.errors?.[0]?.message || ''}`);
  return data.restrictedDataToken;
}

// Pull merchant-fulfilled unshipped orders, hydrated with items + address.
// createdAfterISO defaults to 30 days back. Capped by maxOrders to respect the
// tight getOrders rate limits.
async function fetchUnfulfilledOrders(creds, { createdAfterISO, maxOrders = 100 } = {}) {
  const mp = MARKETPLACES[(creds.marketplace || 'US').toUpperCase()];
  const createdAfter = createdAfterISO || new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  const summaries = [];
  let nextToken = null;
  do {
    const qs = nextToken
      ? `?MarketplaceIds=${mp}&NextToken=${encodeURIComponent(nextToken)}`
      : `?MarketplaceIds=${mp}&CreatedAfter=${encodeURIComponent(createdAfter)}&OrderStatuses=Unshipped,PartiallyShipped&FulfillmentChannels=MFN&MaxResultsPerPage=100`;
    const res = await spFetch(creds, `/orders/v0/orders${qs}`);
    const data = await res.json();
    if (!res.ok) throw new Error(`Amazon getOrders failed (${res.status}): ${data.errors?.[0]?.message || ''}`);
    summaries.push(...(data.payload?.Orders || []));
    nextToken = data.payload?.NextToken || null;
  } while (nextToken && summaries.length < maxOrders);

  const orders = [];
  for (const o of summaries.slice(0, maxOrders)) {
    const orderId = o.AmazonOrderId;
    // Items (SellerSKU/qty/title are non-restricted).
    const itemsRes = await spFetch(creds, `/orders/v0/orders/${orderId}/orderItems`);
    const itemsData = await itemsRes.json();
    const items = itemsData.payload?.OrderItems || [];
    // Address via a per-order RDT (restricted PII).
    let address = {};
    try {
      const rdt = await createRdt(creds, [{
        method: 'GET',
        path: `/orders/v0/orders/${orderId}/address`,
        dataElements: ['shippingAddress'],
      }]);
      const addrRes = await spFetch(creds, `/orders/v0/orders/${orderId}/address`, { token: rdt });
      const addrData = await addrRes.json();
      address = addrData.payload?.ShippingAddress || {};
    } catch (e) {
      // No PII approval yet → import without an address (order still visible).
      address = { _restricted: e.message };
    }
    orders.push(mapAmazonOrder(o, items, address, mp));
  }
  return orders;
}

function mapAmazonOrder(o, items, address, marketplaceId) {
  const nameParts = (address.Name || '').split(' ');
  return {
    externalId:          o.AmazonOrderId,
    externalOrderNumber: o.AmazonOrderId,
    customerEmail:       o.BuyerInfo?.BuyerEmail || '',
    customerInfo: {
      firstName: nameParts[0] || '',
      lastName:  nameParts.slice(1).join(' ') || '',
      name:      address.Name || '',
      company:   '',
      phone:     address.Phone || '',
      address1:  address.AddressLine1 || '',
      address2:  [address.AddressLine2, address.AddressLine3].filter(Boolean).join(' '),
      city:      address.City || '',
      state:     address.StateOrRegion || '',
      zip:       address.PostalCode || '',
      country:   address.CountryCode || 'US',
      email:     o.BuyerInfo?.BuyerEmail || '',
    },
    items: items.map(li => ({
      name:           li.Title || li.SellerSKU || 'Item',
      sku:            li.SellerSKU || li.ASIN || '',
      qty:            li.QuantityOrdered || 1,
      price:          parseFloat(li.ItemPrice?.Amount) || 0,
      weight:         null, // Amazon order items don't carry weight
      productId:      null,
      externalItemId: li.OrderItemId, // needed for shipment confirmation
    })),
    subtotal: parseFloat(o.OrderTotal?.Amount) || 0,
    tax:      0,
    total:    parseFloat(o.OrderTotal?.Amount) || 0,
    marketplaceId,
  };
}

// Confirm shipment (push tracking back). Requires the order's items with their
// Amazon OrderItemIds + quantities.
async function confirmShipment(creds, order, { trackingNumber, carrierName }) {
  const mp = MARKETPLACES[(creds.marketplace || 'US').toUpperCase()];
  const orderItems = (order.items || [])
    .filter(it => it.externalItemId)
    .map(it => ({ orderItemId: it.externalItemId, quantity: Number(it.qty) || 1 }));
  if (!orderItems.length) throw new Error('No Amazon order-item ids to confirm.');

  const res = await spFetch(creds, `/orders/v0/orders/${order.externalId}/shipmentConfirmation`, {
    method: 'POST',
    body: {
      marketplaceId: mp,
      packageDetail: {
        packageReferenceId: String(order.externalId).slice(-30),
        carrierCode:        carrierName,       // 'UPS' | 'FedEx' | 'USPS'
        trackingNumber:     trackingNumber,
        shipDate:           new Date().toISOString(),
        orderItems,
      },
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Amazon shipment confirmation failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return { ok: true };
}

module.exports = {
  REGIONS, MARKETPLACES, verifyConnection, fetchUnfulfilledOrders, mapAmazonOrder, confirmShipment,
};
