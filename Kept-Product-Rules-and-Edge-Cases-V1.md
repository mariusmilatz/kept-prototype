# Kept — Product Rules and Edge Cases V1

**Document status:** Working rules foundation
**Version:** 1.0
**Scope of this document:** V0.1-critical rules only. Rules that only matter once Kept moves real money automatically (Open Banking, payment initiation, broker/ETF execution, couple mode) are noted at the end as *Deferred* with just enough of a placeholder to keep the data model forward-compatible. They are **not** fully specified here — that happens alongside the V0.2/V0.3 specs.
**Depends on:** Kept — Product Blueprint V1
**Feeds into:** V0.1 feature specification, data model, information architecture.

---

## 0. How to read this document

Each rule has an ID (e.g. `SW-03`) so later documents and tickets can reference it precisely. Where the blueprint left a decision open, this document states a **Recommended default** and marks it **[DEFAULT — needs sign-off]**. Anything not marked is a direct consequence of decisions already confirmed in Blueprint V1 Section 40.

The single most important principle governing every rule below:

> **Kept records a claim about money, not money itself.** In V0.1 no funds move through Kept. Every rule must preserve the honesty of that claim and never let a *recorded* number masquerade as *transferred* or *invested* money. (Blueprint 11.2, 40.4, 40.5.)

---

## 1. The four money states (the backbone of everything)

Every amount in Kept lives in exactly one of four states at any moment. These states — not categories, not goals — are the spine of the data model and the UI.

| State | Meaning | Who sets it | Reversible? |
|-------|---------|-------------|-------------|
| **Recorded** | User logged a Saving Win. A claim exists. | User (log action) | Yes — edit/delete |
| **Confirmed** | The Win is eligible to be transferred (passed credibility rules). | System, or user approval | Yes |
| **Transferred** | User has marked that they actually moved this money into savings/investment, outside Kept. | User (manual mark in V0.1) | Yes — un-mark |
| **Invested** | The transferred money reached an investment destination. | *Deferred to V0.2+* | — |

**Rules:**

- `MS-01` A Saving Win always enters at **Recorded**.
- `MS-02` State only ever moves forward through mark actions, or backward through explicit edit/un-mark. It is never inferred silently. Kept must never auto-advance a Win to Transferred.
- `MS-03` The home screen and every total must show at minimum the split between **Recorded this month** and **Transferred**. Showing a single blended number is prohibited (Blueprint 13, 11.2).
- `MS-04` **Invested** is displayed in V0.1 only as a projection/estimate, never as a realised state, because Kept cannot yet verify it.
- `MS-05` Money can be Transferred without ever having a real Kept-initiated payment — in V0.1 "Transferred" means *the user asserts they moved it*. UI copy must reflect assertion, not fact: "You marked £150 as transferred," not "Kept transferred £150."

---

## 2. What counts as a Saving Win

The credibility of the whole product rests here. A Saving Win must correspond to a spend the user **realistically would have made** and **consciously chose not to** (or chose a cheaper version of). (Blueprint 8, 9, 22.)

### 2.1 What counts

- `CT-01` **Avoided purchase** — a specific thing the user was about to buy and did not. Win = the price they would have paid.
- `CT-02` **Cheaper alternative** — user bought a lower-cost option instead of a specific higher-cost one. Win = expected cost − actual cost.
- `CT-03` **Habit saving** — a repeatable, pre-priced behaviour (coffee at home, lunch from home). Win = the stored default amount.
- `CT-04` **Recurring saving** — a genuine permanent reduction of a repeated cost (cancelled/renegotiated subscription or bill). Win = the periodic reduction. Governed separately in §6.
- `CT-05` **Reduced purchase** — user spent less than a *planned* amount. Allowed but flagged lower-credibility (see §2.3).

### 2.2 What does NOT count (hard rules)

- `CT-06` **Not buying something you were never going to buy.** "I didn't buy a yacht → £2,000,000 saved." Kept must make this feel wrong. See the plausibility guardrail `CT-11`.
- `CT-07` **Money you don't have / can't afford.** A cheaper alternative you couldn't have bought the expensive version of is not a saving.
- `CT-08` **Ordinary non-spending.** Sleeping, not shopping on a normal day, existing. A Win requires an identifiable *avoided purchase or reduction*.
- `CT-09` **Deferred, not avoided.** If the user intends to buy it later, it is not saved — it is postponed. Kept does not distinguish these automatically in V0.1, but onboarding copy and the empty-state must teach "avoided ≠ postponed." (Product risk to watch in beta.)
- `CT-10` **The same saving twice.** Covered fully in §7 (double-counting).

