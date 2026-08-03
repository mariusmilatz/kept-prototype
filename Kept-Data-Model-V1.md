# Kept — Data Model V1

**Document status:** Working data foundation
**Version:** 1.0
**Scope:** The logical data model for **V0.1** (recording, manual transfer tracking, single goal, projections). Entities and fields needed only for bank/broker automation or couple mode are marked *Deferred* — where a deferred feature needs a hook now to avoid a future migration, the field exists but is unused.
**Depends on:** Blueprint V1 · Product Rules and Edge Cases V1 (all §15 decisions CONFIRMED 2026-07-31)
**Feeds into:** Screen IA, V0.1 feature spec, and the eventual Xcode schema (SwiftData / Core Data / backend).

---

## 0. Modelling principles (non-negotiable)

- `DM-P1` **Money is stored as an integer count of minor units (pence).** Field suffix `_minor`. No floats, ever — rounding drift would corrupt the transfer invariant and the north-star metric. (Rules `NET-03`.)
- `DM-P2` **Rates and percentages are stored as integer basis points** (e.g. 5% = `500` bps), never floats.
- `DM-P3` **Every entity has** `id` (UUID), `created_at`, `updated_at` (UTC instants), unless noted.
- `DM-P4` **Enums are stored as stable string codes**, not ordinals — so reordering never re-labels existing rows.
- `DM-P5` **The four money states drive the schema.** A `SavingWin` carries an explicit `money_state`; the transfer invariant is enforced at write time, not left to the UI.
- `DM-P6` **Time is stored twice on user-facing dated rows:** the UTC instant (`occurred_at`) and the *frozen* local display date (`display_date` + `tz_offset_minutes`), per rule `TZ-03`.

### Naming decision (resolves a collision from the Rules doc)

The Rules doc used the word **"Confirmed"** for two different things: a money-state *and* a credibility label. In the data model these are separate fields, so to remove all ambiguity:

- The **money state** keeps `confirmed` (Recorded → **Confirmed** → Transferred).
- The credibility label formerly called "Confirmed" is renamed **`verified`**.

So a Win can be `money_state = confirmed` while `credibility = verified` — different fields, no clash. This rename is the only substantive change from the Rules doc's vocabulary; everything else maps 1:1.

---

## 1. Entity map

```
User ─┬─1:1─ ProjectionSettings
      ├─1:*─ Goal            (V0.1: exactly one is_primary)
      ├─1:*─ QuickAction
      ├─1:*─ RecurringDefinition ─1:*─┐
      ├─1:*─ SavingWin ◄──────────────┘  (source_recurring_id)
      │        │
      │        ├─*:1─ Goal            (goal_id)
      │        ├─*:1─ QuickAction     (source_quick_action_id, nullable)
      │        └─*:1─ Transfer        (transfer_id, nullable)   ← whole-Win: ≤1 transfer
      ├─1:*─ Transfer
      └─1:*─ CorrectionDelta ─*:1─ SavingWin (corrected)
                             └─*:1─ Transfer (source, immutable)
```

Reference/lookup values (`Category`, all enums) are code-level enums, not tables, in V0.1.

---

## 2. Core entity: `SavingWin`

The fundamental object. One row per avoided/reduced/recurring saving.

