/* ============================================================
   NEXTLAO — CARRIERS.JS
   Real UPS and FedEx API integration
   
   UPS API Docs: https://developer.ups.com
   FedEx API Docs: https://developer.fedex.com
   
   ENVIRONMENT VARIABLES NEEDED IN RAILWAY:
   UPS_CLIENT_ID=GFEJ4LvREM7YPQAmhiW14tRKSTg7xQrLu9HNUXYjpGpGHmiA
   UPS_CLIENT_SECRET=your_ups_secret_here
   UPS_ACCOUNT_NUMBER=094D28
   FEDEX_API_KEY=l70dda9f5128074cb49159bfa6ce39fbba
   FEDEX_SECRET_KEY=your_fedex_secret_here
   FEDEX_ACCOUNT_NUMBER=210378599
   FEDEX_SANDBOX=true   (set to false when you have live FedEx credentials)
   ============================================================ */

'use strict';

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

/* ============================================================
   ── UPS API ──────────────────────────────────────────────────
   Uses UPS OAuth 2.0 + Shipping API v2403
   ============================================================ */

class UPSCarrier {
  constructor(){
    this.clientId      = process.env.UPS_CLIENT_ID;
    this.clientSecret  = process.env.UPS_CLIENT_SECRET;
    this.accountNumber = process.env.UPS_ACCOUNT_NUMBER || '094D28';
    this.baseUrl       = 'https://onlinetools.ups.com'; // production
    this.sandboxUrl    = 'https://wwwcie.ups.com';      // sandbox/testing
    this.accessToken   = null;
    this.tokenExpiry   = null;
  }

  // UPS: use sandbox only when explicitly set, otherwise always production
  get apiUrl(){
    return process.env.UPS_SANDBOX === 'true' ? this.sandboxUrl : this.baseUrl;
  }

