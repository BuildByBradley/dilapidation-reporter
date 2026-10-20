export const uuid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
export const nowIso = () => new Date().toISOString();
export const formatReference = (n: number, code = 'D') => `${code}-${String(n).padStart(3, '0')}`;
/** The number part of a reference: "L1-007" → 7 (what a plan's pin shows next to the floor's legend). */
export const referenceNumber = (ref: string) => parseInt(ref.slice(ref.lastIndexOf('-') + 1).replace(/\D/g, ''), 10) || 0;
/** The prefix of a reference: "L1-007" → "L1". */
export const referencePrefix = (ref: string) => (ref.includes('-') ? ref.slice(0, ref.lastIndexOf('-')) : '');

/**
 * Reference prefix suggested by a floor's name: Ground → G, Level 1 / 1st floor → L1, Roof → Roof,
 * Basement 2 → B2, Mezzanine → M; anything else → its initials.
 */
export function floorCode(name: string): string {
  const n = name.trim().toLowerCase();
  if (/\bground\b|^g\/?f$|^gf$|^g$/.test(n)) return 'G';
  if (/\broof/.test(n)) return 'Roof';
  if (/\bmezz/.test(n)) return 'M';
  let m = /\b(?:basement|b)\s*-?\s*(\d*)\b/.exec(n);
  if (m && /basement|^b\s*\d/.test(n)) return `B${m[1] || 1}`;
  m = /(?:level|lvl|floor|storey|l)\s*-?\s*(\d+)/.exec(n) ?? /(\d+)\s*(?:st|nd|rd|th)?\s*(?:floor|level|storey)/.exec(n) ?? /^(\d+)$/.exec(n);
  if (m) return `L${Number(m[1])}`;
  const initials = name.trim().split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('').slice(0, 3);
  return initials || 'F';
}
/** Letters, digits and spaces only; used as typed by the user for a floor's reference prefix. */
export const cleanFloorCode = (code: string) => code.replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
