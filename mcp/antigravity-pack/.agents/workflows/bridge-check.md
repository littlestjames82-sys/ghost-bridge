---
description: Check the Ghost Bridge — relay health, new results, open tasks
---

# /bridge-check — Ghost Bridge status sweep

1. Call `ghost_bridge_status` and report relay health + queue counts plainly.
2. Call `ghost_new_results` and summarize anything new from Mr.Ghosty
   (results, approval requests) — one line per task with its number.
3. Call `ghost_inbox` and list anything still waiting, flagging
   `needs-approval` items and what Ryan needs to decide.
4. If something is broken, relay the likely fix from the status output
   instead of guessing.
