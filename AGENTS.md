# AGENTS.md

Instructions for coding agents working on this repository.

## Read this first

This project keeps its memory in [`memory/`](memory/):

1. [`memory/STATE.md`](memory/STATE.md) — current architecture, entry points
   and the invariants that are easy to break.
2. [`memory/CHANGELOG.md`](memory/CHANGELOG.md) — what changed most recently
   (newest first) and why.
3. [`memory/decisions/`](memory/decisions/) — design decisions with their
   reasoning, so you do not re-litigate them or undo them by accident.

## Update this when you change something

Any change to the code **must** be recorded:

- Append a dated entry to `memory/CHANGELOG.md` (newest first) with the
  format described in [`memory/README.md`](memory/README.md).
- Update `memory/STATE.md` when the change touches the architecture, an
  invariant, a user-facing flow or a setting.
- Add or revise a file in `memory/decisions/` when a design choice is made or
  reversed.

## House rules

- `npm run typecheck` and `npm test` must both be green before you finish.
- TypeScript is `strict` with `noUncheckedIndexedAccess` — array access needs
  a guard or a non-null assertion.
- This **is** a git repository (`github.com/zalramadhan/0xgarou-rh-lpbot`,
  private): commit the change, but keep the changelog as the readable history.
  `.env`, `data/` and `*.log` are never committed.
- Never put secrets, keys or `.env` contents into `memory/`.
- Keep behaviour changes opt-in and backwards compatible: existing users'
  settings and open positions must not change meaning.
