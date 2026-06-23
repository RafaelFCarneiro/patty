# FinTrack MCP tools

Contract for the MCP server at `POST /mcp` (streamable HTTP, stateless). All tools share these conventions:

- **Natural inputs**: `account`, `card`, `category`, and `subCategory` take names (case/accent-insensitive, partial match allowed). Resolution failures return structured errors the agent can self-correct from.
- **Errors**: `{ "error": { "code": "...", ... } }` with `isError: true`. Codes: `unknown_account`, `ambiguous_account`, `unknown_category`, `ambiguous_category`, `unknown_sub_category`, `ambiguous_sub_category`, `unknown_card`, `ambiguous_card`, `unknown_transaction`, `unknown_bill`, `duplicate_name`, `in_use`, `category_kind_mismatch`, `validation`. Ambiguous/unknown errors include `candidates` (names) to retry with.
- **Currency**: BRL or USD; from the account/card when one is linked, else the `currency` field, else BRL. Summaries group per currency, never converting.
- **Dates**: `YYYY-MM-DD`.
- **Localized labels**: read views include `*Label` fields — localized display labels for fixed enum values, resolved at read time via the active locale (Design 006). The enum value itself (`type`, `status`, `kind`, `period`) is stable identity; the `*Label` is derived display only. Switching locale reflows all labels with no migration. See per-tool details below.

## create_transaction

Create an expense/income. Omitting `category`/`subCategory` triggers auto-classification via the `merchant_category` table (learned merchant→category weights); the result reports `classification.method` (`rule|history|user|none`) and `confidence` (confirm with the user below 0.6). Idempotent: same `idempotencyKey` returns the existing transaction with `created: false`.

