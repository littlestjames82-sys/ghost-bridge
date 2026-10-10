---
name: ghost-bridge
description: >
  Use when working in a Ghost Developer Studio workspace, when Ryan mentions
  Mr.Ghosty or Muse, when a task needs Ryan's memory/accounts/phone/deploys,
  or when checking on work handed off through the Ghost Bridge queue.
---

# Ghost Bridge skill

Mr.Ghosty is Ryan Cotten's personal agent in Muse. He holds the memory,
files, connected accounts, and approval history for Ghost Developer Studio.
The Ghost Bridge MCP server in this workspace is the connection.

## Tools

- Context: `ghost_whoami`, `ghost_projects`, `ghost_project_status`,
  `ghost_rules`, `ghost_search` — always check status before project work;
  context is served live from the bridge queue repo, so it is current.
- Health: `ghost_bridge_status` — first stop when anything seems off.
- Tasks out: `ghost_handoff` (title, task, project, optional
  priority "urgent"). Pickup ~15 min, urgent ~5 min.
- Tasks back: `ghost_inbox` (recent + status), `ghost_task_result` (full
  thread incl. Mr.Ghosty's result), `ghost_new_results` (only what's new
  since this client's last check — call at session start).
- Act on tasks: `ghost_reply` (answer a question or approve a
  needs-approval hold; clears the hold), `ghost_cancel_task`,
  `ghost_search_tasks` (search the whole task history).

## Flows

- **Delegate:** decide local vs Muse-side → `ghost_handoff` → give Ryan
  the queue number → follow via `ghost_task_result`.
- **Approval hold:** task labeled needs-approval → read Mr.Ghosty's comment
  with `ghost_task_result` → ask Ryan → `ghost_reply` with his exact answer.
- **Catch up:** session start → `ghost_new_results` → brief Ryan in one
  line per task.

## Constraints

- Never include credentials or secrets in tasks or replies.
- Ryan's rules always apply (no paid spend without approval, draft-first
  public posts, no invented facts, DevPulse backend parked, verify before
  "done"). `ghost_rules` is the full list.
- If the relay is down, say so plainly (status tool gives the likely fix) —
  local-file handoffs are the fallback, and Ryan can pass them to Muse
  manually.