  // ── OAUTH TOKEN ─────────────────────────────────────────────
  async getAccessToken(){
    // Return cached token if still valid
    if(this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry){
      return this.accessToken;
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const res = await fetch(`${this.apiUrl}/security/v1/oauth/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if(!res.ok){
      const err = await res.text();
      throw new Error(`UPS OAuth failed: ${err}`);
    }

    const data = await res.json();
    this.accessToken = data.access_token;
    // Set expiry 5 minutes before actual expiry for safety
    this.tokenExpiry = Date.now() + ((data.expires_in - 300) * 1000);

    console.log('UPS: Access token obtained successfully');
    return this.accessToken;
  }

  // ── CREATE SHIPMENT (GENERATE LABEL) ────────────────────────
  async createShipment({
    shipper,
    recipient,
    package: pkg,
    serviceCode,
    labelFormat,
    reference,
    billing,
  }){
    const token = await this.getAccessToken();

    // Build payment information based on billing type
    const billType = billing?.type || '01';
    let paymentInfo;

    if(billType === '01'){
      // Shipper pays (default)
      paymentInfo = {
        ShipmentCharge: {
          Type:        '01',
          BillShipper: { AccountNumber: this.accountNumber },
        },
      };
    } else if(billType === '02'){
      // Bill recipient
      paymentInfo = {
        ShipmentCharge: {
          Type:         '01',
          BillReceiver: {
            AccountNumber: billing.accountNumber,
            Address:       { PostalCode: billing.zip },
          },
        },
      };
    } else if(billType === '03'){
      // Bill 3rd party
      paymentInfo = {
        ShipmentCharge: {
          Type:          '01',
          BillThirdParty: {
            AccountNumber: billing.accountNumber,
            Address: {
              PostalCode:  billing.zip,
              CountryCode: billing.country || 'US',
            },
          },
        },
      };
    }

    const payload = {
      ShipmentRequest: {
        Request: {
          RequestOption: 'nonvalidate',
          TransactionReference: { CustomerContext: reference || 'NextLao Shipment' },
        },
        Shipment: {
          Description: pkg.description || 'Order shipment',
          Shipper: {
            Name:          shipper.name,
            ShipperNumber: this.accountNumber,
            Phone:         { Number: shipper.phone || '5550000000' },
            Address: {
              AddressLine:       [shipper.address1, shipper.address2].filter(Boolean),
              City:              shipper.city,
              StateProvinceCode: shipper.state,
              PostalCode:        shipper.zip,
              CountryCode:       shipper.country || 'US',
            },
          },
          ShipTo: {
            Name:    recipient.name,
            Phone:   { Number: recipient.phone || '5550000000' },
            Address: {
              AddressLine:       [recipient.address1, recipient.address2].filter(Boolean),
              City:              recipient.city,
              StateProvinceCode: recipient.state,
              PostalCode:        recipient.zip,
              CountryCode:       recipient.country || 'US',
              ResidentialAddressIndicator: recipient.residential ? '' : undefined,
            },
          },
          ShipFrom: {
            Name:    shipper.name,
            Phone:   { Number: shipper.phone || '5550000000' },
            Address: {
              AddressLine:       [shipper.address1, shipper.address2].filter(Boolean),
              City:              shipper.city,
              StateProvinceCode: shipper.state,
              PostalCode:        shipper.zip,
              CountryCode:       shipper.country || 'US',
            },
          },
          PaymentInformation: paymentInfo,
          Service: {
            Code:        serviceCode || '03',
            Description: this.getServiceName(serviceCode),
          },
          Package: {
            Description: pkg.description || 'Package',
            Packaging:   { Code: '02' },
            Dimensions: {
              UnitOfMeasurement: { Code: 'IN' },
              Length: String(pkg.length || 12),
              Width:  String(pkg.width  || 9),
              Height: String(pkg.height || 4),
            },
            PackageWeight: {
              UnitOfMeasurement: { Code: 'LBS' },
              Weight: String(pkg.weight || 1),
            },
            ReferenceNumber: { Value: reference || '' },
          },
        },
        LabelSpecification: {
          LabelImageFormat: { Code: labelFormat || 'GIF' },
          HTTPUserAgent:    'Mozilla/4.5',
        },
      },
    };

    const res = await fetch(`${this.apiUrl}/api/shipments/v2403/ship`, {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Content-Type':   'application/json',
        'transId':        `nextlao-${Date.now()}`,
        'transactionSrc': 'nextlao',
      },
      body: JSON.stringify(payload),
    });

    if(!res.ok){
      const err = await res.json().catch(()=>res.text());
      throw new Error(`UPS shipment failed: ${JSON.stringify(err)}`);
    }

    const data   = await res.json();
    const result = data.ShipmentResponse.ShipmentResults;

    return {
      carrier:        'ups',
      trackingNumber: result.ShipmentIdentificationNumber,
      labelImage:     result.PackageResults?.ShippingLabel?.GraphicImage,
      labelFormat:    labelFormat || 'GIF',
      serviceCode:    serviceCode || '03',
      serviceName:    this.getServiceName(serviceCode),
      chargedWeight:  result.BillingWeight?.Weight,
      totalCharge:    result.ShipmentCharges?.TotalCharges?.MonetaryValue,
      currency:       result.ShipmentCharges?.TotalCharges?.CurrencyCode || 'USD',
    };
  }

  // ── VOID SHIPMENT ────────────────────────────────────────────
  async voidShipment(trackingNumber){
    const token = await this.getAccessToken();

    const res = await fetch(`${this.apiUrl}/api/shipments/v2403/void/cancel/${trackingNumber}`, {
      method: 'DELETE',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'transId':        `nextlao-void-${Date.now()}`,
        'transactionSrc': 'nextlao',
      },
    });

    if(!res.ok){
      const err = await res.text();
      throw new Error(`UPS void failed: ${err}`);
    }

    return { success: true, trackingNumber };
  }

  // ── TRACK SHIPMENT ───────────────────────────────────────────
  async trackShipment(trackingNumber){
    const token = await this.getAccessToken();

    const res = await fetch(
      `${this.apiUrl}/api/track/v1/details/${trackingNumber}?locale=en_US&returnSignature=false`,
      {
        method: 'GET',
        headers: {
          'Authorization':  `Bearer ${token}`,
          'transId':        `nextlao-track-${Date.now()}`,
          'transactionSrc': 'nextlao',
        },
      }
    );

    if(!res.ok){
      const err = await res.text();
      throw new Error(`UPS tracking failed: ${err}`);
    }

    const data = await res.json();
    const pkg  = data.trackResponse?.shipment?.[0]?.package?.[0];

    if(!pkg) throw new Error('Tracking info not found');

    return {
      carrier:           'ups',
      trackingNumber,
      status:            pkg.status?.description || 'Unknown',
      statusCode:        pkg.status?.code,
      estimatedDelivery: pkg.deliveryDate?.[0]?.date,
      activities:        (pkg.activity || []).map(a => ({
        description: a.status?.description,
        location:    [a.location?.address?.city, a.location?.address?.stateProvince].filter(Boolean).join(', '),
        timestamp:   `${a.date} ${a.time}`,
      })),
    };
  }

  // ── SCHEDULE PICKUP ──────────────────────────────────────────
  async schedulePickup({
    pickupDate,
    earliestTime,
    latestTime,
    address,
    packageCount,
    totalWeight,
  }){
    const token = await this.getAccessToken();

    const payload = {
      PickupCreationRequest: {
        RatePickupIndicator: 'N',
        Shipper: {
          Account: { AccountNumber: this.accountNumber, AccountCountryCode: 'US' },
        },
        PickupDateInfo: {
          CloseTime:  latestTime   || '1700',
          ReadyTime:  earliestTime || '0900',
          PickupDate: pickupDate,
        },
        PickupAddress: {
          CompanyName:          address.name,
          AddressLine:          address.address1,
          City:                 address.city,
          StateProvince:        address.state,
          PostalCode:           address.zip,
          CountryCode:          'US',
          ResidentialIndicator: 'N',
        },
        TotalWeight: {
          Weight:            String(totalWeight || 10),
          UnitOfMeasurement: 'LBS',
        },
        OverweightIndicator:  'N',
        PaymentMethod:        '00',
        NumberOfBusinessDays: '1',
      },
    };

    const res = await fetch(`${this.apiUrl}/api/pickup/v2205/pickupcreation`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(payload),
    });

    if(!res.ok){
      const err = await res.text();
      throw new Error(`UPS pickup scheduling failed: ${err}`);
    }

    const data = await res.json();
    return {
      success:             true,
      confirmationNumber:  data.PickupCreationResponse?.PRN,
      pickupDate,
      earliestTime,
      latestTime,
    };
  }

  // ── CREATE RETURN LABEL ──────────────────────────────────────
  async createReturnLabel({ shipper, recipient, pkg, reference }){
    return this.createShipment({
      shipper:     recipient,
      recipient:   shipper,
      package:     pkg,
      serviceCode: '03',
      reference:   `RETURN-${reference}`,
    });
  }

  // ── SERVICE CODES ────────────────────────────────────────────
  getServiceName(code){
    const services = {
      '01': 'UPS Next Day Air',
      '02': 'UPS 2nd Day Air',
      '03': 'UPS Ground',
      '12': 'UPS 3 Day Select',
      '13': 'UPS Next Day Air Saver',
      '14': 'UPS Next Day Air Early',
      '59': 'UPS 2nd Day Air A.M.',
    };
    return services[code] || 'UPS Ground';
  }
}

/* ============================================================
   ── FEDEX API ────────────────────────────────────────────────
   Uses FedEx OAuth 2.0 + Ship API v1
   Set FEDEX_SANDBOX=true in Railway for sandbox credentials
   Set FEDEX_SANDBOX=false when you have live FedEx credentials
   ============================================================ */

class FedExCarrier {
  constructor(){
    this.apiKey        = process.env.FEDEX_API_KEY;
    this.secretKey     = process.env.FEDEX_SECRET_KEY;
    this.accountNumber = process.env.FEDEX_ACCOUNT_NUMBER;
    this.baseUrl       = 'https://apis.fedex.com';        // production
    this.sandboxUrl    = 'https://apis-sandbox.fedex.com'; // sandbox
    this.accessToken   = null;
    this.tokenExpiry   = null;
  }

  // Use sandbox URL when FEDEX_SANDBOX=true in Railway Variables
  // Switch to false when you have live production FedEx credentials
  get apiUrl(){
    return process.env.FEDEX_SANDBOX === 'true' ? this.sandboxUrl : this.baseUrl;
  }

  // ── OAUTH TOKEN ─────────────────────────────────────────────
  async getAccessToken(){
    if(this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry){
      return this.accessToken;
    }

    const params = new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     this.apiKey,
      client_secret: this.secretKey,
    });

    const res = await fetch(`${this.apiUrl}/oauth/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params,
    });

    if(!res.ok){
      const err = await res.text();
      throw new Error(`FedEx OAuth failed: ${err}`);
    }

    const data = await res.json();
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + ((data.expires_in - 300) * 1000);

    console.log('FedEx: Access token obtained successfully');
    return this.accessToken;
  }