| Field | Type | Req | Notes / Constraints |
|-------|------|-----|---------------------|
| `id` | UUID | ✓ | |
| `user_id` | UUID → User | ✓ | |
| `goal_id` | UUID → Goal | ✓ | V0.1 always the primary goal (`GL-01`, `GL-02`). |
| `category` | enum `Category` | ✓ | food_drink · snack · takeaway · shopping · transport · subscription · other |
| `win_type` | enum `WinType` | ✓ | avoided · cheaper_alternative · reduced · habit · recurring (`CT-01`–`CT-05`) |
| `name` | string(120) | — | Optional description. |
| `original_cost_minor` | int64 | ✓ | The would-have-paid cost. For `avoided`, equals the Win amount. |
| `alternative_cost_minor` | int64 | ✓ | Default `0`. What was actually spent (0 for avoided). |
| `net_amount_minor` | int64 | ✓ | **Stored**, = `original − alternative`. Constraint `≥ 1`, never negative (`NET-01`,`NET-04`). |
| `currency` | char(3) | ✓ | ISO 4217; **must equal** User.currency in V0.1 (`NET-06`). |
| `money_state` | enum `MoneyState` | ✓ | recorded · confirmed · transferred (`MS-01`). |
| `credibility` | enum `Credibility` | ✓ | verified · habit · recurring · estimated · unverified (`CT` §2.3). |
| `source_quick_action_id` | UUID → QuickAction | — | Set when logged from a quick action. |
| `source_recurring_id` | UUID → RecurringDefinition | — | Set for materialised recurring Wins. |
| `recurring_period_key` | string(7) | — | `YYYY-MM` of the recurring occurrence. Unique with `source_recurring_id` (`RC-04` dup guard). |
| `transfer_id` | UUID → Transfer | — | The **completed** transfer this Win belongs to. Null = still in the pot. |
| `occurred_at` | timestamptz | ✓ | UTC instant of the saving. |
| `display_date` | date | ✓ | Frozen local calendar date at creation (`TZ-03`). Drives month bucketing. |
| `tz_offset_minutes` | int16 | ✓ | Offset used to freeze `display_date`. |
| `created_at` / `updated_at` | timestamptz | ✓ | |

**Constraints (enforced at write time):**

- `SW-C1` `net_amount_minor = original_cost_minor − alternative_cost_minor` and `≥ 1`.
- `SW-C2` `money_state = transferred` **iff** `transfer_id` is set and that Transfer is `completed`.
- `SW-C3` `credibility = unverified` ⇒ `transfer_id` is null and `money_state ≠ transferred` (`CT` §2.3, `CT-11`).
- `SW-C4` A Win with `transfer_id` set is **amount-locked**: `original/alternative/net` immutable while linked (`ED-03`,`ED-05`). Cosmetic fields (`name`, `category`) stay editable.
- `SW-C5` Unique `(source_recurring_id, recurring_period_key)` when both present — one materialised Win per recurring per period.
- `SW-C6` Hard delete allowed **only** when `transfer_id` is null. Locked Wins must be un-marked first (`ED-05`).

**Derived, not stored:** `transfer_eligible = money_state = confirmed AND transfer_id IS NULL AND credibility ≠ unverified`. This is the pot-membership predicate.

---

## 3. `Transfer`

Created **only** when the user marks money as transferred. In V0.1 the "waiting pot" is *derived* (see §9) — it is **not** a Transfer row. Automation states are reserved for V0.2+.

| Field | Type | Req | Notes |
|-------|------|-----|-------|
| `id` | UUID | ✓ | |
| `user_id` | UUID → User | ✓ | |
| `period_key` | string(7) | ✓ | `YYYY-MM` the transfer belongs to. |
| `amount_minor` | int64 | ✓ | See invariant `TR-C1`. |
| `mode` | enum `TransferMode` | ✓ | V0.1 only `manual`. (approval/scheduled/instant/weekly/monthly reserved.) |
| `state` | enum `TransferState` | ✓ | V0.1 only `completed` or `cancelled`. (waiting/scheduled/approval_required/processing/failed/carried_forward reserved.) |
| `destination_label` | string(80) | — | Self-reported in V0.1 (e.g. "My savings account"). No account linkage yet. |
| `marked_transferred_at` | timestamptz | ✓ | When the user asserted the move (`MS-05`). |
| `created_at` / `updated_at` | timestamptz | ✓ | |

**Invariant (supersedes the simpler `ED-07`, now that corrections exist):**

