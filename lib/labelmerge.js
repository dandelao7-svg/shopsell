'use strict';

// Merge many shipping labels into one printable PDF.
//
// Carriers return labels in different formats: UPS gives a base64 GIF,
// FedEx/USPS give a PDF (as a URL or base64). pdf-lib copies existing PDF
// pages and embeds PNG/JPG images — but not GIF — so UPS GIFs are converted
// to PNG with jimp first. Each label lands on its own 4×6 page.

const { PDFDocument } = require('pdf-lib');
const { Jimp } = require('jimp');
const nodeFetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// 4×6 inch label at 72 pt/in.
const PAGE_W = 288;
const PAGE_H = 432;

// Identify a label buffer by its magic bytes.
function sniff(buf) {
  if (!buf || buf.length < 4) return 'unknown';
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf'; // %PDF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';                    // GIF
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';                                        // \x89PNG
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'jpg';                                         // JPEG SOI
  return 'unknown';
}

// Resolve a label source to raw bytes. { labelImage } is base64; { labelUrl }
// is fetched. URLs come from our own DB (carrier-issued), never client input.
async function toBytes(src) {
  if (src.labelImage) return Buffer.from(src.labelImage, 'base64');
  if (src.labelUrl) {
    const res = await nodeFetch(src.labelUrl);
    if (!res.ok) throw new Error(`could not fetch label (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error('label has no image or url');
}

async function addImagePage(outDoc, buf, kind) {
  let bytes = buf;
  let type  = kind;
  if (kind === 'gif') {
    // pdf-lib can't embed GIF — transcode to PNG.
    const img = await Jimp.read(buf);
    bytes = await img.getBuffer('image/png');
    type  = 'png';
  }
  const embedded = type === 'png' ? await outDoc.embedPng(bytes) : await outDoc.embedJpg(bytes);
  const page  = outDoc.addPage([PAGE_W, PAGE_H]);
  const scale = Math.min(PAGE_W / embedded.width, PAGE_H / embedded.height);
  const w = embedded.width * scale;
  const h = embedded.height * scale;
  page.drawImage(embedded, { x: (PAGE_W - w) / 2, y: (PAGE_H - h) / 2, width: w, height: h });
}

// sources: [{ labelImage?, labelUrl?, label?(for error context) }]
// Returns { pdf: Buffer, merged: number, errors: [{ index, label, error }] }.
async function mergeLabels(sources) {
  const out = await PDFDocument.create();
  const errors = [];
  let merged = 0;

  for (let i = 0; i < sources.length; i++) {
    try {
      const buf  = await toBytes(sources[i]);
      const kind = sniff(buf);
      if (kind === 'pdf') {
        const src   = await PDFDocument.load(buf, { ignoreEncryption: true });
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach(p => out.addPage(p));
      } else if (kind === 'gif' || kind === 'png' || kind === 'jpg') {
        await addImagePage(out, buf, kind);
      } else {
        throw new Error('unrecognized label format');
      }
      merged++;
    } catch (e) {
      errors.push({ index: i, label: sources[i]?.label || null, error: e.message });
    }
  }

  const bytes = await out.save();
  return { pdf: Buffer.from(bytes), merged, errors };
}

module.exports = { mergeLabels, sniff };
