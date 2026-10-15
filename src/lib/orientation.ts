/** EXIF orientation helpers (1-8). Browsers apply orientation when decoding; we record it and use it to validate sizes. */
export function orientedSize(w: number, h: number, orientation: number) {
  return orientation >= 5 && orientation <= 8 ? { width: h, height: w } : { width: w, height: h };
}

/** Canvas 2D transform [a,b,c,d,e,f] that maps raw pixels to upright pixels for a raw w x h image. */
export function orientationTransform(orientation: number, w: number, h: number): [number, number, number, number, number, number] {
  switch (orientation) {
    case 2: return [-1, 0, 0, 1, w, 0];
    case 3: return [-1, 0, 0, -1, w, h];
    case 4: return [1, 0, 0, -1, 0, h];
    case 5: return [0, 1, 1, 0, 0, 0];
    case 6: return [0, 1, -1, 0, h, 0];
    case 7: return [0, -1, -1, 0, h, w];
    case 8: return [0, -1, 1, 0, 0, w];
    default: return [1, 0, 0, 1, 0, 0];
  }
}

/** Read the EXIF orientation tag from JPEG bytes; returns 1 when absent/unreadable. */
export function exifOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 2;
  while (off + 4 < dv.byteLength) {
    if (dv.getUint8(off) !== 0xff) return 1;
    const marker = dv.getUint8(off + 1);
    const len = dv.getUint16(off + 2);
    if (marker === 0xe1 && off + 10 < dv.byteLength && dv.getUint32(off + 4) === 0x45786966) {
      const t = off + 10; // TIFF header
      const little = dv.getUint16(t) === 0x4949;
      const ifd = t + dv.getUint32(t + 4, little);
      if (ifd + 2 > dv.byteLength) return 1;
      const n = dv.getUint16(ifd, little);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 10 > dv.byteLength) return 1;
        if (dv.getUint16(e, little) === 0x0112) {
          const val = dv.getUint16(e + 8, little);
          return val >= 1 && val <= 8 ? val : 1;
        }
      }
      return 1;
    }
    if (marker === 0xda) return 1;
    off += 2 + len;
  }
  return 1;
}

/** Cheap header sniff so oversized images are rejected before expensive decoding. */
export function sniffDimensions(bytes: Uint8Array): { width: number; height: number; mime: string } | null {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20), mime: 'image/png' };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 2;
    while (off + 9 < dv.byteLength) {
      if (dv.getUint8(off) !== 0xff) { off++; continue; }
      const m = dv.getUint8(off + 1);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { height: dv.getUint16(off + 5), width: dv.getUint16(off + 7), mime: 'image/jpeg' };
      }
      off += 2 + dv.getUint16(off + 2);
    }
  }
  return null;
}
