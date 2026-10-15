import { liveQuery } from 'dexie';
import { useEffect, useRef, useState } from 'react';

/** Subscribe a component to a Dexie live query. Re-runs when any table it reads changes. */
export function useLive<T>(query: () => Promise<T>, deps: unknown[], initial: T): [T, boolean] {
  const [value, setValue] = useState<T>(initial);
  const [ready, setReady] = useState(false);
  const q = useRef(query);
  q.current = query;
  useEffect(() => {
    setReady(false);
    const sub = liveQuery(() => q.current()).subscribe({
      next: (v) => { setValue(v); setReady(true); },
      error: (e) => { console.error('live query failed', e); setReady(true); },
    });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return [value, ready];
}
