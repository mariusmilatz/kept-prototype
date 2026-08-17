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

function authBase() {
  return Deno.env.get("TRUELAYER_ENV") === "sandbox"
    ? "https://auth.truelayer-sandbox.com"
    : "https://auth.truelayer.com";
}

function apiBase() {
  return Deno.env.get("TRUELAYER_ENV") === "sandbox"
    ? "https://api.truelayer-sandbox.com"
    : "https://api.truelayer.com";
}

function toMinor(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(num)) return null;
  return Math.round(num * 100);
}

function maskIdentifier(account: Record<string, unknown>): string | null {
  const accountNumber = account.account_number as Record<string, unknown> | undefined;
  if (!accountNumber) return null;
  const iban = typeof accountNumber.iban === "string" ? accountNumber.iban : null;
  if (iban && iban.length >= 4) return `****${iban.slice(-4)}`;
  const number = typeof accountNumber.number === "string" ? accountNumber.number : null;
  if (number && number.length >= 4) return `****${number.slice(-4)}`;
  return null;
}

function mapAccountType(value: unknown): string {
  const raw = typeof value === "string" ? value.toUpperCase() : "";
  if (raw.includes("SAVINGS")) return "savings";
  if (raw.includes("TRANSACTION")) return "checking";
  return "other";
}

async function refreshAccessToken(refreshToken: string) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: getEnv("TRUELAYER_CLIENT_ID"),
    client_secret: getEnv("TRUELAYER_CLIENT_SECRET"),
    refresh_token: refreshToken,
  });

  const response = await fetch(`${authBase()}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error_description || json.error || "Failed to refresh token");
  }
  return json;
}

async function fetchAccounts(accessToken: string) {
  const response = await fetch(`${apiBase()}/data/v1/accounts`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || json.message || "Failed to fetch accounts");
  }
  return Array.isArray(json.results) ? json.results : [];
}

async function fetchBalance(accessToken: string, accountId: string) {
  const response = await fetch(`${apiBase()}/data/v1/accounts/${accountId}/balance`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || json.message || `Failed to fetch balance for ${accountId}`);
  }
  return Array.isArray(json.results) ? json.results[0] ?? null : null;
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
    const admin = createClient(supabaseUrl, serviceRoleKey);

    let connectionQuery = admin
      .from("bank_connections")
      .select("id, user_id, provider, status")
      .eq("user_id", userData.user.id)
      .eq("provider", "truelayer")
      .eq("status", "active");

    if (typeof body.connection_id === "string") {
      connectionQuery = connectionQuery.eq("id", body.connection_id);
    }

    const { data: connections, error: connectionError } = await connectionQuery;
    if (connectionError) throw connectionError;
    if (!connections?.length) {
      return new Response(JSON.stringify({ error: "No active TrueLayer connections found" }), { status: 404, headers: corsHeaders });
    }

    const results = [];

    for (const connection of connections) {
      const { data: tokenRow, error: tokenError } = await admin
        .from("bank_connection_tokens")
        .select("*")
        .eq("bank_connection_id", connection.id)
        .single();
      if (tokenError || !tokenRow) throw tokenError || new Error(`Missing token for connection ${connection.id}`);

      let accessToken = tokenRow.access_token as string;
      let refreshToken = tokenRow.refresh_token as string | null;
      const expiresAt = tokenRow.expires_at ? new Date(tokenRow.expires_at as string).getTime() : 0;
      const now = Date.now();

      if (expiresAt && expiresAt - now < 120000 && refreshToken) {
        const refreshed = await refreshAccessToken(refreshToken);
        accessToken = refreshed.access_token as string;
        refreshToken = (refreshed.refresh_token as string | undefined) ?? refreshToken;
        await admin.from("bank_connection_tokens").update({
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: refreshed.token_type ?? tokenRow.token_type,
          expires_at: new Date(Date.now() + ((refreshed.expires_in as number | undefined) ?? 3600) * 1000).toISOString(),
          scope: typeof refreshed.scope === "string" ? refreshed.scope : tokenRow.scope,
          last_refreshed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", tokenRow.id);
      }

      const { error: runInsertError, data: runRow } = await admin.from("bank_sync_runs").insert({
        user_id: userData.user.id,
        bank_connection_id: connection.id,
        status: "running",
        started_at: new Date().toISOString(),
      }).select("id").single();
      if (runInsertError || !runRow) throw runInsertError || new Error("Failed to create sync run");

      try {
        const accounts = await fetchAccounts(accessToken);
        let syncedAccounts = 0;

        for (const account of accounts as Record<string, unknown>[]) {
          const providerAccountId = account.account_id as string;
          const accountType = mapAccountType(account.account_type);
          const displayName = typeof account.display_name === "string" ? account.display_name : "Bank account";
          const currency = typeof account.currency === "string" ? account.currency : "EUR";
          const accountNumber = (account.account_number as Record<string, unknown> | undefined) ?? {};
          const holderName = typeof account.account_holder_name === "string"
            ? account.account_holder_name
            : (typeof account.owner_name === "string" ? account.owner_name : null);
          const paymentEligible = Boolean(accountNumber.iban || accountNumber.number);

          const { data: bankAccount, error: accountError } = await admin
            .from("bank_accounts")
            .upsert({
              user_id: userData.user.id,
              bank_connection_id: connection.id,
              provider_account_id: providerAccountId,
              account_type: accountType,
              account_subtype: typeof account.account_type === "string" ? account.account_type : null,
              display_name: displayName,
              currency,
              account_holder_name: holderName,
              masked_account_identifier: maskIdentifier(account),
              is_source_account: true,
              is_payment_eligible: paymentEligible,
              status: "active",
              provider_metadata: account,
              updated_at: new Date().toISOString(),
            }, { onConflict: "provider_account_id" })
            .select("id")
            .single();
          if (accountError || !bankAccount) throw accountError || new Error(`Failed to upsert account ${providerAccountId}`);

          const balance = await fetchBalance(accessToken, providerAccountId).catch(() => null);
          if (balance) {
            await admin.from("balance_snapshots").insert({
              user_id: userData.user.id,
              bank_account_id: bankAccount.id,
              available_balance_minor: toMinor(balance.available),
              current_balance_minor: toMinor(balance.current),
              credit_limit_minor: toMinor(balance.overdraft),
              currency: typeof balance.currency === "string" ? balance.currency : currency,
              raw_payload: balance,
            });
          }
          syncedAccounts += 1;
        }

        await admin.from("bank_connections").update({ last_synced_at: new Date().toISOString() }).eq("id", connection.id);
        await admin.from("bank_sync_runs").update({
          status: "succeeded",
          finished_at: new Date().toISOString(),
        }).eq("id", runRow.id);

        results.push({ connection_id: connection.id, synced_accounts: syncedAccounts });
      } catch (syncError) {
        await admin.from("bank_sync_runs").update({
          status: "failed",
          finished_at: new Date().toISOString(),
          error_message: syncError instanceof Error ? syncError.message : "Unknown error",
        }).eq("id", runRow.id);
        throw syncError;
      }
    }

    return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
