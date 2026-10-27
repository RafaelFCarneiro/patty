---
name: fintrack-tour
description: Use when the user wants a tour or walkthrough of the FinTrack demo, asks "show me what FinTrack can do", or is trying the demo (the `fintrack-demo` MCP server). Runs the six-step tour on the demo's sample data; on a real FinTrack it only explains how to start the demo.
---

# Touring the FinTrack demo

The same tour is available as the `tour` MCP prompt on the `fintrack-demo` server (Feature Design 022 §6); this
skill is for Claude clients that prefer skills. Do the steps in order, one at a time: run the tools, say what you
found in a few sentences, and wait for the person before the next step. Answer in the demo's language, and group
every figure by currency — never sum across currencies.

## First, check it is the demo

Call `get_status`. If it does not report `demo: true`, **stop**: this server holds real data and the tour would
write sample rows into it. Tell the person to start the demo with
`npx @rafaelfcarneiro/fintrack@latest demo` and add it to their client with
`npx @rafaelfcarneiro/fintrack@latest setup <client> --demo`, then use the `fintrack-demo` server.

## The six steps

1. **"What are my balances?"** — `get_account_balances`: accounts, cards, and the total converted to the base currency.
2. **"Where did my money go last month?"** — `get_spending_summary` for last month, by category.
3. **"Am I over budget?"** — `get_budget_status` for the current month, counting what is still pending.
4. **"Import this statement."** — paste a few recent lines (a known merchant or two, one income and one nobody can
   classify), import them into the checking account with `import_account_statement`, and walk through what was
   classified and the line flagged `needs_review`. The `tour` prompt carries a ready sample per country.
5. **"Tag everything from my trip as travel, then build me a travel dashboard."** — the demo has one trip, seeded
   untagged across several categories and accounts over about six days. Find it with `search_transactions` by dates
   and descriptions (its destination: Florianópolis, Denver, Oaxaca or Cartagena, by country), create the tag with
   `create_tag`, tag the purchases, then build the dashboard (see the `dashboard-building` skill) and save it with
   `save_dashboard`.
6. **"Ready for your own data?"** — explain how to install FinTrack for real, that the demo is sample data, and how
   to remove the demo from the client: `npx @rafaelfcarneiro/fintrack@latest setup <client> --remove-demo`.
