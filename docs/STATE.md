# Where Shura stands — 5 November 2026

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

**522 tests pass.** Working tree clean as of commit `e23e9d5`, on branch
`phase-1-no-dead-passes`. See *What changed, 31 October to 5 November* below —
the sections above it describe the platform as it was on 24 October and are
still accurate about the loop, the rules and the CLI pivot.

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
matter**. Frontend and backend builders had the same grants, so they merged.

### What was removed, on 31 October

Four roles shipped that had never run against a repository — `backlog-author`,
`backlog-reviewer`, `design-analyst` and `merge-queue` — along with the flows
built to drive them: the `design` command, `design-to-backlog.ts`, the Figma
port and connector, `shura submit`, and the `target-ui` fixture.
`design-to-backlog.ts` had no tests at all.

They were parked for weeks and the parking had a cost: untested code in the
tree reads as capability, and every one of them had to be explained to anybody
reading the role list. A foundation has to be small enough to be strong.

`merge-queue` going needs one note. It was the only `admit` actor, so rule 3
has no shipped role to point at any more — but the property is unchanged and
still enforced where it counts: `parseRole` rejects an admit role carrying a
model, and the database refuses the row (`admit_actors_carry_no_model`). The
merge commit's git identity in `shura run` is a hardcoded
`agentIdentity('merge-queue', 'admit', 'deterministic')` in the connectors, not
a role lookup, so that path still works.

Kept deliberately, because tests cover them: `shura run`, the `MergeQueue` port
with both implementations, `admit` in the vocabulary, and `shura probe` — which
`LocalVcs` exists for.

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

## What changed, 31 October to 5 November

Eleven commits on `phase-1-no-dead-passes`, none pushed as of this writing. Each
one exists because a live run exposed something; the commit messages name the
run. In order:

**The whole flow completed cleanly, twice.** `forge-sandbox` PR #2 (reviewer
fixed its own finding) and PR #3 — one builder pass, PASS on the first review,
`awaiting_admission`. Before this week every run ended in an escalation or a
wasted pass.

**Pruned to three positions.** `backlog-author`, `backlog-reviewer`,
`design-analyst` and `merge-queue` are gone, with the `design` command,
`design-to-backlog.ts` (which had no tests at all), the Figma port and
connector, `shura submit`, and the `target-ui` fixture — 1,221 lines. `shura
run`, the `MergeQueue` port and `admit` stay: they are covered by tests in four
files, and `shura probe` needs `LocalVcs`. Rule 3 now has no shipped role to
point at; it is still enforced by `parseRole` and by the database constraint.

**No pass is bought that cannot produce anything.** The builder is pre-flighted
rather than checked afterwards; findings carry `kind: code | evidence |
decision` and are routed to whoever can act on them; and `passKey` refuses to
ask the same producer the same question twice. Measured: a resume whose branch
already carried the work spent **zero** builder passes, against one pass and
~8 minutes before.

**`shura build --here` works with no token at all.** `CheckoutVcs` drives the
developer's own checkout — verified with `GITHUB_TOKEN` emptied — and leaves the
working tree, index and current branch byte-identical. Pull requests go through
a `HostCli` adapter (`gh` today).

**The repository says how it verifies itself.** A plan now carries a `survey`:
the install command, and per check the command, **what a pass proves**, whether
it is **green on the base**, and whether it is **usable as a gate** at all.
`--checks` is a fallback rather than a prerequisite. Proven on a C# repository
the platform knows nothing about: it found `dotnet build ShamalAI.Api.sln`
unaided, measured it, and reported that `dotnet test` there "exits 0 having
discovered and run zero tests. Vacuous green — must not be cited as evidence".

**Dependencies are installed before an agent is handed the worktree**, and the
base is measured once per plan (`plans.baseline`). Together these remove the
reason criterion [19] was unanswerable: a verify task cannot install tools, and
nothing captured a before-state. The reviewer is now handed both.

### What every live run taught that the tests could not

Six bugs this week were found by running it and none by the suite: a false
"predates" warning, two contradictory gate messages, a gate that would have
strung a backgrounded server into a `&&` chain, a vacuously-green check treated
as a gate, a task row that recorded a pass which never ran, and a baseline that
typechecked its way through to an agent that never received it (object spreads
bypass excess-property checking — the link that matters is in `prompt.ts`).

## What has never run

- **`--domain backend`.** The overlay was written from scratch and has never
  reached a model.
- **A reviewer sending work back** rather than fixing it. Now less likely still:
  the prompt prefers `fix`, and the platform overrides a `return` whose findings
  no edit could settle.
- **`shura probe`** since being rewired onto `reviewBranch`.
- **A build on a repository that is not forge-sandbox.** Plans have been made
  against courtshare and a C# API; only forge-sandbox has been built end to end.
- ~~The non-code agents~~ — removed on 31 October rather than left parked.
- ~~The whole flow on a repository that is not forge-sandbox~~ — planning is
  proven on two others.

---

## Known issues

**This directory is inside OneDrive, which resurrects deleted files.** It has
now done so four times, and it gets worse each time rather than settling:

| when | what came back |
| --- | --- |
| 24 Oct | everything deleted in `081e7c8`; `loadAllRoles()` read twelve roles instead of seven and two tests failed |
| 29 Oct | the same 21 files, archived to `~/.shura-archive/2026-10-27-onedrive-resurrected/` |
| 31 Oct | — |
| 5 Nov | **43 files** — both earlier batches plus everything the 31 October prune deleted. Twelve role YAMLs on disk where three belong |

Every occurrence is identifiable rather than guessed at: a resurrected file has
mode `-rwx------@` and an old mtime, while live files are `-rw-r--r--`. All of
them are recoverable — from git history, or from the archive for the three that
were never committed (`frontend-planner.yaml`, `frontend-reviewer.yaml`,
`caching.test.ts`).

**Run `git status` before anything else after a gap in work.** A clean-looking
checkout with twelve roles in it will fail `doctor` and the suite for reasons
that have nothing to do with the code.

This is the strongest argument for moving the repository out of a sync root
entirely. The clone cache has the same problem for a different reason: a private
repository's full history sits in `<project>/.shura/<repo>.git`, inside
OneDrive, which is a privacy issue as much as a correctness one. Phase 6 of the
plan moves it to `~/.cache/shura`; moving the working copy is a decision for
whoever owns the machine.

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

The full plan is at `~/.claude/plans/now-as-we-did-tidy-candle.md`, which is
outside this repository and will not survive a clean machine — worth copying in
before it matters. Phases 1, 2 and 3 are done, Phase 4 is half done.

1. **Finish Phase 4.** A checker per criterion, enforced by the schema, so a
   criterion the pipeline cannot settle becomes impossible to write rather than
   merely answerable — criterion [19] is the case it prevents. Then an evidence
   channel on the verdict, so nothing is written into a target repository again.
2. **Push `phase-1-no-dead-passes` and open a pull request.** Eleven commits,
   unpushed. PR #1 on `sakib142/shura` carries the four earlier ones and should
   probably merge first.
3. **Build on a repository that is not forge-sandbox.** Planning is proven on
   courtshare and on a C# API; building is not.
4. **`shura probe`** — still the cheapest way to learn whether the reviewer is
   good or merely agreeable.
5. **Prompt caching on the codex side** — the claude side has it; codex reported
   12,288 of 17,717 tokens served from cache, so measure before building.
6. **Normalise usage reporting.** `tokensIn` excludes cache reads on one adapter
   and includes them on the other, and `usd` is a would-have-cost on one and a
   deliberate `0` on the other. The figure a run prints cannot be summed, which
   is why this document counts passes and minutes.