- `TR-C1` `amount_minor = Σ(linked SavingWin.net_amount_minor) + Σ(CorrectionDelta.amount_minor applied to this transfer)`.
  In plain terms: a transfer's amount always equals the whole Wins it covers, adjusted by any rollover corrections landing in this period.
- `TR-C2` Linked Wins are whole (FIFO, `CF-06`/`CF-07`) — no Win is split across transfers.
- `TR-C3` Un-marking (`completed → cancelled`) is always allowed; it nulls `transfer_id` on every linked Win, returning them to `money_state = confirmed` (`ED-06`).

---

## 4. `CorrectionDelta` (the rollover mechanism)

New entity created by decision `ED-04`. Corrects a Win whose transfer is already completed, by carrying the difference into a **future** pot — without ever mutating the completed transfer.

| Field | Type | Req | Notes |
|-------|------|-----|-------|
| `id` | UUID | ✓ | |
| `user_id` | UUID → User | ✓ | |
| `saving_win_id` | UUID → SavingWin | ✓ | The corrected Win. |
| `source_transfer_id` | UUID → Transfer | ✓ | The completed transfer being corrected — **immutable** (`ED-04c`). |
| `amount_minor` | int64 **signed** | ✓ | Sign = effect on future pots. `+` = a future pot owes more; `−` = future pot is smaller. (Logged £4.20, real £3.20 → moved too much → `−100`.) |
| `remaining_minor` | int64 **signed** | ✓ | Unabsorbed portion. Starts = `amount_minor`; trends to 0 as it applies across pots (`ED-04b`). |
| `status` | enum `CorrectionStatus` | ✓ | pending · applied · superseded |
| `target_period_key` | string(7) | — | Default = the next open period. |
| `applied_in_transfer_ids` | UUID[] | — | Transfers that absorbed part/all of it. |
| `created_at` / `updated_at` | timestamptz | ✓ | |

**Rules:**

- `CD-C1` A correction **never** counts as a Saving Win — excluded from behavioural metrics, streaks, and "Recorded this month" (`ED-04a`). It only adjusts money-to-transfer.
- `CD-C2` A negative delta may not push a pot below £0; it absorbs down to 0 and carries `remaining_minor` forward until 0 (`ED-04b`).
- `CD-C3` `status = applied` only when `remaining_minor = 0`.
- `CD-C4` Editing the same locked Win again supersedes the prior pending delta (`superseded`) and issues a fresh one, so deltas never stack ambiguously.

---

## 5. `Goal`

| Field | Type | Req | Notes |
|-------|------|-----|-------|
| `id` | UUID | ✓ | |
| `user_id` | UUID → User | ✓ | |
| `name` | string(80) | ✓ | |
| `type` | enum `GoalType` | ✓ | long_term_investment · emergency_fund · house_deposit · holiday · car · business · child · custom |
| `target_amount_minor` | int64 | — | Optional (`GL-03`) — "just invest more" needs no number. |
| `target_date` | date | — | Optional. |
| `is_primary` | bool | ✓ | V0.1: exactly one `true` per user (`GL-01`). |
| `status` | enum `GoalStatus` | ✓ | active · achieved · archived |
| `currency` | char(3) | ✓ | = User.currency. |
| `created_at` / `updated_at` | timestamptz | ✓ | |

*Deferred field (present, unused in V0.1):* `allocation_bps` for multi-goal % splits (`GL` §20.3).

---

## 6. `QuickAction`

| Field | Type | Req | Notes |
|-------|------|-----|-------|
| `id` | UUID | ✓ | |
| `user_id` | UUID → User | ✓ | |
| `name` | string(60) | ✓ | e.g. "Coffee". |
| `default_amount_minor` | int64 | ✓ | `≥ 50` default floor (`NET-05`); custom Wins may go lower. |
| `category` | enum `Category` | ✓ | |
| `usage_count` | int32 | ✓ | Default 0; drives ordering + auto-suggestion (`QA-04`). |
| `display_order` | int32 | ✓ | |
| `source` | enum `QuickActionSource` | ✓ | user_created · system_suggested |
| `is_archived` | bool | ✓ | Default false. |
| `created_at` / `updated_at` | timestamptz | ✓ | |

