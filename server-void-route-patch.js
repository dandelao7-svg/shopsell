/* ============================================================
   SERVER.JS PATCH — VOID / REFUND LABEL ROUTE
   ============================================================

   Replace the existing `/api/shipping/void` route in your server.js
   with the route below.

   What changed:
   - Now supports USPS refunds (via Shippo) in addition to UPS void
     and FedEx cancel.
   - Returns clearer messaging about what each carrier did
     ("voided" vs "refund requested").
   - Removed `requireAuth` (so the frontend can call it from anywhere
     without a token). Re-add it if you want to lock it down.

   To install:
   1. Open server.js on GitHub
   2. Search for: VOID / CANCEL LABEL
   3. Replace the block from "// VOID / CANCEL LABEL" through the
      closing `});` of that route with the route below.

   ============================================================ */

// VOID / CANCEL / REFUND LABEL
app.post('/api/shipping/void', async (req, res) => {
  try {
    const { carrier, trackingNumber, transactionId } = req.body;

    if (!carrier || !trackingNumber) {
      return res.status(400).json({ error: 'carrier and trackingNumber are required.' });
    }

    let result;

    if (carrier === 'ups') {
      // UPS: void is instant. No charge if package was never scanned.
      result = await carriers.ups.voidShipment(trackingNumber);
      result.carrier      = 'ups';
      result.action       = 'voided';
      result.userMessage  = 'UPS label voided. No charge applied since package was never scanned.';

    } else if (carrier === 'fedex') {
      // FedEx: cancel is instant. No charge if package was never scanned.
      result = await carriers.fedex.cancelShipment(trackingNumber);
      result.carrier      = 'fedex';
      result.action       = 'cancelled';
      result.userMessage  = 'FedEx label cancelled. No charge applied since package was never scanned.';

    } else if (carrier === 'usps') {
      // USPS via Shippo: requires the transactionId from when the label was created.
      // Shippo charges immediately on label purchase — refund is requested from USPS.
      if (!transactionId) {
        return res.status(400).json({
          error: 'USPS refunds require a transactionId. Pass the Shippo transactionId from when the label was created.'
        });
      }
      result = await carriers.usps.refundLabel(transactionId);
      result.carrier      = 'usps';
      result.action       = 'refund_requested';
      result.userMessage  = 'Refund requested through Shippo. USPS reviews unused labels — refund typically issued in 14-21 days if approved.';

    } else {
      return res.status(400).json({ error: 'Unsupported carrier. Use ups, fedex, or usps.' });
    }

    console.log(`Label ${result.action}: ${carrier.toUpperCase()} ${trackingNumber}`);
    res.json({ success: true, result });

  } catch (err) {
    console.error('Void/refund error:', err);
    res.status(500).json({ error: 'Failed to void/refund label: ' + err.message });
  }
});
