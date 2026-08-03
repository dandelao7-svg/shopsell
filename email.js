/* ============================================================
   SHOPSELL — EMAIL.JS
   Transactional email via Resend.

   ENV VARS:
     RESEND_API_KEY — required to actually send. If missing, all sends
                      become no-ops and log a single warning.
     RESEND_FROM    — sender address. Defaults to onboarding@resend.dev
                      (works without domain verification for testing).
   ============================================================ */

'use strict';

const { Resend } = require('resend');

const apiKey   = process.env.RESEND_API_KEY;
const fromAddr = process.env.RESEND_FROM || 'ShopSell <onboarding@resend.dev>';

let client = null;
if (apiKey) {
  client = new Resend(apiKey);
} else {
  console.warn('⚠ RESEND_API_KEY not set — email sends will be skipped.');
}

const nodeFetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// Escape user-provided values that land in HTML email bodies.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Build an attachment from carrier label data:
//   - UPS gives us a base64 GIF in `labelImage`
//   - FedEx/USPS give us a hosted URL in `labelUrl` — fetch its bytes
function mimeForFormat(fmt) {
  const f = (fmt || '').toUpperCase();
  if (f === 'PDF') return { mime: 'application/pdf', ext: 'pdf' };
  if (f === 'PNG') return { mime: 'image/png',       ext: 'png' };
  return                  { mime: 'image/gif',       ext: 'gif' };
}

async function buildLabelAttachment({ labelImage, labelUrl, labelFormat, trackingNumber }) {
  const { ext } = mimeForFormat(labelFormat);
  const filename = `return-label-${trackingNumber || 'shopsell'}.${ext}`;

  if (labelImage) {
    return { filename, content: labelImage }; // Resend accepts base64 strings directly
  }
  if (labelUrl) {
    try {
      const res = await nodeFetch(labelUrl);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return { filename, content: buf };
    } catch (err) {
      console.warn('Failed to fetch label URL for email attachment:', err.message);
      return null;
    }
  }
  return null;
}