- `QA-C1` Editing `default_amount_minor` does **not** alter past Wins (`QA-05`) — Wins store their own amounts.
- Logging is one-tap + undo (`QA-03`); the undo window is a UI concern, not stored — an undone log deletes the just-created Win before it ever leaves `recorded`.

---

## 7. `RecurringDefinition`

Template that materialises one Win per period (`RC-02`).

| Field | Type | Req | Notes |
|-------|------|-----|-------|
| `id` | UUID | ✓ | |
| `user_id` | UUID → User | ✓ | |
| `name` | string(80) | ✓ | e.g. "Cancelled music subscription". |
| `amount_minor` | int64 | ✓ | Periodic reduction. |
| `frequency` | enum `RecurringFrequency` | ✓ | V0.1: `monthly` only (`RC-01`). weekly reserved. |
| `category` | enum `Category` | ✓ | |
| `goal_id` | UUID → Goal | ✓ | |
| `start_date` | date | ✓ | |
| `end_date` | date | — | Optional (`RC-07`). |
| `next_period_key` | string(7) | ✓ | Next `YYYY-MM` to materialise. |
| `status` | enum `RecurringStatus` | ✓ | active · paused · ended |
| `created_at` / `updated_at` | timestamptz | ✓ | |

- `RC-C1` Materialised Win is created at `credibility = recurring`, `money_state = recorded`, and requires the one-tap monthly "still active?" confirm to advance to `confirmed`/transfer-eligible (`RC-03`).
- `RC-C2` Editing the definition affects only **future** materialisations (`RC-05`); past Wins are untouched.
- `RC-C3` Uniqueness enforced via `SavingWin` `SW-C5`.

---

## 8. `ProjectionSettings` (1:1 with User)

| Field | Type | Req | Notes |
|-------|------|-----|-------|
| `user_id` | UUID → User (PK) | ✓ | |
| `return_low_bps` | int16 | ✓ | Default `300` (3%). |
| `return_standard_bps` | int16 | ✓ | Default `500` (5%). |
| `return_high_bps` | int16 | ✓ | Default `700` (7%). *(Only loose end from §15 — tunable.)* |
| `horizon_years` | int16 | ✓ | Default e.g. 20. |
| `inflation_adjust` | bool | ✓ | Default false (`PR-05`). |
| `contribution_basis` | enum `ContributionBasis` | ✓ | goal_target · win_average (`PR-02`). |
| `display_scenario` | enum `ProjectionScenario` | ✓ | low · standard · high. Default standard. |
| `compounding` | enum | ✓ | V0.1 `monthly` (`PR-03`). |
| `updated_at` | timestamptz | ✓ | |

- `PS-C1` The projection **base** = all Saving Wins that are `recorded` OR `transferred` (i.e. everything logged), per confirmed decision `PR-01`. The realised **Transferred** total is computed separately and shown alongside (`PR-01b`) — it is never merged into the projection base label.

---

## 9. `User`

| Field | Type | Req | Notes |
|-------|------|-----|-------|
| `id` | UUID | ✓ | |
| `name` | string(80) | — | |
| `email` | string(254) | ✓ | Login identity. |
| `country` | char(2) | ✓ | ISO 3166-1. |
| `currency` | char(3) | ✓ | Set from country at onboarding; **immutable** in V0.1 (`NET-06`). |
| `timezone` | string(40) | ✓ | IANA tz (e.g. `Europe/London`). |
| `primary_goal_id` | UUID → Goal | — | Set after onboarding. |
| `subscription_status` | enum | ✓ | free · premium (V0.1: free). |
| `created_at` / `updated_at` | timestamptz | ✓ | |

- `U-C1` Account deletion (`CX-03`) hard-deletes the User and cascades to all owned rows. Export (`CX-02`) is offered first.

