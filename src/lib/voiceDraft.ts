import type { Category, Severity } from './types';

/**
 * Turns a spoken note into suggested record fields using plain keyword rules. This is deliberately simple and
 * transparent: it only suggests, the inspector always sees and can change the result before it is saved.
 */
const SEVERITY_RULES: [Severity, RegExp][] = [
  ['major', /\b(major|severe|serious|significant|extensive|widespread|large|wide|deep|structural)\b/i],
  ['moderate', /\b(moderate|medium|noticeable|some)\b/i],
  ['minor', /\b(minor|hairline|small|slight|light|cosmetic|superficial|fine)\b/i],
];

/** keyword -> start of a category name (matched case-insensitively against the project's own category names). */
const CATEGORY_HINTS: [RegExp, string][] = [
  [/\b(cracks?|cracked|cracking|fissures?|split|hairline)\b/i, 'crack'],
  [/\b(damp|moisture|water|leak\w*|stain\w*|mould|mold|wet|rising damp|efflorescence|blister\w*)\b/i, 'moisture'],
  [/\b(door|doors|window|windows|frame|glazing|hinge|handle|sill)\b/i, 'door'],
  [/\b(ceiling|ceilings|cornice|soffit)\b/i, 'ceiling'],
  [/\b(floor|floors|flooring|tile|tiles|tiling|carpet|screed|skirting)\b/i, 'floor'],
  [/\b(paint|painting|plaster|finish|finishes|peeling|flaking|scuff\w*|wallpaper)\b/i, 'finish'],
  [/\b(external|outside|boundary|paving|driveway|gutter|gutters|fence|roof|facade|façade|garden)\b/i, 'external'],
];

export type VoiceSuggestion = { severity?: Severity; categoryId?: string };

export function suggestFromSpeech(text: string, categories: Pick<Category, 'id' | 'name' | 'archived'>[]): VoiceSuggestion {
  const out: VoiceSuggestion = {};
  for (const [sev, re] of SEVERITY_RULES) if (re.test(text)) { out.severity = sev; break; }
  const usable = categories.filter((c) => !c.archived);
  let best: { id: string; at: number } | undefined;
  for (const [re, stem] of CATEGORY_HINTS) {
    const m = re.exec(text);
    const cat = usable.find((c) => c.name.toLowerCase().includes(stem));
    if (m && cat && (!best || m.index < best.at)) best = { id: cat.id, at: m.index }; // earliest mention wins
  }
  if (best) out.categoryId = best.id;
  return out;
}

/** Tidy dictated text: collapse whitespace, capitalise the first letter, make sure it ends with a full stop. */
export function tidyTranscript(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const cap = t[0].toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
}

export const appendText = (existing: string, addition: string) => {
  const a = addition.trim();
  if (!a) return existing;
  return existing.trim() ? `${existing.replace(/\s+$/, '')}\n${a}` : a;
};