Input: `description`, `amount` (positive), `type` (`expense|income`), `idempotencyKey` (required; stable key like `<date>-<desc>-<amount>`), optional `date`, `account` OR `card` (not both — card transactions join the cycle's bill), `category` OR `subCategory` (not both — `subCategory` implies its parent category), `currency`, `rawInput` (original user phrasing), `tags`, `status` (`effective|pending`; omit for date-aware default — see below).

Returns `TransactionView` with `typeLabel` and `statusLabel` — localized display labels for the transaction's type and status.

**`status` field**: `effective` means the transaction has cleared; it counts toward balances and summaries. `pending` means it is expected but not yet cleared — excluded from balances and summaries until `confirm_transaction` is called. **Default is date-aware**: when omitted, future-dated transactions default to `pending` and past/present transactions default to `effective`. An explicit `status` always overrides the default. Status is never auto-flipped by the passage of the date — call `confirm_transaction` explicitly.

**Kind validation**: `expense` transactions must use a category/sub-category with `kind: expense` or `both`; `income` transactions must use `kind: income` or `both`. Violation returns `category_kind_mismatch`.

Example: `{"description": "Almoço restaurante", "amount": 45.0, "type": "expense", "account": "nubank", "subCategory": "Restaurante", "idempotencyKey": "2026-06-14-almoco-45"}` → linked to sub-category Restaurante under Alimentação.

## create_transactions_bulk

Statement paste / import (1–200 items). Each item is classified and idempotent — `idempotencyKey` is derived from `date+description+amount` when absent, so re-importing the same statement is a no-op. Top-level `account`/`card` act as defaults for items without their own. Each item may set an optional `status` (`effective|pending`; omit for date-aware default).

Returns `summary` counts plus per-item `status`: `created`, `needs_review` (no category or confidence < 0.6 — confirm with the user), `duplicate`, or `error` (with the structured AppError). Each transaction includes `typeLabel` and `statusLabel`.

## create_credit_card / list_credit_cards

`create_credit_card`: `name`, `closingDay` (1–28; transactions after it belong to next month's bill), `dueDay` (1–28), `currency` (default BRL), optional `limit`, optional `paymentAccount` (name of the default paying account for bill payment). Auto-creates an internal `credit` account (`Card: <name>`) that tracks outstanding card debt (ADR-010). Card purchases post to this account, driving its balance negative. Error: `duplicate_name`, `validation` (currency mismatch with payment account).

## get_bill

Input: `card` (name), `month`, `year`. Returns the fatura: `bill` (`status: open|closed|paid`, `statusLabel`, `closeDate`, `dueDate`), `cardName`, `total`, and `transactions` (each with `typeLabel`/`statusLabel`). Bills are created automatically (status `open`) when the first card transaction of a cycle arrives. Error: `unknown_bill`.

## pay_bill

Input: `card`, `month`, `year`, optional `account` (paying account name override). Creates a **canonical transfer** (paying account → card internal account) for the full bill total, then marks the bill `paid` (ADR-010). The paying account is resolved as: explicit `account` → card's default `paymentAccount` → `validation` error. Same-currency only. Idempotent: re-calling on a paid bill is a no-op. If total ≤ 0, marks paid with no transfer. Errors: `unknown_bill`, `unknown_card`, `unknown_account`, `validation` (no payer, currency mismatch, credit payer).

## delete_credit_card

Input: `card` (name), `confirm` (default false). Hard delete: removes the card, its internal credit account, all correlated transactions (purchases + bill payments), and all bills. Without `confirm: true`, returns a dry run: `{ deleted: false, dryRun: true, wouldDelete: { card, account, transactions, bills } }`. With `confirm: true`, deletes atomically. Errors: `unknown_card`.

## create_recurring / list_recurring / apply_due_recurring

`create_recurring`: `description`, `amount`, `type`, `period` (`weekly|monthly|yearly`), `startDate` (first due), optional `account`, `category`, `currency`. Recurring transactions are classified as `user` with confidence 1.

`list_recurring`: returns all recurring rules with `periodLabel` (localized period).

`apply_due_recurring` (optional `through: YYYY-MM-DD`, default today): materializes a transaction for every rule due on/before `through`, bounded at 36 occurrences per rule. Each returned transaction includes `typeLabel` and `statusLabel`. Each occurrence is stamped with the date-aware default — past/present land `effective`, future land `pending`. Passing a future `through` pre-creates upcoming salary, rent, and subscriptions as pending, feeding projections without extra monthly effort. Default behaviour (`through` omitted) is unchanged catch-up. Idempotent via `rec-<ruleId>-<dueDate>` — safe to re-run anytime.

## confirm_transaction

Flip a `pending` transaction to `effective`. Once effective, the transaction counts toward balances and spending summaries. If the transaction is already `effective`, this is a no-op (returns the existing transaction unchanged). Returns the transaction with `typeLabel` and `statusLabel`.

Input: `id` (required — use `search_transactions` with `status: "pending"` to find pending transactions).

REST mirror: `POST /api/transactions/:id/confirm`.

Errors: `unknown_transaction`.

## update_transaction

Patch fields by `id`. Only provided fields change. Returns the updated transaction with `typeLabel` and `statusLabel`. Setting `category` is a **user correction**: confidence becomes 1 and the `merchant_category` weight is strengthened (the system learns). Changing `account` also updates `currency` to match.

Input: `id` (required), optional `description`, `amount`, `type`, `date`, `account`, `category`, `subCategory`, `tags`.

**Kind validation on update**: if `category`/`subCategory` is provided without `type`, the existing transaction type is used for kind validation. On mismatch, the error includes a `hint` field with the exact `type` value to pass to resolve it (e.g. `"Category \"Salário\" is income-only; to use it, set type: \"income\""`). Transfer transactions (`type: transfer`) cannot have a `category`/`subCategory` and cannot have their `type` changed — both are rejected with a `validation` error. Note: `type` on this endpoint accepts `expense|income` only; use `create_transfer` to create transfers.

Errors: `unknown_transaction`, resolution errors, `category_kind_mismatch`, `validation`.

## delete_transaction

Two-step destructive action. Without `confirm: true` it is a **dry run**: returns `{ deleted: false, dryRun: true, wouldDelete: {...} }` — show it to the user and ask before calling again with `confirm: true`. The transaction includes `typeLabel` and `statusLabel`.

Input: `id` (required), `confirm` (default false).

## search_transactions

Filter by `month`+`year` (or `from`/`to`), `type` (`expense|income|transfer`), `status` (`pending|effective`), `category`/`subCategory`/`account` (names), free-text `text` (description substring), `tags`, `limit` (default 50, max 200). Returns newest first. Each `TransactionView` includes `typeLabel` and `statusLabel`. With an `account` filter this is the full extrato: the account matches as source OR destination, so transfers in both directions are included. Results include `subCategoryId`/`subCategoryName` when set.

Use `status: "pending"` to list scheduled/expected transactions (e.g. "what is due today" or "what income is expected this month").

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

`create_account`: `name` (required), `type` (`checking|savings|wallet|investment`, default checking — checking = conta corrente), `currency` (default BRL). Error: `duplicate_name`, `validation` (type `credit` is rejected — credit accounts are created automatically via `create_credit_card`).

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

Attach tags at write time via the `tags` array on `create_transaction` / `create_transactions_bulk`.

## set_locale / get_preferences

`set_locale`: `locale` (`en|es|pt`), `source` (`inferred|explicit`). Sets the display language for default category names. The AI agent calls this with `source: "inferred"` when it detects the user's language from conversation, or `source: "explicit"` when the user directly requests a locale change. **Guardrails**: (1) Anti-churn — only switch on a clear, sustained language change, not isolated foreign words, merchant names, or proper nouns. (2) Respect explicit — if the current `locale_source` is `"explicit"`, an `inferred` switch is rejected with a `validation` error; the user must explicitly request the change. Error: `validation`.

`get_preferences`: no input. Returns `{ locale, localeSource }` — the **stored** preference, not the effective display locale. Use to check whether the user set the locale explicitly before attempting an inferred switch. Note: when `FINTRACK_LOCALE` is set, `list_categories` uses the env value for display names, which may differ from the stored `locale` returned here.

**Resolution order** (for display names): `FINTRACK_LOCALE` env var → `settings.locale` → `'en'` (cold-start default).
