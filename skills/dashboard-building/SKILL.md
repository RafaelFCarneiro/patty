---
name: dashboard-building
description: Use when the user asks to build, change, extend, or "show me" a dashboard/UI for their PATTY finances. Guides generating a data-less HTML fragment that fetches live data from the PATTY API and saving it with save_dashboard.
---

<!-- patty:skill-pointer -->

# Building a PATTY dashboard

The guide lives in PATTY itself, so it is always the version that matches the server you are talking to.

1. Call the `get_dashboard_guide` tool of the `patty` MCP server.
2. Follow what it returns: read the API contract with `get_api_contract`, then build the fragment and save it with
   `save_dashboard`.

Do not build a dashboard from memory: the guide holds the hard rules (a dashboard never contains data, it fetches it).
