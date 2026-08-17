import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

async function ensureGuestSession(projectUrl: string, anonKey: string, deviceId: string) {
  const credentials = await buildGuestCredentials(deviceId);
  const admin = createClient(projectUrl, getSecretKey());
  let authResult = await signInWithPassword(projectUrl, anonKey, credentials.email, credentials.password);
  if (!authResult.ok) {
    const { error } = await admin.auth.admin.createUser({
      email: credentials.email,
      password: credentials.password,
      email_confirm: true,
      user_metadata: { kept_guest: true },
      app_metadata: { provider: "kept-guest", fingerprint: credentials.fingerprint.slice(0, 12) },
    });
    if (error && !String(error.message || "").toLowerCase().includes("already")) throw error;
    authResult = await signInWithPassword(projectUrl, anonKey, credentials.email, credentials.password);
  }
  if (!authResult.ok || !authResult.json?.access_token) {
    throw new Error(authResult.json?.msg || authResult.json?.error_description || authResult.json?.error || "Could not create prototype bank session");
  }
  return authResult.json;
}

async function resolveUserScopedClient(projectUrl: string, anonKey: string, req: Request, deviceId: string) {
  const incomingAuth = req.headers.get("Authorization");
  if (incomingAuth) {
    const userClient = createClient(projectUrl, anonKey, {
      global: { headers: { Authorization: incomingAuth } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (!userError && userData.user) {
      return { client: userClient, userId: userData.user.id };
    }
  }

  const session = await ensureGuestSession(projectUrl, anonKey, deviceId);
  const authHeader = `Bearer ${session.access_token}`;
  const client = createClient(projectUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  return { client, userId: session.user?.id || null, authHeader };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  try {
    const projectUrl = Deno.env.get("SUPABASE_URL");
    if (!projectUrl) throw new Error("Missing SUPABASE_URL");
    const anonKey = getPublishableKey();
    const body = await req.json().catch(() => ({}));
    const deviceId = typeof body.device_id === "string" ? body.device_id : "";
    const shouldSync = !!body.sync;
    const scoped = await resolveUserScopedClient(projectUrl, anonKey, req, deviceId);
    const client = scoped.client;

    if (shouldSync) {
      const authHeader = req.headers.get("Authorization") || scoped.authHeader;
      if (authHeader) {
        await fetch(`${projectUrl}/functions/v1/truelayer-sync`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: anonKey,
            Authorization: authHeader,
          },
          body: JSON.stringify({}),
        });
      }
    }

    const { data: connectionRows, error: connectionError } = await client
      .from("bank_connections")
      .select("*")
      .eq("provider", "truelayer")
      .eq("status", "active")
      .order("connected_at", { ascending: false })
      .limit(1);
    if (connectionError) throw connectionError;

    const connection = connectionRows?.[0] ?? null;
    let account = null;
    let snapshot = null;
    let rule = null;

    if (connection) {
      const { data: accountRows, error: accountError } = await client
        .from("bank_accounts")
        .select("*")
        .eq("bank_connection_id", connection.id)
        .eq("status", "active")
        .order("is_payment_eligible", { ascending: false })
        .order("updated_at", { ascending: false });
      if (accountError) throw accountError;
      account = (accountRows || []).find((row) => row.is_payment_eligible) || (accountRows || [])[0] || null;

      const { data: ruleRows, error: ruleError } = await client
        .from("transfer_rules")
        .select("*")
        .limit(1);
      if (ruleError) throw ruleError;
      rule = ruleRows?.[0] ?? null;

      if (account) {
        const { data: snapshotRows, error: snapshotError } = await client
          .from("balance_snapshots")
          .select("*")
          .eq("bank_account_id", account.id)
          .order("created_at", { ascending: false })
          .limit(1);
        if (snapshotError) throw snapshotError;
        snapshot = snapshotRows?.[0] ?? null;
      }
    }

    return new Response(JSON.stringify({
      user_id: scoped.userId,
      connection,
      account,
      snapshot,
      rule,
    }), { status: 200, headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Bank refresh failed" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
