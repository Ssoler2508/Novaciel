# Cleanup before delivery (no new features)

Checkpoints: A → B → C → D. Each one ends in one commit, except A, which is a read-only report.
Goal: hand over the code as it is today (Steps 0–7c and 9; Step 8 and Step 10 not built) clean, documented and reproducible. **No behavior change.** Every test that passes today must still pass, with no test deleted to make it pass.

---

## How to run (rules for Claude Code)

- Run **only the checkpoint you are asked for**, plan first, and stop after it. A and C present a plan and wait for approval.
- Branch: check that the working tree is clean (except `web/`, which is not yours) and create `chore/cleanup-entrega` from `main`. Never commit to `main`, never merge, never push.
- Commit message format: `chore(cleanup-<letter>): <short summary>`.
- A checkpoint is done only when `npm run typecheck`, `npm test` (full suite, sequential, laptop plugged in and awake) and `npm run test:fast` pass.
- **Do not touch `web/`**, the clone at `D:\Dev\novacielOP\Novaciel`, its `.env` or its databases. Do not change route paths, methods or response shapes. Never read `.env`.
- Do not change migrations that already exist (they are applied in databases). Do not change `docs/HASH_PIEZA_NP1.md` or its vectors.

---

## Checkpoint A — Inventory (read-only report, wait for approval)

Produce a report in the plan, changing nothing. For each item, say what you found, where, and what you propose:

1. **Dead code:** unused files, exports, functions and types (e.g. `npx ts-prune` or `npx knip` run once with `npx`, not installed); code only referenced by tests; leftovers from removed features (`aprobarPlanInterno`, `plan:approve-internal`, `createPlannerProvider`…).
2. **Dependencies:** unused or misplaced (`dependencies` vs `devDependencies`), and anything not pinned that should be; `npm audit` summary.
3. **TEMPORARY / TODO / FIXME / VERIFY markers:** list them all, grouped: (a) intentional and documented (e.g. the Step 8 bridge in approvals, house values marked VERIFY), which stay; (b) stale ones to remove or turn into documented debt.
4. **Consistency:** naming (Spanish domain names, English code), error classes, log messages without client text, duplicated helpers that could share one implementation **without changing behavior**.
5. **Scripts:** every `npm run` script in `package.json` works or is removed; dev-only scripts have the dev guard.
6. **Configuration:** every variable read in `src/config` is in `.env.example` with a one-line explanation, and nothing in `.env.example` is unused. No real values anywhere.
7. **Secrets and data in the repository:** search the working tree and the full git history (`git log -p`, `git grep` over all commits) for keys, tokens, passwords, `.env` files, real client data, certificates; check `.gitignore` covers `.env*`, `.data/`, `node_modules/`, `dist/`, caches. Report findings only by file and commit, never print a secret.
8. **Files that should not be there:** scratch scripts, large binaries, generated files, test leftovers.
9. **Line endings:** add `* text=auto eol=lf` to the existing `.gitattributes` (keeping the fixture rules) and list which files would be renormalized.
10. **Documentation state:** README (does it let a new developer set up the project on Windows without Docker?), `docs/PLAN.md` step status, ADR list, known debt scattered across files, open questions.
11. **Third-party notices:** licenses that require attribution or have conditions: Inter (OFL), Remotion (its own license and the free-plan conditions in ADR-06), sharp/libvips (LGPL), React, FFmpeg (system tool, not bundled), Chrome Headless Shell (downloaded at setup).

End the plan with the list of changes proposed for B and C. Wait for approval.

---

## Checkpoint B — Code cleanup (no behavior change)

Apply only the code changes approved in A:
- remove dead code, stale markers and unused dependencies;
- fix misplaced dependencies;
- unify duplicated helpers only where the tests prove identical behavior;
- line endings: the `.gitattributes` change and `git add --renormalize .` in **its own commit** (`chore(cleanup-B): normalize line endings`), so the diff of the real cleanup stays readable.

Report the test count before and after (it must not drop, except for tests of removed dead code, each one listed with the reason).

---

## Checkpoint C — Delivery documentation (wait for approval)

Present the outline, then write:
1. **README.md**: what the system does (one paragraph); requirements (Windows, Node version, PostgreSQL 18, FFmpeg/ffprobe with `zscale`/`tonemap`, the Remotion browser download); setup step by step (databases, `.env` from `.env.example`, migrations, seed, create admin, `npm run remotion:browser`); how to run (`npm run dev`), test (`npm test`, `npm run test:fast`, the skip flags) and the dev scripts in the order of the weekly flow (plan → approve → briefs → produce → approve → publicable check).
2. **docs/ENTREGA.md** (delivery notes for NovaCiel and the Senior):
   - what is built, step by step, with what is real and what is a fake/adapter (LLM fake by default, vision fake, notifier fake, storage local, no publishing);
   - the non-negotiable rules and where each is enforced (approval of the exact file, verified facts, `cliente_id`, adapters, budget authorization, encrypted credentials, fictional test data);
   - what is **not** built: Step 8 (QC; the TEMPORARY bridge in approvals), Step 10 (publishing; must call `assertPublicable` with the piece locked and reschedule reminders), Step 11 (dashboard and real alerts), 7d (voice);
   - the consolidated known debt (one list, from all ADRs and prompts);
   - the open questions for NovaCiel (one list, including: the two new transitions to `con_cambios`, the substitute's 2 h, the plan deadline, Remotion contractor question, `ambos` language, house values marked VERIFY, the system Anthropic key and budget, voice and publishing providers, production PostgreSQL/OS/S3);
   - the pending security action: **the old `ANTHROPIC_API_KEY` that was exposed early in the project must be rotated and removed from `.env`** (the developer does this by hand; never in code).
3. **docs/ADR index** (list with one line each) and `docs/PLAN.md` step status updated (Steps 0–7c and 9 done; 7d blocked; 8, 10, 11, 12 pending).
4. **THIRD_PARTY_NOTICES.md** with the licenses from A.11.

---

## Checkpoint D — Final verification

1. From a clean state: `npm ci`, `npm run typecheck`, `npm run build` (if it exists), `npm test`, `npm run test:fast`; report counts and times.
2. Migrations on the test database: down to the first and up again, cleanly (never on `novaciel_db` without saying so first).
3. `npm run seed` twice on `novaciel_db` (`Created: 0` the second time).
4. The secret scan from A.7 again on the final branch.
5. Print the summary for the developer: commits of the branch, files changed per checkpoint, and the exact merge commands (the developer merges):
   ```
   git switch main
   git merge --no-ff chore/cleanup-entrega
   git branch -d chore/cleanup-entrega
   npm test
   git push origin main
   ```
   Stop.