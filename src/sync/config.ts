/**
 * Cloud project for sync. Both values are public by design (the publishable key only allows what the
 * row-level security in supabase/setup.sql permits: each signed-in user reaches only their own data).
 * Override with VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY; set VITE_SUPABASE_URL=off to build without sync.
 */
const env = import.meta.env ?? {};
export const SUPABASE_URL: string = env.VITE_SUPABASE_URL ?? 'https://ypnjoytcmfguwtdozbsg.supabase.co';
export const SUPABASE_KEY: string = env.VITE_SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_YPNEB-lp47Mr9QVlXusKtg_4073RdAS';
export const cloudConfigured = SUPABASE_URL !== 'off' && !!SUPABASE_KEY;
