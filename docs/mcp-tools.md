# FinTrack MCP tools

Contract for the MCP server at `POST /mcp` (streamable HTTP, stateless). All tools share these conventions:

- **Natural inputs**: `account` and `category` take names (case/accent-insensitive, partial match allowed). Resolution failures return structured errors the agent can self-correct from.
- **Errors**: `{ "error": { "code": "...", ... } }` with `isError: true`. Codes: `unknown_account`, `ambiguous_account`, `unknown_category`, `ambiguous_category`, `unknown_transaction`, `duplicate_name`, `validation`. Ambiguous/unknown errors include `candidates` (names) to retry with.
- **Currency**: BRL or USD; from the account when one is linked, else the `currency` field, else BRL. Summaries group per currency, never converting.
- **Dates**: `YYYY-MM-DD`.

## create_transaction

Create an expense/income. Omitting `category` triggers auto-classification via the merchant graph; the result reports `classification.method` (`rule|graph|user|none`) and `confidence` (confirm with the user below 0.6). Idempotent: same `idempotencyKey` returns the existing transaction with `created: false`.

Input: `description`, `amount` (positive), `type` (`expense|income`), `idempotencyKey` (required; stable key like `<date>-<desc>-<amount>`), optional `date`, `account`, `category`, `currency`, `rawInput` (original user phrasing).

Example: `{"description": "Uber para o aeroporto", "amount": 32.5, "type": "expense", "account": "nubank", "idempotencyKey": "2026-06-09-uber-32.50"}` → transaction classified as Transporte (`rule`, 0.8).

## update_transaction

Patch fields by `id`. Only provided fields change. Setting `category` is a **user correction**: confidence becomes 1 and the merchant→category `[:USUALLY]` edge is strengthened (the system learns). Changing `account` also updates `currency` to match.

Input: `id` (required), optional `description`, `amount`, `type`, `date`, `account`, `category`.
Errors: `unknown_transaction`, resolution errors.

## delete_transaction

Two-step destructive action. Without `confirm: true` it is a **dry run**: returns `{ deleted: false, dryRun: true, wouldDelete: {...} }` — show it to the user and ask before calling again with `confirm: true`.

Input: `id` (required), `confirm` (default false).

## search_transactions

Filter by `month`+`year` (or `from`/`to`), `type`, `category`/`account` (names), free-text `text` (description substring), `limit` (default 50, max 200). Returns newest first.

## get_spending_summary

Input: `month`, `year`. Returns per-currency blocks: `income`, `expenses`, `balance`, `byCategory` (sorted by total desc). Currencies are never mixed or converted.

## create_account / list_accounts

`create_account`: `name` (required), `type` (`checking|savings|wallet|investment`, default checking), `currency` (default BRL). Error: `duplicate_name`.

## create_category / list_categories

`create_category`: `name` (required), `kind` (`expense|income|both`, default expense). Prefer existing categories (`list_categories`) before creating. Error: `duplicate_name`.
