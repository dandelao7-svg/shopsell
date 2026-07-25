# Demo store images — sources & selection rules

These images back the seeded public demo storefront (`seed-demo.js`, slug
`demo`). They are **self-hosted** — served from `/demo/*.jpg` by
`express.static('public')` — deliberately, so the demo does not hotlink a third
party's CDN from production.

## Source & licence

All photos are from [Unsplash](https://unsplash.com) and are used under the
[Unsplash Licence](https://unsplash.com/license), which permits free commercial
use without permission or attribution. Attribution is not required; this file
exists so each image can be traced, re-downloaded, or replaced.

Each file was fetched from `images.unsplash.com/photo-<id>` at the size noted.
To re-download one, that URL plus `?w=<width>&q=75&fm=jpg&fit=max` reproduces it.

| File | Unsplash photo id | Width | Depicts |
|---|---|---|---|
| `linen-shirt.jpg` | `1596755094514-f87e34085b2c` | 800 | button-up shirt on a hanger |
| `canvas-tote.jpg` | `1544816155-12df9643f363` | 800 | tan canvas tote bag |
| `ceramic-mug.jpg` | `1514228742587-6b1558fcca3d` | 800 | white ceramic mug |
| `wool-scarf.jpg` | `1457545195570-67f207084966` | 800 | stack of folded knit scarves |
| `leather-belt.jpg` | `1624222247344-550fb60583dc` | 800 | brown leather belt + buckle |
| `leather-boots.jpg` | `1608256246200-53e635b5b65f` | 800 | brown leather boots, studio |
| `cotton-socks.jpg` | `1586350977771-b3b0abd50c82` | 800 | patterned cotton socks |
| `silk-tie.jpg` | `1589756823695-278bc923f962` | 800 | coiled silk tie on wood |
| `tile-clothing.jpg` | `1489987707025-afc232f7ea0f` | 800 | rack of shirts |
| `tile-accessories.jpg` | `1511499767150-a48a237f0083` | 800 | round sunglasses |
| `tile-home.jpg` | `1513694203232-719a280e022f` | 800 | living room, sofa + plant |
| `tile-beauty.jpg` | `1596462502278-27bfdc403348` | 800 | makeup flat-lay |
| `hero.jpg` | `1441986300917-64674bd600d8` | 1600 | boutique interior |
| `editorial.jpg` | `1556905055-8f358a7a47b2` | 1200 | knitwear + denim flat-lay |

## Rules for adding or swapping an image

A `200` from the CDN only proves the URL resolves — it says nothing about what
the photo shows. Every image above was downloaded and **looked at**. Apply the
same three checks before swapping one in:

1. **It depicts the item.** In the first pass the "leather belt" was a backpack,
   the "denim jacket" was a person in a white sweater, and the "wool scarf" was
   mostly a cup of coffee.
2. **No third-party branding.** Rejected an Omega watch for the accessories tile
   and Bobbi Brown / Curology packaging for beauty. This store is public-facing;
   it should not display other companies' trademarks.
3. **No identifiable faces.** Unsplash's licence does not carry model releases,
   and a recognisable person shown as a "product" implies an endorsement nobody
   agreed to. The `Denim Jacket` slot was dropped and replaced with
   `Leather Boots` because no unbranded, face-free denim shot was available.
   (`cotton-socks.jpg` shows feet only — standard for sock photography.)
