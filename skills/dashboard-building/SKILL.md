---
name: dashboard-building
description: Use when the user asks to build, change, extend, or "show me" a dashboard/UI for their PATTY finances. Guides generating a data-less HTML fragment that fetches live data from the PATTY API and saving it with save_dashboard.
---

<!-- patty:skill-pointer -->

# Building a PATTY dashboard

The guide lives in PATTY itself, so it is always the version that matches the server you are talking to.

1. Pick the PATTY MCP server the dashboard is for: `patty`, or `patty-demo` when you are in the demo tour. Use that one
   server for every call below, so the guide, the contract and the save all come from the same instance.
2. Call its `get_dashboard_guide` tool.
3. Follow what it returns: read the API contract with its `get_api_contract`, then build the fragment and save it with
   its `save_dashboard`.

Do not build a dashboard from memory: the guide holds the hard rules (a dashboard never contains data, it fetches it).
