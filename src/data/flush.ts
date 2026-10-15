/** Debounced editors register here so navigation, report generation and backup can commit pending edits first. */
const flushers = new Set<() => Promise<void>>();
export function registerFlush(fn: () => Promise<void>): () => void {
  flushers.add(fn);
  return () => { flushers.delete(fn); };
}
export async function flushAll(): Promise<void> {
  await Promise.all([...flushers].map((f) => f()));
}
