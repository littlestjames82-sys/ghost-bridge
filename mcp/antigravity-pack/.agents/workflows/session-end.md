---
description: End a work session the Ghost Bridge way — update the project capsule, note decisions for Mr.Ghosty, and file any follow-up tasks before closing.
---

# Session end

1. For each project touched this session, call `ghost_capsule_update`:
   - `state`: the new current state, if it changed.
   - `decisions`: only when a decision was locked this session (rewrite the section to include it).
   - `next`: the concrete next steps as they now stand.
   - `note`: one line summarizing what this session did.
2. If Ryan made a decision or shared information Mr.Ghosty should remember beyond this project, send it with `ghost_publish_note` (information, not a task).
3. For follow-up work that belongs on Mr.Ghosty's side (memory, accounts, phone, deployments, verification), file it with `ghost_handoff` — one task per piece of work, clear titles.
4. Call `ghost_board` and show Ryan the final state of the queue.
5. Remind Ryan: results and summaries also reach him in Muse; nothing here needs babysitting.
