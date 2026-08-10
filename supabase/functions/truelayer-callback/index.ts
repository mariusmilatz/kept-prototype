import { createClient } from "jsr:@supabase/supabase-js@2";

const htmlHeaders = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };

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

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildReturnUrl(redirectTo: string, params: Record<string, string>) {
  const hash = new URLSearchParams(params).toString();
  const separator = redirectTo.includes("#") ? "&" : "#";
  return `${redirectTo}${separator}${hash}`;
}

function finishPage(title: string, message: string, redirectTo?: string | null, params: Record<string, string> = {}) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeRedirect = redirectTo ? buildReturnUrl(redirectTo, params) : null;
  const safeLink = safeRedirect ? escapeHtml(safeRedirect) : "";
  const meta = safeRedirect
    ? `<meta http-equiv="refresh" content="0;url=${safeLink}">`
    : "";
  const script = safeRedirect
    ? `<script>window.location.replace(${JSON.stringify(safeRedirect)});</script>`
    : "";
  const action = safeRedirect
    ? `<p><a href=\"${safeLink}\">Return to Kept</a></p>`
    : `<p>You can close this window and return to Kept.</p>`;
  return `<!doctype html><html><head>${meta}</head><body style=\"font-family:-apple-system,system-ui,sans-serif;padding:32px;background:#f3f1ea;color:#1c2024\"><h1>${safeTitle}</h1><p>${safeMessage}</p>${action}${script}</body></html>`;
}

function redirectOrPage(
  title: string,
  message: string,
  redirectTo?: string | null,
  params: Record<string, string> = {},
  status = 303,
) {
  if (redirectTo) {
    const location = buildReturnUrl(redirectTo, params);
    return Response.redirect(location, status);
  }

  return new Response(finishPage(title, message, redirectTo, params), { status, headers: htmlHeaders });
}