  // ── CREATE SHIPMENT ──────────────────────────────────────────
  async createShipment({
    shipper,
    recipient,
    package: pkg,
    serviceType,
    labelFormat,
    reference,
  }){
    const token = await this.getAccessToken();

    const payload = {
      labelResponseOptions: 'URL_ONLY',
      requestedShipment: {
        shipper: {
          contact: {
            personName:  shipper.name,
            phoneNumber: shipper.phone || '5550000000',
            companyName: shipper.company || shipper.name,
          },
          address: {
            streetLines:         [shipper.address1, shipper.address2].filter(Boolean),
            city:                shipper.city,
            stateOrProvinceCode: shipper.state,
            postalCode:          shipper.zip,
            countryCode:         shipper.country || 'US',
          },
        },
        recipients: [{
          contact: {
            personName:  recipient.name,
            phoneNumber: recipient.phone || '5550000000',
          },
          address: {
            streetLines:         [recipient.address1, recipient.address2].filter(Boolean),
            city:                recipient.city,
            stateOrProvinceCode: recipient.state,
            postalCode:          recipient.zip,
            countryCode:         recipient.country || 'US',
            residential:         false,
          },
        }],
        shipDatestamp: new Date().toISOString().split('T')[0],
        serviceType:   serviceType || 'FEDEX_GROUND',
        packagingType: 'YOUR_PACKAGING',
        pickupType:    'USE_SCHEDULED_PICKUP',
        shippingChargesPayment: {
          paymentType: 'SENDER',
          payor: {
            responsibleParty: {
              accountNumber: { value: this.accountNumber },
            },
          },
        },
        labelSpecification: {
          labelFormatType: 'COMMON2D',
          imageType:       labelFormat || 'PDF',
          labelStockType:  'PAPER_4X6',
        },
        requestedPackageLineItems: [{
          weight: {
            units: 'LB',
            value: pkg.weight || 1,
          },
          dimensions: {
            length: pkg.length || 12,
            width:  pkg.width  || 9,
            height: pkg.height || 4,
            units:  'IN',
          },
          customerReferences: [{
            customerReferenceType: 'CUSTOMER_REFERENCE',
            value: reference || 'NextLao',
          }],
        }],
      },
      accountNumber: { value: this.accountNumber },
    };

    const res = await fetch(`${this.apiUrl}/ship/v1/shipments`, {
      method: 'POST',
      headers: {
        'Authorization':               `Bearer ${token}`,
        'Content-Type':                'application/json',
        'x-customer-transaction-id':   `nextlao-${Date.now()}`,
        'x-locale':                    'en_US',
      },
      body: JSON.stringify(payload),
    });

    if(!res.ok){
      const err = await res.json().catch(()=>res.text());
      throw new Error(`FedEx shipment failed: ${JSON.stringify(err)}`);
    }

    const data  = await res.json();
    const piece = data.output?.transactionShipments?.[0];

    if(!piece) throw new Error('FedEx: No shipment data returned');

    const pkgResult = piece.pieceResponses?.[0];

    return {
      carrier:        'fedex',
      trackingNumber: pkgResult?.trackingNumber,
      labelUrl:       pkgResult?.packageDocuments?.[0]?.url,
      serviceType:    serviceType || 'FEDEX_GROUND',
      serviceName:    this.getServiceName(serviceType),
    };
  }

