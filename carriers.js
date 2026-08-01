/* ============================================================
   SHOPSELL — CARRIERS.JS
   UPS, FedEx, USPS shipping carrier integrations

   FIX in this version: UPS createShipment now extracts GraphicImage
   (base64 GIF) from the UPS API response and returns it as labelImage,
   so the frontend can render the actual scannable label with barcode
   and maxicode.
   ============================================================ */

'use strict';

// Every carrier API call goes through here. Carrier endpoints (UPS/FedEx/
// Shippo) can occasionally hang — a newly-activated product, a slow upstream,
// a dropped connection — and node-fetch has no default timeout, so a hung
// socket would otherwise wedge the seller's whole request indefinitely (spinner
// forever, no error). Bound every call with an AbortController and turn a
// timeout into a clean, catchable error the route can surface.
const CARRIER_TIMEOUT_MS = 30000;

async function nodeFetch(url, opts = {}) {
  const { default: f } = await import('node-fetch');
  const { timeoutMs = CARRIER_TIMEOUT_MS, ...rest } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await f(url, { ...rest, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      let host = url;
      try { host = new URL(url).host; } catch { /* keep raw url */ }
      throw new Error(`Carrier request timed out after ${Math.round(timeoutMs / 1000)}s (${host}). The carrier did not respond — try again in a moment.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// PER-SELLER TOKEN CACHE
// Carrier instances are now built per request (each seller brings their
// own credentials — see buildCarrier), so OAuth tokens can't live on the
// instance. Cache them at the module level, keyed by the credential that
// obtained them, so we don't re-authenticate on every label.
// ============================================================
const _tokenCache = new Map(); // key -> { token, expiresAt }

// UPS returns errors as { response: { errors: [{ code, message }] } }. The
// numeric code is what actually disambiguates failures (e.g. 250002/250003 =
// account or product-entitlement problems, not a bad request), so keep it in
// the thrown message instead of dropping it.
function _upsErr(data) {
  const errs = data?.response?.errors;
  if (Array.isArray(errs) && errs.length) {
    return errs.map(e => `${e.code ? `[${e.code}] ` : ''}${e.message}`).join('; ');
  }
  return data?.ShipmentResponse?.Response?.ResponseStatus?.Description
      || data?.RateResponse?.Response?.ResponseStatus?.Description
      || JSON.stringify(data).slice(0, 500);
}

function _getCachedToken(key) {
  const hit = _tokenCache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.token;
  return null;
}

function _setCachedToken(key, token, expiresInSec) {
  _tokenCache.set(key, { token, expiresAt: Date.now() + (expiresInSec - 60) * 1000 });
}

// ============================================================
// INTERNATIONAL CUSTOMS
// A shipment is cross-border when ship-to country ≠ ship-from country. Those
// labels require a customs declaration (commercial invoice). The common
// `customs` block is normalized here, then each carrier's createShipment maps
// it into that carrier's own structure. See INTERNATIONAL-SHIPPING-DESIGN.md.
// ============================================================
function isCrossBorder(shipper = {}, recipient = {}) {
  return (shipper.country || 'US').toUpperCase() !== (recipient.country || 'US').toUpperCase();
}

// Normalize the incoming customs block to a common internal shape, or null if
// there's nothing usable. Values are clamped/typed so carrier payloads are safe.
function normalizeCustoms(customs, shipper = {}) {
  if (!customs || !Array.isArray(customs.items) || !customs.items.length) return null;
  const originDefault = (shipper.country || 'US').toUpperCase().slice(0, 2);
  const items = customs.items.map(it => ({
    description:   String(it.description || 'Goods').slice(0, 200),
    quantity:      Math.max(1, parseInt(it.quantity, 10) || 1),
    value:         Math.max(0, parseFloat(it.value) || 0),        // unit value
    weightLb:      Math.max(0.1, parseFloat(it.weight) || 0.1),   // per-unit, lb
    hsCode:        String(it.hsCode || '').replace(/[^0-9]/g, '').slice(0, 12),
    originCountry: String(it.originCountry || originDefault).toUpperCase().slice(0, 2),
  }));
  // US export filing (EEI/AES). Under $2,500 per shipment a low-value exemption
  // code goes on the label; at/above it, an actual AES filing (ITN) is required.
  // Honor a caller-supplied ITN or explicit exemption; else default the low-value
  // code. aesRequired flags an at/above-threshold shipment with no ITN yet.
  const AES_THRESHOLD = 2500;
  const totalValue = items.reduce((s, it) => s + it.value * it.quantity, 0);
  const itn = customs.itn ? String(customs.itn).replace(/[^A-Za-z0-9]/g, '') : '';
  const eelPfc = itn
    ? `AES ${itn}`
    : (customs.eelPfc || (totalValue < AES_THRESHOLD ? 'NOEEI 30.37(a)' : null));
  return {
    contentsType:  customs.contentsType || 'merchandise',
    incoterm:      (customs.incoterm || 'DDU').toUpperCase() === 'DDP' ? 'DDP' : 'DDU',
    invoiceNumber: String(customs.invoiceNumber || 'INV').slice(0, 35),
    currency:      (customs.currency || 'USD').toUpperCase().slice(0, 3),
    signer:        String(customs.signer || shipper.name || 'Shipper').slice(0, 60),
    eelPfc,
    aesRequired:   totalValue >= AES_THRESHOLD && !itn,
    items,
  };
}

// UPS: Shipment.ShipmentServiceOptions.InternationalForms (commercial invoice).
function _upsInternationalForms(c, recipient = {}) {
  const d = new Date();
  const invoiceDate = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return {
    FormType:        '01', // 01 = Commercial Invoice
    // SoldTo (the buyer) — UPS Paperless Invoice requires it. Without an
    // enrolled account UPS falls back to returning a printable form image.
    Contacts: {
      SoldTo: {
        Name:          recipient.company || recipient.name || 'Recipient',
        AttentionName: recipient.name || 'Recipient',
        Phone:         { Number: (recipient.phone || '5550000000').replace(/\D/g, '') },
        Address: {
          AddressLine:       [recipient.address1, recipient.address2].filter(Boolean),
          City:              recipient.city,
          StateProvinceCode: recipient.state,
          PostalCode:        recipient.zip,
          CountryCode:       recipient.country || 'US',
        },
      },
    },
    InvoiceNumber:   c.invoiceNumber,
    InvoiceDate:     invoiceDate,
    ReasonForExport: 'SALE',
    CurrencyCode:    c.currency,
    Product: c.items.map(it => ({
      Description:       it.description,
      ...(it.hsCode ? { CommodityCode: it.hsCode } : {}),
      OriginCountryCode: it.originCountry,
      Unit: {
        Number:            String(it.quantity),
        Value:             it.value.toFixed(2),
        UnitOfMeasurement: { Code: 'EA' },
      },
      ProductWeight: { UnitOfMeasurement: { Code: 'LBS' }, Weight: it.weightLb.toFixed(2) },
    })),
  };
}

// FedEx: requestedShipment.customsClearanceDetail.
function _fedexCustomsDetail(c) {
  return {
    dutiesPayment:     { paymentType: c.incoterm === 'DDP' ? 'SENDER' : 'RECIPIENT' },
    commercialInvoice: { termsOfSale: c.incoterm },
    commodities: c.items.map(it => ({
      description:          it.description,
      countryOfManufacture: it.originCountry,
      ...(it.hsCode ? { harmonizedCode: it.hsCode } : {}),
      quantity:             it.quantity,
      quantityUnits:        'EA',
      unitPrice:            { amount: Number(it.value.toFixed(2)), currency: c.currency },
      customsValue:         { amount: Number((it.value * it.quantity).toFixed(2)), currency: c.currency },
      weight:               { units: 'LB', value: it.weightLb },
    })),
  };
}

// Shippo: a /customs/declarations body (referenced by the shipment).
function _shippoCustomsDeclaration(c) {
  const contents = { gift: 'GIFT', sample: 'SAMPLE', documents: 'DOCUMENTS', returned_goods: 'RETURNED_GOODS' }[c.contentsType] || 'MERCHANDISE';
  return {
    contents_type:       contents,
    non_delivery_option: 'RETURN',
    certify:             true,
    certify_signer:      c.signer,
    incoterm:            c.incoterm,
    ...(c.eelPfc ? { eel_pfc: c.eelPfc } : {}),  // US export exemption / AES ITN
    items: c.items.map(it => ({
      description:    it.description,
      quantity:       it.quantity,
      net_weight:     it.weightLb.toFixed(2),
      mass_unit:      'lb',
      value_amount:   it.value.toFixed(2),
      value_currency: c.currency,
      origin_country: it.originCountry,
      ...(it.hsCode ? { tariff_number: it.hsCode } : {}),
    })),
  };
}

// ============================================================
// UPS
// ============================================================
class UPS {
  constructor(creds = {}) {
    this.sandboxUrl = 'https://wwwcie.ups.com';
    this.baseUrl    = 'https://onlinetools.ups.com';
    this.clientId      = creds.clientId;
    this.clientSecret  = creds.clientSecret;
    this.accountNumber = creds.accountNumber;
  }

  get apiUrl() {
    return process.env.UPS_SANDBOX === 'true' ? this.sandboxUrl : this.baseUrl;
  }

  async getAccessToken() {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('UPS credentials not configured. Connect your UPS account in Settings.');
    }

    // Cache per credential so we don't re-auth on every request.
    const cacheKey = `ups:${this.clientId}`;
    const cached = _getCachedToken(cacheKey);
    if (cached) return cached;

    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const res = await nodeFetch(`${this.apiUrl}/security/v1/oauth/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type':  'application/x-www-form-urlencoded',
        'x-merchant-id': this.accountNumber,
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`UPS OAuth failed: ${res.status} ${errText}`);
    }

    const data = await res.json();
    _setCachedToken(cacheKey, data.access_token, data.expires_in);
    console.log('UPS: Access token obtained successfully');
    return data.access_token;
  }

  async createShipment({ shipper, recipient, package: pkg, serviceCode, labelFormat, reference, barcodeReference, billing, customs, signature, insuranceAmount }) {
    const token = await this.getAccessToken();

    const isResidential = recipient.residential === true;
    // Cross-border → attach the commercial-invoice InternationalForms.
    const intlForms = isCrossBorder(shipper, recipient) ? normalizeCustoms(customs, shipper) : null;

    // Signature confirmation. UPS DCISType: 1=service default sig, 2=adult sig,
    // 3=USPS delivery confirmation (only). We map:
    //   'signature' → 1 (standard signature required)
    //   'adult'     → 2 (adult signature)
    //   'delivery'  → 3 (delivery confirmation only, no signature)
    //   'none' or unset → nothing added; carrier default applies.
    const sigMap = { signature: '1', adult: '2', delivery: '3' };
    const sigCode = sigMap[signature] || null;
    // Declared value (also drives UPS insurance above the auto-included $100).
    const insAmt = Number(insuranceAmount) > 0 ? Number(insuranceAmount) : 0;
    const packageServiceOptions = (sigCode || insAmt > 0) ? {
      ...(sigCode ? { DeliveryConfirmation: { DCISType: sigCode } } : {}),
      ...(insAmt > 0 ? { DeclaredValue: { CurrencyCode: 'USD', MonetaryValue: insAmt.toFixed(2) } } : {}),
    } : null;

    const payload = {
      ShipmentRequest: {
        Request: {
          RequestOption: 'nonvalidate',
          TransactionReference: { CustomerContext: reference || 'NextLao Shipment' },
        },
        Shipment: {
          Description: pkg.description || 'Goods',
          Shipper: {
            Name:           shipper.name || 'Shipper',
            AttentionName:  shipper.name || 'Shipper',
            ShipperNumber:  this.accountNumber,
            Phone:          { Number: (shipper.phone || '5550000000').replace(/\D/g, '') },
            Address: {
              AddressLine:       [shipper.address1, shipper.address2].filter(Boolean),
              City:              shipper.city,
              StateProvinceCode: shipper.state,
              PostalCode:        shipper.zip,
              CountryCode:       shipper.country || 'US',
            },
          },
          ShipTo: {
            Name:          recipient.company || recipient.name || 'Recipient',
            AttentionName: recipient.name || 'Recipient',
            Phone:         { Number: (recipient.phone || '5550000000').replace(/\D/g, '') },
            Address: {
              AddressLine:       [recipient.address1, recipient.address2].filter(Boolean),
              City:              recipient.city,
              StateProvinceCode: recipient.state,
              PostalCode:        recipient.zip,
              CountryCode:       recipient.country || 'US',
              ...(isResidential ? { ResidentialAddressIndicator: '' } : {}),
            },
          },
          ShipFrom: {
            Name:          shipper.name || 'Shipper',
            AttentionName: shipper.name || 'Shipper',
            Phone:         { Number: (shipper.phone || '5550000000').replace(/\D/g, '') },
            Address: {
              AddressLine:       [shipper.address1, shipper.address2].filter(Boolean),
              City:              shipper.city,
              StateProvinceCode: shipper.state,
              PostalCode:        shipper.zip,
              CountryCode:       shipper.country || 'US',
            },
          },
          PaymentInformation: {
            ShipmentCharge: {
              Type: '01', // 01 = Transportation
              BillShipper: { AccountNumber: this.accountNumber },
            },
          },
          Service: {
            Code:        serviceCode || '03',
            Description: 'UPS Service',
          },
          ...(intlForms ? { ShipmentServiceOptions: { InternationalForms: _upsInternationalForms(intlForms, recipient) } } : {}),
          Package: {
            Description:   pkg.description || 'Package',
            Packaging:     { Code: '02', Description: 'Customer Supplied Package' },
            ...(packageServiceOptions ? { PackageServiceOptions: packageServiceOptions } : {}),
            Dimensions: {
              UnitOfMeasurement: { Code: 'IN', Description: 'Inches' },
              Length: String(pkg.length || 12),
              Width:  String(pkg.width  || 9),
              Height: String(pkg.height || 4),
            },
            PackageWeight: {
              UnitOfMeasurement: { Code: 'LBS', Description: 'Pounds' },
              Weight:            String(pkg.weight || 1),
            },
            ...((reference || barcodeReference) ? {
              ReferenceNumber: [
                ...(reference ? [{ Code: '02', Value: String(reference).slice(0, 35) }] : []),
                ...(barcodeReference ? [{
                  Code: '02',
                  // UPS bar-code rules: alphanumeric only, <=14 chars. Strip
                  // hyphens / spaces / punctuation so callers can pass any
                  // human-friendly value (e.g. "SS-8") and it still encodes.
                  Value: String(barcodeReference).replace(/[^A-Za-z0-9]/g, '').slice(0, 14),
                  // Empty-string presence flag tells UPS to render this ref as a
                  // Code 128 barcode on the label (domestic US only, 1 per shipment).
                  BarCodeIndicator: '',
                }] : []),
              ],
            } : {}),
          },
        },
        LabelSpecification: {
          LabelImageFormat: { Code: labelFormat || 'GIF', Description: labelFormat || 'GIF' },
          HTTPUserAgent:    'Mozilla/5.0',
        },
      },
    };

    const res = await nodeFetch(`${this.apiUrl}/api/shipments/v2403/ship`, {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Content-Type':   'application/json',
        'transId':        `nextlao-ship-${Date.now()}`,
        'transactionSrc': 'nextlao',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok || !data.ShipmentResponse) {
      throw new Error(`UPS Ship API error: ${_upsErr(data)}`);
    }

    const sr = data.ShipmentResponse;
    const shipmentResults = sr.ShipmentResults;
    const packageResults  = Array.isArray(shipmentResults?.PackageResults)
      ? shipmentResults.PackageResults[0]
      : shipmentResults?.PackageResults;

    // Extract the label image (base64 GIF) — THIS IS THE FIX
    const labelImage = packageResults?.ShippingLabel?.GraphicImage || null;

    // International commercial-invoice image. On a UPS Paperless-Invoice-enrolled
    // account UPS transmits it electronically and returns nothing here; on a
    // non-enrolled account it returns the printable form so it can be attached.
    const formNode = Array.isArray(shipmentResults?.Form) ? shipmentResults.Form[0] : shipmentResults?.Form;
    const customsForm = formNode?.Image?.GraphicImage || null;

    const trackingNumber =
      packageResults?.TrackingNumber || shipmentResults?.ShipmentIdentificationNumber;

    const totalCharge = shipmentResults?.ShipmentCharges?.TotalCharges?.MonetaryValue || null;
    const currency    = shipmentResults?.ShipmentCharges?.TotalCharges?.CurrencyCode  || 'USD';
    const billingWeight = shipmentResults?.BillingWeight?.Weight || pkg.weight;

    return {
      carrier:        'ups',
      trackingNumber,
      labelImage,                      // ← base64 GIF, frontend renders this
      customsForm,                     // ← intl commercial invoice (null if paperless/domestic)
      labelUrl:       null,
      labelFormat:    labelFormat || 'GIF',
      serviceCode:    serviceCode || '03',
      serviceName:    this.getServiceName(serviceCode || '03'),
      chargedWeight:  String(billingWeight),
      totalCharge:    totalCharge,
      currency:       currency,
      shipmentId:     shipmentResults?.ShipmentIdentificationNumber,
    };
  }

  // Rate shopping: ask UPS for ALL available services + prices for this
  // package/route in one call (the "Shop" request option). Returns the
  // normalized rate shape used across every carrier.
  async getRates({ shipper, recipient, package: pkg }) {
    const token = await this.getAccessToken();

    const addr = a => ({
      AddressLine:       [a.address1, a.address2].filter(Boolean),
      City:              a.city,
      StateProvinceCode: a.state,
      PostalCode:        a.zip,
      CountryCode:       a.country || 'US',
    });

    const payload = {
      RateRequest: {
        Request: {
          RequestOption: 'Shop', // Shop = return every available service
          TransactionReference: { CustomerContext: 'NextLao Rating' },
        },
        Shipment: {
          Shipper:  { Name: shipper.name || 'Shipper', ShipperNumber: this.accountNumber, Address: addr(shipper) },
          ShipTo:   { Name: recipient.name || 'Recipient', Address: {
            ...addr(recipient),
            ...(recipient.residential === true ? { ResidentialAddressIndicator: '' } : {}),
          } },
          ShipFrom: { Name: shipper.name || 'Shipper', Address: addr(shipper) },
          Package: {
            PackagingType: { Code: '02', Description: 'Customer Supplied Package' },
            Dimensions: {
              UnitOfMeasurement: { Code: 'IN', Description: 'Inches' },
              Length: String(pkg.length || 12),
              Width:  String(pkg.width  || 9),
              Height: String(pkg.height || 4),
            },
            PackageWeight: {
              UnitOfMeasurement: { Code: 'LBS', Description: 'Pounds' },
              Weight:            String(pkg.weight || 1),
            },
          },
        },
      },
    };

    const res = await nodeFetch(`${this.apiUrl}/api/rating/v2409/Shop`, {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Content-Type':   'application/json',
        'transId':        `nextlao-rate-${Date.now()}`,
        'transactionSrc': 'nextlao',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok || !data.RateResponse) {
      throw new Error(`UPS Rating API error: ${_upsErr(data)}`);
    }

    const rated = data.RateResponse.RatedShipment || [];
    const list  = Array.isArray(rated) ? rated : [rated];

    return list.map(r => {
      const code = r.Service?.Code;
      return {
        carrier:       'ups',
        serviceCode:   code,
        serviceName:   this.getServiceName(code),
        totalCharge:   parseFloat(r.TotalCharges?.MonetaryValue ?? r.NegotiatedRateCharges?.TotalCharge?.MonetaryValue ?? 'NaN'),
        currency:      r.TotalCharges?.CurrencyCode || 'USD',
        estimatedDays: r.GuaranteedDelivery?.BusinessDaysInTransit
          ? parseInt(r.GuaranteedDelivery.BusinessDaysInTransit, 10)
          : null,
      };
    }).filter(r => Number.isFinite(r.totalCharge));
  }

  getServiceName(code) {
    const names = {
      '01': 'UPS Next Day Air',
      '02': 'UPS 2nd Day Air',
      '03': 'UPS Ground',
      '12': 'UPS 3 Day Select',
      '13': 'UPS Next Day Air Saver',
      '14': 'UPS Next Day Air Early',
      '59': 'UPS 2nd Day Air A.M.',
    };
    return names[code] || `UPS Service ${code}`;
  }

  async voidShipment(trackingNumber) {
    const token = await this.getAccessToken();

    const res = await nodeFetch(
      `${this.apiUrl}/api/shipments/v1/void/cancel/${trackingNumber}`,
      {
        method: 'DELETE',
        headers: {
          'Authorization':  `Bearer ${token}`,
          'transId':        `nextlao-void-${Date.now()}`,
          'transactionSrc': 'nextlao',
        },
      }
    );

    const data = await res.json();
    if (!res.ok) {
      throw new Error(`UPS void failed: ${data?.response?.errors?.[0]?.message || 'Unknown error'}`);
    }
    return { success: true, trackingNumber, response: data };
  }

  async track(trackingNumber) {
    const token = await this.getAccessToken();

    const res = await nodeFetch(
      `${this.apiUrl}/api/track/v1/details/${trackingNumber}`,
      {
        headers: {
          'Authorization':  `Bearer ${token}`,
          'transId':        `nextlao-track-${Date.now()}`,
          'transactionSrc': 'nextlao',
        },
      }
    );

    const data = await res.json();
    if (!res.ok) {
      throw new Error(`UPS tracking failed: ${data?.response?.errors?.[0]?.message || 'Unknown error'}`);
    }

    const shipment = data?.trackResponse?.shipment?.[0];
    const pkg      = shipment?.package?.[0];

    return {
      trackingNumber,
      carrier:    'ups',
      status:     pkg?.currentStatus?.description || 'Unknown',
      activities: (pkg?.activity || []).map(a => ({
        date:        a.date,
        time:        a.time,
        location:    `${a.location?.address?.city || ''}, ${a.location?.address?.stateProvince || ''}`.trim(),
        description: a.status?.description,
      })),
    };
  }

  async schedulePickup({ pickupDate, earliestTime, latestTime, address, packageCount, totalWeight }) {
    const token = await this.getAccessToken();

    const formattedDate = pickupDate.replace(/\D/g, ''); // YYYYMMDD

    const payload = {
      PickupCreationRequest: {
        RatePickupIndicator: 'N',
        Shipper: {
          Account: {
            AccountNumber: this.accountNumber,
            AccountCountryCode: address.country || 'US',
          },
        },
        PickupDateInfo: {
          CloseTime:    latestTime || '1700',
          ReadyTime:    earliestTime || '0900',
          PickupDate:   formattedDate,
        },
        PickupAddress: {
          CompanyName:        address.name || 'NextLao Store',
          ContactName:        address.contactName || address.name || 'NextLao',
          AddressLine:        address.address1 || '',
          Room:               '',
          Floor:              '',
          City:               address.city || '',
          StateProvince:      address.state || '',
          PostalCode:         address.zip || '',
          CountryCode:        address.country || 'US',
          ResidentialIndicator: 'N',
          Phone:              { Number: (address.phone || '5550000000').replace(/\D/g, '') },
        },
        AlternateAddressIndicator: 'N',
        PickupPiece: [{
          ServiceCode:           '003', // 003 = Ground
          Quantity:              String(packageCount || 1),
          DestinationCountryCode:'US',
          ContainerCode:         '01',  // 01 = Package
        }],
        TotalWeight: {
          Weight:            String(totalWeight || 10),
          UnitOfMeasurement: 'LBS',
        },
      },
    };

    const res = await nodeFetch(`${this.apiUrl}/api/pickupcreation/v1/pickup`, {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Content-Type':   'application/json',
        'transId':        `nextlao-pickup-${Date.now()}`,
        'transactionSrc': 'nextlao',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      const errMsg = data?.response?.errors?.[0]?.message || JSON.stringify(data).slice(0, 300);
      throw new Error(`UPS pickup failed: ${errMsg}`);
    }

    return {
      success:            true,
      confirmationNumber: data?.PickupCreationResponse?.PRN,
      rateStatus:         data?.PickupCreationResponse?.RateStatus,
    };
  }
}

// ============================================================
// FEDEX
// ============================================================
class FedEx {
  constructor(creds = {}) {
    this.sandboxUrl  = 'https://apis-sandbox.fedex.com';
    this.baseUrl     = 'https://apis.fedex.com';
    this.apiKey        = creds.apiKey;
    this.secretKey     = creds.secretKey;
    this.accountNumber = creds.accountNumber;
  }

  get apiUrl() {
    return process.env.FEDEX_SANDBOX === 'true' ? this.sandboxUrl : this.baseUrl;
  }

  async getAccessToken() {
    if (!this.apiKey || !this.secretKey) {
      throw new Error('FedEx credentials not configured. Connect your FedEx account in Settings.');
    }

    // Cache per credential so we don't re-auth on every request.
    const cacheKey = `fedex:${this.apiKey}`;
    const cached = _getCachedToken(cacheKey);
    if (cached) return cached;

    const params = new URLSearchParams();
    params.append('grant_type',    'client_credentials');
    params.append('client_id',     this.apiKey);
    params.append('client_secret', this.secretKey);

    const res = await nodeFetch(`${this.apiUrl}/oauth/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`FedEx OAuth failed: ${res.status} ${errText}`);
    }

    const data = await res.json();
    _setCachedToken(cacheKey, data.access_token, data.expires_in);
    console.log('FedEx: Access token obtained successfully');
    return data.access_token;
  }

  async createShipment({ shipper, recipient, package: pkg, serviceType, labelFormat, reference, customs, signature, insuranceAmount }) {
    const token = await this.getAccessToken();

    const intlCustoms = isCrossBorder(shipper, recipient) ? normalizeCustoms(customs, shipper) : null;

    // Signature options. FedEx signatureOptionDetail.optionType:
    //   DIRECT   → any recipient signature
    //   ADULT    → 21+
    //   INDIRECT → delivered without direct signature but confirmed (delivery)
    //   NO_SIGNATURE_REQUIRED → explicit no-signature
    //   SERVICE_DEFAULT → don't override the service default
    const sigMap = { signature: 'DIRECT', adult: 'ADULT', delivery: 'INDIRECT' };
    const sigOpt = sigMap[signature] || null;
    const insAmt = Number(insuranceAmount) > 0 ? Number(insuranceAmount) : 0;
    const specialServices = [];
    if (sigOpt) specialServices.push('SIGNATURE_OPTION');
    const packageSpecialServices = specialServices.length ? {
      specialServiceTypes: specialServices,
      ...(sigOpt ? { signatureOptionType: sigOpt } : {}),
    } : null;

    const payload = {
      labelResponseOptions: 'URL_ONLY',
      requestedShipment: {
        shipper: {
          contact: {
            personName:  shipper.name || 'Shipper',
            phoneNumber: (shipper.phone || '5550000000').replace(/\D/g, ''),
          },
          address: {
            streetLines:  [shipper.address1, shipper.address2].filter(Boolean),
            city:         shipper.city,
            stateOrProvinceCode: shipper.state,
            postalCode:   shipper.zip,
            countryCode:  shipper.country || 'US',
          },
        },
        recipients: [{
          contact: {
            personName:  recipient.name || 'Recipient',
            phoneNumber: (recipient.phone || '5550000000').replace(/\D/g, ''),
          },
          address: {
            streetLines:  [recipient.address1, recipient.address2].filter(Boolean),
            city:         recipient.city,
            stateOrProvinceCode: recipient.state,
            postalCode:   recipient.zip,
            countryCode:  recipient.country || 'US',
            residential:  recipient.residential === true,
          },
        }],
        shipDatestamp: new Date().toISOString().slice(0, 10),
        serviceType:   serviceType || 'FEDEX_GROUND',
        packagingType: 'YOUR_PACKAGING',
        pickupType:    'USE_SCHEDULED_PICKUP',
        ...(intlCustoms ? {
          customsClearanceDetail: _fedexCustomsDetail(intlCustoms),
          shippingDocumentSpecification: {
            shippingDocumentTypes: ['COMMERCIAL_INVOICE'],
            commercialInvoiceDetail: { documentFormat: { docType: 'PDF', stockType: 'PAPER_LETTER' } },
          },
        } : {}),
        shippingChargesPayment: {
          paymentType: 'SENDER',
          payor: { responsibleParty: { accountNumber: { value: this.accountNumber } } },
        },
        labelSpecification: {
          imageType:  labelFormat || 'PDF',
          labelStockType: 'PAPER_4X6',
        },
        requestedPackageLineItems: [{
          weight: { units: 'LB', value: pkg.weight || 1 },
          dimensions: {
            length: pkg.length || 12,
            width:  pkg.width  || 9,
            height: pkg.height || 4,
            units:  'IN',
          },
          ...(insAmt > 0 ? { declaredValue: { amount: insAmt, currency: 'USD' } } : {}),
          ...(packageSpecialServices ? { packageSpecialServices } : {}),
          ...(reference ? { customerReferences: [{ customerReferenceType: 'CUSTOMER_REFERENCE', value: String(reference).slice(0, 30) }] } : {}),
        }],
        ...(reference ? { customerReferences: [{ customerReferenceType: 'CUSTOMER_REFERENCE', value: String(reference).slice(0, 30) }] } : {}),
      },
      accountNumber: { value: this.accountNumber },
    };

    const res = await nodeFetch(`${this.apiUrl}/ship/v1/shipments`, {
      method: 'POST',
      headers: {
        'Authorization':       `Bearer ${token}`,
        'Content-Type':        'application/json',
        'X-locale':            'en_US',
        'x-customer-transaction-id': `nextlao-ship-${Date.now()}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok || !data.output) {
      const errMsg = data?.errors?.[0]?.message || JSON.stringify(data).slice(0, 500);
      throw new Error(`FedEx Ship API error: ${errMsg}`);
    }

    const transaction    = data.output.transactionShipments?.[0];
    const pieceResponse  = transaction?.pieceResponses?.[0];
    const packageDocs    = pieceResponse?.packageDocuments?.[0];

    return {
      carrier:        'fedex',
      trackingNumber: pieceResponse?.trackingNumber,
      labelImage:     packageDocs?.encodedLabel || null, // base64 if present
      labelUrl:       packageDocs?.url          || null,
      labelFormat:    labelFormat || 'PDF',
      serviceType:    serviceType || 'FEDEX_GROUND',
      serviceName:    this.getServiceName(serviceType || 'FEDEX_GROUND'),
      totalCharge:    transaction?.shipmentRating?.shipmentRateDetails?.[0]?.totalNetCharge || null,
      currency:       transaction?.shipmentRating?.shipmentRateDetails?.[0]?.currency || 'USD',
    };
  }

  // Rate shopping: ask FedEx for all available services + prices for this
  // package/route. Omitting serviceType makes the Rate API return every
  // eligible service. Returns the normalized rate shape.
  async getRates({ shipper, recipient, package: pkg }) {
    const token = await this.getAccessToken();

    const payload = {
      accountNumber: { value: this.accountNumber },
      requestedShipment: {
        shipper: {
          address: {
            streetLines:  [shipper.address1, shipper.address2].filter(Boolean),
            city:         shipper.city,
            stateOrProvinceCode: shipper.state,
            postalCode:   shipper.zip,
            countryCode:  shipper.country || 'US',
          },
        },
        recipient: {
          address: {
            streetLines:  [recipient.address1, recipient.address2].filter(Boolean),
            city:         recipient.city,
            stateOrProvinceCode: recipient.state,
            postalCode:   recipient.zip,
            countryCode:  recipient.country || 'US',
            residential:  recipient.residential === true,
          },
        },
        pickupType:      'USE_SCHEDULED_PICKUP',
        packagingType:   'YOUR_PACKAGING',
        rateRequestType: ['ACCOUNT', 'LIST'],
        requestedPackageLineItems: [{
          weight: { units: 'LB', value: pkg.weight || 1 },
          dimensions: {
            length: pkg.length || 12,
            width:  pkg.width  || 9,
            height: pkg.height || 4,
            units:  'IN',
          },
        }],
      },
    };

    const res = await nodeFetch(`${this.apiUrl}/rate/v1/rates/quotes`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'X-locale':      'en_US',
        'x-customer-transaction-id': `nextlao-rate-${Date.now()}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok || !data.output) {
      const errMsg = data?.errors?.[0]?.message || JSON.stringify(data).slice(0, 300);
      throw new Error(`FedEx Rate API error: ${errMsg}`);
    }

    return (data.output.rateReplyDetails || []).map(d => {
      // Prefer the account (negotiated) rate, fall back to list.
      const details = d.ratedShipmentDetails || [];
      const account = details.find(x => x.rateType === 'ACCOUNT') || details[0] || {};
      const transit = d.commit?.transitDays?.maximumTransitTime || d.commit?.daysInTransit;
      const daysMap = { ONE_DAY:1, TWO_DAYS:2, THREE_DAYS:3, FOUR_DAYS:4, FIVE_DAYS:5, SIX_DAYS:6, SEVEN_DAYS:7 };
      return {
        carrier:       'fedex',
        serviceCode:   d.serviceType,
        serviceName:   d.serviceName || this.getServiceName(d.serviceType),
        totalCharge:   parseFloat(account.totalNetCharge ?? 'NaN'),
        currency:      account.currency || 'USD',
        estimatedDays: typeof transit === 'string' ? (daysMap[transit] ?? null) : (transit ?? null),
      };
    }).filter(r => Number.isFinite(r.totalCharge));
  }

  getServiceName(type) {
    const names = {
      FEDEX_GROUND:        'FedEx Ground',
      FEDEX_EXPRESS_SAVER: 'FedEx Express Saver',
      FEDEX_2_DAY:         'FedEx 2Day',
      FEDEX_2_DAY_AM:      'FedEx 2Day A.M.',
      PRIORITY_OVERNIGHT:  'FedEx Priority Overnight',
      STANDARD_OVERNIGHT:  'FedEx Standard Overnight',
    };
    return names[type] || type;
  }

  async cancelShipment(trackingNumber) {
    const token = await this.getAccessToken();

    const res = await nodeFetch(`${this.apiUrl}/ship/v1/shipments/cancel`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'X-locale':      'en_US',
      },
      body: JSON.stringify({
        accountNumber:  { value: this.accountNumber },
        trackingNumber,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(`FedEx cancel failed: ${data?.errors?.[0]?.message || 'Unknown error'}`);
    }
    return { success: true, trackingNumber, response: data };
  }

  async track(trackingNumber) {
    const token = await this.getAccessToken();

    const res = await nodeFetch(`${this.apiUrl}/track/v1/trackingnumbers`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'X-locale':      'en_US',
      },
      body: JSON.stringify({
        trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
        includeDetailedScans: true,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(`FedEx tracking failed: ${data?.errors?.[0]?.message || 'Unknown error'}`);
    }

    const trackResult = data?.output?.completeTrackResults?.[0]?.trackResults?.[0];

    return {
      trackingNumber,
      carrier:    'fedex',
      status:     trackResult?.latestStatusDetail?.description || 'Unknown',
      activities: (trackResult?.scanEvents || []).map(e => ({
        date:        e.date,
        location:    `${e.scanLocation?.city || ''}, ${e.scanLocation?.stateOrProvinceCode || ''}`.trim(),
        description: e.eventDescription,
      })),
    };
  }
}

// ============================================================
// USPS — via Shippo
// ============================================================
class USPS {
  constructor(creds = {}) {
    this.apiKey  = creds.apiKey;
    this.baseUrl = 'https://api.goshippo.com';
  }

  // Create a Shippo customs declaration and return its object_id.
  async _createCustomsDeclaration(c) {
    const res = await nodeFetch(`${this.baseUrl}/customs/declarations/`, {
      method: 'POST',
      headers: { 'Authorization': `ShippoToken ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(_shippoCustomsDeclaration(c)),
    });
    const data = await res.json();
    if (!res.ok || !data.object_id) {
      throw new Error(`Shippo customs declaration error: ${data.detail || JSON.stringify(data).slice(0, 200)}`);
    }
    return data.object_id;
  }

  async createShipment({ shipper, recipient, package: pkg, serviceToken, reference, customs, signature, insuranceAmount }) {
    if (!this.apiKey) {
      throw new Error('Shippo token not configured. Connect your USPS/Shippo account in Settings.');
    }

    // Cross-border → create a customs declaration first and reference it on the
    // shipment (Shippo requires the declaration object for international labels).
    let customsDeclarationId = null;
    const intlCustoms = isCrossBorder(shipper, recipient) ? normalizeCustoms(customs, shipper) : null;
    if (intlCustoms) {
      customsDeclarationId = await this._createCustomsDeclaration(intlCustoms);
    }

    // Shippo `extra` bundle carries signature + insurance directives to USPS.
    // signature_confirmation values: STANDARD | ADULT (basic delivery
    // confirmation is a service level, not this flag). Insurance is a
    // structured object with provider USPS to route through Priority's
    // built-in coverage.
    const insAmt = Number(insuranceAmount) > 0 ? Number(insuranceAmount) : 0;
    const sigMap = { signature: 'STANDARD', adult: 'ADULT' };
    const shippoExtra = {};
    if (sigMap[signature]) shippoExtra.signature_confirmation = sigMap[signature];
    if (insAmt > 0) {
      shippoExtra.insurance = { amount: insAmt.toFixed(2), currency: 'USD', provider: 'USPS', content: 'Merchandise' };
    }
    const hasExtra = Object.keys(shippoExtra).length > 0;

    // Step 1: Create shipment to get rates
    const shipmentRes = await nodeFetch(`${this.baseUrl}/shipments/`, {
      method: 'POST',
      headers: {
        'Authorization': `ShippoToken ${this.apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        address_from: {
          name:    shipper.name,
          street1: shipper.address1,
          city:    shipper.city,
          state:   shipper.state,
          zip:     shipper.zip,
          country: shipper.country || 'US',
          phone:   shipper.phone || '5550000000',
        },
        address_to: {
          name:    recipient.name,
          street1: recipient.address1,
          street2: recipient.address2 || '',
          city:    recipient.city,
          state:   recipient.state,
          zip:     recipient.zip,
          country: recipient.country || 'US',
          phone:   recipient.phone || '5550000000',
        },
        parcels: [{
          length:        String(pkg.length || 12),
          width:         String(pkg.width  || 9),
          height:        String(pkg.height || 4),
          distance_unit: 'in',
          weight:        String(pkg.weight || 1),
          mass_unit:     'lb',
        }],
        ...(customsDeclarationId ? { customs_declaration: customsDeclarationId } : {}),
        ...(hasExtra ? { extra: shippoExtra } : {}),
        async: false,
      }),
    });

    const shipmentData = await shipmentRes.json();
    if (!shipmentRes.ok || !shipmentData.rates) {
      throw new Error(`Shippo shipment error: ${shipmentData.detail || 'Unknown'}`);
    }

    // Find a USPS rate matching the requested service
    const wantedToken = serviceToken || 'usps_priority';
    const rate = shipmentData.rates.find(r =>
      r.provider === 'USPS' && r.servicelevel?.token === wantedToken
    ) || shipmentData.rates.find(r => r.provider === 'USPS');

    if (!rate) {
      throw new Error('No USPS rates returned from Shippo');
    }

    // Step 2: Purchase the label
    const txRes = await nodeFetch(`${this.baseUrl}/transactions/`, {
      method: 'POST',
      headers: {
        'Authorization': `ShippoToken ${this.apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        rate:           rate.object_id,
        label_file_type: 'PDF',
        async:          false,
        metadata:       reference || '',
      }),
    });

    const txData = await txRes.json();
    if (!txRes.ok || txData.status !== 'SUCCESS') {
      throw new Error(`Shippo label purchase failed: ${(txData.messages || []).map(m => m.text).join('; ') || 'Unknown'}`);
    }

    return {
      carrier:        'usps',
      trackingNumber: txData.tracking_number,
      transactionId:  txData.object_id,    // ← needed for refunds
      labelImage:     null,
      labelUrl:       txData.label_url,
      labelFormat:    'PDF',
      serviceCode:    rate.servicelevel?.token,
      serviceName:    rate.servicelevel?.name || 'USPS',
      totalCharge:    rate.amount,
      currency:       rate.currency || 'USD',
    };
  }

  // Rate shopping: create a Shippo shipment and return every USPS rate it
  // offers, normalized to the shared shape. serviceCode is the Shippo
  // servicelevel token (e.g. usps_priority) that /label passes back as serviceType.
  async getRates({ shipper, recipient, package: pkg }) {
    if (!this.apiKey) {
      throw new Error('Shippo token not configured. Connect your USPS/Shippo account in Settings.');
    }

    const res = await nodeFetch(`${this.baseUrl}/shipments/`, {
      method: 'POST',
      headers: {
        'Authorization': `ShippoToken ${this.apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        address_from: {
          name: shipper.name, street1: shipper.address1, city: shipper.city,
          state: shipper.state, zip: shipper.zip, country: shipper.country || 'US',
          phone: shipper.phone || '5550000000',
        },
        address_to: {
          name: recipient.name, street1: recipient.address1, street2: recipient.address2 || '',
          city: recipient.city, state: recipient.state, zip: recipient.zip,
          country: recipient.country || 'US', phone: recipient.phone || '5550000000',
        },
        parcels: [{
          length: String(pkg.length || 12), width: String(pkg.width || 9),
          height: String(pkg.height || 4), distance_unit: 'in',
          weight: String(pkg.weight || 1), mass_unit: 'lb',
        }],
        async: false,
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.rates) {
      throw new Error(`Shippo rating error: ${data.detail || 'Unknown'}`);
    }

    return data.rates
      .filter(r => r.provider === 'USPS')
      .map(r => ({
        carrier:       'usps',
        serviceCode:   r.servicelevel?.token,
        serviceName:   r.servicelevel?.name || 'USPS',
        totalCharge:   parseFloat(r.amount ?? 'NaN'),
        currency:      r.currency || 'USD',
        estimatedDays: r.estimated_days ?? null,
      }))
      .filter(r => Number.isFinite(r.totalCharge));
  }

  async refundLabel(transactionId) {
    if (!this.apiKey) {
      throw new Error('Shippo token not configured. Connect your USPS/Shippo account in Settings.');
    }
    if (!transactionId) {
      throw new Error('Shippo transactionId is required to refund a USPS label');
    }

    const res = await nodeFetch(`${this.baseUrl}/refunds/`, {
      method: 'POST',
      headers: {
        'Authorization': `ShippoToken ${this.apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        transaction: transactionId,
        async:       false,
      }),
    });

    const data = await res.json();

    // Shippo returns status: QUEUED | PENDING | SUCCESS | ERROR
    if (!res.ok || data.status === 'ERROR') {
      const msg = (data.messages || []).map(m => m.text).join('; ') || data.detail || 'Refund request failed';
      throw new Error(`Shippo refund error: ${msg}`);
    }

    return {
      success:        true,
      carrier:        'usps',
      transactionId,
      status:         data.status, // QUEUED, PENDING, SUCCESS
      message:        'Refund requested. USPS reviews unused labels — refund typically issued in 14–21 days if approved.',
      refundId:       data.object_id,
    };
  }

  async track(trackingNumber) {
    if (!this.apiKey) {
      throw new Error('Shippo token not configured. Connect your USPS/Shippo account in Settings.');
    }

    const res = await nodeFetch(`${this.baseUrl}/tracks/usps/${trackingNumber}`, {
      headers: { 'Authorization': `ShippoToken ${this.apiKey}` },
    });

    const data = await res.json();
    return {
      trackingNumber,
      carrier:    'usps',
      status:     data.tracking_status?.status_details || data.tracking_status?.status || 'Unknown',
      activities: (data.tracking_history || []).map(h => ({
        date:        h.status_date,
        location:    `${h.location?.city || ''}, ${h.location?.state || ''}`.trim(),
        description: h.status_details,
      })),
    };
  }
}

// ============================================================
// EXPORTS
// ============================================================

// Build a carrier client from a specific seller's credentials.
//   ups:   { clientId, clientSecret, accountNumber }
//   fedex: { apiKey, secretKey, accountNumber }
//   usps:  { apiKey }   (Shippo token)
function buildCarrier(carrier, creds = {}) {
  switch ((carrier || '').toLowerCase()) {
    case 'ups':   return new UPS(creds);
    case 'fedex': return new FedEx(creds);
    case 'usps':  return new USPS(creds);
    default: throw new Error(`Unsupported carrier: ${carrier}`);
  }
}

async function track(carrier, trackingNumber, creds) {
  return buildCarrier(carrier, creds).track(trackingNumber);
}

async function createReturnLabel(carrier, params, creds) {
  return buildCarrier(carrier, creds).createShipment(params);
}

// Rate shopping for a single carrier. Returns an array of normalized rates:
//   { carrier, serviceCode, serviceName, totalCharge, currency, estimatedDays }
async function getRates(carrier, params, creds) {
  return buildCarrier(carrier, creds).getRates(params);
}

// Live auth/connectivity check for a single seller's credentials.
// Returns { ok: true } or { ok: false, error }.
async function testCarrierCreds(carrier, creds = {}) {
  try {
    const c = buildCarrier(carrier, creds);
    if (carrier === 'usps') {
      if (!creds.apiKey) throw new Error('Shippo API token is required.');
      const res = await nodeFetch(`${c.baseUrl}/addresses/?results=1`, {
        headers: { 'Authorization': `ShippoToken ${creds.apiKey}` },
      });
      if (!res.ok) throw new Error(`Shippo rejected the token (${res.status}).`);
    } else {
      await c.getAccessToken(); // UPS/FedEx OAuth round-trip
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  UPS,
  FedEx,
  USPS,
  buildCarrier,
  track,
  createReturnLabel,
  getRates,
  testCarrierCreds,
};
