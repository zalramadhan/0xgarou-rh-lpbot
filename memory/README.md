# Agent memory

This folder is the project's memory for coding sessions. It answers two
questions for whoever (human or agent) works on this repo next:

1. **What is true right now?** → [`STATE.md`](STATE.md)
2. **What changed, when and why?** → [`CHANGELOG.md`](CHANGELOG.md)

## Files

| File | Purpose | Update when |
| --- | --- | --- |
| `STATE.md` | Current architecture, entry points, invariants, conventions. The "map" of the codebase. | Architecture, invariants or conventions change. |
| `CHANGELOG.md` | Append-only, dated log of every change made to the project. Newest first. | **Every** code change. |
| `decisions/` | One file per notable design decision, with the reasoning and the alternatives that were rejected. | A decision is made that a future session could get wrong or would want to revisit. |

## Session protocol

**Start of a session**

1. Read `memory/STATE.md` — it is the fastest way to orient yourself.
2. Read the top of `memory/CHANGELOG.md` — it shows what changed most recently
   and therefore what is most likely to be half-finished.
3. Read `decisions/` when the task touches a subsystem that has a recorded
   decision (e.g. the Bid Ask ladder, one-sided range rules).

**End of a session (or part-way through a large change)**

1. Append an entry to `memory/CHANGELOG.md`.
2. Update `memory/STATE.md` if the change altered the architecture, an
   invariant, a user-facing flow, or a setting.
3. Add or update a file in `memory/decisions/` if a design choice was made or
   reversed.
4. Make sure `npm run typecheck` and `npm test` pass, and record that in the
   changelog entry.

## Changelog entry format

```markdown
## YYYY-MM-DD — Short title

**Area:** bot flow | core | store | monitor | ui | tests | docs | infra

**What changed**
- Bullet per user-visible or structural change.

**Why**
- The reason the change was needed.

**Files**
- `path/to/file.ts` — what happened in it.

**Verification**
- `npm run typecheck` — pass
- `npm test` — N/N pass
```

Keep entries factual and short. If a change was reverted, say so in a later
entry rather than editing history — the log is append-only so that a future
session can see the sequence of events.

## Rules

- Never store secrets, private keys, tokens or `.env` contents here.
- Prefer writing down *why* something is the way it is; the code already says
  *what* it does.
- If the code and `STATE.md` disagree, the code wins — fix `STATE.md`.
- The memory folder is documentation: it is committed with the code, not
  ignored by `.gitignore`.
