Tracked Supabase Edge Functions for Kept.

- `truelayer-callback/`
  - Handles the TrueLayer OAuth return flow
  - Includes duplicate-callback protection so a second hit with the same one-time code returns success if the connection already exists
