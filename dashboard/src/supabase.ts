/** Singleton Supabase client + dashboard-level config read from Vite env vars. */
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY environment variable');
}

export const supabase = createClient(url, anonKey);

/** The monitored vault address, surfaced in the header. */
export const VAULT_ADDRESS =
  import.meta.env.VITE_VAULT_ADDRESS ?? '0x0000000000000000000000000000000000000000';
