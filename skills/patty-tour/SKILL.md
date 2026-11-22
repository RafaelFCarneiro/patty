---
name: patty-tour
description: Use when the user wants a tour or walkthrough of the PATTY demo, asks "show me what PATTY can do", or is trying the demo (the `patty-demo` MCP server). Runs the six-step tour on the demo's sample data; on a real PATTY it only explains how to start the demo.
---

<!-- patty:skill-pointer -->

# Touring the PATTY demo

The tour lives in PATTY itself, in the demo's language.

1. Call the `get_workflow` tool of the `patty-demo` MCP server with `{ "name": "tour" }` (use that one server for the
   whole tour, including the dashboard step).
2. Follow the messages it returns, one step at a time, waiting for the person between steps.

On a server that holds real data the tour only says how to start the demo; do not run it there.
