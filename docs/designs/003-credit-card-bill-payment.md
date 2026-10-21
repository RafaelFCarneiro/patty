# Feature Design 003: Credit-card bill payment (cash leaves an account)

**Type:** Feature design (a feature + technical assessment) · **Design status:** Accepted ·
**Implementation status:** Done · **Branch:** `feat/bill-payment` (suggested) ·
**Date:** 2026-06-21 (revised) · Governed by **ADR-010** (credit cards are liability accounts); preserves
**ADR-002** (transfers); revises invariant #8 in `docs/architecture.md`.

> **Implementation status** tracks delivery, distinct from the design's acceptance. Values:
> `Not started` · `In progress` · `Done` · `Blocked`. The implementing PR updates this line (→ `In progress`
> when work starts, → `Done` on merge); use `Blocked` with a one-line reason if stuck.

## Context

A credit-card purchase references `credit_card_id` + `bill_id` but **no account**, so it touches no balance —
it accrues on the fatura. `pay_bill` today only flips the bill to `paid` (`controllers/bills.ts`), so the cash
that leaves a bank account to settle the bill is **never recorded** and the paying account's balance is
permanently overstated. There is also no representation of how much you currently owe on a card.

The first cut of this design modeled the payment as a one-legged transfer (FROM only). That broke ADR-002's
canonical "transfers move value between two accounts." **ADR-010** fixes it at the root: a credit card gains its
own **internal liability account**, so a purchase is debt against it and a payment is an ordinary two-legged
transfer that pays the debt down — ADR-002 stays intact and the card gains a useful balance. This design builds
the bill-payment feature on that model.

Invariant #8 ("pay_bill flips status only — a payment transaction would double-count") guarded the *wrong* fix:
a payment recorded as an **expense** double-counts spend; a payment recorded as a **transfer** is excluded from
summaries and does not. The fix is a transfer; the invariant is revised (ADR-010).

## Decision

1. **Rely on the ADR-010 model.** `AccountType` gains `credit`; each card owns a 1:1 internal `credit` account
   (`credit_cards.account_id`); card purchases post to it (`from_account_id` = card account) so its balance =
   negative outstanding debt, derived by the existing machinery. (Details and rationale: ADR-010.)
2. **`pay_bill` settles the bill with a canonical transfer.** It resolves the paying account, validates
   currency, computes the bill total (`computeBillTotal`, unchanged), and — when `> 0` — creates a
   `type: 'transfer'` transaction with **both legs**: `from_account_id` = paying bank account,
   `to_account_id` = the card's internal account, `bill_id` linked, `idempotencyKey: billpay-<billId>`. Then it
   sets the bill `paid`. The transfer debits cash and credits the card account toward zero; it is excluded from
   spending summaries. If already paid → idempotent no-op; if total `<= 0` (net-credit fatura) → mark paid with
   no transfer.
