/* ============================================================
   SHOPSELL — CARRIERS.JS
   UPS, FedEx, USPS shipping carrier integrations

   FIX in this version: UPS createShipment now extracts GraphicImage
   (base64 GIF) from the UPS API response and returns it as labelImage,
   so the frontend can render the actual scannable label with barcode
   and maxicode.
   ============================================================ */

'use strict';

const nodeFetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ============================================================
// UPS
// ============================================================
class UPS {
  constructor() {
    this.sandboxUrl = 'https://wwwcie.ups.com';
    this.baseUrl    = 'https://onlinetools.ups.com';
    this.clientId   = process.env.UPS_CLIENT_ID;
    this.clientSecret = process.env.UPS_CLIENT_SECRET;
    this.accountNumber = process.env.UPS_ACCOUNT_NUMBER || '094D28';
    this._tokenCache = { token: null, expiresAt: 0 };
  }

  get apiUrl() {
    return process.env.UPS_SANDBOX === 'true' ? this.sandboxUrl : this.baseUrl;
  }

  async getAccessToken() {
    // Cache token to avoid re-auth on every request
    if (this._tokenCache.token && Date.now() < this._tokenCache.expiresAt) {
      return this._tokenCache.token;
    }

    if (!this.clientId || !this.clientSecret) {
      throw new Error('UPS credentials not configured (UPS_CLIENT_ID / UPS_CLIENT_SECRET)');
    }

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
    this._tokenCache = {
      token:     data.access_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    };
    console.log('UPS: Access token obtained successfully');
    return data.access_token;
  }

  async createShipment({ shipper, recipient, package: pkg, serviceCode, labelFormat, reference, billing }) {
    const token = await this.getAccessToken();

    const isResidential = recipient.residential === true;

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
          Package: {
            Description:   pkg.description || 'Package',
            Packaging:     { Code: '02', Description: 'Customer Supplied Package' },
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
          ...(reference ? {
            ReferenceNumber: { Code: '00', Value: String(reference).slice(0, 35) },
          } : {}),
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
      const errMsg =
        data?.response?.errors?.[0]?.message ||
        data?.ShipmentResponse?.Response?.ResponseStatus?.Description ||
        JSON.stringify(data).slice(0, 500);
      throw new Error(`UPS Ship API error: ${errMsg}`);
    }

    const sr = data.ShipmentResponse;
    const shipmentResults = sr.ShipmentResults;
    const packageResults  = Array.isArray(shipmentResults?.PackageResults)
      ? shipmentResults.PackageResults[0]
      : shipmentResults?.PackageResults;

    // Extract the label image (base64 GIF) — THIS IS THE FIX
    const labelImage = packageResults?.ShippingLabel?.GraphicImage || null;

    const trackingNumber =
      packageResults?.TrackingNumber || shipmentResults?.ShipmentIdentificationNumber;

    const totalCharge = shipmentResults?.ShipmentCharges?.TotalCharges?.MonetaryValue || null;
    const currency    = shipmentResults?.ShipmentCharges?.TotalCharges?.CurrencyCode  || 'USD';
    const billingWeight = shipmentResults?.BillingWeight?.Weight || pkg.weight;

    return {
      carrier:        'ups',
      trackingNumber,
      labelImage,                      // ← base64 GIF, frontend renders this
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
  constructor() {
    this.sandboxUrl  = 'https://apis-sandbox.fedex.com';
    this.baseUrl     = 'https://apis.fedex.com';
    this.apiKey      = process.env.FEDEX_API_KEY;
    this.secretKey   = process.env.FEDEX_SECRET_KEY;
    this.accountNumber = process.env.FEDEX_ACCOUNT_NUMBER;
    this._tokenCache = { token: null, expiresAt: 0 };
  }

  get apiUrl() {
    return process.env.FEDEX_SANDBOX === 'true' ? this.sandboxUrl : this.baseUrl;
  }

  async getAccessToken() {
    if (this._tokenCache.token && Date.now() < this._tokenCache.expiresAt) {
      return this._tokenCache.token;
    }

    if (!this.apiKey || !this.secretKey) {
      throw new Error('FedEx credentials not configured (FEDEX_API_KEY / FEDEX_SECRET_KEY)');
    }

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
    this._tokenCache = {
      token:     data.access_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    };
    console.log('FedEx: Access token obtained successfully');
    return data.access_token;
  }

  async createShipment({ shipper, recipient, package: pkg, serviceType, labelFormat, reference }) {
    const token = await this.getAccessToken();

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
  constructor() {
    this.apiKey  = process.env.SHIPPO_API_KEY;
    this.baseUrl = 'https://api.goshippo.com';
  }

  async createShipment({ shipper, recipient, package: pkg, serviceToken, reference }) {
    if (!this.apiKey) {
      throw new Error('Shippo API key not configured (SHIPPO_API_KEY)');
    }

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
      labelImage:     null,
      labelUrl:       txData.label_url,
      labelFormat:    'PDF',
      serviceCode:    rate.servicelevel?.token,
      serviceName:    rate.servicelevel?.name || 'USPS',
      totalCharge:    rate.amount,
      currency:       rate.currency || 'USD',
    };
  }

  async track(trackingNumber) {
    if (!this.apiKey) {
      throw new Error('Shippo API key not configured');
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
const ups   = new UPS();
const fedex = new FedEx();
const usps  = new USPS();

async function track(carrier, trackingNumber) {
  switch (carrier.toLowerCase()) {
    case 'ups':   return ups.track(trackingNumber);
    case 'fedex': return fedex.track(trackingNumber);
    case 'usps':  return usps.track(trackingNumber);
    default: throw new Error(`Unsupported carrier: ${carrier}`);
  }
}

async function createReturnLabel(carrier, params) {
  switch (carrier.toLowerCase()) {
    case 'ups':   return ups.createShipment(params);
    case 'fedex': return fedex.createShipment(params);
    case 'usps':  return usps.createShipment(params);
    default: throw new Error(`Unsupported carrier: ${carrier}`);
  }
}

async function testConnections() {
  const results = { ups: false, fedex: false, usps: false };
  try { await ups.getAccessToken();   results.ups   = true; } catch (e) { results.upsError   = e.message; }
  try { await fedex.getAccessToken(); results.fedex = true; } catch (e) { results.fedexError = e.message; }
  results.usps = !!process.env.SHIPPO_API_KEY;
  return results;
}

module.exports = {
  ups,
  fedex,
  usps,
  track,
  createReturnLabel,
  testConnections,
};
