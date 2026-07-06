# ShopSell — Deployment Guide

Your complete ecommerce platform. Follow these steps exactly and you'll be live on Railway in about 20 minutes.

---

## What you have

| File | What it does |
|------|-------------|
| `index.html` | Buyer-facing storefront — shop, cart, checkout |
| `dashboard.html` | Seller dashboard — products, orders, Stripe, analytics |
| `server.js` | Node.js backend — all API routes, Stripe payments |
| `database.js` | PostgreSQL data layer — products, orders, sellers, buyers |
| `carriers.js` / `lib/crypto.js` | Multi-carrier shipping + encryption for stored credentials |
| `package.json` | Node dependencies |
| `.env.example` | Template listing every environment variable — copy to `.env` and fill in |

---

## Step 1 — Set up your Stripe account (your platform account)

This is the Stripe account that charges sellers their monthly fee.

1. Go to **stripe.com** and create a free account
2. Go to **Developers → API keys** — copy your Secret Key (`sk_live_...`)
3. Go to **Products** → click **Add product**
   - Create product: "ShopSell Starter" → $79/month recurring → copy the Price ID
   - Create product: "ShopSell Growth"  → $119/month recurring → copy the Price ID
   - Create product: "ShopSell Pro"     → $149/month recurring → copy the Price ID
4. Go to **Developers → Webhooks** → **Add endpoint**
   - URL: `https://YOUR-RAILWAY-DOMAIN.up.railway.app/api/stripe/webhook`
   - Events to send: select **All events** (or at minimum the ones listed in server.js)
   - Copy the **Signing secret** (`whsec_...`)

---

## Step 2 — Put your files on GitHub

Railway deploys from GitHub. This takes 2 minutes.

1. Go to **github.com** and create a free account if you don't have one
2. Click **New repository** → name it `shopsell` → create it
3. Upload all your files (drag and drop in the GitHub interface)
4. Make sure your `.env` file is NOT uploaded — it's already listed in `.gitignore`, so keep it that way (your secrets stay local; you set them directly in Railway in Step 4)

---

## Step 3 — Deploy on Railway

1. Go to **railway.app** and sign in with your GitHub account
2. Click **New project** → **Deploy from GitHub repo**
3. Select your `shopsell` repository
4. Railway will detect it's a Node.js app automatically

---

## Step 4 — Add environment variables on Railway

1. In your Railway project, click your service → **Variables** tab
2. Click **RAW Editor** and paste these, filled in with your real values:

```
NODE_ENV=production
PORT=3000
ALLOWED_ORIGIN=https://YOUR-RAILWAY-DOMAIN.up.railway.app

# Database — auto-provided by the Railway PostgreSQL plugin (see Step 5).
# Reference it rather than typing a raw URL:
DATABASE_URL=${{Postgres.DATABASE_URL}}

# Secrets — generate each ONCE with the command shown, then never change them.
JWT_SECRET=         (generate: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
ENCRYPTION_KEY=     (generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")   # 64 hex chars — encrypts sellers' stored credentials; NEVER rotate once data exists

# Stripe — this is your PLATFORM account that charges sellers their monthly fee.
# (Buyer-payment keys are per-seller "bring your own account" and are set in the
#  seller dashboard, NOT here — there is no global publishable key env var.)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_GROWTH=price_...
STRIPE_PRICE_PRO=price_...

# Optional — transactional email (order/shipping notifications).
# If unset, the app simply skips sending email.
RESEND_API_KEY=re_...
RESEND_FROM=orders@yourdomain.com

# Optional — carrier sandbox toggles (default to live when unset).
UPS_SANDBOX=false
FEDEX_SANDBOX=false
```

---

## Step 5 — Add a PostgreSQL database

ShopSell stores everything in PostgreSQL — products, orders, sellers, buyer accounts, and encrypted carrier/Stripe credentials.

1. In your Railway project → **New** → **Database** → **Add PostgreSQL**
2. Railway provisions it and exposes a connection string
3. Make sure your service's `DATABASE_URL` variable references it: `DATABASE_URL=${{Postgres.DATABASE_URL}}` (from Step 4)
4. The app creates all tables automatically on first boot — no manual migration needed

---

## Step 6 — Deploy

1. Railway deploys automatically when you save variables
2. Click **View logs** to watch it start up
3. You should see:
   ```
   ShopSell Server running on port 3000
   ✓ Database schema ready
   ```
4. Click **Settings** → copy your Railway domain (e.g. `shopsell-production.up.railway.app`)
5. Paste that domain into your `ALLOWED_ORIGIN` variable

---

## Step 7 — Test it

Open your Railway URL in a browser:

- `https://YOUR-DOMAIN.up.railway.app/` → buyer storefront
- `https://YOUR-DOMAIN.up.railway.app/dashboard` → seller dashboard
- `https://YOUR-DOMAIN.up.railway.app/health` → should return `{"status":"ok"}`

---

## Step 8 — Set up a custom domain (optional)

1. Railway → Settings → Domains → **Add custom domain**
2. Enter your domain (e.g. `shopsell.com`)
3. Railway gives you DNS records to add at your domain registrar
4. Update `ALLOWED_ORIGIN` to your custom domain

---

## Stripe test cards (for testing checkout)

| Card number | What it simulates |
|-------------|------------------|
| `4242 4242 4242 4242` | Successful payment |
| `4000 0000 0000 0002` | Declined card |
| `4000 0027 6000 3184` | Requires authentication (3D Secure) |

Use any future expiry date and any 3-digit CVV.

---

## Security checklist before going live

- [ ] `JWT_SECRET` is at least 64 random characters
- [ ] `ENCRYPTION_KEY` is exactly 64 hex characters — and is **never rotated** once credentials are stored (rotating it makes existing encrypted data unrecoverable)
- [ ] `.env` file is NOT in your GitHub repository
- [ ] Stripe is in **live mode** (not test mode)
- [ ] Railway PostgreSQL database is attached and `DATABASE_URL` references it
- [ ] `ALLOWED_ORIGIN` is set to your exact domain
- [ ] Two-factor authentication (2FA) enabled on Railway, Stripe, and GitHub

---

## Monthly costs estimate

| Service | Cost |
|---------|------|
| Railway (Hobby plan) | ~$5/month |
| Stripe platform fees | 2.9% + $0.30 per seller subscription payment |
| Total to start | ~$5/month |

Your sellers pay you $79–$149/month each. Stripe takes ~$2.60–$4.62 per payment. You keep the rest.

---

## Need help?

If something isn't working, check:
1. Railway **Logs** tab — shows any errors on startup
2. Make sure all environment variables are filled in (no empty values)
3. Make sure the Railway PostgreSQL database is attached and `DATABASE_URL` is set
