# The PATTY demo

A throwaway PATTY with four months of sample data, so you can see the dashboards and talk to an AI about them in
a few minutes, without touching your real finances (Feature Design 022).

```bash
npx @rfc0/patty@latest demo [--country br|us|mx|co] [--reset]
```

It seeds `~/.patty/demo.db`, then serves the dashboards, REST and MCP on `http://127.0.0.1:51738` with **no login**
until you stop it. The real install is never read or written: it keeps its own database, key, port (`51737`) and
sign-in.

## What it contains

Generated relative to today through the product's own write flows: checking, savings, investment and wallet accounts,
two credit cards with paid, closed and open bills, a monthly salary, rent and subscriptions as recurring rules,
groceries, transport, restaurants, health and leisure with merchant variety, transfers, pending future items, budgets
(some over, some under), a small USDC and BTC position with exchange rates — and one trip, left **untagged** on purpose.

| `--country` | Language | Currency | The trip |
|---|---|---|---|
| `br` | pt | BRL | Florianópolis |
| `us` | en | USD | Denver |
| `mx` | es | MXN | Oaxaca |
| `co` | es | COP | Cartagena |

Without `--country`, your OS locale picks one (`es-CO` → `co`, `pt` → `br`, `es` → `mx`, otherwise `us`). Every page
carries a "Demo" banner and a `[Demo]` title, and the MCP server tells the AI it is a demo — do not enter real data.

## Take the tour

Add the demo to your AI client next to your real PATTY:

```bash
npx @rfc0/patty@latest setup <client> --demo
```

That adds a second MCP server, `patty-demo`, and never touches the `patty` entry. Then run its **`tour`** prompt
(Claude users can also ask for the `patty-tour` skill). It takes no arguments: it reads the demo's country and
language from the database and walks through six steps, in that language:

1. "What are my balances?" — accounts, cards, the converted total.
2. "Where did my money go last month?" — spending by category.
3. "Am I over budget?" — budget status, counting what is pending.
4. "Import this statement" — a short sample statement for the country; shows classification and `needs_review`.
5. "Tag everything from my trip as travel, then build me a travel dashboard" — the AI finds the untagged trip by dates
   and descriptions, tags it and builds a dashboard.
6. "Ready for your own data?" — how to install for real and remove the demo.

On a real database the prompt runs nothing: it only says the tour is for the demo and how to start it.

## Two servers in one client

`patty` and `patty-demo` are separate servers with separate databases, ports and keys, so your AI client sees
two sets of the same tools. The demo server's instructions tell the AI to say it is sample data and never to record
real money there; for your own finances use `patty`. The demo entry is opt-in — plain `setup` never writes it.

## Reset and remove

- **Reset the data:** stop the demo server, then `npx @rfc0/patty@latest demo --reset`. It deletes only a
  database that says it is a demo, and refuses anything else untouched.
- **Remove the AI client entry:** `npx @rfc0/patty@latest setup <client> --remove-demo` removes only
  `patty-demo`.
