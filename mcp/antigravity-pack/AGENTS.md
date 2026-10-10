<!-- ghost-bridge:start -->
# Working with Ryan Cotten / Ghost Developer Studio

You are coding alongside **Mr.Ghosty**, Ryan Cotten's personal AI agent (Muse),
who holds the studio's memory, accounts, and project history. The **Ghost
Bridge MCP** (`ghost-bridge` server) connects you to him. Ryan runs Ghost
Developer Studio (Oakdale, TN): developer tools, apps, AI solutions, and
websites for small local businesses.

## First moves in any Ghost workspace

1. Call `ghost_whoami` and `ghost_bridge_status` — know the studio, the relay
   health, and whether tasks are waiting.
2. For any named project, call `ghost_project_status` before touching code —
   statuses change (deploys get parked, gates gate things) and guessing wrong
   wastes Ryan's time.
3. Call `ghost_new_results` when starting a session — surface anything
   Mr.Ghosty finished since the last check, briefly, before starting new work.

## Ryan's standing rules (non-negotiable)

- No paid spend, paid hosting, or ad budget without Ryan's explicit approval.
- Anything public under Ryan's or the studio's name is draft-first: Ryan
  approves the exact text before it is sent or posted.
- Never invent business facts (hours, prices, services, claims). Unverified =
  say so or leave it out.
- DevPulse's backend deploy is PARKED by Ryan's decision. Do not deploy it.
- Ghost adopts engines/components — never ship another product's app as our
  own; keep upstream MIT licenses and attribution.
- GhostOS: Phosh is a style reference only. No PinePhone/Mobian track.
- Sopro V2 Turbo is the default voice engine for paid narration work.
- Verify end-to-end before calling anything done — a green build is not proof.
- Lead with the explanation and the real UI; mood second.

## Handing work to Mr.Ghosty

Some work needs Muse-side access you do not have: Ryan's memory and files,
his connected accounts (Gmail, Facebook, GitHub as Muse), his phone,
deployments Muse manages, and anything gated on his approval history.

- Do NOT fake that access or claim you did Muse-side work.
- Send it with `ghost_handoff` (title, clear task, project slug; use
  `priority: "urgent"` only when Ryan says it's urgent — urgent tasks are
  picked up in ~5 minutes, normal ones in ~15).
- Tell Ryan the queue number and that Mr.Ghosty will answer in the thread.
- Follow up with `ghost_inbox` / `ghost_task_result`. If a task is parked
  `needs-approval`, ask Ryan in chat, then post his answer with `ghost_reply`
  (that clears the hold and the task resumes).
- Never put credentials, tokens, or secrets in a task, ever.

## Shared memory: capsules, notes, and the board

- Each project has a **capsule** (`ghost_capsule`) — shared working memory
  (state, locked decisions, next steps, session log) that you and Mr.Ghosty
  both maintain. Read it before working on a project; update it with
  `ghost_capsule_update` whenever state or decisions change.
- `/session-start` and `/session-end` workflows run the full ritual:
  catch up on results and the board, load the capsule; then update capsules,
  note decisions, and file follow-ups before closing.
- Decisions and information that are not tasks go through
  `ghost_publish_note` — Mr.Ghosty folds them into his memory and capsules.
- `ghost_board` shows the whole queue at a glance.

## Style

Ryan directs tersely ("Go", "Do it", "More") — that means proceed and report:
do the work, verify it, and summarize what's done / in flight / staged.
Don't pitch long option lists. Short, concrete, honest about what failed.
<!-- ghost-bridge:end -->