3. **Paying account: card default + per-call override.** `credit_cards` gains `payment_account_id` (FK →
   `accounts`), settable at card creation. `pay_bill` takes an optional `account` (name) override. Resolution:
   explicit `account` → `payment_account_id` → else a `validation` error ("no paying account: pass `account` or
   set the card's payment account"). The paying account must be a non-`credit` account.
4. **Full payment, idempotent.** Key `billpay-<billId>`; re-calling `pay_bill` on a paid bill is a no-op.
   Partial payment is **out of v1** but additive later (see Deferred follow-up).
5. **Same currency only.** Paying account currency = card currency (= card-account currency). Mismatch →
   `validation` error (no FX).
6. **`create_credit_card` auto-creates the internal account** (ADR-010) and accepts optional `paymentAccount`
   (name) for the default payer. The internal account's currency = the card currency. A `credit` account is
   created **only** here — `create_account` rejects `type: 'credit'` (a `validation` error), so there is no
   standalone credit account.
7. **Surface:** `create_credit_card` + `paymentAccount`; `pay_bill` + `account`. REST mirrors both. `get_bill`
   keeps its shape — the payment transfer appears in the bill's transaction list (linked by `bill_id`) but does
   not change the total (transfers excluded from `computeBillTotal`), correctly showing the fatura was paid.
8. **`delete_credit_card` is a hard delete of the whole card.** It removes the card, its internal `credit`
   account, all its bills, and **every correlated transaction** — the card's purchases *and* its bill payments.
   Like `delete_transaction`, it is a **two-step destructive action**: without `confirm: true` it is a dry run
   returning what would be deleted (card name, account, counts of transactions + bills); with `confirm: true` it
   deletes atomically. **Caveat (by design):** deleting the bill-payment transfers removes transfer-outs from the
   bank accounts that paid them, so those accounts' balances increase as if the payments never happened, and the
   purchases drop out of historical spending summaries — a full hard delete rewrites that history. A future
   **enable/disable (soft archive)** capability is the non-destructive alternative (deferred follow-up).

## Scope / out of scope

- **In:** the ADR-010 model (credit account type; card↔internal-account 1:1; purchases post to the card
  account; `create_transfer` rejects `credit` legs; `credit` accounts visible in balances/list); `pay_bill`
  canonical transfer (paying account → card account) for the full bill total + mark paid; `payment_account_id`
  default + `pay_bill` `account` override + same-currency validation; idempotent full payment; **`delete_credit_card`
  hard delete** (card + internal account + correlated transactions + bills; two-step dry-run/confirm); invariant
  #8 revision; REST/MCP surface + docs.
- **Out:** **partial payments** (deferred — immediate follow-up); **card enable/disable (soft archive)** — the
  non-destructive alternative to hard delete (deferred follow-up); interest / minimum payment / unpaid rollover;
  cross-currency payment (FX); raw `create_transfer` to/from `credit` accounts (disallowed, ADR-010); a general
  `update_credit_card` tool (unless the "learn default payer" one-liner is trivial); scheduling / auto-pay.

## Options Considered

**This design implements ADR-010** (the credit-card-as-liability-account model — Implementation steps 1–4) **and
builds bill payment + delete on top** (steps 5–7). The *model choice itself* (one-legged transfer vs. derived
balance vs. liability account) was adjudicated in **ADR-010** (Option C chosen), so it is not re-argued here; the
only option this design weighs is the **payment** sub-decision below. ADR-010 is in scope of this design's
implementation, not separate work.

### Full payment v1 — **chosen**
**Pros:** one payment per bill; clean idempotency (`billpay-<billId>`); `open/closed → paid`; smallest correct
slice.
**Cons:** no partial settlement yet.

### Partial payment now — deferred
**Pros:** realistic.
**Cons:** adds paid-amount tracking, a `partially_paid` status, per-payment idempotency keys, and overpayment
validation. Deferred; the chosen transaction model makes it additive.

## Consequences

- **Schema/migration:** `accounts.type` gains `credit`; `credit_cards` gains `account_id` (FK → internal
  account) + `payment_account_id` (FK → default payer). Existing dev DB reset (clean slate — no production data).
- **Card creation** auto-creates the internal `credit` account and links it; stores the optional default payer.
- **Card purchases** set `from_account_id` = card account (ADR-010). **Audit** anything that assumed a card
  purchase has no account leg (adapters, balance/summary, extrato); the SQL itself is unchanged and correct.
- **`pay_bill`** builds the two-legged transfer directly (it sets `bill_id` + a custom idempotency key, which
  `createTransfer` doesn't); it does **not** make an expense. Already-paid → no-op; total `<= 0` → mark paid, no
  transfer.
- **Balances/summaries reused unchanged:** `balanceParts` debits the payer (transfer-out) and credits the card
  account (transfer-in); `summaryRows` excludes transfers; the extrato shows the payment on both accounts.
- **Visibility:** `credit` accounts appear in `get_account_balances` / `list_accounts` (negative = owed).
- **Invariant #8 revised** (ADR-010 wording) in `docs/architecture.md`.
- **Blast radius:** `models/{account,creditCard}.ts`, `schema.ts` + migration, `controllers/{bills,creditCards,
  transactions,transfers}.ts`, the two diplomats + wire schemas, docs. No change to the balance/summary queries
  or classification.

> **Sizable change** (schema + purchase-recording + new tool behavior). Optional staging into two PRs:
> **PR1 (ADR-010 core)** — credit account type, card↔account, purchases post to it, `credit` visibility, transfer
> restriction; **PR2 (this payment)** — `pay_bill` transfer + `paymentAccount`. PR1 alone is coherent (you can
> *see* card debt); PR2 lets you pay it. Ship as one or two at the implementer's discretion.

---

## Implementation prompt

> Hand this section to a coding agent. The design above is the source of truth; **read ADR-010 first**
> (`docs/adr/010-*`) and ADR-002. Work on branch **`feat/bill-payment`**; `git fetch && git rebase origin/main`
> first. Read: `CLAUDE.md` (esp. the **Definition of Done**), `docs/architecture.md` (invariants + dependency
> table), `docs/code-style.md`, `docs/code-quality.md`. Skim `src/models/{account,creditCard,bill}.ts`,
> `src/controllers/{bills,creditCards,transactions,transfers,accounts}.ts`, `src/controllers/resolve.ts`,
> `src/logic/bill.ts`, `src/diplomat/db/schema.ts`, `src/diplomat/db/repos/{bills,transactions,accounts}.ts`,
> `src/diplomat/mcp/server.ts`, `src/diplomat/http/routes.ts`.

### Steps

1. **Account type + schema** (ADR-010): add `credit` to `AccountType`. Add `credit_cards.account_id` (FK →
   `accounts.id`) and `payment_account_id` (FK → `accounts.id`), both nullable at the column level. Generate the
   migration. Existing dev DB is reset via the manual `scripts/reset-local-db.sh` (no production data).
2. **Card creation** (`controllers/credit-cards.ts`): auto-create the internal `credit` account (name e.g.
   `Card: <name>`, currency = card currency, initial balance 0), link via `account_id`. Accept optional
   `paymentAccount` (name) → resolve via `resolve.ts`, validate same currency, store as `payment_account_id`.
   In `controllers/accounts.ts`, make `create_account` reject `type: 'credit'` with a `validation` error — a
   credit account is created only by this card flow.
3. **Card purchases post to the card account** (`controllers/transactions.ts`): when a transaction resolves to a
   card, set `from_account_id` = the card's internal account (keep `credit_card_id` + bill attach). Audit
   adapters/balance/summary/extrato for any "card ⇒ no account leg" assumption.
4. **Disallow `credit` legs in `create_transfer`** (`controllers/transfers.ts`): a `validation` error if either
   account resolves to a `credit` account (pay_bill is the only path into a card account).
5. **`pay_bill`** (`controllers/bills.ts`): resolve paying account = explicit `account` → card
   `payment_account_id` → else `validation` error. Validate non-`credit` payer + same currency. Compute
   `computeBillTotal`. If `> 0`, create a `type: TransactionType.enum.transfer` transaction: `from_account_id`
   = payer, `to_account_id` = card account, `bill_id` = bill, `currency` = card currency,
   `idempotencyKey: \`billpay-${bill.id}\``, classification `{ method: 'none', confidence: 0 }`, description like
   `Bill payment: <card> <month>/<year>`, date = today. Then `setStatus('paid')`. Already paid → return existing
   (no-op); total `<= 0` → mark paid, no transfer. Use enum constants, never literals.
6. **Surface:** add `account` to the `pay_bill` MCP tool + REST route; add `paymentAccount` to
   `create_credit_card`. `credit` accounts appear in `get_account_balances` / `list_accounts` (no special
   filtering needed beyond the new type).
7. **`delete_credit_card`** (new tool + controller + repo): input `card` (name) + `confirm` (default false).
   Without `confirm`, return a dry run (`{ deleted: false, dryRun: true, wouldDelete: { card, account,
   transactions: N, bills: M } }`) — mirror `delete_transaction`'s shape. With `confirm: true`, delete
   **atomically** (one DB transaction): the correlated transactions (where `credit_card_id` = card OR
   `from_account_id`/`to_account_id` = the card account — covers purchases and bill payments; `transaction_tags`
   cascade), then the card's bills, then the internal `credit` account, then the card row — in FK-safe order.
   Errors: `unknown_card`. Add the MCP tool + REST route. (Per the safety rules, deletion stays a confirmable,
   user-driven action.)

### Tests
- **Unit** (`logic/`): payment amount = bill total; net-credit bill (`<= 0` → no transfer). Keep `logic/` pure.
- **Integration** (in-process libSQL): card with internal account + a purchase → the card `credit` account shows
  the negative balance; `pay_bill` → (a) bill `paid`, (b) payer balance −= total, (c) card account balance → 0,
  (d) `get_spending_summary` unchanged (no double-count), (e) the payment shows in both extratos as a transfer,
  (f) re-call is a no-op, (g) no payer + no card default → `validation`, (h) currency mismatch → `validation`,
  (i) `create_transfer` touching a `credit` account → `validation`; (j) `create_account` with `type: 'credit'`
  → `validation`; (k) `delete_credit_card` without `confirm` → dry run with correct counts, nothing deleted;
  (l) with `confirm: true` → card, internal account, its purchases, its bill payments, and its bills are all
  gone, and the bank account that paid a bill has that payment reversed out of its balance; (m) unknown card →
  `unknown_card`.
- **Gate:** `npm run lint && npm run typecheck && npm run test:all && npm run build`.

### Invariants — do not break
- **ADR-010:** card purchases post to the card's `credit` account; bill payment is a **canonical two-legged
  transfer** (payer → card account), excluded from spending summaries, never an expense; value enters a `credit`
  account only via `pay_bill`. A `credit` account is created **only** by the card-creation flow —
  `create_account` rejects `type: 'credit'` — and is deleted **only** with its card (no orphan credit account).
- **`delete_credit_card` leaves nothing behind:** card, internal account, correlated transactions (purchases +
  bill payments), and bills are all removed atomically; it is confirmable (dry-run/`confirm: true`).
- **ADR-002 preserved:** transfers keep both legs.
- **Same-currency only**; idempotent via `billpay-<billId>`.
- **Constants over literals; diplomatic layering** (`logic/` pure; orchestration in controllers; zod at
  boundaries; thin diplomats).
- **Docs in the same change:** `docs/architecture.md` (revised invariant #8 + `credit` type + the two card FKs),
  `docs/mcp-tools.md` (`pay_bill` `account`, `create_credit_card` `paymentAccount`, `delete_credit_card`,
  `credit` accounts in balances). Index ADR-010 in the architecture ADR list.
- **Definition of Done (CLAUDE.md):** self-review pass + gate before every push; this is **feature-sized**
  (schema/migration + purchase-recording + tool changes), so also run the independent verification pass.

### Finish
Conventional Commits (`feat(cards): credit cards as liability accounts + bill payment` + `test:`/`docs:`),
`git push -u origin feat/bill-payment`, open a PR (or the two-PR split above) targeting `main`. Run the
Definition of Done; do not merge; after CI, reply to review threads with the resolving SHA.

## Deferred follow-ups

- **Partial payments.** `pay_bill` gains optional `amount` (defaults to outstanding); the bill's **outstanding**
  = total − Σ(its payment transfers); status gains `partially_paid`; keys become `billpay-<billId>-<n>` (or
  client-supplied); add overpayment validation. No change to the v1 transfer shape — partial is purely additive.
  (Interest / minimum-payment / rollover remain out of scope.)
- **Card enable/disable (soft archive).** The non-destructive alternative to hard delete: an `active` flag on the
  card (and its internal account) that hides it from new purchases/payments and from default listings while
  preserving all history and balances. Prefer this over deletion once there's history worth keeping; `delete_credit_card`
  stays as the explicit, confirmable "erase everything" path.
