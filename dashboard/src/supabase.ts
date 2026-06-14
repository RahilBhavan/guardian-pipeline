/** Singleton Supabase client + dashboard-level config read from Vite env vars. */
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY environment variable');
}

export const supabase = createClient(url, anonKey);

/**
 * The monitored vault address, surfaced in the header and used to scope the
 * Supabase queries. Pinned to the committed demo vault (source of truth:
 * demo/addresses.json) rather than a Vercel env var, so the hosted dashboard
 * tracks redeploys via a normal git push to main — no Vercel env change needed.
 * Self-hosting a different vault: change this constant.
 */
export const VAULT_ADDRESS = '0xfF9D77D1EC64C212D0552aEf587fa12125f803AF';