  // ── TRACK SHIPMENT ───────────────────────────────────────────
  async trackShipment(trackingNumber){
    const token = await this.getAccessToken();

    const payload = {
      includeDetailedScans: true,
      trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
    };

    const res = await fetch(`${this.apiUrl}/track/v1/trackingnumbers`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'x-locale':      'en_US',
      },
      body: JSON.stringify(payload),
    });

    if(!res.ok){
      const err = await res.text();
      throw new Error(`FedEx tracking failed: ${err}`);
    }

    const data   = await res.json();
    const result = data.output?.completeTrackResults?.[0]?.trackResults?.[0];

    if(!result) throw new Error('FedEx: Tracking info not found');

    return {
      carrier:           'fedex',
      trackingNumber,
      status:            result.latestStatusDetail?.description || 'Unknown',
      statusCode:        result.latestStatusDetail?.code,
      estimatedDelivery: result.estimatedDeliveryTimeWindow?.window?.ends,
      activities:        (result.scanEvents || []).map(e => ({
        description: e.eventDescription,
        location:    [e.scanLocation?.city, e.scanLocation?.stateOrProvinceCode].filter(Boolean).join(', '),
        timestamp:   e.date,
      })),
    };
  }

  // ── CANCEL SHIPMENT ──────────────────────────────────────────
  async cancelShipment(trackingNumber){
    const token = await this.getAccessToken();

    const payload = {
      accountNumber:  { value: this.accountNumber },
      trackingNumber,
    };

    const res = await fetch(`${this.apiUrl}/ship/v1/shipments/cancel`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(payload),
    });

    if(!res.ok){
      const err = await res.text();
      throw new Error(`FedEx cancel failed: ${err}`);
    }

    return { success: true, trackingNumber };
  }

  getServiceName(type){
    const services = {
      'FEDEX_GROUND':        'FedEx Ground',
      'FEDEX_2_DAY':         'FedEx 2Day',
      'FEDEX_2_DAY_AM':      'FedEx 2Day A.M.',
      'PRIORITY_OVERNIGHT':  'FedEx Priority Overnight',
      'STANDARD_OVERNIGHT':  'FedEx Standard Overnight',
      'FIRST_OVERNIGHT':     'FedEx First Overnight',
      'FEDEX_EXPRESS_SAVER': 'FedEx Express Saver',
    };
    return services[type] || 'FedEx Ground';
  }
}

