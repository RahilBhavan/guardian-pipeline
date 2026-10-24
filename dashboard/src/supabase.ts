/** Singleton Supabase client + dashboard-level config read from Vite env vars. */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * The dashboard reads a live Supabase backend only when VITE_GUARDIAN_LIVE is
 * "true" and both Supabase variables are set. Otherwise `supabase` is null and
 * the app renders the recorded run in `data/recorded-run.json`. The hosted
 * Supabase project was deleted (issue #23), so the hosted build leaves
 * VITE_GUARDIAN_LIVE unset even if stale Supabase variables remain configured.
 */
export const LIVE_BACKEND = import.meta.env.VITE_GUARDIAN_LIVE === 'true' && !!url && !!anonKey;

export const supabase: SupabaseClient | null = LIVE_BACKEND ? createClient(url, anonKey) : null;

/**
 * The monitored vault address, surfaced in the header and used to scope the
 * Supabase queries. Pinned to the committed demo vault (source of truth:
 * demo/addresses.json) rather than a Vercel env var, so the hosted dashboard
 * tracks redeploys via a normal git push to main — no Vercel env change needed.
 * Self-hosting a different vault: change this constant.
 */
export const VAULT_ADDRESS = '0xfF9D77D1EC64C212D0552aEf587fa12125f803AF';
