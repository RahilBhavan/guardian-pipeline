/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_VAULT_ADDRESS: string;
  /** Set to "true" to read a live Supabase backend; anything else shows the recorded run. */
  readonly VITE_GUARDIAN_LIVE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
