# ShopSell — Feature List (sales reference)

A running inventory of what the platform does, for pitching to prospects and keeping the
[user manual](guide.html) in sync. **Keep this updated as features ship.** Last updated: 2026-07-19.

> One-liner: **Storefront + multichannel OMS + shipping, in one platform.** Sellers get a
> branded online store, connect their own Stripe and carriers, sell across marketplaces, and
> print labels — all from one dashboard.

---

## 1. Buyer storefront
- Multi-tenant branded storefronts — each seller gets their own store on a **custom domain** or a `<slug>.nextlao.com` **subdomain**.
- Product catalog: categories, **variants/options** (size, color…), multiple images, ratings & **customer reviews**.
- Product **search**, category filtering, and sorting (price, rating, newest, featured).
- **SEO-ready:** server-rendered product pages, canonical tags, Open Graph / Twitter cards, JSON-LD, sitemap, branded social share images.
- **Cart + checkout** on the seller's **own Stripe account** (bring-your-own-keys).
- **Apple Pay / Google Pay** (wallet) express checkout.
- Buyer **accounts**, order history, and order tracking.
- **Discount codes** applied at checkout.
- **Self-service returns** — buyers generate their own prepaid return label.
- Transactional emails: order confirmation, shipping/tracking, return label.

## 2. Storefront customization — "make it yours"
- **3 theme presets** — Department, Boutique, Minimal — each re-skins the whole store (colors, corner style, shadows, fonts).
- **Accent color** picker (overrides the theme).
- **Logo** upload (image) or store-name wordmark.
- **Featured products carousel** — auto-advancing, paged, toggle on/off, star products to feature.
- **Announcement bar** — the top sale/free-shipping ticker (text + link + on/off).
- **Hero customization** — eyebrow, headline, subtext, both button labels, and a **background image** (auto dark overlay).
- **Email-capture popup** — offer a configurable % off for an email; the visitor gets a **unique one-time discount code** by email (works at checkout) and joins the seller's **subscriber list** (CSV export).
- **Footer content pages** — About, FAQ, Privacy, Terms, contact.
- _Roadmap:_ section show/hide + reorder, footer social links, custom fonts, bulk marketing email send + unsubscribe (email-capture phase 2), visual editor.

## 3. Seller dashboard
- **Product management** — add/edit, variants, images, inventory/stock, low-stock flags.
- **CSV import** with a column-mapping step.
- **Order management** and fulfillment.
- **Customers** list and **analytics** (GMV, orders, plan mix).
- **Discount code** creation (percentage/fixed, min-subtotal, usage limits, expiry).
- **Custom domain** connection (DNS TXT verification + CNAME).
- **Stripe setup** (seller's own account) and **payouts**.
- **Billing** — subscription plans (starter / growth / pro) with feature gating.

## 4. Shipping suite (ShipStation-style)
- **Multi-carrier**: UPS, FedEx, USPS — each with the seller's own account credentials.
- **Rate shopping** across carriers/services.
- **Label purchase + printing**; **batch** label buying.
- **Merged label PDFs** and **packing slips**.
- **Package presets**, per-product dimensions, per-order weights, **ship-from profiles**.
- **Tracking**, returns, and **automation rules**.

## 5. Sales channels (multichannel OMS)
- Import + sync orders from **Shopify**, **Amazon**, **eBay** (live), and **TikTok Shop**.
- Deduped into one order inbox; buying a label **pushes tracking back** to the source channel as a fulfillment (best-effort).

## 6. Platform & trust
- **Multi-tenant** host routing; two auth realms (sellers vs. buyers).
- **Encrypted secrets at rest** (AES-256-GCM) for carrier + Stripe credentials.
- **Operator admin console** (signups, GMV, plan breakdown).
- **Automated daily database backups**.
- Transactional email via Resend on a verified domain.

---

### Talking points for a pitch
- "**One login** runs your store, your shipping, and every marketplace."
- "Bring **your own** Stripe and carrier accounts — we don't take a cut of card processing, and you keep your negotiated shipping rates."
- "Your store, **your brand** — themes, colors, logo, hero, in minutes, no code."
- "Sell on Amazon/eBay/Shopify/TikTok and fulfill it all from **one inbox**."
