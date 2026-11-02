import { useEffect, useState } from 'react';

/**
 * Tells a long-open tab (e.g. the office PC) that a newer version has been published, so it does not keep running
 * old code. Compares the app script named in the live index.html with the one this page loaded.
 */
export function UpdateBanner() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const loaded = document.querySelector<HTMLScriptElement>('script[type="module"][src*="assets/index-"]')?.src.match(/index-[\w-]+\.js/)?.[0];
    if (!loaded) return; // dev server: nothing to compare
    const check = async () => {
      try {
        const html = await (await fetch(`${location.pathname}?v=${Date.now()}`, { cache: 'no-store' })).text();
        const live = html.match(/assets\/(index-[\w-]+\.js)/)?.[1];
        if (live && live !== loaded) setAvailable(true);
      } catch { /* offline: try again later */ }
    };
    void check();
    const id = setInterval(check, 5 * 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', onVisible); };
  }, []);
  if (!available) return null;
  return (
    <div className="update-banner no-print" role="status" data-testid="update-banner">
      A newer version of the app is available.
      <button className="primary" onClick={() => location.reload()}>Reload now</button>
      <button className="link" onClick={() => setAvailable(false)}>Later</button>
    </div>
  );
}
