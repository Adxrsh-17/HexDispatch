---
description: Implement one HexDispatch phase (usage /phase N)
argument-hint: <phase number 0-9>
---

You are implementing **Phase $ARGUMENTS** of HexDispatch.

1. Read `CLAUDE.md` (fixed decisions, coding rules, definition of done, working agreement) and `docs/phases/PHASE-$ARGUMENTS.md`. Skim `docs/PROJECT_PLAN.md` for the sections the phase touches.
2. Check that every earlier phase is complete (README checklist). If not, stop and say which one is missing.
3. Plan briefly: list the files and modules you will add or change and the order. No long essay.
4. Implement ONLY this phase. Respect its "Out of scope" list. Do not start the next phase.
5. Write tests as you go (unit, plus at least one Testcontainers integration test per touched service). Add metrics and traces with the code, not after.
6. Run `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test`. Fix failures.
7. For each acceptance criterion in the phase file, run the test or script that demonstrates it. If a criterion cannot be demonstrated (for example Docker is unavailable), say so plainly.
8. Write an ADR for each non-obvious decision. Update docs and tick the phase in `README.md` only if all criteria are demonstrated.
9. Commit in small, clear commits.

Final report, in this order:

- A table: acceptance criterion | evidence (test name or command) | pass/fail.
- Assumptions made.
- Anything incomplete or unverified.
- Measured numbers only if you measured them; include the command and seed.