function renderItemsHtml(items) {
  return (items || []).map(it => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e5e0">${esc(it.name)}${it.variantTitle ? ' <span style="color:#9ca3af">— ' + esc(it.variantTitle) + '</span>' : ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e5e0;text-align:right;font-variant-numeric:tabular-nums">${esc(it.qty)}</td>
    </tr>
  `).join('');
}

// ============================================================
// BUYER EMAIL — "your return label is ready"
// ============================================================
async function sendReturnLabelToBuyer({
  toEmail, orderNumber, storeName, carrier, trackingNumber,
  items, labelImage, labelUrl, labelFormat, returnAddress,
}) {
  if (!client) return { skipped: true };
  if (!toEmail) return { skipped: true, reason: 'no recipient' };

  const attachment = await buildLabelAttachment({ labelImage, labelUrl, labelFormat, trackingNumber });

  const returnAddrHtml = returnAddress ? `
    <div style="margin-top:18px;padding:12px 14px;background:#f7f7f2;border-radius:8px;font-size:13px;color:#374151">
      <div style="font-weight:600;margin-bottom:4px">Return ships to:</div>
      ${esc(returnAddress.name)}<br>
      ${esc(returnAddress.address1)}${returnAddress.address2 ? '<br>' + esc(returnAddress.address2) : ''}<br>
      ${esc(returnAddress.city)}, ${esc(returnAddress.state)} ${esc(returnAddress.zip)}
    </div>` : '';

  const labelLinkHtml = labelUrl
    ? `<p style="margin:18px 0"><a href="${esc(labelUrl)}" style="display:inline-block;background:#e63946;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Open / print label</a></p>`
    : `<p style="margin:18px 0;color:#6b7280;font-size:13px">Your label is attached to this email.</p>`;

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f7f2;margin:0;padding:24px;color:#0f0f1a">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e5e5e0">
      <h1 style="font-size:22px;margin:0 0 8px;font-weight:700">Your return label is ready</h1>
      <p style="margin:0 0 18px;color:#6b7280;font-size:14px">Order ${esc(orderNumber)} from ${esc(storeName)}</p>

      <div style="background:#0f0f1a;color:#fff;padding:16px;border-radius:10px;text-align:center;margin:14px 0">
        <div style="font-size:10px;letter-spacing:2px;color:rgba(255,255,255,0.6);text-transform:uppercase;margin-bottom:4px">Tracking number</div>
        <div style="font-size:18px;font-weight:600;letter-spacing:1.5px;word-break:break-all">${esc(trackingNumber)}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:4px">${esc((carrier || '').toUpperCase())}</div>
      </div>

      ${labelLinkHtml}

      <h3 style="font-size:14px;margin:22px 0 8px">Items in this return</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tbody>${renderItemsHtml(items)}</tbody>
      </table>

      ${returnAddrHtml}

      <p style="margin:22px 0 0;font-size:13px;color:#6b7280;line-height:1.6">
        Tape the label securely to the outside of the package. Cover or remove any old shipping labels.
        Drop the package off at a ${esc((carrier || '').toUpperCase())} location.
      </p>
    </div>
    <p style="text-align:center;color:#9ca3af;font-size:11px;margin-top:16px">Sent by ${esc(storeName)} via ShopSell</p>
  </body></html>`;

  const payload = {
    from:    fromAddr,
    to:      [toEmail],
    subject: `Your return label for ${orderNumber}`,
    html,
  };
  if (attachment) payload.attachments = [attachment];

  try {
    const { data, error } = await client.emails.send(payload);
    if (error) { console.error('Resend (buyer) error:', error); return { sent: false, error }; }
    return { sent: true, id: data?.id };
  } catch (err) {
    console.error('Resend (buyer) exception:', err.message);
    return { sent: false, error: err.message };
  }
}

// ============================================================
// SELLER EMAIL — "buyer initiated a return"
// ============================================================
async function sendReturnNotificationToSeller({
  toEmail, orderNumber, buyerEmail, buyerName, carrier, trackingNumber,
  items, reason, storeName,
}) {
  if (!client) return { skipped: true };
  if (!toEmail) return { skipped: true, reason: 'no recipient' };

  const reasonHtml = reason ? `
    <h3 style="font-size:14px;margin:22px 0 6px">Reason from buyer</h3>
    <p style="margin:0;padding:10px 12px;background:#f7f7f2;border-radius:8px;font-size:13px;color:#374151;white-space:pre-wrap">${esc(reason)}</p>` : '';

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f7f2;margin:0;padding:24px;color:#0f0f1a">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e5e5e0">
      <h1 style="font-size:22px;margin:0 0 8px;font-weight:700">Return request: ${esc(orderNumber)}</h1>
      <p style="margin:0 0 18px;color:#6b7280;font-size:14px">A buyer has issued themselves a return label.</p>

      <h3 style="font-size:14px;margin:14px 0 6px">Buyer</h3>
      <p style="margin:0 0 4px;font-size:14px">${esc(buyerName || buyerEmail)}</p>
      <p style="margin:0;font-size:13px;color:#6b7280">${esc(buyerEmail)}</p>

      <h3 style="font-size:14px;margin:22px 0 6px">Items being returned</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tbody>${renderItemsHtml(items)}</tbody>
      </table>

      <h3 style="font-size:14px;margin:22px 0 6px">Inbound tracking</h3>
      <div style="font-family:monospace;font-size:14px;color:#0f0f1a">
        ${esc((carrier || '').toUpperCase())} · ${esc(trackingNumber)}
      </div>

      ${reasonHtml}

      <p style="margin:24px 0 0;font-size:12px;color:#6b7280">
        Expect this package soon. You can void the label from your Shipping → History page if the buyer never sends it.
      </p>
    </div>
    <p style="text-align:center;color:#9ca3af;font-size:11px;margin-top:16px">${esc(storeName)} · ShopSell returns</p>
  </body></html>`;

  try {
    const { data, error } = await client.emails.send({
      from:    fromAddr,
      to:      [toEmail],
      subject: `Return request: ${orderNumber} — ${(carrier || '').toUpperCase()} ${trackingNumber}`,
      html,
    });
    if (error) { console.error('Resend (seller) error:', error); return { sent: false, error }; }
    return { sent: true, id: data?.id };
  } catch (err) {
    console.error('Resend (seller) exception:', err.message);
    return { sent: false, error: err.message };
  }
}

// ── Shared helpers for order/receipt emails ─────────────────
function money(n) {
  const v = Number(n);
  return '$' + (Number.isFinite(v) ? v : 0).toFixed(2);
}

// Public carrier tracking URLs. Returns null for unknown carriers so the
// template can fall back to just showing the number.
function trackingUrl(carrier, tracking) {
  const t = encodeURIComponent(tracking || '');
  switch ((carrier || '').toLowerCase()) {
    case 'ups':   return `https://www.ups.com/track?tracknum=${t}`;
    case 'fedex': return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
    case 'usps':  return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;
    default:      return null;
  }
}

// Itemized rows with a line total (name ×qty ........ $line). Order items
// carry { name, qty, price }; price is per-unit.
function renderReceiptRows(items) {
  return (items || []).map(it => {
    const qty = Number(it.qty) || 0;
    const line = (Number(it.price) || 0) * qty;
    return `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e5e0">${esc(it.name)}${it.variantTitle ? ` <span style="color:#9ca3af">— ${esc(it.variantTitle)}</span>` : ''}${qty > 1 ? ` <span style="color:#9ca3af">× ${qty}</span>` : ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e5e0;text-align:right;font-variant-numeric:tabular-nums">${money(line)}</td>
    </tr>`;
  }).join('');
}

function renderTotals(subtotal, tax, total, discount) {
  const row = (label, val, { bold = false, neg = false } = {}) => `
    <tr>
      <td style="padding:4px 12px;text-align:right;font-size:${bold ? '15px;font-weight:700;color:#0f0f1a' : '13px;color:#6b7280'}">${esc(label)}</td>
      <td style="padding:4px 12px;text-align:right;width:96px;font-variant-numeric:tabular-nums;font-size:${bold ? '15px;font-weight:700' : '13px'}">${neg ? '−' : ''}${money(val)}</td>
    </tr>`;
  return `<table style="width:100%;border-collapse:collapse;margin-top:6px">
      ${subtotal != null ? row('Subtotal', subtotal) : ''}
      ${Number(discount) > 0 ? row('Discount', discount, { neg: true }) : ''}
      ${tax != null ? row('Tax', tax) : ''}
      ${row('Total', total, { bold: true })}
    </table>`;
}

// Shipping/ship-to address card. Accepts the checkout customerInfo shape
// ({ firstName, lastName, address1, address2, city, state, zip }).
function renderAddressBlock(a, label) {
  if (!a || !(a.address1 || a.city)) return '';
  const name = [a.firstName, a.lastName].filter(Boolean).join(' ') || a.name || '';
  return `
    <div style="margin-top:18px;padding:12px 14px;background:#f7f7f2;border-radius:8px;font-size:13px;color:#374151">
      <div style="font-weight:600;margin-bottom:4px">${esc(label)}</div>
      ${name ? esc(name) + '<br>' : ''}
      ${esc(a.address1 || '')}${a.address2 ? '<br>' + esc(a.address2) : ''}<br>
      ${esc(a.city || '')}, ${esc(a.state || '')} ${esc(a.zip || '')}
    </div>`;
}

function emailShell(inner, footerNote) {
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f7f2;margin:0;padding:24px;color:#0f0f1a">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e5e5e0">
      ${inner}
    </div>
    <p style="text-align:center;color:#9ca3af;font-size:11px;margin-top:16px">${esc(footerNote)}</p>
  </body></html>`;
}

async function _send(payload, who) {
  try {
    const { data, error } = await client.emails.send(payload);
    if (error) { console.error(`Resend (${who}) error:`, error); return { sent: false, error }; }
    return { sent: true, id: data?.id };
  } catch (err) {
    console.error(`Resend (${who}) exception:`, err.message);
    return { sent: false, error: err.message };
  }
}

// ============================================================
// BUYER EMAIL — "order confirmed" receipt
// ============================================================
async function sendOrderConfirmationToBuyer({
  toEmail, orderNumber, storeName, items, subtotal, discount, tax, total, shippingAddress,
}) {
  if (!client) return { skipped: true };
  if (!toEmail) return { skipped: true, reason: 'no recipient' };

  const inner = `
      <h1 style="font-size:22px;margin:0 0 8px;font-weight:700">Thanks for your order</h1>
      <p style="margin:0 0 18px;color:#6b7280;font-size:14px">Order ${esc(orderNumber)} · ${esc(storeName)}</p>

      <div style="background:#0f0f1a;color:#fff;padding:14px 16px;border-radius:10px;text-align:center;margin:14px 0">
        <div style="font-size:10px;letter-spacing:2px;color:rgba(255,255,255,0.6);text-transform:uppercase;margin-bottom:4px">Order confirmed</div>
        <div style="font-size:18px;font-weight:600;letter-spacing:1px">${esc(orderNumber)}</div>
      </div>

      <h3 style="font-size:14px;margin:22px 0 8px">Order summary</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tbody>${renderReceiptRows(items)}</tbody>
      </table>
      ${renderTotals(subtotal, tax, total, discount)}

      ${renderAddressBlock(shippingAddress, 'Shipping to')}

      <p style="margin:22px 0 0;font-size:13px;color:#6b7280;line-height:1.6">
        We'll email you tracking details as soon as your order ships.
      </p>`;

  return _send({
    from:    fromAddr,
    to:      [toEmail],
    subject: `Order confirmed — ${orderNumber}`,
    html:    emailShell(inner, `Sent by ${storeName} via ShopSell`),
  }, 'order-confirm');
}

// ============================================================
// SELLER EMAIL — "you have a new order"
// ============================================================
async function sendNewOrderToSeller({
  toEmail, orderNumber, storeName, buyerName, buyerEmail, items, total,
}) {
  if (!client) return { skipped: true };
  if (!toEmail) return { skipped: true, reason: 'no recipient' };

  const inner = `
      <h1 style="font-size:22px;margin:0 0 8px;font-weight:700">New order: ${esc(orderNumber)}</h1>
      <p style="margin:0 0 18px;color:#6b7280;font-size:14px">${money(total)} · ${esc(storeName)}</p>

      <h3 style="font-size:14px;margin:14px 0 6px">Customer</h3>
      <p style="margin:0 0 4px;font-size:14px">${esc(buyerName || buyerEmail || 'Guest')}</p>
      ${buyerEmail ? `<p style="margin:0;font-size:13px;color:#6b7280">${esc(buyerEmail)}</p>` : ''}

      <h3 style="font-size:14px;margin:22px 0 8px">Items</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tbody>${renderReceiptRows(items)}</tbody>
      </table>
      ${renderTotals(null, null, total)}

      <p style="margin:24px 0 0;font-size:13px;color:#6b7280">
        Log in to your dashboard to fulfill this order and print a shipping label.
      </p>`;

  return _send({
    from:    fromAddr,
    to:      [toEmail],
    subject: `New order ${orderNumber} — ${money(total)}`,
    html:    emailShell(inner, `${storeName} · ShopSell orders`),
  }, 'new-order-seller');
}

// ============================================================
// BUYER EMAIL — "your order has shipped" + tracking
// ============================================================
async function sendShippingNotificationToBuyer({
  toEmail, orderNumber, storeName, carrier, trackingNumber, items, shippingAddress,
}) {
  if (!client) return { skipped: true };
  if (!toEmail) return { skipped: true, reason: 'no recipient' };

  const url = trackingUrl(carrier, trackingNumber);
  const carrierLabel = (carrier || '').toUpperCase();

  const trackingBox = trackingNumber ? `
      <div style="background:#0f0f1a;color:#fff;padding:16px;border-radius:10px;text-align:center;margin:14px 0">
        <div style="font-size:10px;letter-spacing:2px;color:rgba(255,255,255,0.6);text-transform:uppercase;margin-bottom:4px">Tracking number</div>
        <div style="font-size:18px;font-weight:600;letter-spacing:1.5px;word-break:break-all">${esc(trackingNumber)}</div>
        ${carrierLabel ? `<div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:4px">${esc(carrierLabel)}</div>` : ''}
      </div>` : '';

  const trackBtn = url ? `
      <p style="margin:18px 0"><a href="${esc(url)}" style="display:inline-block;background:#0f0f1a;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Track your package</a></p>` : '';

  const inner = `
      <h1 style="font-size:22px;margin:0 0 8px;font-weight:700">Your order is on its way</h1>
      <p style="margin:0 0 18px;color:#6b7280;font-size:14px">Order ${esc(orderNumber)} · ${esc(storeName)}</p>

      ${trackingBox}
      ${trackBtn}

      <h3 style="font-size:14px;margin:22px 0 8px">What's shipping</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tbody>${renderItemsHtml(items)}</tbody>
      </table>

      ${renderAddressBlock(shippingAddress, 'Shipping to')}

      <p style="margin:22px 0 0;font-size:13px;color:#6b7280;line-height:1.6">
        ${url ? 'Use the button above to follow your package.' : 'Your carrier will provide delivery updates shortly.'}
      </p>`;

  return _send({
    from:    fromAddr,
    to:      [toEmail],
    subject: `Your ${storeName} order has shipped — ${orderNumber}`,
    html:    emailShell(inner, `Sent by ${storeName} via ShopSell`),
  }, 'shipping-notify');
}

// ============================================================
// SELLER EMAIL — "reset your password"
// ============================================================
async function sendPasswordReset({ toEmail, firstName, resetUrl }) {
  if (!client) return { skipped: true };
  if (!toEmail) return { skipped: true, reason: 'no recipient' };

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
      <h2 style="font-weight:700">Reset your password</h2>
      <p>Hi ${esc(firstName) || 'there'}, we got a request to reset your ShopSell password.</p>
      <p style="margin:24px 0">
        <a href="${esc(resetUrl)}" style="background:#e63946;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Reset password</a>
      </p>
      <p style="color:#6b7280;font-size:13px">This link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password won't change.</p>
      <p style="color:#9ca3af;font-size:12px;word-break:break-all">Or paste this link: ${esc(resetUrl)}</p>
    </div>`;

  try {
    const { data, error } = await client.emails.send({
      from:    fromAddr,
      to:      [toEmail],
      subject: 'Reset your ShopSell password',
      html,
    });
    if (error) { console.error('Password reset email error:', error); return { skipped: false, error }; }
    return { skipped: false, id: data?.id };
  } catch (err) {
    console.error('Password reset email failed:', err.message);
    return { skipped: false, error: err.message };
  }
}

// ============================================================
// BUYER EMAIL — "here's your welcome discount code"
// ============================================================
async function sendWelcomeDiscount({ toEmail, storeName, code, percent, storeUrl }) {
  if (!client) return { skipped: true };
  if (!toEmail) return { skipped: true, reason: 'no recipient' };

  const shopBtn = storeUrl
    ? `<p style="margin:18px 0"><a href="${esc(storeUrl)}" style="display:inline-block;background:#0f0f1a;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Start shopping</a></p>`
    : '';

  const inner = `
      <h1 style="font-size:22px;margin:0 0 8px;font-weight:700">Here's your ${esc(percent)}% off</h1>
      <p style="margin:0 0 18px;color:#6b7280;font-size:14px">Thanks for subscribing to ${esc(storeName)}.</p>

      <div style="background:#0f0f1a;color:#fff;padding:18px 16px;border-radius:10px;text-align:center;margin:14px 0">
        <div style="font-size:10px;letter-spacing:2px;color:rgba(255,255,255,0.6);text-transform:uppercase;margin-bottom:6px">Your code — ${esc(percent)}% off</div>
        <div style="font-size:22px;font-weight:700;letter-spacing:2px">${esc(code)}</div>
      </div>

      <p style="margin:14px 0;font-size:14px;color:#374151">Enter it at checkout to take ${esc(percent)}% off your order. It's good for one use.</p>
      ${shopBtn}
      <p style="margin:22px 0 0;font-size:12px;color:#9ca3af;line-height:1.6">
        You're receiving this because you signed up for offers from ${esc(storeName)}. You can unsubscribe at any time.
      </p>`;

  return _send({
    from:    fromAddr,
    to:      [toEmail],
    subject: `Your ${percent}% off code for ${storeName}`,
    html:    emailShell(inner, `Sent by ${storeName} via ShopSell`),
  }, 'welcome-discount');
}

// ============================================================
// BUYER EMAIL — "an item you asked about is back in stock"
// ============================================================
async function sendBackInStockEmail({ toEmail, storeName, productName, productUrl }) {
  if (!client) return { skipped: true };
  if (!toEmail) return { skipped: true, reason: 'no recipient' };

  const shopBtn = productUrl
    ? `<p style="margin:18px 0"><a href="${esc(productUrl)}" style="display:inline-block;background:#0f0f1a;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Shop it now</a></p>`
    : '';

  const inner = `
      <h1 style="font-size:22px;margin:0 0 8px;font-weight:700">${esc(productName)} is back in stock</h1>
      <p style="margin:0 0 18px;color:#6b7280;font-size:14px">Good news from ${esc(storeName)} — the item you asked about is available again.</p>
      ${shopBtn}
      <p style="margin:22px 0 0;font-size:12px;color:#9ca3af;line-height:1.6">
        You're getting this because you signed up for a back-in-stock alert. We only send it once.
      </p>`;

  return _send({
    from:    fromAddr,
    to:      [toEmail],
    subject: `Back in stock: ${productName}`,
    html:    emailShell(inner, `Sent by ${storeName} via ShopSell`),
  }, 'back-in-stock');
}

// ============================================================
// SELLER-INITIATED — "here's the shipping label for tracking # X"
// Used when a seller forwards a purchased outbound label to a supplier,
// warehouse hand, or themselves for backup. The label file rides as an
// attachment so the recipient can print it directly.
// ============================================================
async function sendShippingLabelToRecipient({
  toEmail, fromStoreName, trackingNumber, carrier, service, note,
  labelImage, labelUrl, labelFormat, labelPdf, shipTo,
}) {
  if (!client) return { skipped: true };
  if (!toEmail) return { skipped: true, reason: 'no recipient' };

  // Prefer a pre-built 4x6 PDF (mergeLabels output) — it normalizes
  // wildly different carrier formats into one predictable file so
  // "print actual size" always yields a 4x6 label on 8.5x11 paper.
  const attachment = labelPdf
    ? { filename: `shipping-label-${trackingNumber || 'shopsell'}.pdf`, content: labelPdf }
    : await buildLabelAttachment({ labelImage, labelUrl, labelFormat, trackingNumber });
  const carrierLabel = (carrier || '').toUpperCase();

  const shipToBlock = shipTo && (shipTo.name || shipTo.address1) ? `
    <div style="margin-top:18px;padding:12px 14px;background:#f7f7f2;border-radius:8px;font-size:13px;color:#374151">
      <div style="font-weight:600;margin-bottom:4px">Ship to:</div>
      ${esc(shipTo.name || '')}<br>
      ${esc(shipTo.address1 || '')}${shipTo.address2 ? '<br>' + esc(shipTo.address2) : ''}<br>
      ${esc(shipTo.city || '')}, ${esc(shipTo.state || '')} ${esc(shipTo.zip || '')}
    </div>` : '';

  const noteBlock = note && note.trim() ? `
    <div style="margin-top:14px;padding:12px 14px;background:#eff6ff;border-left:3px solid #3b82f6;border-radius:6px;font-size:13px;color:#1e3a8a;white-space:pre-wrap">${esc(note.trim())}</div>` : '';

  const labelLinkHtml = labelUrl
    ? `<p style="margin:18px 0"><a href="${esc(labelUrl)}" style="display:inline-block;background:#0f0f1a;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Open / print label</a></p>`
    : `<p style="margin:18px 0;color:#6b7280;font-size:13px">The label is attached to this email.</p>`;

  const inner = `
      <h1 style="font-size:22px;margin:0 0 8px;font-weight:700">Shipping label ready</h1>
      <p style="margin:0 0 18px;color:#6b7280;font-size:14px">${esc(fromStoreName || 'A ShopSell seller')} sent you this label to print and stick on a package.</p>

      <div style="background:#0f0f1a;color:#fff;padding:16px;border-radius:10px;text-align:center;margin:14px 0">
        <div style="font-size:10px;letter-spacing:2px;color:rgba(255,255,255,0.6);text-transform:uppercase;margin-bottom:4px">Tracking number</div>
        <div style="font-size:18px;font-weight:600;letter-spacing:1.5px;word-break:break-all">${esc(trackingNumber || '')}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:4px">${esc(carrierLabel)}${service ? ' · ' + esc(service) : ''}</div>
      </div>

      ${labelLinkHtml}
      ${shipToBlock}
      ${noteBlock}

      <p style="margin:22px 0 0;font-size:13px;color:#6b7280;line-height:1.6">
        Tape the label securely to the outside of the package with the barcode flat.
        Drop it off at a ${esc(carrierLabel)} location or hand it to a driver.
      </p>`;

  const payload = {
    from:    fromAddr,
    to:      [toEmail],
    subject: `Shipping label — ${carrierLabel}${trackingNumber ? ' ' + trackingNumber : ''}`,
    html:    emailShell(inner, `Sent by ${fromStoreName || 'ShopSell'} via ShopSell`),
  };
  if (attachment) payload.attachments = [attachment];

  return _send(payload, 'label-forward');
}

module.exports = {
  sendReturnLabelToBuyer,
  sendReturnNotificationToSeller,
  sendOrderConfirmationToBuyer,
  sendNewOrderToSeller,
  sendShippingNotificationToBuyer,
  sendPasswordReset,
  sendWelcomeDiscount,
  sendBackInStockEmail,
  sendShippingLabelToRecipient,
};
