import { describe, expect, it } from 'vitest';
import { csvCell, csvRow } from '../../src/lib/csv';
import { exifOrientation, orientationTransform, orientedSize, sniffDimensions } from '../../src/lib/orientation';
import { formatReference } from '../../src/lib/ids';

describe('csv', () => {
  it('escapes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
    expect(csvRow(['x', 1, null])).toBe('x,1,');
  });
  it('neutralises formula prefixes', () => {
    for (const s of ['=1+1', '+1', '-2', '@SUM(A1)']) expect(csvCell(s).startsWith("'")).toBe(true);
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });
});
describe('orientation', () => {
  it('swaps dimensions for 5-8', () => {
    expect(orientedSize(400, 300, 1)).toEqual({ width: 400, height: 300 });
    expect(orientedSize(400, 300, 6)).toEqual({ width: 300, height: 400 });
    expect(orientedSize(400, 300, 8)).toEqual({ width: 300, height: 400 });
  });
  it('transforms map raw corners onto upright canvas', () => {
    const [a, b, c, d, e, f] = orientationTransform(6, 400, 300); // 90deg CW
    const map = (x: number, y: number) => [a * x + c * y + e, b * x + d * y + f];
    expect(map(0, 0)).toEqual([300, 0]);
    expect(map(400, 300)).toEqual([0, 400]);
    const t3 = orientationTransform(3, 400, 300);
    expect([t3[0] * 0 + t3[2] * 0 + t3[4], t3[1] * 0 + t3[3] * 0 + t3[5]]).toEqual([400, 300]);
  });
  it('reads EXIF orientation from a JPEG', () => {
    // SOI, APP1 "Exif\0\0", big-endian TIFF, one IFD entry tag 0x0112 = 6
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe1, 0x00, 0x1e, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
      0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0xff, 0xd9,
    ]);
    expect(exifOrientation(bytes)).toBe(6);
    expect(exifOrientation(new Uint8Array([1, 2, 3, 4]))).toBe(1);
  });
  it('sniffs PNG dimensions', () => {
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(png.buffer).setUint32(16, 6000); new DataView(png.buffer).setUint32(20, 4000);
    expect(sniffDimensions(png)).toEqual({ width: 6000, height: 4000, mime: 'image/png' });
  });
});
describe('references', () => {
  it('formats', () => { expect(formatReference(7)).toBe('D-007'); expect(formatReference(1234)).toBe('D-1234'); });
});
