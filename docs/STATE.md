# Where Shura stands — 24 October 2026

A handover note. What works, what is proven, what is not, and what to do next.

Companion to `docs/HOW-IT-WORKS.md`, which traces the loop file by file.

---

## In one paragraph

Shura drives the `claude` and `codex` CLIs as subprocesses, authenticated by
your own subscriptions, so a run costs quota rather than money. Three agents —
**planner**, **builder**, **reviewer** — carry one work item from a sentence to
a pull request, with a human approving the plan before anything is written and
a human merging at the end. The reviewer always runs a different vendor's model
from the builder, and that is enforced in code rather than asked for in a
prompt. All of it has now run end to end against a real repository.

**457 tests pass.** Working tree clean as of commit `cb11d41`.

---

## The proof it works

On 18 October, against `sakib142/forge-sandbox`:

| step | what happened |
| --- | --- |
| planner (claude) | wrote criterion [2]: styling must come from design tokens — a rule it took from the `frontend` domain overlay |
| builder (claude) | implemented the empty state, but **hard-coded a pixel value** for the border |
| reviewer (codex) | `CHANGES_REQUESTED` — *"hard-coded pixel value, violating the token-only styling criterion"*, blocker |
| reviewer fix | added `borderWidth: { thin: '1px' }` to `tokens.ts` and used it — fixed the cause, not the symptom |
| pull request | [#1](https://github.com/sakib142/forge-sandbox/pull/1), two commits, `dev-01 (builder)` and `rev-01 (reviewer)` separately attributed |

`$0.5793 of quota, not billed.`

A different vendor's model caught a real defect, against a criterion derived
from a domain rule, and corrected it properly. That is the whole thesis.

---

## Running it

Setup is machine-wide and already done. A new terminal needs nothing but the
directory.

```bash
cd "/Users/mohammad.sakib/Library/CloudStorage/OneDrive-OneWorkplace/Documents/AI Project and Docs/Agent HUB"

pnpm shura doctor      # Postgres, git, both CLIs, warns if an API key is set
pnpm shura smoke       # both CLIs actually answer — proves the cross-vendor pair
```

### The whole flow

```bash
# 1 — plan. --checks is the one thing you must get right per repo.
pnpm shura build --repo <owner>/<repo> \
  --task "what you want, in your own words" \
  --checks "npm ci && npm test" \
  --domain frontend

# 2 — read it, answer its open questions, approve
pnpm shura plans <id>
pnpm shura approve <id> --answer "..." --answer "..."

# 3 — build, review, open a pull request
pnpm shura build --resume <id>
```

`--checks` is persisted on the plan, so it is passed once and the build
inherits it.

### One agent at a time

For debugging. Each stops where the next would take over, and none opens a
pull request.

```bash
pnpm shura try planner  --repo <owner>/<repo> --task "…" --domain frontend
pnpm shura try builder  --plan <id>
pnpm shura try reviewer --repo <owner>/<repo> --branch <b> --criteria-from <id>
```

### In a browser

```bash
pnpm shura serve        # http://localhost:7777
```

Submit work, read the plan, answer its questions, approve, watch it build.
Bound to localhost only, and cross-origin POSTs are refused — it can spend
money and push code, so neither is optional. It has **no field for `--checks`**,
so for a repo that is not the configured one, use the terminal.

### Inspecting

```bash
pnpm shura plans              # what is waiting on you
pnpm shura audit --verify     # every break in the hash chain
```

---

## How it is put together

### Three positions, domains as an overlay

The **position** decides mechanics — grants, sandbox mode, output schema,
whether the agent can write — and is enforced. The **domain** only ever changes
prose.

```
roles      planner · builder · reviewer      packages/roles/definitions/
domains    frontend · backend                packages/roles/domains/
```

Adding `mobile` or `data` is one markdown file, not three role YAMLs.

This replaced nine roles where the split was half-real: `frontend-developer`
and `backend-developer` had **identical grants**, `backend-developer`'s prompt
contained nothing backend-specific, and backend could neither plan nor review.

The test for whether something deserves its own role is **grants, not subject
matter**. `backlog-author` holds `[tracker.read, docs.read, backlog.propose]`
and cannot touch a repository, so it stays separate. Frontend and backend
builders had the same grants, so they merged.

### Still outside that model

`backlog-author`, `backlog-reviewer`, `design-analyst` work on tickets and
designs rather than code. `merge-queue` is `kind: admit` — deterministic code
carrying no model, by rule 3. **None has run on the CLI path.** Parked, not
abandoned.

### The four rules

1. A verifier's vendor differs from its producer's — checked at schedule time
   by `selectVerifier()`, plus a database `CHECK` constraint.
2. A verifier holds no write grant but its own verdict channel.
3. Admission is deterministic code carrying no model.
4. Every verdict records both vendors, both models, tokens and cost.

**Rule 2 is stronger than it was.** A verifier used to hold no write because we
withheld the tool; under `codex exec -s read-only` the kernel refuses the
syscall. Probed against the live CLI: the agent tries, and reports back
`operation not permitted`.

### Why the CLIs

The API path cost **$5.47** for one run on a 170-file repo and produced a
single file before hitting its ceiling. Metered billing lands on top of a
subscription the developer already pays for, and nobody adopts a tool that
charges twice.

Three protections keep it on a subscription: the runtime blanks
`ANTHROPIC_API_KEY` before spawning; it then **refuses to run** if the CLI
reports `apiKeySource` as anything but `none`; and the launcher unsets the keys
too.

Both CLIs still report a dollar figure — what the work *would* have cost on
metered API. `describeSpend` renders it as `of quota, not billed
(subscription)` so it cannot be read as a bill.

---

## What has never run

- **The whole flow on a repository that is not forge-sandbox.** One repo, 12
  files, is not a sample.
- **`--domain backend`.** The overlay was written from scratch and has never
  reached a model.
- **A reviewer sending work back** rather than fixing it. The `return` path and
  the rework loop are untested live.
- **`shura probe`** since being rewired onto `reviewBranch`. It measures catch
  rate against seeded faults and is how you would know whether the reviewer is
  genuinely good or merely agreeable.
- **The non-code agents** — backlog, design.

---

## Known issues

**This directory is inside OneDrive, which resurrects deleted files.** On 24
October, every file deleted in commit `081e7c8` was back on disk as untracked —
the old role YAMLs, the old API runtimes, and `eval/designs/edb-news-section.json`,
the client data deliberately stripped from git history. Two tests failed
because `loadAllRoles()` read twelve roles instead of seven. **Check
`git status` after any gap in work.** `eval/designs/` is now gitignored so it
cannot be committed back by accident, but the rest will return.

**The audit chain carries 21 historical breaks**, all at `id <= 204`, from a
concurrency bug fixed in migration `0010`. Everything recorded since is intact.
An append-only log cannot be rewritten to make a report look clean — that is
the point of it — so `audit --verify` will keep reporting them.

**The reviewer can edit shared files.** Its fix touched `src/tokens.ts`, not
just the component under review. Defensible there — the token was genuinely
missing — but it is a reviewer with write access editing outside the change it
judged. Your pull-request review is the only check on it, which is the trade
accepted deliberately. The pull request names those commits.

**Bash is not a sandbox on the building side.** The guard hook inspects
commands for credential filenames and blocks writes outside the worktree, but a
shell is Turing-complete and an agent set on evading it would. The real
boundaries are the worktree, the push guard, and the read-only sandbox on the
reviewing side.

**`shura/shura-8`** is still on forge-sandbox from a builder-only test, with no
pull request.

---

## Bugs found by running it, not by testing it

Worth recording, because every one survived a green test suite.

| | |
| --- | --- |
| `StructuredOutput` was denied | asked the agent for a schema, then refused it the only tool that delivers one. It recovered **by luck** because the final message carried the JSON too. |
| `Bash` bypassed the guard | a planner holding no `Write` tool still ran `npm install`. The same shell could have read a `.env`. |
| …and that fix was broken | the generated guard split on the letter `s`, because `\s` does not survive a template literal. `cat .env` sailed through; `cat ./.env` blocked by coincidence. |
| macOS `/var` vs `/private/var` | paths compared literally, so the guard **refused legitimate writes to its own worktree**. The builder was denied twice before stumbling onto the matching spelling. |
| the chain forked under load | `bigserial` allocates ids before the trigger's lock, and READ COMMITTED meant a waiter could not see the row it was chaining to. Thirty events forked it where twelve did not. |
| two fixes died with the API path | `strictSchema` (OpenAI requires `required` to name every key) and `nullsAsAbsent` (a vendor says "not supplied" with an explicit null) were solved once, deleted with `openai.ts`, and had to be rediscovered by live failures. |
| `verifyChange` had drifted | `shura probe` would have reported every seeded fault as missed while the reviewer worked fine. |
| `audit --verify` stopped at the first break | one old break hid every later one. |

The pattern: **deleting code deletes knowledge.** Both recovered fixes now sit
at the vendor boundary they belong to, with tests naming the live failure that
found them.

---

## What I would do next

1. **`shura probe`** — the cheapest way to learn whether the reviewer is good
   or just agreeable. It passed 7/7 on a demanding spec, which could be either.
2. **A second repository**, ideally with `--domain backend`, to find what is
   specific to forge-sandbox.
3. **Make the reviewer return rather than fix**, once, to exercise the rework
   loop.
4. **Prompt caching on the codex side** — the claude side has it; codex usage
   showed 30k of 36k tokens served from cache already, so check before
   building.
5. **Decide about the non-code agents** — fold in, or delete. They have never
   run on this path and are currently dead weight in `loadAllRoles()`.
