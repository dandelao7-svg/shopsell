/* ============================================================
   demo-content.js — the seeded demo store's catalog and layout.
   ------------------------------------------------------------
   PURE DATA. No requires, no side effects — requiring this file must never
   touch the database or the network, so the local preview harness (and any
   test) can import the exact content seed-demo.js will write.

   seed-demo.js writes it; public/demo/CREDITS.md documents the images and the
   rules for swapping one.
   ============================================================ */
const SLUG  = 'demo';
const EMAIL = 'demo@nextlao.com';

// Every image was visually checked to depict its item, to be unbranded, and to
// contain no identifiable faces. See public/demo/CREDITS.md before swapping one.
const PRODUCTS = [
  { sku:'DEMO-SHIRT-01', name:'Linen Shirt',   category:'clothing',    price:68,  compareAtPrice:85, img:'linen-shirt',
    description:'A breathable European linen shirt cut for everyday wear. Garment-washed so it stays soft from the first day.' },
  { sku:'DEMO-TOTE-01',  name:'Canvas Tote',   category:'accessories', price:34,  compareAtPrice:null, img:'canvas-tote',
    description:'Heavyweight cotton canvas with reinforced handles. Holds a laptop, a market run, or a weekend of nonsense.' },
  { sku:'DEMO-MUG-01',   name:'Ceramic Mug',   category:'home',        price:22,  compareAtPrice:28, img:'ceramic-mug',
    description:'Hand-glazed stoneware with a rounded body that keeps coffee hot longer. Dishwasher and microwave safe.' },
  { sku:'DEMO-SCARF-01', name:'Wool Scarf',    category:'clothing',    price:52,  compareAtPrice:null, img:'wool-scarf',
    description:'Chunky lambswool knit with a fringed edge. Warm enough for a real winter, soft enough to wear indoors.' },
  { sku:'DEMO-BELT-01',  name:'Leather Belt',  category:'accessories', price:58,  compareAtPrice:null, img:'leather-belt',
    description:'Full-grain leather with a solid brass buckle. Ages into its own patina instead of cracking.' },
  { sku:'DEMO-BOOT-01',  name:'Leather Boots', category:'clothing',    price:180, compareAtPrice:220, img:'leather-boots',
    description:'Goodyear-welted lace-up boots with a resoleable leather sole. Built to be repaired, not replaced.' },
  { sku:'DEMO-SOCK-01',  name:'Cotton Socks',  category:'clothing',    price:16,  compareAtPrice:null, img:'cotton-socks',
    description:'Combed cotton with a cushioned footbed and a ribbed cuff that actually stays up. Sold as a single pair.' },
  { sku:'DEMO-TIE-01',   name:'Silk Tie',      category:'accessories', price:64,  compareAtPrice:null, img:'silk-tie',
    description:'Woven mulberry silk with a hand-rolled tip and a wool interlining that holds a dimple all day.' },
];

// Featured carousel needs enough products to actually scroll.
const FEATURED = new Set(['DEMO-SHIRT-01','DEMO-TOTE-01','DEMO-SCARF-01','DEMO-BOOT-01','DEMO-BELT-01','DEMO-TIE-01']);

// A layout using every section type, so the demo doubles as a live example of
// what the Page layout editor can build.
const SECTIONS = [
  { type:'promo_banner', config:{ text:'Free shipping on every order — always', style:'solid' } },
  { type:'hero', config:{
      eyebrow:'Independent makers · Free shipping always',
      title:'Things worth keeping.',
      subtext:'A small catalog of well-made basics from independent workshops. No fast fashion, no filler — just the pieces we actually use.',
      cta1:{ label:'Shop the collection' },
      cta2:{ label:'New arrivals' },
      image:'/demo/hero.jpg' } },
  // `category` makes each tile filter the product grid below. Only the three
  // categories the demo actually stocks are shown — a Beauty tile leading to an
  // empty grid reads as broken (tile-beauty.jpg stays unused, ready for it).
  { type:'category_tiles', config:{ heading:'Shop by department', tiles:[
      { label:'Clothing',      image:'/demo/tile-clothing.jpg',    category:'clothing' },
      { label:'Accessories',   image:'/demo/tile-accessories.jpg', category:'accessories' },
      { label:'Home & Living', image:'/demo/tile-home.jpg',        category:'home' },
    ] } },
  { type:'featured_carousel', config:{ heading:'This season’s favorites', source:'featured', autoplay:true } },
  { type:'image_with_text', config:{
      image:'/demo/editorial.jpg',
      heading:'Made to be kept',
      body:'Every piece here is chosen on one test: would we still want it in ten years? That rules out most of what gets made, which is rather the point. Small batches, named workshops, materials that improve with use.',
      cta:{ label:'Read our story' },
      imageSide:'left' } },
  { type:'product_grid', config:{ source:'all', showFilters:true, columns:4 } },
  { type:'newsletter', config:{
      headline:'Get first look at new arrivals',
      subtext:'One email a month, and a welcome code for your first order. No noise.',
      buttonLabel:'Join the list' } },
];

const STOREFRONT_CONTENT = {
  contactEmail: EMAIL,
  about: 'Northwind Supply is a demonstration storefront built on ShopSell. Every product, photo and page you see here was set up through the normal seller dashboard — no custom code.',
  faq: 'Is this a real shop?\nNo. Northwind Supply is a demo store showing what a ShopSell storefront looks like when it is fully set up. Orders cannot be placed.\n\nHow was it built?\nEntirely through the seller dashboard: products, theme, and the homepage layout in the Page layout editor.',
  privacy: 'This is a demonstration storefront. It does not collect, store, or process personal data, and no orders can be placed through it.',
  terms: 'This is a demonstration storefront operated by ShopSell for illustrative purposes. No goods are offered for sale and no orders can be placed.',
  theme: 'classic',
  accentColor: '',
  featuredRailEnabled: true,
  announcementEnabled: false,
  popupEnabled: false,
  sections: SECTIONS,
};

module.exports = { SLUG, EMAIL, PRODUCTS, FEATURED, SECTIONS, STOREFRONT_CONTENT };
