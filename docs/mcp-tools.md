# FinTrack MCP tools

Contract for the MCP server at `POST /mcp` (streamable HTTP, stateless). All tools share these conventions:

- **Natural inputs**: `account`, `card`, `category`, and `subCategory` take names (case/accent-insensitive, partial match allowed). Resolution failures return structured errors the agent can self-correct from.
- **Errors**: `{ "error": { "code": "...", ... } }` with `isError: true`. Codes: `unknown_account`, `ambiguous_account`, `unknown_category`, `ambiguous_category`, `unknown_sub_category`, `ambiguous_sub_category`, `unknown_card`, `ambiguous_card`, `unknown_transaction`, `unknown_bill`, `unknown_dashboard`, `unknown_budget`, `duplicate_name`, `duplicate_budget`, `not_expense_category`, `in_use`, `category_kind_mismatch`, `validation`, `conflict` (a concurrent write raced this one out — retry). Ambiguous/unknown errors include `candidates` (names) to retry with.
- **Currency**: BRL or USD; from the account/card when one is linked, else the `currency` field, else USD. Summaries group per currency, never converting.
- **Dates**: `YYYY-MM-DD`.
- **Localized labels**: read views include `*Label` fields — localized display labels for fixed enum values, resolved at read time via the active locale (Design 006). The enum value itself (`type`, `status`, `kind`, `period`) is stable identity; the `*Label` is derived display only. Switching locale reflows all labels with no migration. See per-tool details below.

## Transaction write basics

These rules are shared by every transaction-creating tool below (`add_card_purchase`, `add_account_expense`, `add_account_income`, `import_card_statement`, `import_account_statement`) and are stated once here rather than repeated per tool.

**`status` field**: `effective` means the transaction has cleared; it counts toward balances and summaries. `pending` means it is expected but not yet cleared — excluded from balances and summaries until `confirm_transaction` is called. **Default is date-aware**: when omitted, future-dated transactions default to `pending` and past/present transactions default to `effective`. An explicit `status` always overrides the default. Status is never auto-flipped by the passage of the date — call `confirm_transaction` explicitly.

**Kind validation**: `expense` transactions must use a category/sub-category with `kind: expense` or `both`; `income` transactions must use `kind: income` or `both`. Violation returns `category_kind_mismatch`.

**Idempotency**: every write tool takes `idempotencyKey` (required except on statement-import items, which derive one when absent) — a stable key like `<date>-<description>-<amount>`. Same key returns the existing transaction with `created: false` instead of creating a duplicate.

## import_card_statement / import_account_statement

ADR-017 step 2: statement paste / import (1–200 items), split into single-source, aggregate-specific tools — no per-line ownership routing. Each item is classified and idempotent — `idempotencyKey` is derived from `date+description+amount` when absent, so re-importing the same statement is a no-op. Each item may set an optional `status` (`effective|pending`; omit for date-aware default) and an optional `note` (free-form memo, max 1000 chars). Item schemas are `.strict()`: a field that doesn't belong to that aggregate (e.g. `account` on a card-statement item, `billMonth`/`billYear` on an account-statement item) is rejected as an unrecognized key before the tool handler runs, refusing the whole call rather than silently dropping it or failing just that one item.

Returns `summary` counts plus per-item `status`: `created`, `needs_review` (no category or confidence < 0.6 — confirm with the user), `duplicate`, or `error` (with the structured AppError). Each transaction includes `typeLabel` and `statusLabel`.

