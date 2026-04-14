import { createClient, SupabaseClient } from "@supabase/supabase-js";

function getEnvOrThrow(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable: ${name}. Set it in your .env.local or hosting dashboard.`
    );
  }
  return value.trim();
}

function validateSupabaseUrl(url: string): string {
  try {
    new URL(url);
  } catch {
    throw new Error(
      `Invalid supabaseUrl: "${url.substring(0, 30)}..." is not a valid URL. ` +
      `Expected format: https://xxxxx.supabase.co`
    );
  }
  return url;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serviceClientInstance: SupabaseClient<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createServiceClient(): SupabaseClient<any> {
  if (!serviceClientInstance) {
    const url = validateSupabaseUrl(getEnvOrThrow("NEXT_PUBLIC_SUPABASE_URL"));
    const key = getEnvOrThrow("SUPABASE_SERVICE_ROLE_KEY");
    serviceClientInstance = createClient(url, key);
  }
  return serviceClientInstance;
}