/* ============================================================
   ── USPS API ─────────────────────────────────────────────────
   Uses USPS Web Tools API — tracking only for now
   ============================================================ */

class USPSCarrier {
  constructor(){
    this.apiKey  = process.env.USPS_API_KEY;
    this.baseUrl = 'https://secure.shippingapis.com/ShippingAPI.dll';
  }

  async trackShipment(trackingNumber){
    if(!this.apiKey) throw new Error('USPS API key not configured');

    const xml = `<TrackFieldRequest USERID="${this.apiKey}">
      <TrackID ID="${trackingNumber}"/>
    </TrackFieldRequest>`;

    const res  = await fetch(`${this.baseUrl}?API=TrackV2&XML=${encodeURIComponent(xml)}`);
    const text = await res.text();

    const eventMatch = text.match(/<Event>(.*?)<\/Event>/);
    const cityMatch  = text.match(/<EventCity>(.*?)<\/EventCity>/);
    const dateMatch  = text.match(/<EventDate>(.*?)<\/EventDate>/);
    const timeMatch  = text.match(/<EventTime>(.*?)<\/EventTime>/);

    return {
      carrier:       'usps',
      trackingNumber,
      status:        eventMatch?.[1] || 'In Transit',
      location:      cityMatch?.[1]  || '',
      lastUpdate:    `${dateMatch?.[1] || ''} ${timeMatch?.[1] || ''}`.trim(),
    };
  }
}

/* ============================================================
   ── CARRIER SERVICE ──────────────────────────────────────────
   Single interface for all carriers
   UPS is always primary — FedEx and USPS are fallbacks
   ============================================================ */

class CarrierService {
  constructor(){
    this.ups   = new UPSCarrier();
    this.fedex = new FedExCarrier();
    this.usps  = new USPSCarrier();
  }

  getCarrier(carrier){
    const map = { ups: this.ups, fedex: this.fedex, usps: this.usps };
    const c = map[carrier?.toLowerCase()];
    if(!c) throw new Error(`Unknown carrier: ${carrier}`);
    return c;
  }

  async createLabel(carrier, shipmentData){
    return this.getCarrier(carrier).createShipment(shipmentData);
  }

  async track(carrier, trackingNumber){
    return this.getCarrier(carrier).trackShipment(trackingNumber);
  }

  async createReturnLabel(carrier, shipmentData){
    const c = this.getCarrier(carrier);
    if(c.createReturnLabel) return c.createReturnLabel(shipmentData);
    return c.createShipment({
      ...shipmentData,
      shipper:   shipmentData.recipient,
      recipient: shipmentData.shipper,
    });
  }

  // Test all carrier API connections
  async testConnections(){
    const results = {};

    try {
      await this.ups.getAccessToken();
      results.ups = { connected: true, message: 'UPS API connected' };
    } catch(e) {
      results.ups = { connected: false, message: e.message };
    }

    try {
      await this.fedex.getAccessToken();
      results.fedex = { connected: true, message: 'FedEx API connected' };
    } catch(e) {
      results.fedex = { connected: false, message: e.message };
    }

    results.usps = {
      connected: !!process.env.USPS_API_KEY,
      message:   process.env.USPS_API_KEY
        ? 'USPS API key configured'
        : 'USPS API key not set',
    };

    return results;
  }
}

// Export singleton instance
module.exports = new CarrierService();