---

## 10. Derived values (computed, never stored)

Storing these would risk them drifting out of sync with the Wins. They are always computed on read. (An optional cache is noted in §12.)

| Value | Definition |
|-------|-----------|
| **Recorded this month** | `Σ net` of Wins where `display_date` ∈ current period (behavioural metric, `CF-03`). |
| **Waiting to transfer (pot)** | `Σ net` of Wins where `transfer_eligible = true`, `±` pending `CorrectionDelta.remaining_minor` targeting this/earlier periods, floored at £0 (`CF-02`,`CD-C2`). |
| **Transferred total** | `Σ Transfer.amount_minor` where `state = completed`. |
| **Goal progress** | Transferred total toward the goal (primary metric, `GL-04`); Recorded shown as secondary "on track to add". |
| **Projection (low/std/high)** | Future value of `(base = recorded+transferred to date)` + forward contribution, per `ProjectionSettings` (`PS-C1`). Display-rounded only (`NET-07`). |

---

## 11. State machines

**`SavingWin.money_state`**

| From | To | Trigger | Guard |
|------|----|---------|-------|
| — | recorded | log a Win | always |
| recorded | confirmed | passes credibility / user confirm / recurring monthly-confirm | `credibility ≠ unverified` |
| recorded/confirmed | recorded | edit that lowers credibility to unverified (e.g. amount raised past soft-cap) | — |
| confirmed | transferred | included in a completed Transfer | whole-Win FIFO |
| transferred | confirmed | its Transfer un-marked | `TR-C3` |
| recorded/confirmed | *(deleted)* | user delete | `transfer_id IS NULL` (`SW-C6`) |

**`Transfer.state`** (V0.1 subset): `completed ⇄ cancelled` (via un-mark). Other states reserved.

**`CorrectionDelta.status`**: `pending → applied` (when `remaining_minor = 0`); `pending → superseded` (re-correction, `CD-C4`).

**`RecurringDefinition.status`**: `active ⇄ paused`; `active/paused → ended` (end_date reached or user ends, `RC-06`).

---

## 12. Physical storage — recommendation (not yet binding)

The logical model is storage-agnostic. For V0.1, given that **no money is held and no bank is connected**, the lowest-risk path is:

- **Local-first on device with SwiftData** (iOS 17+) — Wins, Goals, etc. live on the phone; `id` UUIDs, `_minor` as `Int64`, enums as `String` raw values, instants as `Date` (store UTC). Export (`CX-02`) satisfies portability; account/email can be a thin auth layer.
- **When a backend becomes necessary** (multi-device, or V0.2 bank connection), **Supabase/Postgres** maps cleanly: `uuid`, `bigint` for `_minor`, `text` enums with check constraints, `timestamptz`. The invariants in §2–4 become DB constraints + triggers.

*Decision to make before Xcode, but not before Screen IA:* local-only vs backend-from-day-one. It does not change the logical model above — only where it lives.

*Optional denormalised cache (either backend):* `PeriodSummary` (user, period_key, recorded_minor, transferred_minor, win_count, top_category, largest_win_minor) to serve the weekly/monthly review (Blueprint 24.4) without re-aggregating. Purely a cache — the Wins remain source of truth.

---

## 13. What this locks, and what's next

**Locked:** every V0.1 rule now has a concrete home — the four states, integer-pence money, the transfer invariant with corrections folded in, the FIFO pot, recurring materialisation, and honest projections.

**Open (non-blocking):** ① projection scenario % (`return_*_bps` defaults 3/5/7). ② local-only vs backend storage — a delivery decision, not a model decision.

**Recommended next document:** **Complete User-Flow Map V1** — now that entities and their state transitions are fixed, the flows (onboarding → first Win → pot → mark-transfer → correction → monthly review) can be drawn as concrete state changes rather than sketches. After that, Screen IA, then the V0.1 feature spec — and only then Xcode.