**`import_card_statement`**: `card` (required — every item is a purchase on this ONE card, joining each item's own cycle bill via `add_card_purchase`'s policy), `items` (each mirrors `add_card_purchase`'s input minus `card`/`idempotencyKey`(optional here)/`rawInput`/`subCategory`/`tags`), `rawInput` (the original pasted statement text). REST mirror: `POST /api/credit-cards/statement`.

**`import_account_statement`**: `account` (optional — every item is an expense or income on this ONE account; omit to record unattached, e.g. cash, movements), `items` (each mirrors `add_account_expense`/`add_account_income`'s input minus `idempotencyKey`(optional here)/`rawInput`/`subCategory`/`tags`, plus a required `type` (`expense|income`) since a statement mixes both and the movement kind isn't fixed by which tool was called), `rawInput`. Each item's `type` picks `add_account_expense` or `add_account_income`. REST mirror: `POST /api/accounts/statement`.

## add_card_purchase

Record a credit-card purchase, joining the cycle bill (fatura) — the credit-card aggregate's purchase entry point (ADR-016). Owned by the credit-card aggregate: it resolves the card, computes the bill period, and rejects landing on a `paid` bill before writing anything.

Input: `description`, `amount` (positive), `type` (`expense|income`), `idempotencyKey` (required), optional `date`, `card` (name — **required**; the card's own internal liability account is always the destination, so there is no `account` field here), `billMonth` + `billYear` (optional — explicit target bill cycle; both required together, see below), `category` OR `subCategory` (not both — `subCategory` implies its parent category), `currency` (accepted for schema symmetry with `add_account_expense`/`add_account_income`, but has no effect — a card's currency is fixed at creation and always wins), `rawInput` (original user phrasing), `note` (free-form memo/observação, max 1000 chars), `tags`, `status` (see Transaction write basics above).

Returns `TransactionView` with `typeLabel`, `statusLabel`, and `billId` (the bill this transaction currently belongs to).

**Bill assignment** (Design 012): omit `billMonth`/`billYear` for the default cycle-based auto-assignment (from `date` + the card's `closingDay`/`dueDay`). Provide both together to target a specific cycle instead — the bill is auto-created (`open`) if that cycle has none yet; providing only one of the two is a `validation` error. Whether auto-assigned or explicit, a request that would land the transaction on an already-`paid` bill is rejected with a `validation` error pointing at `revert_bill_payment` — a `paid` bill's transaction membership is frozen (see `update_card_transaction`/`delete_card_transaction` below). `import_card_statement` applies this same policy to every item (see above).

REST mirror: `POST /api/credit-cards/purchases`.

Errors: resolution errors (`unknown_card`, `unknown_category`, …), `category_kind_mismatch`, `validation` (unpaired `billMonth`/`billYear`, landing on a `paid` bill).

## add_account_expense / add_account_income

Record an expense or income from a bank account / wallet — the account aggregate's movement entry points (ADR-016). Two intent-specific tools instead of one tool with a `type` field, mirroring the natural-language intents ("I spent…" vs. "I got paid…").

Input: `description`, `amount` (positive), `idempotencyKey` (required), optional `date`, `account` (name — omitting it records an unattached, e.g. cash, movement), `category` OR `subCategory` (not both), `currency` (resolved from the account when linked, else this field, else USD), `rawInput`, `note`, `tags`, `status` (see Transaction write basics above). There is no `card`, `type`, or `billMonth`/`billYear` field: the movement kind is the tool itself, and bill assignment is card-only vocabulary that doesn't apply to an account movement — `import_account_statement` dispatches each item here, keyed on the item's `type`, since a statement item still needs a discriminator (see above).

Returns `TransactionView` with `typeLabel` and `statusLabel` (no `billId`; that field only ever appears on card transactions).

REST mirrors: `POST /api/accounts/expenses`, `POST /api/accounts/income`.

Errors: resolution errors (`unknown_account`, `ambiguous_account`, `unknown_category`, …), `category_kind_mismatch`, `validation` (credit account rejected — post via `add_card_purchase` instead, category/subCategory both set).

## create_credit_card / list_credit_cards

`create_credit_card`: `name`, `closingDay` (1–28; transactions after it belong to next month's bill), `dueDay` (1–28), `currency` (default USD), optional `limit`, optional `paymentAccount` (name of the default paying account for bill payment). Auto-creates an internal `credit` account (`Card: <name>`) that tracks outstanding card debt (ADR-010). Card purchases post to this account, driving its balance negative. Error: `duplicate_name`, `validation` (currency mismatch with payment account).

## update_credit_card

Input: `name` (current card name, identifies it), optional `newName`, `limit`, `closingDay`, `dueDay`, `paymentAccount` — only provided fields change (Design 014 phase C, mirrors `update_account`). `currency` is accepted by the schema but always rejected with `validation` — a card's currency is fixed at creation (baked into its internal account and every existing transaction), so sending it surfaces a clear error rather than silently no-oping. Renaming (`newName`) cascades to the card's internal `credit` account (`Card: <name>` → `Card: <newName>`, ADR-010) as one atomic two-entity update; a name that collides case-insensitively with another card is rejected with `duplicate_name` before either write. `paymentAccount` is resolved and validated exactly like `create_credit_card`/`pay_bill`: rejected with `validation` if it names a credit account or its currency doesn't match the card's. `limit`/`closingDay`/`dueDay` are plain field updates — changing `closingDay`/`dueDay` applies to **future** bill cycles only; existing `bills` rows keep the `closeDate`/`dueDate` already computed for them. REST mirror: `PATCH /api/credit-cards/:name`. Errors: `unknown_card`, `ambiguous_card`, `unknown_account`, `ambiguous_account`, `duplicate_name`, `validation` (currency change rejected, currency mismatch, credit payment account).

## get_bill

Input: `card` (name), `month`, `year`. Returns the fatura: `bill` (`status: open|closed|paid`, `statusLabel`, `closeDate`, `dueDate`), `cardName`, `total`, and `transactions` (each with `typeLabel`/`statusLabel`). Bills are created automatically (status `open`) when the first card transaction of a cycle arrives. Error: `unknown_bill`.

## pay_bill

Input: `card`, `month`, `year`, optional `account` (paying account name override), optional `paymentDate` (`YYYY-MM-DD`, defaults to today). Creates a **canonical transfer** (paying account → card internal account) for the full bill total, then marks the bill `paid` and links the transfer via `paymentTransactionId` (ADR-010, Design 011). The paying account is resolved as: explicit `account` → card's default `paymentAccount` → `validation` error. Same-currency only. The payment transfer is always dated `paymentDate` (or today) and always `effective` — a bill payment records a payment that already occurred, so `paymentDate` must not be in the future (rejected with `validation`); this is the invariant that an `effective` transaction's date is never in the future (Design 014), also enforced at `confirm_transaction` — other tools that accept an explicit `status` are unaffected (see `docs/architecture.md`'s invariant 20). Idempotent: re-calling on a paid bill is a no-op. If total ≤ 0, marks paid with no transfer (`paymentTransactionId` stays absent). Errors: `unknown_bill`, `unknown_card`, `unknown_account`, `validation` (no payer, currency mismatch, credit payer, future `paymentDate`).

## revert_bill_payment

Input: `card`, `month`, `year`. Undoes a bill payment: deletes the linked payment transfer and flips the bill `paid → closed` (Design 011). Not `paid` → no-op success, returns the bill unchanged. Paid with no linked transfer (the `pay_bill` non-positive-total branch) → flips to `closed`, nothing to delete. This is the exact inverse of `pay_bill`; both are idempotent no-ops outside the `paid ⇄ closed` transition. The deleted transaction's idempotency key is freed, so paying again afterward creates a fresh transfer. REST mirror: `POST /api/bills/revert`. Errors: `unknown_bill`, `unknown_card`.

## delete_credit_card

Input: `card` (name), `confirm` (default false). Hard delete: removes the card, its internal credit account, all correlated transactions (purchases + bill payments), and all bills. Without `confirm: true`, returns a dry run: `{ deleted: false, dryRun: true, wouldDelete: { card, account, transactions, bills } }`. With `confirm: true`, deletes atomically. Errors: `unknown_card`.

## create_recurring / list_recurring / apply_due_recurring

`create_recurring`: `description`, `amount`, `type`, `period` (`weekly|monthly|yearly`), `startDate` (first due), optional `account`, `category`, `currency`, `merchant` (Feature Design 017). Recurring transactions are classified as `user` with confidence 1. `merchant` names the merchant the rule pays (e.g. `"Netflix"`, a landlord); when omitted it's derived from `description` — either way, normalized the same way a transaction's merchant is. A rule created before this field existed has no merchant until re-saved (there is no `update_recurring` today).

`list_recurring`: returns all recurring rules with `periodLabel` (localized period).

`apply_due_recurring` (optional `through: YYYY-MM-DD`, default today): materializes a transaction for every rule due on/before `through`, bounded at 36 occurrences per rule. Each returned transaction includes `typeLabel` and `statusLabel`, and carries the rule's `merchant` (if any), so recurring spend participates in merchant concentration and classification like any other transaction. Each occurrence is stamped with the date-aware default — past/present land `effective`, future land `pending`. Passing a future `through` pre-creates upcoming salary, rent, and subscriptions as pending, feeding projections without extra monthly effort. Default behaviour (`through` omitted) is unchanged catch-up. Idempotent via `rec-<ruleId>-<dueDate>` — safe to re-run anytime. Every due rule's occurrences and `next_due` advance apply as one atomic batch (ADR-021 phase 3b); a rare concurrent write is retried automatically and only surfaces as `conflict` if retries are exhausted.

## confirm_transaction

Flip a `pending` transaction to `effective`. Once effective, the transaction counts toward balances and spending summaries. If the transaction is already `effective`, this is a no-op (returns the existing transaction unchanged). Returns the transaction with `typeLabel` and `statusLabel`.

**Confirm-with-edit** (Design 014 phase B): optional `amount`/`date` correct a pending estimate in the same call, applied together with the status flip. Allowed only for an account/card movement — editing `amount`/`date` on a **transfer or bill-payment** transaction is rejected (`transactionErrors.confirmEditNotAllowedForTransfer`, pointing at `update_account_transaction` for a transfer or `pay_bill`/`revert_bill_payment` for a bill payment); a plain status-only confirm of one is still fine, since it makes no date claim of its own. The resolved date — the given `date`, or the existing date if omitted — must not be in the future (`transactionErrors.cannotConfirmFutureDated`): an `effective` transaction's date is never in the future (`docs/architecture.md` invariant 20), so a plain confirm of a transaction whose *existing* date is already future-dated is rejected too, not just an explicit future `date` edit. Reclassifying (category/subCategory/tags/note) is not part of confirm — use `update_account_transaction`/`update_card_transaction` for that.

Input: `id` (required — use `search_transactions` with `status: "pending"` to find pending transactions), optional `amount`, `date` (`YYYY-MM-DD`).

REST mirror: `POST /api/transactions/:id/confirm` (body: `amount`/`date`, both optional).

Errors: `unknown_transaction`, `validation` (edit rejected for a transfer/bill-payment, future-dated confirm).

## update_card_transaction / delete_card_transaction, update_account_transaction / delete_account_transaction

ADR-017: no god write flow for update/delete — each is a self-validating, caller-addressed tool owned by exactly one aggregate. **Ownership (by account type, ADR-020)**: a transaction is credit-card-aggregate-owned iff it involves a `credit` account (ADR-010) as either leg (`accountId` or `toAccountId`) — a card purchase's own account **is** the card's internal account, and the bill-payment transfer's destination **is** that same account; otherwise it is account-aggregate-owned (account expenses/income, ordinary transfers). This is resolved from the canonical account type, not sniffed from `cardId`/`billId` presence — `TransactionView` doesn't expose account types directly. In practice, `cardId`/`billId` (always returned by `search_transactions`/`TransactionView`) remain reliable proxies for picking the right tool, since only a card purchase or the bill-payment transfer can ever have a `credit` leg (`create_transfer` and the account expense/income tools both reject posting to a `credit` account outright) — but if ever unsure, especially reasoning about an ordinary transfer's `toAccountId`, call the tool and follow the wrong-tool redirect below rather than resolving account types yourself.

**Wrong-tool redirect**: calling a card tool on an account-owned transaction, or an account tool on a card-owned transaction, is rejected with a `validation` error naming the correct tool — a guard, not a dispatcher; nothing re-routes the call for you.

### update_card_transaction

Patch fields of a card-owned transaction by `id` (from `search_transactions`). Only provided fields change. Returns the updated transaction with `typeLabel`, `statusLabel`, and `billId` (reflects a `billMonth`/`billYear` reassignment immediately). Setting `category` is a **user correction**: confidence becomes 1 and the `merchant_category` weight is strengthened. `account` cannot be changed — a card transaction is always funded by the card's own internal liability account (ADR-010) and has no independent account to reassign; sending it is rejected with a `validation` error rather than silently repointing the transaction (which would desync the card's balance from its bill total).

Input: `id` (required), optional `description`, `amount`, `type`, `date`, `account` (rejected — see above), `billMonth` + `billYear` (optional — reassign to a different bill cycle; both required together), `category`, `subCategory`, `note` (free-form memo — empty string clears; omit to leave unchanged), `tags`.

**Bill reassignment** (Design 012): `billMonth`/`billYear` moves the transaction to a different cycle's bill for its **own card** — there is no way to change which card a transaction belongs to, so this can never cross cards. The target bill is auto-created (`open`) if that cycle has none yet. Rejected with a `validation` error, pointing at `revert_bill_payment`, if either the transaction's *current* bill or the *target* bill is `paid` — a `paid` bill's transaction membership is frozen.

**The bill-payment transfer cannot be edited at all**: a transaction with `billId` set and no `cardId` is definitionally the transfer `pay_bill` created, so *any* update — reassignment or otherwise — is rejected with a `validation` error pointing at `revert_bill_payment`. It is created/removed only by `pay_bill`/`revert_bill_payment`. This rejection is bill-process policy, not transfer-type-immutability — the credit-card aggregate never runs the transfer-mutability check at all (ADR-020 §3); that check lives solely in `update_account_transaction` (see below), the only tool that ever reaches a regular, mutable transfer.

**Kind validation on update**: if `category`/`subCategory` is provided without `type`, the existing transaction type is used for kind validation. On mismatch, the error includes an actionable `hint` field (e.g. `"Category \"Salário\" is income-only; use a matching category, or record this as income instead"` — phrased tool-agnostically since the same error is also raised by `update_account_transaction`, `add_card_purchase`, `add_account_expense`, and `add_account_income`). Note: `type` accepts `expense|income` only; use `create_transfer` to create transfers.

REST mirror: `PATCH /api/credit-cards/transactions/:id`.

Errors: `unknown_transaction`, resolution errors, `category_kind_mismatch`, `validation` (wrong-tool redirect, `account` rejected, paid-bill immutability, bill-payment-transfer edit rejected).

### delete_card_transaction

Two-step destructive action on a card-owned transaction. Without `confirm: true` it is a **dry run**: returns `{ deleted: false, dryRun: true, wouldDelete: {...} }` — show it to the user and ask before calling again with `confirm: true`. The transaction includes `typeLabel` and `statusLabel`.

Input: `id` (required), `confirm` (default false).

**Any transaction on a `paid` bill cannot be deleted this way** (Design 012, broadened from Design 011's narrower payment-transfer-only rule): the id is rejected with a `validation` error before the dry-run flow, pointing at `revert_bill_payment` — this covers ordinary purchases on a paid bill as well as the payment transfer itself (whose own bill is always the one it paid). Transactions on a non-paid bill delete normally.

REST mirror: `DELETE /api/credit-cards/transactions/:id`.

Errors: `unknown_transaction`, `validation` (wrong-tool redirect, paid-bill immutability).

### update_account_transaction

Patch fields of an account-owned transaction by `id` (from `search_transactions`). Only provided fields change. Returns the updated transaction with `typeLabel` and `statusLabel` (no `billId`; that field only ever appears on card transactions). Setting `category` is a **user correction**: confidence becomes 1 and the `merchant_category` weight is strengthened. Changing `account` also updates `currency` to match it.

Input: `id` (required), optional `description`, `amount`, `type`, `date`, `account`, `category`, `subCategory`, `note` (free-form memo — empty string clears; omit to leave unchanged), `tags`. There is no `billMonth`/`billYear` field: bill assignment is card-only vocabulary that structurally doesn't apply here (mirrors `add_account_expense`/`add_account_income`'s create-side omission).

**Kind validation on update**: same rule as `update_card_transaction` above. Transfer transactions (`type: transfer`) cannot have a `category`/`subCategory` and cannot have their `type` changed — both are rejected with a `validation` error. Note: `type` accepts `expense|income` only; use `create_transfer` to create transfers.

REST mirror: `PATCH /api/accounts/transactions/:id`.

Errors: `unknown_transaction`, resolution errors, `category_kind_mismatch`, `validation` (wrong-tool redirect, transfer immutability).

### delete_account_transaction

Two-step destructive action on an account-owned transaction. Without `confirm: true` it is a **dry run**: returns `{ deleted: false, dryRun: true, wouldDelete: {...} }` — show it to the user and ask before calling again with `confirm: true`. The transaction includes `typeLabel` and `statusLabel`.

Input: `id` (required), `confirm` (default false).

REST mirror: `DELETE /api/accounts/transactions/:id`.

Errors: `unknown_transaction`, `validation` (wrong-tool redirect).

## search_transactions

Filter by `month`+`year` (or `from`/`to`), `type` (`expense|income|transfer`), `status` (`pending|effective`), `category`/`subCategory`/`account` (names), free-text `text` (description substring), `tags`. Each `TransactionView` includes `typeLabel`, `statusLabel`, and `note` (when set). With an `account` filter this is the full extrato: the account matches as source OR destination, so transfers in both directions are included. Results include `subCategoryId`/`subCategoryName` when set.

Use `status: "pending"` to list scheduled/expected transactions (e.g. "what is due today" or "what income is expected this month").

**Pagination + ordering.** Returns a page, not a bare array:

```jsonc
{ "items": [ /* TransactionView[] */ ],
  "nextCursor": "eyJ2IjoxLCJzb3J0IjoiZGF0ZSIs...",   // absent on the last page
  "total": 312 }                                     // present only when includeTotal: true
```

- `limit` (default 50, max 200): rows per page.
- `sort` (default `date`): `date | amount` — the whitelisted sort field.
- `dir` (default `desc`): `asc | desc`.
- `cursor` (optional): the previous page's `nextCursor`, to fetch the next page. Opaque — never
  construct or inspect it; pass it back exactly as received.
- `includeTotal` (default `false`): when `true`, adds `total` — the count of every transaction
  matching the filters (not just this page). Costs an extra query; ask for it on the first page
  only if you need a count/progress display.

`sort`/`dir` are baked into the cursor: a follow-up request's `sort`/`dir` must match what produced
the cursor, or the call fails with a `validation` error — start a fresh first page (no `cursor`) to
change ordering. To walk every matching transaction, loop passing `nextCursor` back as `cursor` until
it's absent from the response.

REST mirror: `GET /api/transactions` (same query fields; `cursor`/`sort`/`dir`/`limit` are query
strings, `includeTotal` is `"true"`/`"false"`).

**Errors:** resolution errors (`unknown_account`, `unknown_category`, …), `validation` (malformed/stale
cursor, or a cursor whose `sort`/`dir` doesn't match the request's).

## aggregate_spending

Flexible spending aggregation: group transactions by a chosen dimension, measured by a chosen metric. Results are per-currency blocks with totals and percentages. Only effective, non-transfer transactions are counted (consistent with `get_spending_summary` and balances). Category labels are locale-resolved via `localizeCategoryName`.

**Input:**
- `groupBy` (required): `category | account | tag | month | merchant`
- `metric` (default `sum`): `sum | count | avg`
- Period: `month` + `year` **or** `from`/`to` (`YYYY-MM-DD`)
- Filters (all optional): `account` (name), `category` (name), `type` (`expense | income`), `tags` (names)
- `limit` (default 50, max 100): top-N rows per currency
- `sort` (default `desc`): `asc | desc` by metric value

**Output:**
```jsonc
{ "groupBy": "category", "metric": "sum",
  "currencies": [
    { "currency": "BRL", "total": 1850.0,
      "rows": [
        { "key": "cat-food", "label": "Alimentação", "value": 1200.0, "count": 18, "pct": 64.9 },
        { "key": "cat-transport", "label": "Transporte", "value": 650.0, "count": 9, "pct": 35.1 }
      ] } ] }
```

**Errors:** `unknown_account`, `ambiguous_account`, `unknown_category`, `ambiguous_category`, `validation` (missing period).

**Safety (ADR-011):** dynamic query structure comes only from whitelisted enum-keyed SQL fragments; all filter values are parameter-bound; caller text never reaches SQL.

REST mirror: `GET /api/aggregate?groupBy=category&month=6&year=2026`.

## find_correlations

Feature Design 016: one tool over spending-pattern analyses, discriminated by `analysis` (a whitelisted enum,
mirroring `aggregate_spending`'s `groupBy`). Additive across phases — `spending_shifts`, `budget_fit`, and
`merchant_concentration` exist so far (`recurring_candidates` lands in a later phase). Read-only: no entity, no
write flow.

### spending_shifts

"What's driving the change" — what's up or down vs a trailing baseline, per `(category, currency)`.

**Input:**
- `analysis: "spending_shifts"` (required)
- `month`, `year` (required): the reference period
- `baselineMonths` (default `3`): trailing window size in months averaged into the baseline
- `minDeltaPct` (default `20`): only surface categories whose `|deltaPct|` is at least this percentage; a
  brand-new category with no baseline spend at all is always surfaced regardless of this threshold

**Computation:** per `(category, currency)`, `current` = the reference month's effective, expense-only total;
`baseline` = the average monthly effective expense total over the preceding `baselineMonths`; `deltaPct` =
`(current - baseline) / baseline * 100`, or `null` when there is no baseline spend at all (a brand-new category
— reported with `direction: "up"`, not a divide-by-zero). A category with baseline spend but nothing this
month (`current: 0`) is a legitimate `down` shift. Sub-category spend rolls up into its parent category, same
as `aggregate_spending`/budgets (a sub-category transaction's `category_id` is always its parent's). Only
`effective`, `expense`-typed transactions count — pending, income, and transfers never do, even on a
`both`-kind category.

**Output:**
```jsonc
{ "analysis": "spending_shifts", "month": 6, "year": 2026,
  "shifts": [
    { "category": "Alimentação", "currency": "BRL", "current": 1200.0, "baseline": 800.0,
      "deltaPct": 50.0, "direction": "up" },
    { "category": "New Hobby", "currency": "BRL", "current": 300.0, "baseline": 0,
      "deltaPct": null, "direction": "up" }
  ] }
```
Sorted by `|deltaPct|` descending; brand-new-spend categories (`deltaPct: null`) sort first.

**Safety:** the query shape is fixed (no caller-selected dimension); all filter values (dates, thresholds) are
parameter-bound, never concatenated into SQL — the same discipline as ADR-011 without needing a whitelist
fragment map, since there is no structural choice to whitelist.

### budget_fit

Closes the loop between insights and budgets: does each budget's limit make sense against actual spending, and
what would a realistic limit be. **Read-only** — apply a suggestion yourself via `create_budget`/`update_budget`;
this mode never writes.

**Input:**
- `analysis: "budget_fit"` (required)
- `month`, `year` (required): the reference period
- `baselineMonths` (default `3`): same trailing-average definition as `spending_shifts`
- `slackPct` (default `20`): how far below the limit the baseline can sit before the verdict is `"generous"`
- `overPct` (default `20`): how far above the limit the baseline can sit before the verdict is `"unrealistic"`

**Computation:** `budgeted` has one line per existing budget — `baseline` is measured against the budget's own
target the same way `get_budget_status` measures `spent` (a category budget rolls up its sub-categories; a
sub-category budget measures only its own spend), split into a current-month/trailing-baseline pair like
`spending_shifts`. `verdict` compares `baseline` to `limit`: `"realistic"` (within `[1 - slackPct%, 1 + overPct%]`
of the limit), `"unrealistic"` (baseline materially over the limit — consistently over-budget), or `"generous"`
(baseline well under the limit). Every line also carries a `suggestedLimit` (`baseline` plus a 10% margin, not
the bare average, since a limit set exactly at the average would be exceeded by any normal month-to-month
variance) — pass it straight to `update_budget`. `unbudgeted` lists top-level categories with an established
(nonzero) baseline spend pattern and no budget covering them at all (whether directly or via a sub-category
budget), each with a `suggestedLimit` ready for `create_budget`. A one-off current-month blip with no baseline
track record is never suggested. Per-currency throughout — a BRL budget is measured only against BRL spend.

**Output:**
```jsonc
{ "analysis": "budget_fit", "month": 6, "year": 2026,
  "budgeted": [
    { "id": "budget-1", "category": "Alimentação", "currency": "BRL", "limit": 500.0,
      "current": 640.0, "baseline": 720.0, "verdict": "unrealistic", "suggestedLimit": 792.0 },
    { "id": "budget-2", "category": "Lazer", "currency": "BRL", "limit": 800.0,
      "current": 90.0, "baseline": 100.0, "verdict": "generous", "suggestedLimit": 110.0 }
  ],
  "unbudgeted": [
    { "category": "Transporte", "currency": "BRL", "baseline": 340.0, "suggestedLimit": 374.0 }
  ] }
```

No REST mirror yet (MCP-only, mirrors the budget tools).

### merchant_concentration

"Where within Food is my money actually going?" — spend concentration by merchant within a category, the
concrete reading of "merchant clusters" (literal clustering/co-visitation was rejected as too fuzzy — see the
design doc's Options/decisions).

**Input:**
- `analysis: "merchant_concentration"` (required)
- `month`, `year` (required): the period
- `category` (optional): restrict to a single category by name; omitted means every category
- `topN` (default `5`): top merchants to return per category

**Computation:** per `(category, currency)`, group effective, expense-only spend by merchant. `categoryTotal` is
the full total (reconciles with `aggregate_spending`); `merchants` is the top `topN` by spend, each with `share`
(`spent / categoryTotal`, a **0-1 fraction**, not a percentage) and `cumulativeShare` (running total in
descending-spend order — the last returned merchant's `cumulativeShare` plus `othersSpent / categoryTotal` sums
to 1). `othersSpent` is `categoryTotal` minus the returned merchants — the long tail beyond `topN`. A transaction
with no classified merchant groups under a locale-resolved "Unknown". Sub-category spend rolls up into its
parent category, same as `spending_shifts`/`budget_fit`.

**Output:**
```jsonc
{ "analysis": "merchant_concentration", "month": 6, "year": 2026,
  "categories": [
    { "category": "Alimentação", "currency": "BRL", "categoryTotal": 1200.0,
      "merchants": [
        { "merchant": "ifood", "spent": 700.0, "share": 0.5833, "cumulativeShare": 0.5833 },
        { "merchant": "uber eats", "spent": 300.0, "share": 0.25, "cumulativeShare": 0.8333 }
      ],
      "othersSpent": 200.0 }
  ] }
```
Sorted by category name; within a category, `merchants` is sorted by spend descending.

**Errors:** `unknown_category`, `ambiguous_category` (invalid `category` filter).

No REST mirror yet (MCP-only, mirrors the budget tools).

## get_spending_summary

Input: `month`, `year`. Returns per-currency blocks: `income`, `expenses`, `balance`, `byCategory` (sorted by total desc). Currencies are never mixed or converted.

## update_account

Update a bank account by name. `name` (via `newName`) and `initialBalance` are always editable. `type` is only editable when the account has no transactions/transfers (and cannot be set to `credit`). `currency` is only editable when the account has no transactions/transfers, no recurring rules, and is not a credit card payment account.

Input: `name` (required — current account name), optional `newName`, `initialBalance`, `type` (`checking|savings|wallet|investment`), `currency`.

**Credit accounts are rejected** — they are managed by their credit card (ADR-010).

Errors: `unknown_account`, `ambiguous_account`, `duplicate_name` (rename collision), `validation` (credit account, type→credit, field blocked by associations).

REST mirror: `PATCH /api/accounts/:name`.

## delete_account

Delete a bank account by name. **Block-if-in-use**: if any transactions, transfers, recurring rules, or credit cards (as payment account) reference it, returns `in_use` error with reference counts — nothing is deleted. No dry-run/confirm (non-destructive: only removes unreferenced accounts).

Input: `name` (required).

**Credit accounts are rejected** — use `delete_credit_card` instead (ADR-010).

**`in_use` error shape**: `{ code: "in_use", entity: "account", name, references: { transactions, recurring, cards } }`. HTTP status: 409 Conflict.

Errors: `unknown_account`, `ambiguous_account`, `validation` (credit account), `in_use`.

REST mirror: `DELETE /api/accounts/:name`.

## create_account / list_accounts

`create_account`: `name` (required), `type` (`checking|savings|wallet|investment`, default checking — checking = conta corrente), `currency` (default USD). Error: `duplicate_name`, `validation` (type `credit` is rejected — credit accounts are created automatically via `create_credit_card`).

`list_accounts`: optional `type` filter (e.g. all investment accounts). Returns `typeLabel` — the localized display label for the account type (e.g. "Conta corrente" in pt).

## get_account_balances

Current balance per account, **derived** (never stored): `initialBalance + income − expenses + transfers in − transfers out`. Returns `typeLabel` (localized account type). **Only `effective` transactions count** — pending transactions are never included in the balance. Returns the parts alongside the balance. Optional filters: `account` (name), `type`.

Optional `projectedAsOf` (`YYYY-MM-DD`): when provided, also returns `projectedBalance` = effective balance + all pending transactions dated on/before that date. This is a provisioning view (what you will stand at that date assuming all pending clear). The effective `balance` is always present; `projectedBalance` is only present when `projectedAsOf` is supplied.

Note: `create_account` accepts `initialBalance` (default 0).

## create_transfer

Move value between accounts (`from`, `to` names, `amount`, `idempotencyKey`, optional `date`, `description`). Creates a **transaction with `type: 'transfer'`** carrying both FROM and TO accounts (ADR-002): debits one balance, credits the other, excluded from spending summaries, and appears in both accounts' statements via `search_transactions` (which is also how you list transfers — `type: 'transfer'`). The returned transaction includes `typeLabel` and `statusLabel`. Both accounts must share a currency; cross-currency returns a `validation` error (FX pending). **Credit accounts are rejected on either leg** — use `pay_bill` to settle card debt (ADR-010). Idempotent.

## create_category / list_categories

`create_category`: `name` (required), `kind` (`expense|income|both`, default expense). Prefer existing categories (`list_categories`) before creating. Error: `duplicate_name`.

`list_categories`: returns all top-level categories with `kindLabel` (localized category kind). **Names are resolved to the active locale** for default (seeded) categories via `names?.[locale] ?? name`; user-created categories always show their literal `name`. Each category includes a `names` map (set for defaults with `{pt, es}`, `null` for user-created).

## create_sub_category / list_sub_categories

`create_sub_category`: `name` (required), `parentId` (required — use `list_categories` to find it). Sub-categories inherit their parent's `kind`; the same kind validation applies to transactions. Names must be unique within the same parent. Error: `duplicate_name`, `unknown_category`.

`list_sub_categories`: optional `parentId` filter. Returns `{ id, name, parentId, parentName, kind, kindLabel }`.

**Name resolution**: `subCategory` is resolved by name across all parents. If two sub-categories under different parents share the same name (e.g., "Outros" under Alimentação and Transporte), resolution returns `ambiguous_sub_category` — retry with a more specific name or use `list_sub_categories` to disambiguate.

TransactionView includes `subCategoryId` and `subCategoryName` when a sub-category is linked.

## delete_category / delete_sub_category

`delete_category`: `name` (required). Deletes a category by name. **Block-if-in-use**: if any transactions, recurring rules, or sub-categories reference it, returns `in_use` error with reference counts — nothing is deleted. On success, also removes the category's learned `merchant_category` rules (re-learnable; not a blocker). Seeded categories follow the same rules — no special protection.

`delete_sub_category`: `name` (required). Same block-if-in-use semantics for sub-categories.

**`in_use` error shape**: `{ code: "in_use", entity: "category" | "sub_category", name, references: { transactions, recurring, subCategories } }`. HTTP status: 409 Conflict. Only blocking (user-record) references are listed; merchant rules are not.

## create_tag / list_tags / delete_tag

Free-form labels attached to transactions (e.g. "work", "travel", "reembolsável"), orthogonal to categories.

- `create_tag`: `name` (required, unique). Error: `duplicate_name`.
- `list_tags`: no input — returns all tags `{ id, name }`.
- `delete_tag`: `id` (required). Removes the tag and all its transaction associations.

Attach tags at write time via the `tags` array on `add_card_purchase` / `add_account_expense` / `add_account_income` (statement-import items omit `tags` — bulk import classifies automatically).

## create_budget / update_budget / delete_budget / list_budgets / get_budget_status

Feature Design 015: a recurring monthly spending limit on a category or sub-category, in one currency.

- `create_budget`: exactly one of `category`/`subCategory` (required — resolved by name like every other
  category reference), `currency`, `limit` (positive), `period` (optional, defaults to `monthly` — the only
  period for now). A **category** budget rolls up its sub-categories' spend (the envelope behavior): sub-category
  transactions carry the parent's `category_id`. A **sub-category** budget measures only its own spend, and also
  counts toward its parent's budget if one exists. Returns `{ id, category, subCategory?, currency, limit,
  period }` — `subCategory` is present only when the budget targets a sub-category.
  Errors: `unknown_category`/`ambiguous_category`/`unknown_sub_category`/`ambiguous_sub_category` (name
  resolution), `validation` (neither or both of `category`/`subCategory` given), `not_expense_category` (an
  income-kind category can't be budgeted — a budget caps spending), `duplicate_budget` (a budget already exists
  for this exact target/currency/period — use `update_budget` instead).
- `update_budget`: `id` (required, from `create_budget`/`list_budgets`), `limit`/`period` (optional — only
  provided fields change). The target and currency are fixed at creation and can't be changed. Error:
  `unknown_budget`.
- `delete_budget`: `id` (required). **Idempotent** — an already-absent id is not an error, returns
  `{ deleted: false }` (same shape as `delete_tag`).
- `list_budgets`: no input — returns all budgets (the limits themselves, no spend) as `{ id, category,
  subCategory?, currency, limit, period }`.
- `get_budget_status`: `month` (1–12), `year` — spend-vs-limit for every budget in that month. `spent` is
  effective, `expense`-typed (never `income` or `transfer` — a `both`-kind category is budgetable, so income
  booked to one is excluded rather than inflating the cap), same-currency spend. Returns `{ period: { month, year },
  categories: [{ category, lines: [{ id,
  subCategory?, currency, limit, period, spent, remaining, pct }] }] }` — grouped by top-level category name, so
  a category's own budget and each of its sub-categories' own budgets read as one coherent unit; per-currency
  lines are never combined (no cross-currency total — that needs FX, the deferred PLAN open question).
  `remaining` (limit − spent) and `pct` (spent / limit) can go negative / exceed 1 when over budget — over-budget
  is reported, never an error. A month with no matching transactions reports `spent: 0` for every budget.

No REST mirror yet (MCP-only).

## save_dashboard / list_dashboards / delete_dashboard / rename_dashboard

LLM-generated local dashboards over the HTTP API (ADR-013). A dashboard is a self-contained HTML shell stored by name and served live at `GET /ui/:name`. The seeded `overview` dashboard is the Phase B baseline data-less template (fetch-on-load, no inline data). `skills/dashboard-building/SKILL.md` is the guardrail checklist an agent follows to build or adapt a dashboard from this template without violating the no-inline-data rule — read the contract (`fintrack://openapi`), map sections to real endpoints, and self-check against the hard rules before calling `save_dashboard`.

- `save_dashboard`: `name`, `html` (required). **Upsert** — saving to an existing name replaces it immediately, no rebuild/restart. **CRITICAL**: the HTML must never embed financial data, secrets, or tokens — render layout/styling only and `fetch()` data client-side from `/api` on load (read the `fintrack://openapi` resource for the contract), so the dashboard is always live and safe to share. Returns the stored `{ name, html, updatedAt }`.
  - **Rejected (`validation`, 422) if the HTML can't possibly render**: no `<!doctype html>`/`<html>` root element, or an inline `<script>` with a JS syntax error (checked by compiling it, never executing it). This is a cheap render-ability check, not sanitization or a full HTML validator — full sanitization is out of scope for this local single-user app (ADR-013 Phase A). A rejected save leaves the previously stored dashboard untouched.
- `list_dashboards`: no input — returns all dashboards as `{ name, updatedAt }` (HTML omitted).
- `delete_dashboard`: `name` (required). **Idempotent** — an already-absent name is not an error, returns `{ deleted: false }` (same shape as `delete_tag`). Present → deletes it and returns `{ deleted: true }`; `GET /ui/:name` 404s afterward.
- `rename_dashboard`: `name`, `newName` (both required). Preserves content and identity — only the name changes. Errors: `unknown_dashboard` if `name` doesn't exist, `duplicate_name` if `newName` is already taken (nothing is renamed either way). On success, `GET /ui/:newName` serves it immediately; `GET /ui/:name` (the old name) 404s.

REST mirror: `GET /api/dashboards` (list, HTML omitted), `GET /api/dashboards/:name` (JSON, `unknown_dashboard` if absent), `POST /api/dashboards` (upsert, same validation and 422 as above), `DELETE /api/dashboards/:name` (idempotent, always `200 { deleted }`), `POST /api/dashboards/:name/rename` (body `{ newName }`; `404`/`409` for the same errors as above). The browser-facing serving route is `GET /ui/:name` — returns the stored HTML as `text/html; charset=utf-8` with no-cache headers (404 `unknown_dashboard` if absent); it is not part of the `/api` JSON contract and does not appear in the OpenAPI document. The Phase B baseline dashboard (`overview`) is seeded on first boot; `save_dashboard` overrides it permanently.

## set_locale / get_preferences

`set_locale`: `locale` (`en|es|pt`), `source` (`inferred|explicit`). Sets the display language for default category names. The AI agent calls this with `source: "inferred"` when it detects the user's language from conversation, or `source: "explicit"` when the user directly requests a locale change. **Guardrails**: (1) Anti-churn — only switch on a clear, sustained language change, not isolated foreign words, merchant names, or proper nouns. (2) Respect explicit — if the current `locale_source` is `"explicit"`, an `inferred` switch is rejected with a `validation` error; the user must explicitly request the change. Error: `validation`.

`get_preferences`: no input. Returns `{ locale, localeSource }` — the **stored** preference, not the effective display locale. Use to check whether the user set the locale explicitly before attempting an inferred switch. Note: when `FINTRACK_LOCALE` is set, `list_categories` uses the env value for display names, which may differ from the stored `locale` returned here.

**Resolution order** (for display names): `FINTRACK_LOCALE` env var → `settings.locale` → `'en'` (cold-start default).

## get_status

No input. Returns `{ name: "fintrack", version, db, locale }`:

- `name` — always `"fintrack"`.
- `version` — the package version from `package.json` (same value as the `serverInfo.version` reported in the MCP `initialize` handshake). In dev: `0.0.0-development`; in published releases: the semantic-release version.
- `db` — `"ok"` if the database is reachable, `"error"` otherwise.
- `locale` — the effective active locale (`en`, `es`, or `pt`).

A convenience for tool-only callers (AI agent / chat user). The MCP protocol already exposes version via the `initialize` handshake `serverInfo` and liveness via `ping` — this tool complements those for callers that can only invoke tools.

REST mirror: `GET /api/status` returns the same payload. `GET /api/health` remains as a bare liveness probe (`{ status: "ok" }`).

## Resources

Unlike tools (invoked with arguments), resources are read by URI — no input schema, no side effects.

### `fintrack://openapi`

Returns the same OpenAPI 3.0 document served at `GET /api/openapi.json` (`application/json`, `text` content). Generated from the `wire/in`/`wire/out`/`models` zod schemas that back the REST routes (ADR-013 Phase A) — read this before generating `fetch()` calls against `/api` so the shapes can't be guessed wrong. This is the app's first MCP resource; read via `resources/read` with `uri: "fintrack://openapi"` (discoverable via `resources/list`).
