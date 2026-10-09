# docs/prompts

One file per step. Claude Code runs one checkpoint at a time; you review each one before the next. Step 2 has checkpoints A to H.

## Launch a step
1. On `main` with a clean tree (`git status`), and the step file already committed.
2. Run (plan mode, checkpoint A only):
   `claude --permission-mode plan "Run checkpoint A of docs/prompts/step-02.md. Follow its 'How to run' rules and stop after the commit."`
3. Read the plan, approve it, let it finish. It works on branch `step-02`. Checkpoints B and H wait for your approval of their design.

## After each checkpoint
- `git show --stat HEAD`: only the expected files; never `.env` or `.data/`.
- `npm test` and `npm run typecheck`: both green.
- OK: press Shift+Tab back to plan mode and type `Run checkpoint B of docs/prompts/step-02.md.` (Run `/clear` first if the session is long.)
- Not OK: `This fails: <error>. Fix it as a new commit inside the current checkpoint.`

## Finish the step
After checkpoint H and the step's final check pass:
```
git switch main
git merge --no-ff step-02
git branch -d step-02
```
Then `/clear` and bring the short `npm test` output to the chat.
