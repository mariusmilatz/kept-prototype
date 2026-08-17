Tracked Supabase Edge Functions for Kept (project ref `ykblaaedpqdvzzzdbfdp`).

All functions honour `TRUELAYER_ENV` (`sandbox` | `live`) to switch between
`auth.truelayer-sandbox.com` / `api.truelayer-sandbox.com` and the live hosts.

- `kept-bank-bootstrap/` (public, no JWT)
  - `GET`  → returns `{ project_url, publishable_key, functions_url }` so the browser can build a Supabase client.
  - `POST` → creates/signs-in a deterministic **guest** user from a hashed `device_id` and returns a session.
- `kept-bank-state/` (public, no JWT)
  - `POST` → resolves the current user (real JWT or guest via `device_id`), optionally triggers `truelayer-sync`, and returns `{ user_id, connection, account, snapshot, rule }`.
- `truelayer-connect/` (requires JWT)
  - `POST` → builds the TrueLayer OAuth auth URL, stores a `truelayer_auth_sessions` row, returns `{ auth_url, state }`. Sandbox defaults `providers=uk-cs-mock`.
- `truelayer-callback/` (public, no JWT — this is TrueLayer's redirect target)
  - Handles the OAuth return: exchanges `code`, stores connection + token + accounts + balance snapshot + a default `transfer_rules` row, then redirects back to the app with `#bank-return=success`.
  - Includes duplicate-callback protection so a second hit with the same one-time code returns success if the connection already exists.
- `truelayer-sync/` (requires JWT)
  - `POST` → refreshes the TrueLayer access token if near expiry, re-fetches accounts + balances, writes new `balance_snapshots`, and records a `bank_sync_runs` row.

Data model (public schema): `bank_connections`, `bank_accounts`,
`balance_snapshots`, `transfer_rules`, `bank_sync_runs`,
`truelayer_auth_sessions`, and `bank_connection_tokens` (token storage).
Everything is currently **Data API** (read-only: accounts + balances). There is
no Payments API / money-movement function yet — that is the "Stage B" build.

Recovery note: `truelayer-connect`, `kept-bank-bootstrap`, `kept-bank-state`, and
`truelayer-sync` were pulled back out of the deployed project on 2026-08-17 via the
Supabase MCP after they were found missing from local source. Keep them in sync here.
