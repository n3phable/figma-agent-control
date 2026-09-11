/**
 * [INPUT]: Imports node:zlib.
 * [OUTPUT]: Exports pngSize, decodePng, encodePng, imageStats, diffPng.
 * [POS]: PNG codec and pixel evidence shared by the bridge and offline image tools.
 * [PROTOCOL]: When changing this file, update this header and check AGENTS.md.
 */
import zlib from 'node:zlib';

// -- PNG reading and writing --------------------------------------------
// Support only the subset needed for Figma exports and difference images: 8-bit, non-interlaced; decode all formats to RGBA.
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = bytes => { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function pngSize(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(SIGNATURE) || bytes.toString('latin1', 12, 16) !== 'IHDR') throw Error('File is not a valid PNG');
  const size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (!size.width || !size.height) throw Error('Invalid PNG dimensions');
  return size;
}

export function decodePng(bytes) {
  const { width, height } = pngSize(bytes);
  const depth = bytes[24], colorType = bytes[25], interlace = bytes[28], channels = CHANNELS[colorType];
  if (depth !== 8 || !channels || interlace !== 0) throw Error('Only 8-bit non-interlaced PNG is supported');
  const idat = []; let palette = null, transparency = null;
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('latin1', offset + 4, offset + 8), body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IDAT') idat.push(body); else if (type === 'PLTE') palette = body; else if (type === 'tRNS') transparency = body; else if (type === 'IEND') break;
    offset += 12 + length;
  }
  // Derive the decompression limit from IHDR so malformed data cannot expand beyond its declared dimensions.
  const stride = width * channels, raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height }), pixels = Buffer.alloc(stride * height);
  if (raw.length < (stride + 1) * height) throw Error('PNG data is incomplete');
  // Unfilter by row: 0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[row + x - channels] : 0, up = y ? pixels[row - stride + x] : 0, corner = y && x >= channels ? pixels[row - stride + x - channels] : 0;
      const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
      const predictor = [0, left, up, (left + up) >> 1, pa <= pb && pa <= pc ? left : pb <= pc ? up : corner][filter];
      if (predictor === undefined) throw Error('Invalid PNG filter type');
      pixels[row + x] = (line[x] + predictor) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels, d = i * 4;
    if (colorType === 6) rgba.set(pixels.subarray(s, s + 4), d);
    // RGB and grayscale tRNS use 16-bit color keys; matching pixels are fully transparent.
    else if (colorType === 2) { rgba.set(pixels.subarray(s, s + 3), d); rgba[d + 3] = transparency?.length >= 6 && [0, 1, 2].every(c => pixels[s + c] === transparency.readUInt16BE(c * 2)) ? 0 : 255; }
    else if (colorType === 0 || colorType === 4) { rgba.fill(pixels[s], d, d + 3); rgba[d + 3] = colorType === 4 ? pixels[s + 1] : transparency?.length >= 2 && pixels[s] === transparency.readUInt16BE(0) ? 0 : 255; }
    else { const k = pixels[s]; if (!palette || k * 3 + 2 >= palette.length) throw Error('Invalid PNG palette'); rgba.set(palette.subarray(k * 3, k * 3 + 3), d); rgba[d + 3] = transparency && k < transparency.length ? transparency[k] : 255; }
  }
  return { width, height, data: rgba };
}

export function encodePng(width, height, rgba) {
  const chunk = (type, body) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(body.length); head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// -- Image summaries ----------------------------------------------------
// Transparency ratio and dominant colors indicate whether the background rendered before viewing the image. Count exact RGB values
// to distinguish #F6F6F6 from #FFFFFF; above one million pixels, evenly spaced sampling yields estimated ratios.
export function imageStats(bytes) {
  const { width, height, data } = decodePng(bytes), total = width * height, step = Math.max(1, Math.floor(total / 1e6)), counts = new Map();
  let sampled = 0, transparent = 0, opaque = 0;
  for (let i = 0; i < total; i += step) {
    sampled++;
    const a = data[i * 4 + 3];
    if (a === 0) { transparent++; continue; }
    if (a < 250) continue;
    opaque++;
    const key = data[i * 4] << 16 | data[i * 4 + 1] << 8 | data[i * 4 + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let top = null, most = 0;
  for (const [key, n] of counts) if (n > most) { top = key; most = n; }
  const ratio = n => sampled ? Number((n / sampled).toFixed(4)) : 0;
  return { transparentRatio: ratio(transparent), opaqueRatio: ratio(opaque),
    dominant: top === null ? null : { color: '#' + top.toString(16).padStart(6, '0').toUpperCase(), ratio: ratio(most) }, ...(step > 1 ? { sampledEvery: step } : {}) };
}

// -- Pixel differences --------------------------------------------------
// Compare the overlapping image area with premultiplied alpha, so nearly transparent antialiased edges do not count as full-intensity changes;
// count alpha differences separately. Changed pixels are red; unchanged pixels show a pale grayscale version of the after image.
export function diffPng(beforeBytes, afterBytes, threshold = 0) {
  const a = decodePng(beforeBytes), b = decodePng(afterBytes);
  const width = Math.min(a.width, b.width), height = Math.min(a.height, b.height), image = new Uint8Array(width * height * 4);
  let changed = 0, maxDelta = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * a.width + x) * 4, j = (y * b.width + x) * 4, d = (y * width + x) * 4;
    const alphaA = a.data[i + 3], alphaB = b.data[j + 3];
    let delta = Math.abs(alphaA - alphaB);
    for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.round(Math.abs(a.data[i + c] * alphaA - b.data[j + c] * alphaB) / 255));
    maxDelta = Math.max(maxDelta, delta);
    if (delta > threshold) {
      changed++;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      image.set([255, 0, 0, 255], d);
    } else {
      const gray = 255 - Math.round((255 - (b.data[j] * 0.3 + b.data[j + 1] * 0.59 + b.data[j + 2] * 0.11)) * 0.25 * b.data[j + 3] / 255);
      image.set([gray, gray, gray, 255], d);
    }
  }
  return {
    before: { width: a.width, height: a.height }, after: { width: b.width, height: b.height }, sameSize: a.width === b.width && a.height === b.height,
    compared: { width, height }, threshold, changedPixels: changed, changedRatio: width * height ? Number((changed / (width * height)).toFixed(6)) : 0,
    changedBounds: changed ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null, maxChannelDelta: maxDelta,
    image: encodePng(width, height, image)
  };
}
