# FinTrack MCP tools

Contract for the MCP server at `POST /mcp` (streamable HTTP, stateless). All tools share these conventions:

- **Natural inputs**: `account`, `card`, `category`, and `subCategory` take names (case/accent-insensitive, partial match allowed). Resolution failures return structured errors the agent can self-correct from.
- **Errors**: `{ "error": { "code": "...", ... } }` with `isError: true`. Codes: `unknown_account`, `ambiguous_account`, `unknown_category`, `ambiguous_category`, `unknown_sub_category`, `ambiguous_sub_category`, `unknown_card`, `ambiguous_card`, `unknown_transaction`, `unknown_bill`, `unknown_dashboard`, `unknown_budget`, `duplicate_name`, `duplicate_budget`, `not_expense_category`, `in_use`, `category_kind_mismatch`, `validation`, `conflict` (a concurrent write raced this one out — retry). Ambiguous/unknown errors include `candidates` (names) to retry with. A `validation` error whose fix is another operation also carries `hint: "use <tool>"` (e.g. `use revert_bill_payment`) — the domain names the operation, this edge says which tool performs it; the REST API's same field names the route (`use POST /api/bills/revert`).
- **Currency**: BRL, USD, MXN, COP, USDC or BTC; from the account/card when one is linked, else the `currency` field, else USD. Summaries group per currency, never converting.
- **Dates**: `YYYY-MM-DD`.
- **Localized labels**: read views include `*Label` fields — localized display labels for fixed enum values, resolved at read time via the active locale (Design 006). The enum value itself (`type`, `status`, `kind`, `period`) is stable identity; the `*Label` is derived display only. Switching locale reflows all labels with no migration. See per-tool details below.

## Scopes per tool

