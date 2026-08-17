import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

function getPublishableKey() {
  const publishableKeys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (publishableKeys) {
    const parsed = JSON.parse(publishableKeys);
    if (parsed?.default) return parsed.default as string;
  }
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (anonKey) return anonKey;
  throw new Error("Missing Supabase browser key");
}

function getSecretKey() {
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    const parsed = JSON.parse(secretKeys);
    if (parsed?.default) return parsed.default as string;
  }
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (serviceRoleKey) return serviceRoleKey;
  throw new Error("Missing Supabase secret key");
}

async function sha256(input: string) {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signInWithPassword(projectUrl: string, anonKey: string, email: string, password: string) {
  const response = await fetch(`${projectUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
    },
    body: JSON.stringify({ email, password }),
  });
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, json };
}

async function buildGuestCredentials(deviceId: string) {
  const normalized = (deviceId || "").trim();
  if (!normalized) throw new Error("Missing device_id");
  const salt = getSecretKey().slice(0, 24);
  const digest = await sha256(`${normalized}:${salt}`);
  return {
    email: `guest-${digest.slice(0, 24)}@kept.local`,
    password: `Kept!${digest.slice(0, 32)}aA1`,
    fingerprint: digest,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const projectUrl = Deno.env.get("SUPABASE_URL");
    if (!projectUrl) throw new Error("Missing SUPABASE_URL");
    const publishableKey = getPublishableKey();

    if (req.method === "GET") {
      return new Response(JSON.stringify({
        project_url: projectUrl,
        publishable_key: publishableKey,
        functions_url: `${projectUrl}/functions/v1`,
      }), { status: 200, headers: corsHeaders });
    }

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
    }

    const body = await req.json().catch(() => ({}));
    const deviceId = typeof body.device_id === "string" ? body.device_id : "";
    const credentials = await buildGuestCredentials(deviceId);
    const admin = createClient(projectUrl, getSecretKey());

    let authResult = await signInWithPassword(projectUrl, publishableKey, credentials.email, credentials.password);
    if (!authResult.ok) {
      const { error } = await admin.auth.admin.createUser({
        email: credentials.email,
        password: credentials.password,
        email_confirm: true,
        user_metadata: { kept_guest: true },
        app_metadata: { provider: "kept-guest", fingerprint: credentials.fingerprint.slice(0, 12) },
      });
      if (error && !String(error.message || "").toLowerCase().includes("already")) throw error;
      authResult = await signInWithPassword(projectUrl, publishableKey, credentials.email, credentials.password);
    }

    if (!authResult.ok) {
      throw new Error(authResult.json?.msg || authResult.json?.error_description || authResult.json?.error || "Could not create prototype bank session");
    }

    return new Response(JSON.stringify({
      session: {
        access_token: authResult.json.access_token,
        refresh_token: authResult.json.refresh_token,
        expires_in: authResult.json.expires_in,
        token_type: authResult.json.token_type,
        user: authResult.json.user,
      },
    }), { status: 200, headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
