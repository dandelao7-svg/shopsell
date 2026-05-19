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
      <td style="padding:8px 12px;border-bottom:1px solid #e5e5e0">${esc(it.name)}</td>
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

module.exports = {
  sendReturnLabelToBuyer,
  sendReturnNotificationToSeller,
};
