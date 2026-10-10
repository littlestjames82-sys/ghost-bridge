---
description: Start a work session the Ghost Bridge way — catch up on results, read the board, and load the active project's capsule before doing anything.
---

# Session start

1. Call `ghost_bridge_status` — confirm the relay is healthy and note anything waiting on Ryan.
2. Call `ghost_new_results` — surface anything Mr.Ghosty finished, asked, or parked since the last session. Summarize it for Ryan in two or three lines.
3. Call `ghost_board` — show Ryan the queue at a glance (queued / working / waiting on him).
4. Ask Ryan which project this session is about (or infer it from the workspace). Call `ghost_capsule` for it and `ghost_project_status`. Work from the capsule — it holds the current state, locked decisions, and next steps agreed with Mr.Ghosty.
5. Follow the rules in the capsule and `ghost_rules`. If the session's work needs Muse-side access (memory, accounts, deployments), send it with `ghost_handoff` instead of improvising.
