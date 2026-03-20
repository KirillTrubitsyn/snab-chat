import { createClient } from "@supabase/supabase-js";

function getEnvOrThrow(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable: ${name}. Set it in your .env.local or hosting dashboard.`
    );
  }
  return value;
}

export function createServiceClient() {
  const url = getEnvOrThrow("NEXT_PUBLIC_SUPABASE_URL");
  const key = getEnvOrThrow("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

export function createBrowserClient() {
  const url = getEnvOrThrow("NEXT_PUBLIC_SUPABASE_URL");
  const key = getEnvOrThrow("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return createClient(url, key);
}
