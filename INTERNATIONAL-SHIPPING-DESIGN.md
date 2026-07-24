# International Shipping — Design Doc

**Status:** Draft · **Author:** design session 2026-07-24 · **Owner:** Dan

Goal: let a seller ship across borders — generate compliant labels with the
**customs paperwork** carriers require, quote international rates, and let buyers
outside the US check out — without breaking the working US-domestic flow.

Related: the deferred [ShipStation-parity goal] for the shipping module.

---

## 1. Where we are today

The shipping stack is **US-domestic by design**, but the address layer is
already partly international:

- **Carriers** (`carriers.js`): `UPS`, `FedEx`, and `USPS` (via Shippo) each build
  a carrier-specific payload in `createShipment()`. All three send a recipient
  `country` (defaulting to `'US'`) — **but none send any customs/commodity data.**
  A cross-border label built today would be rejected or non-compliant.
- **Checkout** (`index.html`): already supports **4 countries** — US, Canada, UK,
  Australia — with per-country region lists (`REGIONS`) and country→ISO mapping
  (`co-country` → `US/CA/GB/AU`). So buyers abroad can *enter* an address.
- **Quick Ship** (`shipping.html`): the from/to forms assume US state + ZIP.
- **Products** (`database.js` `products` table): has `name`, `description`,
  `category`, `brand`, `price`, `sku`, `weight`, … **but no customs fields**
  (no HS code, country of origin, or customs description).
- **Label route** (`server.js` `POST /api/shipping/label`, ~4724) passes the
  request straight to the carrier — no customs assembly.

**The gap in one line:** addresses can be foreign, but there is **no customs
documentation and no product data to build it from**. That's the core of this
project — everything else is comparatively small.

---

## 2. Why international is a different build (not a toggle)

A domestic label needs from/to addresses + weight. A cross-border shipment also
requires a **commercial invoice / customs declaration** describing *what* is in
the box, its *value*, and its *classification*, so customs can assess duties and
clear it. That declaration is legally required, carrier-validated, and must be
populated **per line item**. Everything downstream (duties, compliance, forms)
hangs off it.

---

## 3. Data model changes

### 3a. Product-level customs data (the prerequisite)

Customs data must *come from somewhere*. Add per-product fields so labels
auto-populate the invoice instead of manual entry every time:

```sql
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS hs_code            TEXT,     -- Harmonized System tariff code
  ADD COLUMN IF NOT EXISTS country_of_origin  TEXT,     -- ISO-2, where it was made
  ADD COLUMN IF NOT EXISTS customs_description TEXT;     -- plain description for customs (falls back to name)
```

- Surface these in the Add/Edit-product form (`dashboard.html`), under a
  "Customs / international" section, all optional (only needed to ship abroad).
- `customs_value` defaults to the product `price`; add an override only if a
  seller needs a declared value that differs from the sale price.

### 3b. Shipment customs payload (request shape)

The label request (`POST /api/shipping/label`) gains an optional `customs` block,
assembled server-side from the order's line items + product customs fields:

```jsonc
{
  "carrier": "ups", "shipper": {…}, "recipient": {…}, "package": {…},
  "customs": {
    "contentsType": "merchandise",         // merchandise | gift | sample | documents | returned_goods
    "incoterm": "DDU",                      // DDU (buyer pays duty) | DDP (seller pays)
    "invoiceNumber": "SS-1042",
    "items": [
      { "description": "Cotton t-shirt", "quantity": 2, "value": 24.00,
        "currency": "USD", "weight": 0.4, "hsCode": "610910", "originCountry": "US" }
    ]
  }
}
```

Domestic shipments simply omit `customs` — **zero change to the domestic path**.

---

## 4. Carrier customs payloads

`customs` maps onto each carrier's own international structure inside
`createShipment()`. Only added when the shipment crosses a border
(`shipper.country !== recipient.country`).

- **UPS** — add `Shipment.ShipmentServiceOptions.InternationalForms`:
  `FormType:'01'` (commercial invoice), `Product[]` (`Description`,
  `CommodityCode` = HS, `OriginCountryCode`, `Unit{Number,Value,UnitOfMeasurement}`,
  `ProductWeight`), `InvoiceNumber`, `InvoiceDate`, `ReasonForExport`,
  `CurrencyCode`. International service `Code`s (e.g. `07` Worldwide Express,
  `11` Standard).
- **FedEx** — add `requestedShipment.customsClearanceDetail`:
  `commodities[]` (`description`, `harmonizedCode`, `countryOfManufacture`,
  `quantity`, `quantityUnits`, `unitPrice`, `customsValue`, `weight`),
  `dutiesPayment` (SENDER for DDP / RECIPIENT for DDU), and
  `shippingDocumentSpecification` for the electronic commercial invoice.
  International `serviceType` (e.g. `INTERNATIONAL_PRIORITY`, `INTERNATIONAL_ECONOMY`).
