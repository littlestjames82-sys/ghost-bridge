---
description: Send a task to Mr.Ghosty (Muse) via the Ghost Bridge queue
---

# /handoff — send a task to Mr.Ghosty

1. Confirm with Ryan what needs doing and why it needs Muse-side access
   (memory, accounts, phone, deploys) — if it can be done locally, do it here.
2. Identify the project slug if any (check `ghost_projects`).
3. Call `ghost_handoff` with a precise title, a self-contained task body
   (goal, context, what done looks like), the project slug, and
   `priority: "urgent"` only if Ryan said so.
4. Report the queue number to Ryan and how to follow it
   (`ghost_task_result`), and that pickup is ~15 min (~5 if urgent).