async function exchangeCode(code: string) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: getEnv("TRUELAYER_CLIENT_ID"),
    client_secret: getEnv("TRUELAYER_CLIENT_SECRET"),
    redirect_uri: getEnv("TRUELAYER_REDIRECT_URI"),
    code,
  });

  const response = await fetch(`${authBase()}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error_description || json.error || "TrueLayer token exchange failed");
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

async function findExistingConnection(admin: ReturnType<typeof createClient>, state: string) {
  const { data, error } = await admin
    .from("bank_connections")
    .select("id")
    .eq("provider_connection_id", state)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function countConnectionAccounts(admin: ReturnType<typeof createClient>, bankConnectionId: string) {
  const { count, error } = await admin
    .from("bank_accounts")
    .select("id", { count: "exact", head: true })
    .eq("bank_connection_id", bankConnectionId);

  if (error) throw error;
  return count ?? 0;
}

async function buildExistingSuccessResponse(
  admin: ReturnType<typeof createClient>,
  session: Record<string, unknown>,
  state: string,
  retries = 0,
): Promise<Response | null> {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const existingConnection = await findExistingConnection(admin, state);
    if (existingConnection?.id) {
      const accountCount = await countConnectionAccounts(admin, existingConnection.id as string);
      await admin.from("truelayer_auth_sessions").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        error_message: null,
      }).eq("id", session.id as string);

      return redirectOrPage(
        "Kept bank connection added",
        `${accountCount || 1} account(s) connected successfully.`,
        (session.redirect_to as string | null | undefined) ?? null,
        {
          "bank-return": "success",
          accounts: String(accountCount || 1),
        },
      );
    }

    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  return null;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  const admin = createClient(getEnv("SUPABASE_URL"), getEnv("SUPABASE_SERVICE_ROLE_KEY"));

  if (!state) {
    return redirectOrPage("Kept bank connection failed", "Missing auth state.", null, {}, 400);
  }

  const { data: session, error: sessionError } = await admin
    .from("truelayer_auth_sessions")
    .select("*")
    .eq("state", state)
    .maybeSingle();

  if (sessionError || !session) {
    return redirectOrPage("Kept bank connection failed", "Invalid or expired auth session.", null, {}, 400);
  }

  const completedSessionResponse = await buildExistingSuccessResponse(admin, session, state);
  if (completedSessionResponse && session.status === "completed") {
    return completedSessionResponse;
  }

  if (error) {
    await admin.from("truelayer_auth_sessions").update({
      status: "failed",
      error_message: errorDescription || error,
    }).eq("id", session.id);
    return redirectOrPage("Kept bank connection failed", errorDescription || error, session.redirect_to, {
        "bank-return": "failed",
        message: errorDescription || error,
      }, 303);
  }

  if (!code) {
    return redirectOrPage("Kept bank connection failed", "Missing authorisation code.", session.redirect_to, {
        "bank-return": "failed",
        message: "Missing authorisation code.",
      }, 303);
  }

  try {
    const tokenData = await exchangeCode(code);
    const accessToken = tokenData.access_token as string;
    const refreshToken = tokenData.refresh_token as string | undefined;
    const expiresIn = typeof tokenData.expires_in === "number" ? tokenData.expires_in : 3600;
    const scope = typeof tokenData.scope === "string" ? tokenData.scope : null;

    const accounts = await fetchAccounts(accessToken);
    if (!accounts.length) throw new Error("No accounts returned from TrueLayer.");

    const firstAccount = accounts[0] as Record<string, unknown>;
    const provider = (firstAccount.provider as Record<string, unknown> | undefined) ?? {};

    const { data: bankConnection, error: connectionError } = await admin
      .from("bank_connections")
      .insert({
        user_id: session.user_id,
        provider: "truelayer",
        provider_connection_id: state,
        status: "active",
        institution_id: typeof provider.provider_id === "string" ? provider.provider_id : null,
        institution_name: typeof provider.display_name === "string"
          ? provider.display_name
          : (typeof provider.provider_id === "string" ? provider.provider_id : "TrueLayer connection"),
        connected_at: new Date().toISOString(),
        last_synced_at: new Date().toISOString(),
        provider_metadata: { auth_session_id: session.id },
      })
      .select("id")
      .single();

    if (connectionError || !bankConnection) throw connectionError || new Error("Failed to create bank connection.");

    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const { error: tokenError } = await admin.from("bank_connection_tokens").insert({
      bank_connection_id: bankConnection.id,
      access_token: accessToken,
      refresh_token: refreshToken ?? null,
      token_type: tokenData.token_type ?? "Bearer",
      expires_at: tokenExpiresAt,
      scope,
      last_refreshed_at: new Date().toISOString(),
    });
    if (tokenError) throw tokenError;

    let firstSourceAccountId: string | null = null;

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
          user_id: session.user_id,
          bank_connection_id: bankConnection.id,
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
      if (!firstSourceAccountId) firstSourceAccountId = bankAccount.id;

      try {
        const balance = await fetchBalance(accessToken, providerAccountId);
        if (balance) {
          await admin.from("balance_snapshots").insert({
            user_id: session.user_id,
            bank_account_id: bankAccount.id,
            available_balance_minor: toMinor(balance.available),
            current_balance_minor: toMinor(balance.current),
            credit_limit_minor: toMinor(balance.overdraft),
            currency: typeof balance.currency === "string" ? balance.currency : currency,
            raw_payload: balance,
          });
        }
      } catch (_balanceError) {
      }
    }

    await admin.from("transfer_rules").upsert({
      user_id: session.user_id,
      source_bank_account_id: firstSourceAccountId,
      minimum_balance_minor: 100000,
      transfer_cadence: "manual",
      automation_enabled: false,
      destination_kind: "none",
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

    await admin.from("truelayer_auth_sessions").update({
      status: "completed",
      completed_at: new Date().toISOString(),
      error_message: null,
    }).eq("id", session.id);

    return redirectOrPage("Kept bank connection added", `${accounts.length} account(s) connected successfully.`, session.redirect_to, {
        "bank-return": "success",
        accounts: String(accounts.length),
      });
  } catch (callbackError) {
    const message = callbackError instanceof Error ? callbackError.message : "Unknown error";

    if (message.toLowerCase().includes("invalid_grant")) {
      const existingSuccessResponse = await buildExistingSuccessResponse(admin, session, state, 4);
      if (existingSuccessResponse) return existingSuccessResponse;
    }

    await admin.from("truelayer_auth_sessions").update({
      status: "failed",
      error_message: message,
    }).eq("id", session.id);

    return redirectOrPage("Kept bank connection failed", message, session.redirect_to, {
        "bank-return": "failed",
        message,
      }, 303);
  }
});