- **USPS via Shippo** — create a `customs_declaration` object
  (`contents_type`, `non_delivery_option`, `certify`, `certify_signer`,
  `incoterm`, `items[]`: `description`, `quantity`, `net_weight`, `mass_unit`,
  `value_amount`, `value_currency`, `origin_country`, `tariff_number` = HS), then
  pass its `object_id` as `customs_declaration` on the shipment. Service tokens
  like `usps_priority_mail_international`.

A shared `buildCustoms(customs, carrier)` helper (in `carriers.js`) normalizes
the common block into each carrier's dialect.

---

## 5. Addresses

- **Checkout** (`index.html`): expand `REGIONS` / `co-country` from 4 countries to
  a full ISO country list; for countries without a fixed region set, allow a
  free-text region + postal code (some countries have no postal codes at all →
  allow blank). Keep phone + country required (carriers demand both abroad).
- **Quick Ship** (`shipping.html`): same — country selector, free-form
  region/postal, required recipient phone.
- Validation: relax the US-only state/ZIP checks when `country !== 'US'`.

---

## 6. Services & rates

- Rate shopping (`/api/shipping/rates`) already fans out per carrier; the carrier
  `getRates()` methods need the international service set surfaced when the route
  is cross-border (UPS Worldwide, FedEx International, USPS Intl via Shippo).
- The service pickers (Quick Ship + batch) show international options only for
  cross-border shipments.
- Rates for international need the customs value too (some carriers price on it).

---

## 7. Duties & taxes

- **Incoterm choice: DDU vs DDP.** DDU (default) = the buyer pays duties/taxes on
  delivery; DDP = the seller prepays. This is a per-shipment (or per-store default)
  setting that maps to the carrier `dutiesPayment`/`incoterm` field.
- **Landed cost (optional, later):** to *show* the buyer estimated duties/taxes at
  checkout you need a landed-cost estimate — either a third-party service
  (Zonos / Easyship / carrier landed-cost APIs) or a simplified estimate. Scope
  this as a follow-on; v1 can ship DDU with a "duties/taxes may apply on delivery"
  notice at checkout.

---

## 8. Compliance (don't skip, but phase it)

- **Restricted / prohibited items** — some goods can't ship to some countries;
  at minimum surface a warning. A per-product "not for international" flag is a
  cheap first step.
- **Denied-party screening** — screening the recipient against restricted-party
  lists. Carriers do some of this; a dedicated check is a later add.
- **Export filing (AES/EEL/PFC)** — US exports over the filing threshold
  (commonly **$2,500 per HS code**) require an EEI/AES filing; below it, an
  exemption code (e.g. `NOEEI 30.37(a)`) goes on the label. Carriers accept the
  exemption code as a field — populate it for sub-threshold shipments; flag
  above-threshold shipments for manual handling in v1.

---

## 9. Phasing

1. **Product customs data** — schema + Add/Edit-product form fields (HS code,
   country of origin, customs description). *No shipping behavior change yet;
   just capture the data.*
2. **Customs on labels** — `customs` request block + `buildCustoms()` per carrier
   + auto-assemble from order line items in `/api/shipping/label`. Cross-border
   detection. Ship DDU with the sub-threshold export-exemption code. *First real
   international label.*
3. **Addresses + services** — full country list at checkout + Quick Ship,
   relaxed validation, international service types in rate shopping.
4. **Duties options** — DDU/DDP choice + a checkout "duties may apply" notice.
5. **Landed cost + compliance** — optional duty/tax estimation, restricted-item
   flags, denied-party screening, above-threshold AES handling.

Phase 1 is safe and additive (dormant fields). Phase 2 is the substantive build
and where testing against a real cross-border label matters most.

---

## 10. Open decisions

- **HS codes: manual vs assisted.** Sellers won't know HS codes offhand.
  Recommend: free-text entry in v1, with a lookup/autoclassify helper later
  (carrier or third-party classify APIs).
- **Customs value = price?** Default yes; allow an override for gifts/samples.
- **DDU default vs DDP.** Recommend DDU default (no seller duty exposure), DDP as
  an opt-in per store or per shipment.
- **Multi-currency.** Do we declare/charge in the seller's currency only, or
  localize? v1: declare in the seller's currency (USD), revisit for display.
- **Which countries to enable first.** Recommend starting with CA/UK/AU/EU (the
  checkout already lists 3 of them) rather than "everywhere."

---

## Appendix: why this fits our stack

- Additive schema via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `initSchema` —
  no migration step, consistent with the existing pattern.
- The `customs` block is optional on the label request, so the domestic path is
  byte-for-byte unchanged and low-risk.
- Per-carrier customs assembly lives where the rest of each carrier's payload
  already lives (`createShipment` in `carriers.js`), behind one `buildCustoms()`
  helper — same shape as `buildCarrier()`.
