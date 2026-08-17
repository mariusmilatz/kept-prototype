import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function getEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function getAuthBase() {
  return Deno.env.get("TRUELAYER_ENV") === "sandbox"
    ? "https://auth.truelayer-sandbox.com"
    : "https://auth.truelayer.com";
}

function randomState() {
  return `${crypto.randomUUID()}${crypto.randomUUID().replaceAll("-", "")}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });

  try {
    const supabaseUrl = getEnv("SUPABASE_URL");
    const anonKey = getEnv("SUPABASE_ANON_KEY");
    const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    const authHeader = req.headers.get("Authorization");

    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), { status: 401, headers: corsHeaders });
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
    }

    const body = await req.json().catch(() => ({}));
    const state = randomState();
    const scopes = Array.isArray(body.scopes) && body.scopes.length
      ? body.scopes
      : ["info", "accounts", "balance", "offline_access"];
    const redirectUri = getEnv("TRUELAYER_REDIRECT_URI");
    const clientId = getEnv("TRUELAYER_CLIENT_ID");
    const providerId = typeof body.provider_id === "string" ? body.provider_id : null;
    const providers = typeof body.providers === "string"
      ? body.providers
      : (Deno.env.get("TRUELAYER_ENV") === "sandbox" ? "uk-cs-mock" : null);

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(" "),
      state,
    });
    if (providers) params.set("providers", providers);
    if (providerId) params.set("provider_id", providerId);

    const authUrl = `${getAuthBase()}/?${params.toString()}`;

    const { error: insertError } = await admin.from("truelayer_auth_sessions").insert({
      user_id: userData.user.id,
      state,
      redirect_to: typeof body.redirect_to === "string" ? body.redirect_to : null,
      provider_id: providerId,
      scopes,
      auth_url: authUrl,
    });

    if (insertError) throw insertError;

    return new Response(JSON.stringify({ auth_url: authUrl, state, scopes }), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