**There is no user-management tool, by design.** Creating, inviting, disabling and promoting users, and the instance's sign-in cap, are session-only and admin-only: browser pages under `/ui/access/users` and the trusted terminal's `fintrack users` command ([`auth.md`](auth.md#users-roles-and-invitations)). No token — whatever its scope — and no MCP client can reach them.

Over HTTP with authentication `required`, `/mcp` takes an `Authorization: Bearer ftk_…` personal access token (or a session
cookie), and every tool needs a scope ([`auth.md`](auth.md#scopes)). A tool's scope derives from its
`annotations.readOnlyHint`: `true` → `fintrack:read`, otherwise `fintrack:write` (which includes read). A read-only token
that calls a write tool gets HTTP `403` with `WWW-Authenticate: Bearer error="insufficient_scope",
scope="fintrack:write", …` before the tool runs. Resources (`fintrack://…`) and prompts need `fintrack:read`. Over stdio the caller is the
signed-in credential — a `FINTRACK_TOKEN` or a saved browser sign-in, each with its own scopes ([`auth.md`](auth.md#signing-in-claude-stdio)):
a read-only one that calls a write tool gets the same `insufficient_scope` tool error, and a session with **no** credential gets an
ordinary error result, `FinTrack: not signed in. Open <origin>/ui/connect?code=ABCD-EFGH and confirm the code ABCD-EFGH.`, from every
tool, resource read and prompt get (the lists and `initialize` still work). Only an explicit `FINTRACK_AUTH=disabled` makes stdio the trusted owner.

The split is pinned by a unit test (`test/unit/diplomat/mcp/scopes.test.ts`), so reclassifying a tool is a reviewed diff.

| Scope | Tools |
|---|---|
| `fintrack:read` (`readOnlyHint: true`) | `aggregate_spending`, `find_correlations`, `get_account_balances`, `get_bill`, `get_budget_status`, `get_preferences`, `get_spending_summary`, `get_status`, `list_accounts`, `list_budgets`, `list_categories`, `list_credit_cards`, `list_dashboards`, `list_exchange_rates`, `list_recurring`, `list_sub_categories`, `list_tags`, `search_transactions` |
| `fintrack:write` (`readOnlyHint: false`) | `add_account_expense`, `add_account_income`, `add_card_purchase`, `apply_due_recurring`, `confirm_transaction`, `create_account`, `create_budget`, `create_category`, `create_credit_card`, `create_recurring`, `create_sub_category`, `create_tag`, `create_transfer`, `delete_account`, `delete_account_transaction`, `delete_budget`, `delete_card_transaction`, `delete_category`, `delete_credit_card`, `delete_dashboard`, `delete_sub_category`, `delete_tag`, `import_account_statement`, `import_card_statement`, `pay_bill`, `rename_dashboard`, `revert_bill_payment`, `save_dashboard`, `set_base_currency`, `set_exchange_rate`, `set_exchange_rates`, `set_locale`, `update_account`, `update_account_transaction`, `update_budget`, `update_card_transaction`, `update_credit_card` |

**Whose data a tool sees (ADR-033 §5).** Every tool, resource and prompt acts as the authenticated user: it reads only that user's own rows plus the shared defaults, and writes only that user's rows. Another user's id or name is reported exactly as one that does not exist (`unknown_*`, or `{ deleted: false }` for the idempotent deletes) — never "forbidden" — and the candidate lists in not-found/ambiguous errors name only your own rows and the defaults. The **shared defaults** — the seeded categories, the bundled dashboards — are the same for everyone and **read-only**: `delete_category`, `delete_sub_category`'s targets, `delete_dashboard` and `rename_dashboard` on one answer a `validation` error with one message. Names and idempotency keys are unique **per user**, so two users may each have an account called "Checking", and the same statement imports for each of them. `set_exchange_rate(s)` writes shared market data.

Error codes added by token authentication (HTTP only, not tool results): `invalid_token` (`401`), `insufficient_scope`
(`403`, carries the `scope` needed). Inside a tool call a scope failure (defence in depth) comes back as a tool error
`{ "error": { "code": "insufficient_scope", "scope": "fintrack:write" } }`.

## Transaction write basics

These rules are shared by every transaction-creating tool below (`add_card_purchase`, `add_account_expense`, `add_account_income`, `import_card_statement`, `import_account_statement`) and are stated once here rather than repeated per tool.

**`status` field**: `effective` means the transaction has cleared; it counts toward balances and summaries. `pending` means it is expected but not yet cleared — excluded from balances and summaries until `confirm_transaction` is called. **Default is date-aware**: when omitted, future-dated transactions default to `pending` and past/present transactions default to `effective`. An explicit `status` always overrides the default. Status is never auto-flipped by the passage of the date — call `confirm_transaction` explicitly.

**Kind validation**: `expense` transactions must use a category/sub-category with `kind: expense` or `both`; `income` transactions must use `kind: income` or `both`. Violation returns `category_kind_mismatch`.

**Idempotency**: every write tool derives its own dedup key from the write's full identity (funding source, type, currency, date, description, amount) — no caller ever supplies a whole key. A repeat call with identical input is a no-op, returning the existing transaction with `created: false`. Every write tool accepts an optional `discriminator` for recording a genuinely-distinct transaction that would otherwise be identical (e.g. two identical purchases the same day) — not a dedup key itself, just a value folded into the derivation.

## import_card_statement / import_account_statement

ADR-017 step 2: statement paste / import (1–200 items), split into single-source, aggregate-specific tools — no per-line ownership routing. Each item is classified and idempotent — its dedup key is derived the same way a single add's is, from that item's own resolved account/card, date, description, and amount, so re-importing the same statement is a no-op. Each item may set an optional `status` (`effective|pending`; omit for date-aware default), an optional `note` (free-form memo, max 1000 chars), and an optional `discriminator` (same escape hatch as a single add). Item schemas are `.strict()`: a field that doesn't belong to that aggregate (e.g. `account` on a card-statement item, `billMonth`/`billYear` on an account-statement item) is rejected as an unrecognized key before the tool handler runs, refusing the whole call rather than silently dropping it or failing just that one item.

Returns `summary` counts plus per-item `status`: `created`, `needs_review` (no category or confidence < 0.6 — confirm with the user), `duplicate`, or `error` (with the structured AppError). Each transaction includes `typeLabel` and `statusLabel`.

**`import_card_statement`**: `card` (required — every item is a purchase on this ONE card, joining each item's own cycle bill via `add_card_purchase`'s policy), `items` (each mirrors `add_card_purchase`'s input minus `card`/`rawInput`/`subCategory`/`tags`), `rawInput` (the original pasted statement text). REST mirror: `POST /api/credit-cards/statement`.

**`import_account_statement`**: `account` (optional — every item is an expense or income on this ONE account; omit to record unattached, e.g. cash, movements), `items` (each mirrors `add_account_expense`/`add_account_income`'s input minus `rawInput`/`subCategory`/`tags`, plus a required `type` (`expense|income`) since a statement mixes both and the movement kind isn't fixed by which tool was called), `rawInput`. Each item's `type` picks `add_account_expense` or `add_account_income`. REST mirror: `POST /api/accounts/statement`.

## add_card_purchase

Record a credit-card purchase, joining the cycle bill (fatura) — the credit-card aggregate's purchase entry point (ADR-016). Owned by the credit-card aggregate: it resolves the card, computes the bill period, and rejects landing on a `paid` bill before writing anything.

Input: `description`, `amount` (positive), `type` (`expense|income`), optional `date`, `card` (name — **required**; the card's own internal liability account is always the destination, so there is no `account` field here), `billMonth` + `billYear` (optional — explicit target bill cycle; both required together, see below), `category` OR `subCategory` (not both — `subCategory` implies its parent category), `currency` (accepted for schema symmetry with `add_account_expense`/`add_account_income`, but has no effect — a card's currency is fixed at creation and always wins), `discriminator` (optional — see Transaction write basics above), `rawInput` (original user phrasing), `note` (free-form memo/observação, max 1000 chars), `tags`, `status` (see Transaction write basics above).

Returns `TransactionView` with `typeLabel`, `statusLabel`, and `billId` (the bill this transaction currently belongs to).

**Bill assignment** (Design 012): omit `billMonth`/`billYear` for the default cycle-based auto-assignment (from `date` + the card's `closingDay`/`dueDay`). Provide both together to target a specific cycle instead — the bill is auto-created (`open`) if that cycle has none yet; providing only one of the two is a `validation` error. Whether auto-assigned or explicit, a request that would land the transaction on an already-`paid` bill is rejected with a `validation` error pointing at `revert_bill_payment` — a `paid` bill's transaction membership is frozen (see `update_card_transaction`/`delete_card_transaction` below). `import_card_statement` applies this same policy to every item (see above).

REST mirror: `POST /api/credit-cards/purchases`.

Errors: resolution errors (`unknown_card`, `unknown_category`, …), `category_kind_mismatch`, `validation` (unpaired `billMonth`/`billYear`, landing on a `paid` bill).

## add_account_expense / add_account_income

Record an expense or income from a bank account / wallet — the account aggregate's movement entry points (ADR-016). Two intent-specific tools instead of one tool with a `type` field, mirroring the natural-language intents ("I spent…" vs. "I got paid…").

Input: `description`, `amount` (positive), optional `date`, `account` (name — omitting it records an unattached, e.g. cash, movement), `category` OR `subCategory` (not both), `currency` (resolved from the account when linked, else this field, else USD), `discriminator` (optional — see Transaction write basics above), `rawInput`, `note`, `tags`, `status` (see Transaction write basics above). There is no `card`, `type`, or `billMonth`/`billYear` field: the movement kind is the tool itself, and bill assignment is card-only vocabulary that doesn't apply to an account movement — `import_account_statement` dispatches each item here, keyed on the item's own `type` field, since a statement mixes both expense and income lines.

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

`create_recurring`: `description`, `amount`, `type`, `period` (`weekly|monthly|yearly`), `startDate` (first due), optional `account`, `category`, `currency`, `merchant` (Feature Design 017). Recurring transactions are classified as `user` with confidence 1. `merchant` names the merchant the rule pays (e.g. `"Netflix"`, a landlord) and is stored normalized, as given; when omitted, the merchant is resolved the same way a transaction's is — an already-learned `merchant_category` match takes priority (reusing that key rather than fragmenting it), falling back to the normalized `description` only when nothing matches. A rule created before this field existed has no merchant until re-saved (there is no `update_recurring` today).

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

**Wrong-tool redirect**: calling a card tool on an account-owned transaction, or an account tool on a card-owned transaction, is rejected with a `validation` error whose `hint` names the correct tool (`use update_account_transaction`) — a guard, not a dispatcher; nothing re-routes the call for you.

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

Filter by `month`+`year` **or** `from`/`to` — not both (combining them is a `validation` error). `from` is inclusive, `to` is **exclusive** (`[from, to)`): a month is `month`+`year`, or `from` = its 1st and `to` = the 1st of the next month — never its last day. Also `type` (`expense|income|transfer`), `status` (`pending|effective`), `category`/`subCategory`/`account` (names), free-text `text` (description substring), `tags`. Each `TransactionView` includes `typeLabel`, `statusLabel`, and `note` (when set). With an `account` filter this is the full extrato: the account matches as source OR destination, so transfers in both directions are included. Results include `subCategoryId`/`subCategoryName` when set.

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

REST mirror: `GET /api/transactions` (same query fields; `month`/`year`/`cursor`/`sort`/`dir`/`limit` are query
strings, `includeTotal` is `"true"`/`"false"`).

**Errors:** resolution errors (`unknown_account`, `unknown_category`, …), `validation` (malformed/stale
cursor, a cursor whose `sort`/`dir` doesn't match the request's, or `month`/`year` combined with `from`/`to`).

## aggregate_spending

Flexible spending aggregation: group transactions by a chosen dimension, measured by a chosen metric. Results are per-currency blocks with totals and percentages. Only effective, non-transfer transactions are counted (consistent with `get_spending_summary` and balances). Category labels are locale-resolved via `localizeCategoryName`.

**Input:**
- `groupBy` (required): `category | account | tag | month | merchant`
- `metric` (default `sum`): `sum | count | avg`
- Period: `month` + `year` **or** `from`/`to` (`YYYY-MM-DD`; `from` inclusive, `to` **exclusive** — a month ends at the 1st of the next month, not its last day)
- Filters (all optional): `account` (name), `category` (name), `type` (`expense | income`), `tags` (names)
- `limit` (default 50, max 100): top-N rows per currency
- `sort` (default `desc`): `asc | desc` by metric value
- `displayCurrency` (optional, Feature Design 021 Phase 4): also return a converted grand total of the
  per-currency block totals in this currency. Only attached when `metric` is `sum` — a block total is then a
  genuine money quantity to convert and cross-sum; `count` (a transaction count) and `avg` (a sum of per-group
  averages) are not coherent cross-currency amounts, so `displayCurrency` is a no-op for them (omitted, no
  error). Omitting `displayCurrency` entirely leaves the response byte-identical to before this option existed.

**Output:**
```jsonc
{ "groupBy": "category", "metric": "sum",
  "currencies": [
    { "currency": "BRL", "total": 1850.0,
      "rows": [
        { "key": "cat-food", "label": "Alimentação", "value": 1200.0, "count": 18, "pct": 64.9 },
        { "key": "cat-transport", "label": "Transporte", "value": 650.0, "count": 9, "pct": 35.1 }
      ] } ],
  // present only when displayCurrency was supplied and metric is sum
  "converted": { "displayCurrency": "USD", "total": 370.0, "stale": false, "asOf": "2026-08-10T10:00:00Z",
    "excluded": [] } }
```

**Errors:** `unknown_account`, `ambiguous_account`, `unknown_category`, `ambiguous_category`, `validation` (missing period, or unknown `displayCurrency`).

**Safety (ADR-011):** dynamic query structure comes only from whitelisted enum-keyed SQL fragments; all filter values are parameter-bound; caller text never reaches SQL.

REST mirror: `GET /api/aggregate?groupBy=category&month=6&year=2026`.

## find_correlations

Feature Design 016: one tool over spending-pattern analyses, discriminated by `analysis` (a whitelisted enum,
mirroring `aggregate_spending`'s `groupBy`). All four phases are done — `spending_shifts`, `budget_fit`,
`merchant_concentration`, and `recurring_candidates`. Read-only: no entity, no write flow.

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

**Errors:** `validation` (missing `month`/`year` — required for this mode, unlike `recurring_candidates`).

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

**Errors:** `validation` (missing `month`/`year`).

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

**Errors:** `unknown_category`, `ambiguous_category` (invalid `category` filter), `validation` (missing
`month`/`year`).

### recurring_candidates

Merchants with a regular ~monthly cadence that are not yet set up as a recurring rule — each one a
ready-to-confirm `create_recurring` shape (Feature Design 016 phase B). Unlike the three modes above, this one
has **no reference period at all**: it scans a rolling window ending today, not a specific month.

**Input:**
- `analysis: "recurring_candidates"` (required)
- `lookbackMonths` (default `6`): months of transaction history to scan, ending today
- `minOccurrences` (default `3`): minimum qualifying transactions within the lookback to flag a candidate

**Computation:** per `(merchant, currency)`, the effective, expense-only transaction series within the lookback
window is checked for a consistent ~monthly cadence (every consecutive gap within 5 days of 30 — covers every
calendar month length without also accepting a weekly or quarterly pattern) and a stable amount (every
occurrence within 10% of the series average) — both fixed tolerances, not caller params. A merchant with fewer
than `minOccurrences` qualifying transactions, an irregular gap, or amount drift beyond tolerance is not a
candidate. **Excludes any merchant that already backs a recurring rule** — an exact `merchant_key` match against
`recurring_rules.merchant_key` (Feature Design 017); a rule created before that migration (`merchant_key: null`)
doesn't match and so can still surface here until it's re-saved. `category` is the merchant's most recent
occurrence's category (a merchant's category is stable in practice).

**Output:**
```jsonc
{ "analysis": "recurring_candidates",
  "candidates": [
    { "merchant": "netflix", "typicalAmount": 39.9, "currency": "BRL", "category": "Assinaturas",
      "occurrences": 4, "lastDate": "2026-07-05", "suggestedNextDue": "2026-08-05" }
  ] }
```
Sorted by `occurrences` descending, then merchant name. Pass `merchant`/`typicalAmount`/`currency`/`category`/
`suggestedNextDue` straight through as `create_recurring`'s `merchant`/`amount`/`currency`/`category`/`startDate`.

No REST mirror yet (MCP-only).

### displayCurrency (opt-in, Feature Design 021 phase 3, ADR-028 controller-orchestrated)

A `CurrencyCode` accepted alongside any `analysis`, adding a top-level `converted` block —
`{ displayCurrency, total, stale, asOf, excluded }` — a read-time grand total converted against `currency_rates`
via the same `logic/currency-rate.ts`'s `consolidateInCurrency` `get_spending_summary`/`get_budget_status` use. A
currency with no rate to `displayCurrency` is listed in `excluded` (`{ currency, reason: "no_rate" }`) and left
out of `total`, never fabricated; `stale` is true if any contributing rate is stale (fiat 24h / crypto 1h);
`asOf` is the oldest contributing rate's timestamp, or `null` when nothing converted. Omitting `displayCurrency`
leaves every mode's response byte-identical to before this option existed. Invalid `displayCurrency` is rejected
at the schema boundary (no REST mirror, so no HTTP status — the MCP tool call itself fails validation).

Applies per mode, only where that mode reports per-currency money:
- `spending_shifts`: converts the reference month's effective, expense-only spend total per currency — summed
  across **every** `(category, currency)` row, regardless of `minDeltaPct` filtering (a display filter must not
  shrink the total).
- `budget_fit`: converts **committed** (effective + pending) spend matched to a budget, per currency — the same
  measure `get_budget_status`'s `converted` uses (computed once per currency from a fresh spend read for the
  reference period, not by summing `budgeted[].current`, and not the mode's own `spendByCategoryWindowed`
  current/baseline pair), so the two surfaces agree.
- `merchant_concentration`: converts each currency's `categoryTotal` — the per-currency total the concentration
  is computed over, summed once per currency, not each merchant line (avoids double-counting).
- `recurring_candidates`: **unaffected** — its candidates are proposed rules, not per-currency spend totals, so
  `displayCurrency` is a no-op (no `converted` block, even when supplied).

Per-currency/per-line results are unaffected either way, in every mode.

## get_spending_summary

Input: `month`, `year`. Returns per-currency blocks: `income`, `expenses`, `balance`, `byCategory` (sorted by total desc). Currencies are never mixed or converted.

**Optional `displayCurrency` (Feature Design 021, ADR-028 controller-orchestrated):** a `CurrencyCode` that adds a top-level `converted` block — `{ displayCurrency, total, stale, asOf, excluded }` — a read-time grand total of `expenses` across every currency's line, converted against `currency_rates` (the same conversion `get_account_balances` uses, generalized by `logic/currency-rate.ts`'s `consolidateInCurrency`). `total` sums every convertible currency's `expenses`; a currency with no rate to `displayCurrency` is listed in `excluded` (`{ currency, reason: "no_rate" }`) and left out of `total`, never fabricated. A currency with zero `expenses` this period (e.g. income-only) is skipped before conversion entirely — it never costs an `excluded` entry for a missing rate, and a stale rate on file for it never flips the total `stale`. `stale` is true if any contributing (non-zero) rate is stale (fiat 24h / crypto 1h); `asOf` is the oldest contributing rate's timestamp (the total is only as fresh as its stalest input), or `null` when nothing converted. Omitting `displayCurrency` leaves the response byte-identical to before this option existed — `currencies[]` is unaffected either way. Invalid `displayCurrency` is rejected at the schema boundary (422 over REST).

REST mirror: `GET /api/summary?month=6&year=2026&displayCurrency=USD`.

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

Returns `{ balances, consolidatedNetWorth }`. Each `balances[]` entry is a current balance per account, **derived** (never stored): `initialBalance + income − expenses + transfers in − transfers out`. Returns `typeLabel` (localized account type). **Only `effective` transactions count** — pending transactions are never included in the balance. Returns the parts alongside the balance. Optional filters: `account` (name), `type`.

Optional `projectedAsOf` (`YYYY-MM-DD`): when provided, also returns `projectedBalance` = effective balance + all pending transactions dated on/before that date. This is a provisioning view (what you will stand at that date assuming all pending clear). The effective `balance` is always present; `projectedBalance` is only present when `projectedAsOf` is supplied.

**Valuation (ADR-026 Phase 3, controller-orchestrated per ADR-028):** each balance also carries an optional `converted` block — `{ baseCurrency, value, rate, asOf, stale }`, a read-time conversion of `balance` into the effective base currency (`get_preferences`'s `baseCurrency` — explicit `set_base_currency` override, else locale-derived). A balance already in the base currency converts at identity (`rate: 1`, never stale); a balance whose currency has no stored rate to the base (`set_exchange_rate`) omits `converted` entirely — never a fabricated value. `stale` follows the same per-class window `list_exchange_rates` documents (fiat 24h / crypto 1h). The top-level `consolidatedNetWorth` is `{ baseCurrency, total, excluded }`: `total` sums every returned balance's `converted.value`; `excluded` lists the ids of balances with no `converted` block (left out of `total`, not dropped from `balances`).

Note: `create_account` accepts `initialBalance` (default 0).

## create_transfer

Move value between accounts (`from`, `to` names, `amount`, optional `date`, `description`, `discriminator` — see Transaction write basics above). Creates a **transaction with `type: 'transfer'`** carrying both FROM and TO accounts (ADR-002): debits one balance, credits the other, excluded from spending summaries, and appears in both accounts' statements via `search_transactions` (which is also how you list transfers — `type: 'transfer'`). The returned transaction includes `typeLabel` and `statusLabel`. Both accounts must share a currency; cross-currency returns a `validation` error (FX pending). **Credit accounts are rejected on either leg** — use `pay_bill` to settle card debt (ADR-010). Idempotent.

## create_category / list_categories

`create_category`: `name` (required), `kind` (`expense|income|both`, default expense). Prefer existing categories (`list_categories`) before creating. Error: `duplicate_name`.

`list_categories`: returns all top-level categories with `kindLabel` (localized category kind). **Names are resolved to the active locale** for default (seeded) categories via `names?.[locale] ?? name`; user-created categories always show their literal `name`. Each category includes a `names` map (set for defaults with `{pt, es}`, `null` for user-created).

## create_sub_category / list_sub_categories

`create_sub_category`: `name` (required), `parentId` (required — use `list_categories` to find it). Sub-categories inherit their parent's `kind`; the same kind validation applies to transactions. Names must be unique within the same parent. Error: `duplicate_name`, `unknown_category`.

`list_sub_categories`: optional `parentId` filter. Returns `{ id, name, parentId, parentName, kind, kindLabel }`.

**Name resolution**: `subCategory` is resolved by name across all parents. If two sub-categories under different parents share the same name (e.g., "Outros" under Alimentação and Transporte), resolution returns `ambiguous_sub_category` — retry with a more specific name or use `list_sub_categories` to disambiguate.

TransactionView includes `subCategoryId` and `subCategoryName` when a sub-category is linked.

## delete_category / delete_sub_category

`delete_category`: `name` (required). Deletes a category by name. **Block-if-in-use**: if any transactions, recurring rules, or sub-categories reference it, returns `in_use` error with reference counts — nothing is deleted. On success, also removes the category's learned `merchant_category` rules (re-learnable; not a blocker). **The seeded (default) categories are shared by every user and read-only** — deleting one answers a `validation` error ("Default categories and dashboards are shared by every user and can't be changed or deleted…"), checked before the reference counts. A category you created is yours alone.

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
`list_budgets`/`get_budget_status` (including the latter's grouping key) locale-resolve `category`/
`subCategory` via `localizeCategoryName`, same as `aggregate_spending`/`find_correlations`. So does
`create_budget`/`update_budget` for a top-level-category target; for a sub-category target, the reported
parent category name is still the raw, unlocalized one (tracked in #169).

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
- `get_budget_status`: `month` (1–12), `year` — spend-vs-limit for every budget in that month, on two measures
  (Feature Design 020, revises Feature Design 015 phase 2's effective-only measurement): `effective` (cleared
  spend, `status = 'effective'`) and `committed` (effective + pending, `status IN ('effective', 'pending')`) —
  the earmark-aware view of what's already spoken for against the cap. Both are `expense`-typed (never
  `income` or `transfer` — a `both`-kind category is budgetable, so income booked to one is excluded rather than
  inflating the cap), same-currency. Returns `{ period: { month, year }, categories: [{ category, lines: [{ id,
  subCategory?, currency, limit, period, effective: { amount, pct }, committed: { amount, pct },
  pending: { amount, pct }, remaining }] }] }` — grouped by top-level category name, so a category's own budget
  and each of its sub-categories' own budgets read as one coherent unit; per-currency lines are never combined
  (no cross-currency total on the lines themselves — that needs FX, the deferred PLAN open question). `pending`
  (committed.amount − effective.amount) is derived for convenience; `remaining` (limit − committed.amount) is
  the single top-level headroom figure, reported against `committed`; each measure's `pct` is `amount / limit`.
  Any of these can go negative / exceed 1 when over budget — over-budget is reported, never an error. A month
  with no matching transactions reports `amount: 0` for every measure of every budget.

**Optional `displayCurrency` (Feature Design 021 phase 2, ADR-028 controller-orchestrated):** a `CurrencyCode`
that adds a top-level `converted` block — `{ displayCurrency, total, stale, asOf, excluded }` — a read-time
grand total of **committed** (effective + pending) spend across every budgeted category's currency, converted
against `currency_rates` via the same `logic/currency-rate.ts`'s `consolidateInCurrency` `get_spending_summary`
uses. `total` sums each currency's budgeted committed spend once — computed directly from the underlying
per-currency spend matched by at least one budget, not by summing per-line `committed.amount`, so a spend row
counted toward both a sub-category budget and its rolled-up parent budget (the envelope behavior) contributes
to the total only once, never twice. A currency with no rate to `displayCurrency` is listed in `excluded`
(`{ currency, reason: "no_rate" }`) and left out of `total`, never fabricated; `stale` is true if any
contributing rate is stale (fiat 24h / crypto 1h); `asOf` is the oldest contributing rate's timestamp, or
`null` when nothing converted. Omitting `displayCurrency` leaves the response byte-identical to before this
option existed — `categories[]` is unaffected either way. Invalid `displayCurrency` is rejected at the schema
boundary (422 over REST).

REST mirror: `GET /api/budgets` (`list_budgets`), `GET /api/budgets/status?month&year&displayCurrency=USD`
(`get_budget_status`). `create_budget`/`update_budget`/`delete_budget` have no REST mirror yet (MCP-only).

## save_dashboard / list_dashboards / delete_dashboard / rename_dashboard

LLM-generated local dashboards over the HTTP API (ADR-013), rendered as **content fragments** in a shared app
shell (ADR-027 Phase 1). A dashboard is a fragment — `<section>`s + one inline `<script>`, no
`<!doctype>`/`<html>`/`<head>`/`<style>` — stored by name; the shell at `GET /ui`/`GET /ui/:name`
(`ui/shell.html` + `ui/app.css` + `ui/app.js`) provides the document root, shared styling, menu, and Chart.js,
and injects the fragment into `#content` client-side. Every dashboard carries a `source: 'inline' | 'file'`
(ADR-027 Phase 2): `file` — a bundled default read from a git-versioned `.html` file under `ui/dashboards/`
(currently just `overview`, the Phase B baseline data-less template — fetch-on-load, no inline data),
read-only at the install location; `inline` — DB-stored, `save_dashboard`'s only output shape. The menu
(`GET /ui`) groups `file` dashboards as top-level items and `inline` ones under a "Custom" submenu, straight
off `list_dashboards`. `skills/dashboard-building/SKILL.md` is the guardrail checklist an agent follows to
build or adapt a dashboard without violating the no-inline-data rule — read the contract
(`fintrack://openapi`), map sections to real endpoints, and self-check against the hard rules before calling
`save_dashboard`.

- `save_dashboard`: `name`, `html` (required — a content fragment, despite the field name). **Upsert** — saving to an existing name replaces it immediately, no rebuild/restart. **Always stores `source: 'inline'`** (ADR-027 Phase 2 non-negotiable) — saving under a bundled default's name never touches the default (it is shared and read-only): it creates **your own** inline dashboard of that name, which replaces the default for you alone; a custom dashboard can never become file-backed. **CRITICAL**: the fragment must never embed financial data, secrets, or tokens — render layout/styling only and `fetch()` data client-side from `/api` on load (read the `fintrack://openapi` resource for the contract), so the dashboard is always live and safe to share. Returns the stored `{ name, html, updatedAt, source }`.
  - **Rejected (`validation`, 422) if the content can't possibly render as a fragment**: empty content, a full `<!doctype>`/`<html>` document root still present (the shell owns that now), an external `<script src>` reference (fragments carry zero external references — the shell already loads Chart.js once), or an inline `<script>` with a JS syntax error (checked by compiling it, never executing it). This is a cheap render-ability check, not sanitization or a full HTML validator — full sanitization is out of scope for this local single-user app (ADR-013 Phase A). A rejected save leaves the previously stored dashboard untouched.
- `list_dashboards`: no input — returns all dashboards as `{ name, updatedAt, source }` (HTML omitted).
- `delete_dashboard`: `name` (required). **Idempotent** — an already-absent name is not an error, returns `{ deleted: false }` (same shape as `delete_tag`). Present → deletes it and returns `{ deleted: true }`; `GET /api/dashboards/:name` 404s afterward (`GET /ui/:name` itself still serves the shell either way — see below). Deleting a name that is a bundled (`file`) default and not your own copy answers the shared-default `validation` error instead; deleting your own copy of it brings the default back for you.
- `rename_dashboard`: `name`, `newName` (both required). Preserves content, identity and `source` — only the name changes. A bundled default cannot be renamed (the shared-default `validation` error). Errors: `unknown_dashboard` if `name` doesn't exist, `duplicate_name` if `newName` is already taken (nothing is renamed either way). On success, `GET /api/dashboards/:newName` serves it immediately; `GET /api/dashboards/:name` (the old name) 404s.

REST mirror: `GET /api/dashboards` (list, HTML omitted), `GET /api/dashboards/:name` (JSON, `unknown_dashboard` if absent), `POST /api/dashboards` (upsert, same validation and 422 as above), `DELETE /api/dashboards/:name` (idempotent, always `200 { deleted }`), `POST /api/dashboards/:name/rename` (body `{ newName }`; `404`/`409` for the same errors as above). The browser-facing surface is `GET /ui` and `GET /ui/:name` — both **always** serve the shared app shell (`text/html; charset=utf-8`, no-cache), regardless of whether `:name` exists; the shell resolves `:name` client-side and fetches `GET /api/dashboards/:name` to render it (a missing dashboard becomes a client-side not-found state, not a 404 on `/ui/:name` itself). `GET /ui/assets/app.css`/`GET /ui/assets/app.js` serve the shell's own static files. None of `/ui*` is part of the `/api` JSON contract or appears in the OpenAPI document. The Phase B baseline dashboard (`overview`) ships as `ui/dashboards/overview.html` and is reconciled into a `source: 'file'` row on every boot; `save_dashboard` detaches it into a custom, inline dashboard.

## set_locale / get_preferences

`set_locale`: `locale` (`en|es|pt`), `source` (`inferred|explicit`). Sets the display language for default category names. The AI agent calls this with `source: "inferred"` when it detects the user's language from conversation, or `source: "explicit"` when the user directly requests a locale change. **Guardrails**: (1) Anti-churn — only switch on a clear, sustained language change, not isolated foreign words, merchant names, or proper nouns. (2) Respect explicit — if the current `locale_source` is `"explicit"`, an `inferred` switch is rejected with a `validation` error; the user must explicitly request the change. Error: `validation`.

`get_preferences`: no input. Returns `{ locale, localeSource, baseCurrency }` — the **stored** locale preference, not the effective display locale, plus the **resolved** base currency (explicit override if set, else derived from locale). Use to check whether the user set the locale explicitly before attempting an inferred switch. Note: when `FINTRACK_LOCALE` is set, `list_categories` uses the env value for display names, which may differ from the stored `locale` returned here.

**Resolution order** (for display names): `FINTRACK_LOCALE` env var → the caller's own `user_settings.locale` → `'en'` (cold-start default). Preferences are per user: one user's `set_locale` or `set_base_currency` never changes another's.

## set_base_currency

ADR-026 Phase 2. `baseCurrency` (required, `CurrencyCode`). Sets an explicit override for the default valuation target currency, stored on the caller's own `user_settings` row. Unset (`null`), it's derived from locale (pt→BRL, en/es→USD — `logic/locale.ts`'s `resolveBaseCurrency`, the same resolution shape as locale itself: explicit stored value wins, else derived). No consumer reads this yet (account valuation is Phase 3) — this only sets the value `get_preferences.baseCurrency` reports. Returns `{ baseCurrency }`. Idempotent: setting the same value again is a no-op (no write, same response).

REST mirror: `GET /api/preferences` (`get_preferences`), `POST /api/settings/base-currency` (`set_base_currency`).

## set_exchange_rate / set_exchange_rates / list_exchange_rates

ADR-026 Phase 2. A cached, agent-refreshed rate table (`currency_rates`) — **FinTrack never fetches rates itself** (local-first, zero external calls, ADR-004/005). The agent (or a scheduled task) sources current rates (e.g. PTAX for fiat, a crypto price API) and upserts them here; nothing in the backend reaches the network. Rates are self-contained and carry their own `asOf`, so freshness is always visible to whoever reads them. **This is not a history log** — a pair (`from`, `to`) has at most one stored rate; a later `set_exchange_rate` for the same pair **overwrites** it (upsert-latest), never appends. These tools populate/inspect the cache; `get_account_balances` is the read surface that converts against it (ADR-026 Phase 3, see below).

- `set_exchange_rate`: `from`, `to` (`CurrencyCode`, required, must differ — `validation` if equal), `rate` (positive number — 1 unit of `from` = `rate` units of `to`), `asOf` (ISO 8601 timestamp, required), `source` (optional free-text provenance, e.g. `"PTAX"`, `"coingecko"`). Returns the stored view `{ from, to, rate, asOf, source? }`. Error: `validation` (`from === to`).
- `set_exchange_rates`: `rates` (array of the same shape as `set_exchange_rate`'s input, 1–50 items). Bulk upsert with **partial success** — each item is applied independently (its own transaction/retry), so one bad pair never blocks the others. Returns `{ items: [{ status: "ok", rate: {...} } | { status: "error", from, to, error }] }`, one entry per input item in order.
- `list_exchange_rates`: no input. Returns every stored rate as `{ from, to, rate, asOf, source? }[]`. Staleness is not evaluated here — this is the raw cache; `get_account_balances` applies the per-class staleness window (fiat 24h / crypto 1h, both configurable via `FIAT_RATE_STALE_HOURS`/`CRYPTO_RATE_STALE_HOURS`) when it converts against it.

REST mirror: `GET /api/exchange-rates` (`list_exchange_rates`), `POST /api/exchange-rates` (`set_exchange_rate`), `POST /api/exchange-rates/bulk` (`set_exchange_rates`). MCP resource: `fintrack://exchange-rates` mirrors `list_exchange_rates`.

## get_status

No input. Returns `{ name: "fintrack", version, db, locale, demo }`:

- `name` — always `"fintrack"`.
- `version` — the package version from `package.json` (same value as the `serverInfo.version` reported in the MCP `initialize` handshake). In dev: `0.0.0-development`; in published releases: the semantic-release version.
- `db` — `"ok"` if the database is reachable, `"error"` otherwise.
- `locale` — the effective active locale (`en`, `es`, or `pt`).
- `demo` — `true` when the database is marked a demo (`settings.instance_kind = demo`): sample data, not the person's finances. A demo database also sends MCP server `instructions` at `initialize` saying so (say it once, never use it for real finances, use the `fintrack` server for those), in the demo's language (`en`/`pt`/`es`, its owner's `user_settings.locale`); a standard database sends none.

A convenience for tool-only callers (AI agent / chat user). The MCP protocol already exposes version via the `initialize` handshake `serverInfo` and liveness via `ping` — this tool complements those for callers that can only invoke tools.

REST mirror: `GET /api/status` returns the same payload (and, over HTTP with auth `required`, needs a session). `GET /api/health` is the one public probe: liveness plus the database check (`{ status: "ok", db: "ok" | "error" }`).

## Resources

Unlike tools (invoked with arguments), resources are read by URI — no input schema, no side effects.

### `fintrack://openapi`

Returns the same OpenAPI 3.0 document served at `GET /api/openapi.json` (`application/json`, `text` content). Generated from the `wire/in`/`wire/out`/`models` zod schemas that back the REST routes (ADR-013 Phase A) — read this before generating `fetch()` calls against `/api` so the shapes can't be guessed wrong. This is the app's first MCP resource; read via `resources/read` with `uri: "fintrack://openapi"` (discoverable via `resources/list`).

### Reference resources (Feature Design 018)

Static-URI, read-only resources exposing the user's vocabulary — categories, accounts, tags, credit cards, and most-transacted merchants — so an agent resolving natural-language input ("R$32 uber ontem") can read them directly instead of round-tripping a `list_*` tool call every turn. Each mirrors its `list_*` tool exactly (same controller, same data — resource and tool can never disagree). `application/json`, one `contents` entry per resource.

- **`fintrack://categories`** — same array as `list_categories`: top-level categories with locale-resolved display names, `kind` (expense/income/both), and `id`.
- **`fintrack://accounts`** — same array as `list_accounts`: `name`, `type`, `currency`.
- **`fintrack://tags`** — same array as `list_tags`.
- **`fintrack://credit-cards`** — same array as `list_credit_cards`.
- **`fintrack://merchants/top`** — the 20 (`DEFAULT_TOP_MERCHANTS_LIMIT`, `models/merchant.ts`) merchants with the most effective, non-transfer transactions, each `{ merchant, transactionCount, categoryName }` ordered by `transactionCount` descending. `categoryName` is the category the merchant is most often classified into (by transaction frequency, not spend), locale-resolved; `null` when every one of the merchant's transactions is uncategorized. A reference/vocabulary list, not a spend report — no per-currency amounts, no caller-supplied limit (static URI, no `ResourceTemplate` parameters).
- **`fintrack://currencies`** (ADR-026 Phase 1) — same array as `GET /api/currencies`: `{ code, symbol, name, decimals }` for every currency (fiat BRL/USD/MXN/COP, crypto USDC/BTC). No matching `list_*` tool — currencies are a seeded reference table with no write path, so this resource is the read surface. `decimals` is what lets a client format a non-ISO code correctly: `Intl.NumberFormat`'s `style: 'currency'` mode either throws (a malformed code) or silently mis-formats (a well-formed-but-unrecognized 3-letter code like `BTC` — 2 decimals, no real symbol) for USDC/BTC, so format with `symbol` + `decimals` instead for any code not in `Intl.supportedValuesOf('currency')`.
- **`fintrack://exchange-rates`** (ADR-026 Phase 2) — same array as `list_exchange_rates`: `{ from, to, rate, asOf, source? }` for every cached rate. Unlike `fintrack://currencies`, this **does** have a write path (`set_exchange_rate(s)`) — read it to see which pairs are cached and how stale they are before deciding whether to refresh.

## Prompts (Feature Design 019)

Guided-workflow templates (`prompts/list`, `prompts/get`) — orchestration text, not data. Each prompt returns one `{ role: "user", content: { type: "text", text } }` message instructing the model which tools to call and how to synthesize the result; the prompt itself never touches the database. Per MCP protocol, `arguments` are always strings — pass an empty object (`arguments: {}`) even when omitting every field, since a prompt with an `argsSchema` requires the `arguments` key to be present.

- **`monthly_review({ month?, year? })`** — default: the current calendar month/year (an omitted field is defaulted independently, so passing just one still anchors the other to today). Instructs the model to call `get_spending_summary`, `find_correlations` (`spending_shifts`, then `budget_fit`, then `recurring_candidates`), and `get_budget_status` for that period, then write a prose review: per-currency income/expenses/balance, the 2-3 biggest category shifts vs baseline and a plausible driver, budgets that are over or slack, and any recurring-payment candidates worth turning into a rule via `create_recurring`.
- **`budget_checkup({ month?, year? })`** — same period defaulting as `monthly_review`. Instructs the model to call `get_budget_status` and `find_correlations(budget_fit)`, report which budgets are on track/over/generous with each `suggestedLimit`, flag unbudgeted categories with an established spend pattern, and offer to apply a suggestion — the model calls `update_budget`/`create_budget` on the user's say-so.
- **`import_statement({ source? })`** — `source`: `"card"` or `"account"`, optional. Instructs the model to ask the user to paste the statement text, use `import_card_statement` or `import_account_statement` (asking card-vs-account first if `source` is omitted), then report created/duplicate/needs_review/error counts and walk each `needs_review` item with the user for confirmation.

- **`tour()`** (Feature Design 022 §6) — takes no arguments (the client need not send an `arguments` object). Unlike the three above it reads the database, once: the instance marker, the demo's language (the owner's `user_settings.locale`) and its country (`settings.demo_country`, recorded by the seeder; a demo seeded before it was recorded is resolved from the base currency its seed set, then the language's default country). On a **demo** it returns a six-step guided tour in the demo's language — balances (`get_account_balances`), last month by category (`get_spending_summary`), budgets (`get_budget_status`), a short sample statement for the country dated in the days before today, imported into the checking account with `import_account_statement` (showing classification and `needs_review`), tagging the seeded trip to that country's destination as travel and building a travel dashboard (`search_transactions`, `create_tag`, `save_dashboard`), and how to install for real and remove the demo entry (`setup <client> --remove-demo`). On a **standard** database it runs nothing: the text says the tour is for the demo and how to start it (`demo`, then `setup <client> --demo`).

All three of the first prompts are per-currency-aware by construction — the generated text always instructs the model to report figures per currency and never sum across currencies.