### 2.3 Credibility labels

Every Win carries a credibility label. Only some labels are eligible for transfer.

| Label | Applied when | Transfer-eligible? |
|-------|--------------|--------------------|
| **Confirmed** | Avoided purchase or cheaper alternative with a concrete original cost the user entered/confirmed. | Yes |
| **Habit** | Logged from a saved quick action with a pre-set price. | Yes |
| **Recurring** | A recurring saving, per §6. | Yes (once, per period — see §6) |
| **Estimated** | User accepted a suggested amount they didn't originate (e.g. natural-language guess). | Yes, after explicit confirm |
| **Unverified** | Reduced-purchase type (`CT-05`), or amount above the plausibility soft-cap. | **No** — must be reviewed/edited by user first |

- `CT-11` **Plausibility soft-cap [DEFAULT — needs sign-off].** Any single Win above **£100** (or > 5× the user's median Win, whichever is higher, once enough history exists) is created as **Unverified** and shown with a gentle "Does this look right?" confirm step. This is a friction step, not a block — the user can confirm it to Confirmed. Rationale: keeps the north-star metric (real money transferred) honest without shaming a genuine large saving.
- `CT-12` Reduced-purchase Wins (`CT-05`) are **always** Unverified until the user affirms "this was money I'd otherwise have spent."

---

## 3. How the net saving is calculated

One formula, applied consistently. (Blueprint 22.1.)

```
Net Saving Win = Original expected cost − Alternative/actual cost
```

- `NET-01` **Avoided purchase:** alternative cost = 0. Net = original.
- `NET-02` **Cheaper alternative / reduced:** Net = original − actual. Both figures stored; the app never discards the components, because edits and audits need them.
- `NET-03` Net is **stored as an integer number of minor units** (pence), never a float. All money in Kept is integer-pence to avoid rounding drift. Display formatting adds the decimal.
- `NET-04` **Net can never be negative.** If actual ≥ original, the Win is rejected with "That's not a saving — the alternative cost the same or more." (No £0 Wins are stored either; minimum storable Win = 1p, but see `NET-05`.)
- `NET-05` **Minimum meaningful Win [DEFAULT — needs sign-off]:** 1p is allowed technically, but the quick-action minimum default price is £0.50, to avoid noise. Not a hard block on custom entry.
- `NET-06` **Currency:** V0.1 is single-currency per account (Blueprint 27 "Not included: multiple currencies"). The account currency is set at onboarding from country and is immutable in V0.1. Every Win inherits the account currency; there is no per-Win currency in V0.1. (The `currency` field still exists on the Win for forward-compatibility but must equal the account currency.)
- `NET-07` **Rounding:** no rounding is applied to stored values. Projections (§8) may round for display only, and must round consistently (half-up) and never round a total up in a way that overstates savings.

---

## 4. Editing and deleting, and how it interacts with transfers

This is the subtlest area, because a Win can be edited *after* the user has already marked money as transferred. (Blueprint 43 explicitly calls this out.)

### 4.1 Editing a Recorded (not yet transferred) Win

- `ED-01` Free to edit any field. The monthly Recorded total recomputes immediately. No side effects.
- `ED-02` Deleting simply removes it from the Recorded total.

### 4.2 Editing/deleting a Win that is already **inside a transfer** (Confirmed → marked Transferred)

This is where honesty rules bite. Once the user has marked a transfer as done, the *real money has already moved in the real world*. Kept must not silently rewrite history to disagree with the user's bank.

- `ED-03` A Win that has been included in a **completed** (marked-transferred) transfer becomes **locked for amount edits**. The user can still edit description/category/note (cosmetic fields), but not the amount, because the amount is now reconciled against a real-world transfer.
- `ED-04` **CONFIRMED.** A locked Win's amount cannot be silently edited. When the user needs to change one, Kept offers two paths and asks which:
  1. **Un-mark and edit** — un-mark the transfer (returns its Wins to Confirmed), edit freely, re-mark. Use when the whole transfer was wrong.
  2. **Rollover correction (delta on next pot)** — leave the completed transfer untouched (it already matched real money that left the bank) and carry the **difference into the next transfer pot**, positive or negative. Example: logged £4.20 but it was really £3.20 → next pot is £1.00 smaller; if it was £5.20 → next pot owes £1.00 more.
  - Rules for the rollover delta:
    - `ED-04a` It is a distinct **correction entry** linked to the original Win, not a new Saving Win — it never counts toward behavioural metrics (Wins-per-user, streaks) or "Recorded this month". It only adjusts the *money-to-transfer* figure.
    - `ED-04b` A negative delta can never push a transfer pot below £0. It reduces the pot as far as £0 and **carries any remainder further forward** until absorbed.
    - `ED-04c` The completed transfer's stored total is immutable, preserving `ED-07` (transfer total == real-world money moved). The correction lives in the *next* period, where it will be reconciled.
- `ED-05` **Deleting a locked Win:** disallowed directly. The user must first **un-mark the transfer** it belongs to (which returns all its Wins to Confirmed), then delete. This guarantees a transfer record's total always equals the sum of the Wins in it.
- `ED-06` **Un-marking a transfer** (`Transferred → Confirmed`) is always allowed and always reversible. It returns every Win in that transfer to Confirmed and subtracts the amount from the Transferred total. Copy must be neutral: "Marked as not transferred" — no failure language.

### 4.3 Invariant

- `ED-07` **Core invariant:** for any transfer record, `transfer.amount == Σ(amounts of Wins linked to it)` at all times. Every rule above exists to protect this. Any operation that would break it is blocked or routed through un-marking first.

---

## 5. Carry-forward

At period end, recorded money that the user chooses not to transfer has to go somewhere conceptually. (Blueprint 12.4, 13.4, 17.5 "Carried forward".)

- `CF-01` A **period** in V0.1 is a calendar month in the user's timezone [DEFAULT — needs sign-off; alternative is payday-anchored, deferred to V0.2 where payday detection exists].
- `CF-02` At month rollover, any **Confirmed but not-Transferred** Wins are **carried forward**: they remain Confirmed and join the next month's transfer pot. They are *not* re-counted into the new month's "Recorded this month" headline (which counts Wins *created* this month), but they *are* counted into "waiting to transfer."
- `CF-03` This means two distinct numbers must never be conflated:
  - **Recorded this month** = Σ Wins *created* in this calendar month (behavioural metric).
  - **Waiting to transfer** = Σ all Confirmed, not-yet-Transferred Wins regardless of when created (money metric).
- `CF-04` A carried-forward Win retains its **original creation date** forever. Carry-forward changes its transfer-pot membership, not its history. This keeps activity history and behavioural analytics truthful.
- `CF-05` There is no limit to how long a Win can be carried forward in V0.1. (A "stale Win" nudge — "You've carried £40 forward for 3 months, want to transfer it?" — is a V0.2 notification, not a rule here.)
- `CF-06` **Partial transfer** (Blueprint 12.4 "Transfer a smaller amount"): if the user marks less than the waiting total as transferred, Kept must decide *which* Wins are covered. **[DEFAULT — needs sign-off]:** oldest-first (FIFO). The transferred amount consumes whole Wins oldest-first; the remainder carries forward. If the amount doesn't land exactly on a Win boundary, see `CF-07`.
- `CF-07` **Partial transfer not landing on a boundary** (e.g. waiting £183.40 across Wins, user marks £150 transferred). Two clean options; recommended default is (a):
  - **(a) [DEFAULT — needs sign-off] Whole-Win FIFO with a spill:** cover whole Wins oldest-first up to £150; the Win that would be split is **left fully carried-forward** (so slightly less than £150 is marked transferred), and Kept tells the user the exact figure it used: "Marked £148.70 as transferred (nearest whole Wins)." Keeps every Win atomic — no Win is ever half-transferred, which keeps `ED-07` simple.
  - (b) Allow splitting a Win across two transfers. Cleaner math, but breaks Win atomicity and complicates edits. **Not recommended for V0.1.**

---

## 6. Recurring savings

A recurring Win is a *promise about the future*, which makes it the easiest place to accidentally inflate totals. (Blueprint 9.4, 21, 22.3.)

- `RC-01` A recurring saving is defined once with: amount, frequency (weekly/monthly [DEFAULT: monthly only in V0.1]), start date, optional end date.
- `RC-02` Kept **materialises** one concrete Win per period as that period arrives — it does **not** front-load all future periods into today's total. Future periods are shown only as projection (§8), never as Recorded money.
- `RC-03` The materialised Win for a period is created **at the start of that period** [DEFAULT — needs sign-off; alt: on user confirmation]. To respect Blueprint 21.1 ("Kept periodically asks whether the saving is still active"), the recommended V0.1 behaviour is: the recurring Win is created as **Recorded**, and requires a lightweight **monthly confirm** ("Still cancelled? ✓") before it becomes **Confirmed** (transfer-eligible). Un-confirmed recurring Wins never auto-transfer.
- `RC-04` **No double count with manual logs** (`CT-10`, Blueprint 21.2): if a recurring saving exists for a category/merchant, and the user *also* manually logs a Win that looks like the same thing in the same period, Kept flags a possible duplicate (§7) rather than silently summing.
- `RC-05` Editing a recurring definition affects **only future** materialised Wins. Already-materialised past Wins are untouched (they may already be transferred — see §4).
- `RC-06` Ending/cancelling a recurring saving stops future materialisation. It does not delete past Wins.
- `RC-07` A recurring saving with an end date in the past materialises nothing further; Kept should prompt to archive it.

---

## 7. Double-counting prevention

The one failure that would destroy trust in the north-star number. (Blueprint 22.3.)

- `DC-01` **Cheaper-alternative atomicity:** the "expensive version" and the "cheap version" are **one Win**, never two. The UI must make it impossible to log "avoided £25 takeaway" *and* "cooked for £7" as two separate Wins for the same event. The cheaper-alternative flow captures both numbers in a single Win (`NET-02`).
- `DC-02` **Duplicate detection (soft):** when a new Win closely matches a recent one — same quick action / category / amount within a short window (**[DEFAULT: same quick action within 10 minutes, or same amount+category within the same day]**) — Kept shows a non-blocking "Did you mean to log this twice?" confirm. User can dismiss and keep both.
- `DC-03` **Recurring vs manual:** per `RC-04`, a manual Win overlapping an active recurring saving in the same period triggers the duplicate confirm.
- `DC-04` Duplicate detection is **advisory only** in V0.1 — it never blocks or auto-merges. It exists to protect the metric, not to police the user (Blueprint 11.3, 11.6).
- `DC-05` Bank-transaction-based duplicate matching (Blueprint 22.3 final bullet) requires bank data → **Deferred to V0.2.**

---

## 8. Projections (future value)

Projections are the emotional payoff *and* the biggest regulatory/trust risk. Rules here are about honesty as much as math. (Blueprint 11.5, 16, 36.)

### 8.1 What is projected

- `PR-01` **CONFIRMED — projection includes recorded money.** The growth projection is computed on **all Saving Wins — Recorded *and* Transferred** — plus an assumed future contribution. A Win does **not** need to be transferred to move the future curve. This is deliberate: the instant reward moment (log a coffee → immediately see the long-term impact) is core to the product loop (Blueprint Stage 4). Honesty is preserved by **labelling, not by exclusion** — see `PR-01a`/`PR-01b`.
- `PR-01a` The projected number is **always** framed as "could become / estimated / projected", never "you have / invested / guaranteed" (`PR-07`). It is an illustration of what the user's *decisions* could grow into if kept and invested — not a statement about money that has moved.
- `PR-01b` The Future screen must display the **actual Transferred total** alongside the projection, so the four-state split (`MS-03`) stays visible. The projection may include recorded money; the *realised* figures beside it must not. Recorded, Transferred, and Projected use their three separate vocabularies (`CP-01`).
- `PR-02` The assumed forward monthly contribution defaults to the user's recent average *Saving-Win* rate once history exists; before that, it uses the goal's monthly target from onboarding.

### 8.2 The math

- `PR-03` Standard compound-growth with periodic contributions. Monthly compounding [DEFAULT]. Formula and assumptions stored in Projection Settings (Blueprint 31.5).
- `PR-04` **Three scenarios always shown together** (Blueprint 16.3): lower / standard / higher annual return. Default assumption set **[needs sign-off]:** e.g. 3% / 5% / 7% nominal. These are display defaults, not advice.
- `PR-05` **Inflation adjustment** is a toggle; when on, projections show real (today's-money) values and say so.
- `PR-06` All figures are rounded for display only (`NET-07`) and always carry the word **"estimated"** or **"projected"** adjacent to the number.

### 8.3 Language rules (hard constraints)

- `PR-07` **Never** render: "you will have", "guaranteed", "risk-free", or any figure without a visible assumption. (Blueprint 16.4.)
- `PR-08` The active assumptions (return %, horizon, contribution, inflation on/off) must be visible **on the same screen** as any projected figure — never hidden behind a tap.
- `PR-09` Kept must not present projections as personalised financial advice. A standing disclaimer ("Estimates based on assumptions you set. Not financial advice. Investments can go down as well as up.") is attached to the Future screen. (Blueprint 36, 19.3.)

---

## 9. Quick actions

- `QA-01` A quick action stores: name, default amount, category, usage count, display order (Blueprint 31.6).
- `QA-02` Logging from a quick action creates a **Habit**-credibility Win (`CT-03`) at the stored amount in ≤ 2 taps (Blueprint 11.1) — one tap to select, and (per `SW-fast` below) confirmation is implicit for known amounts, or a single confirm tap.
- `QA-03` **[DEFAULT — needs sign-off] One-tap vs confirm:** for quick actions with a fixed stored price, default to **log immediately with an undo snackbar** (true one-tap, matching the widget promise), rather than a confirm dialog. Undo is available for a short window. This satisfies "≤ 5 seconds / one tap" (Blueprint 34) while preserving control via undo.
- `QA-04` Quick actions are suggested/auto-promoted from repeated manual Wins **[DEFAULT: after the same category+amount is logged 3 times]**, but only with user acceptance — Kept proposes, never auto-creates.
- `QA-05` Editing a quick action's default amount does not retroactively change past Wins logged from it.

---

## 10. Goals (V0.1 = one primary goal)

- `GL-01` V0.1 supports exactly **one** active primary goal (Blueprint 20.3, 27). The data model supports many (goal_id on every Win), but the UI exposes one.
- `GL-02` Every Win is allocated to the single goal by default. Per-Win goal reassignment UI is deferred; the field exists.
- `GL-03` A goal has: name, type, optional target amount, optional target date (Blueprint 31.3). Target amount/date are optional so "just invest more" users aren't forced to invent a number.
- `GL-04` **Goal progress** is measured against **Transferred** money by default (money actually moved), with Recorded shown as secondary "on track to add" — never conflate the two (`MS-03`).
- `GL-05` Changing the goal mid-stream does not re-tag historical Wins in V0.1 (single goal, so this is mostly moot; the rule prevents surprises if a user renames/retypes the goal).

---

## 11. Cross-cutting: time, timezone, periods

- `TZ-01` All Win timestamps are stored in UTC and displayed in the user's stored timezone (Blueprint 31.1).
- `TZ-02` "This month" / "this week" boundaries are computed in the **user's timezone**, not UTC, so a late-night Win lands in the day the user experienced.
- `TZ-03` Changing timezone (travel) does not re-bucket historical Wins; buckets are frozen at creation using the then-current timezone offset stored on the Win. **[DEFAULT — needs sign-off]** Simpler alt: always recompute buckets from stored UTC + current timezone. Recommended: freeze the *display date* at creation to avoid Wins hopping between months when a user travels.

---

## 12. Control, export, deletion (V0.1 must-haves)

- `CX-01` Every Win is user-editable and deletable subject to §4 locking.
- `CX-02` **Data export** (Blueprint 27, 32): user can export all Wins, goals, transfers, and settings as a machine-readable file (CSV + JSON [DEFAULT]). Export reflects the four-state model explicitly so the user can reconcile against their bank.
- `CX-03` **Account deletion** removes all personal data; must be genuinely destructive and confirmed. (This is a *user-initiated* deletion of their own data — distinct from the assistant-side prohibition on deleting things.)
- `CX-04` No feature that "protects" money (edit, delete, un-mark, export, safety limits) is ever paywalled (Blueprint 35 principles).

---

## 13. Copy & tone rules that are actually product rules

These are enforced in components, not left to a writer's discretion, because they encode the four-state honesty.

- `CP-01` Recorded money uses "kept / recorded". Transferred money uses "you marked as transferred / moved". Projected money uses "estimated / could become". These three vocabularies never cross (`MS-03`, `PR-07`).
- `CP-02` No spending is ever described as failure, waste, or temptation (Blueprint 38). Un-marking, skipping a transfer, deleting a Win → all neutral.
- `CP-03` Streaks track *positive actions only* and can never be "broken" by ordinary spending (Blueprint 24.3).

---

## 14. Deferred — placeholders only (NOT specified in V0.1)

Listed so the data model stays forward-compatible; each gets its own rules doc with its version.

- **Automatic transfer safeguards** (max per period, min balance, %-of-Wins, notice period, insufficient-funds behaviour, emergency pause) — Blueprint 17.3/17.4. Needs Open Banking + payment initiation. **V0.3.**
- **Bank connection & transaction matching** — Blueprint 18, 22.3. **V0.2+.**
- **Investment/broker connection & real Invested state** — Blueprint 19. **V0.3.**
- **Couple mode** sharing/permission/double-approval rules — Blueprint 23. **V0.2 prototype / V0.3.**
- **Multi-currency per account** — Blueprint 27. Post-V0.3.
- **Payday-anchored periods** — depends on bank data. **V0.2.**

---

## 15. Decision log — CONFIRMED 2026-07-31

All ten Section-15 defaults have been reviewed and resolved. These are now fixed for V0.1.

| # | Rule | Decision |
|---|------|----------|
| 1 | `CT-11` | **Plausibility soft-cap = £100 or 5× median.** Wins above the cap enter as Unverified with a one-tap "Does this look right?" confirm. Non-blocking. |
| 2 | `NET-05` | **£0.50 floor** for quick-action default prices; custom entry may go lower. |
| 3 | `ED-04` | **Lock + un-mark to change** is the default. Plus an opt-in **rollover correction**: leave a completed transfer untouched and carry the +/− difference into the next pot (`ED-04a`–`ED-04c`). |
| 4 | `CF-01` | **Period = calendar month** for V0.1. Payday-anchored deferred to V0.2 (needs bank data). |
| 5 | `CF-06`/`CF-07` | **Whole-Win FIFO with spill.** No Win is ever half-transferred; Kept reports the exact figure used. |
| 6 | `RC-01`/`RC-03` | **Monthly recurring only** in V0.1, with a one-tap **monthly "still active?" confirm** before a recurring Win becomes transfer-eligible. |
| 7 | `PR-01` | **Projection includes recorded money** (Recorded + Transferred), for instant reward impact. Honesty preserved by labelling (`PR-01a`) and by showing the actual Transferred figure alongside (`PR-01b`). Scenario returns remain **3% / 5% / 7%** default (`PR-04`) — still adjustable later. |
| 8 | `QA-03` | **One-tap + undo snackbar.** True one-tap logging; control via undo, not a dialog. |
| 9 | `TZ-03` | **Freeze display date at creation**, so travel never re-buckets past Wins. |
| 10 | `CX-02` | **Export as CSV + JSON**, both reflecting the four-state model. |

Only one item carries a minor still-open sub-detail worth a glance during data-model design: the exact `PR-04` scenario percentages (3/5/7%) — kept as placeholders, trivially changeable, not blocking.

---

## 16. What this unlocks next

With these rules fixed (or defaults accepted), the next documents can be written without re-opening foundational questions:

- **Data model** can be finalised — the four-state model (§1), integer-pence storage (`NET-03`), the transfer invariant (`ED-07`), and the goal_id-on-every-Win forward-compat (`GL-01`) are the load-bearing decisions.
- **User-flow map** and **screen IA** can encode the Recorded/Transferred split and the partial-transfer FIFO flow directly.
- **V0.1 feature spec** becomes mostly assembly rather than invention.

Recommended immediate next step: a **30-minute pass over §15** to accept/adjust the ten defaults, then I draft the **Data Model V1** — because it is the thing every screen and rule now depends on.
