# Shura — شورى

*Shura* is consultation: deciding together rather than alone. No single party's
word settles a matter.

That is the whole design. An agent's output is never admitted on its own word —
a different agent, running a **different vendor's model**, verifies it, and
admission follows from that verdict. The platform refuses to schedule a review
where producer and reviewer share a vendor, before a token is spent.

## Quick start

Five commands from a clean clone to an agent waiting for work.

```bash
pnpm install
pnpm db:up && pnpm migrate            # Postgres on :5440, in Docker
cp .env.example .env                  # then fill in the three keys below
pnpm shura init                       # writes shura.config.yaml
pnpm shura doctor                     # tells you what is still missing
```

`.env` needs three things. Two **different** vendors are the minimum — a
reviewer must run a different vendor's model from the builder, so one key
produces no valid pairing at all:

```
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GITHUB_TOKEN=...      # Contents: read+write, Pull requests: read+write
```

Then start the agent:

```bash
pnpm shura serve
```

```
  Shura is running on http://localhost:7777

  planner   anthropic/claude-sonnet-5     up to $3 per plan
  builder   anthropic/claude-sonnet-5
  reviewer  openai/gpt-6.1-sol            up to $9 per build, 3 attempts

  Nothing is called until you click. Shura does not merge — you do.
  Bound to localhost only. Ctrl-C to stop.
```

Open it, give it a repository and a sentence, and press **Plan it**.

## How it goes from there

**It plans first, and stops.** It reads the repository, works out what your
request means *in that codebase*, and comes back with a plan: what it
understands the task to be, the files it expects to touch, what it decided to
leave out, the acceptance criteria the work will be judged against, and
anything your request did not settle.

Nothing has been written yet. On a twelve-file repository this costs about 20
cents, which is the point — the cheapest moment to catch a misread request is
before any of it is written.

**You answer its questions and approve.** A plan with open questions cannot be
approved blind. Answer them in the boxes, or tick *let the agent decide* —
which is itself a decision, so it has to be made deliberately rather than by
pressing on.

**Then it builds.** A new branch, and it **proves the build is green before
pushing anything**. A reviewer on a different vendor's model reads the diff
against the criteria the plan produced, and either corrects what it found or
sends it back. A pull request is opened and you are asked to merge it.

**Shura does not merge.** Nothing lands until a person approves it.

### The same thing from a terminal

`serve` is the whole flow in a browser. Every step is also a command, which is
what you want in CI or over SSH:

```bash
pnpm shura build --repo owner/name --task "add a date filter to the orders page"
pnpm shura build --repo owner/name --jira KAN-12        # or read it from a ticket

pnpm shura plans                      # what is waiting
pnpm shura plans 96169c32             # one plan in full
pnpm shura approve 96169c32 --answer "It resets on reload." --answer "Last 30 days."
pnpm shura build --resume 96169c32
```

`shura watch` is `serve` without the ability to submit anything — a read-only
window onto runs started elsewhere.

### Why it stops at the plan

The cheapest moment to catch a misread request is before any of it is written.
Planning costs cents; discovering after a build that the agent understood
"filter" to mean something else costs a dollar and an hour of reading a diff.

The plan is also where free-form instructions become acceptance criteria.
Nothing downstream can judge "add a date filter"; everything downstream can
judge *"Given orders in March and April, when the range is set to April, then
only April orders are listed"*. The reviewer sees the criteria and not the
original request — a reviewer with two standards has none.

### The reviewer may fix what it finds, and rule 2 still holds

A reviewer that can only report sends trivial defects back for a whole rework
cycle. So `frontend-reviewer` may correct what it found — without a verifier
ever holding a write grant.

While reviewing, it holds `repo.read`, `test.run` and the verdict, and the
gateway denies it anything else. When it asks to fix, a **separate task of kind
`produce`** runs under the same agent's identity with the grants its role's
`fix` block declares. The audit records both:

```
verify   rev-01   found 2 problems
produce  rev-01   fixed them
```

No single task both judges and writes, which is what rule 2 actually says.

What this does give up: **a fix the reviewer writes is reviewed by no agent.**
Every other change in Shura is written by one model and checked by a different
vendor's model; these are not. The pull request says so, and names the commits,
so the human merging knows where to look hardest.

## Running it

Everything below runs locally. No GitHub, Jira or Figma account is involved.

```bash
pnpm install
pnpm db:up && pnpm migrate     # Postgres on :5440
cp .env.example .env           # then add ANTHROPIC_API_KEY and OPENAI_API_KEY
```

Two keys from **different vendors** are the minimum: a same-vendor pair is
refused, so one key produces no valid producer/verifier pairing at all.

| Command | What it does | Cost |
| --- | --- | --- |
| `pnpm shura doctor` | Checks Postgres, git, the audit chain, the tool catalog, the roles, and which vendor pairs your keys allow | free |
| `pnpm test` | 409 unit and integration tests | free |
| `pnpm shura smoke` | One real tool-calling round-trip per configured vendor. Proves the adapters work against the live APIs | ~$0.01 |
| `pnpm shura serve` | Run the agent; give it work from the browser | free until you click |
| `pnpm shura build --repo o/n --task "..."` | Plan a feature or a fix, and stop for you to approve it | ~$0.20 |
| `pnpm shura build --resume <id>` | Build an approved plan, review it on another vendor, open a pull request | ~$1 |
| `pnpm shura run ORD-12 --reset` | The older loop, which merges automatically: build, review, merge | ~$0.25 |
| `pnpm shura probe` | Seeds known faults that pass the test suite and measures whether the reviewer catches them | ~$0.12 |
| `pnpm shura audit --verify` | Walks the hash-chained audit log for tampering | free |

### Checking the work afterwards

```bash
GIT=/Library/Developer/CommandLineTools/usr/bin/git   # or just `git` if yours works

# What was merged, and by whom
$GIT -C .shura/target.git log --format='%h %an %s' main

# What the agent actually wrote
$GIT -C .shura/target.git diff main~1 main

# Do the merged tests pass, independently of the agents?
$GIT -C .shura/target.git worktree add -q /tmp/check main
(cd /tmp/check && node --test --experimental-strip-types test/orders.test.ts)
$GIT -C .shura/target.git worktree remove --force /tmp/check
```

```bash
# The verdict, with full attribution (rule 4)
docker compose exec -T postgres psql -U shura -d shura -x -c \
  "SELECT decision, overridden, producer_vendor, producer_model,
          verifier_vendor, verifier_model, cost_usd
     FROM verdicts ORDER BY created_at DESC LIMIT 1;"

# Every tool call, allowed and denied
docker compose exec -T postgres psql -U shura -d shura -c \
  "SELECT agent_id, tool, allowed, denial_reason FROM tool_calls ORDER BY id;"
```

### What to watch for in the output

- `verifying  rev-01  (vendor openai != anthropic)` — rule 1, checked before a
  token is spent.
- `DENIED` lines — rule 2 in public. A verifier that reaches for a write is
  refused by the gateway, not by a prompt asking it nicely.
- `merge-queue (admit)` as the merge commit's author — admission is
  deterministic code, and is neither the producer nor the reviewer.

## What it costs, and why

An agent loop resends its whole transcript every turn, so cost is driven almost
entirely by **input** tokens, not output. A measured run on a 170-file
repository billed **2.27M input tokens to produce 22k of output** — a 103:1
ratio — and spent $5.47 before hitting its ceiling, having written one file.

Two things cause that, and both are fixed:

**The transcript was re-sent at full price every turn.** Shura now caches the
growing prefix: the tool definitions, the system prompt, and a rolling
breakpoint at the end of the conversation. Cached input is a tenth of the
normal price. Measured against the live API, that alone cut a six-turn
conversation by 53%, and the saving grows with turn count — the run above would
have been about $1.60.

**The agent had no way to search.** It discovered the codebase by opening files
one at a time — 57 of them, into a 168k-token context — and most of those reads
were answering "where does this live". `repo.search` answers that in one call,
and because it uses `git grep`, dependencies and build output are excluded for
free. Fewer files read means a smaller context, which compounds with caching.

The `usage` line in the live view shows cache hits, so a run that stops saving
money says so rather than quietly costing more.

If you are pointing it at something large, give it a narrow request. "Add an
empty state to the order list" is a cheap, good task. "Improve the orders page"
makes it read everything first.

## The rules, and why they constrain what you can ask for

1. A verifier's vendor must differ from its producer's, checked when the verify
   task is scheduled.
2. A verifier holds no write grant but its own verdict channel. `Vcs` has no
   `merge()` at all, so the capability is absent from the port agent tools are
   built from.
3. Admission is performed by deterministic code carrying no model.
4. Every verdict records both vendors, both models, tokens and cost.

**You can choose which agent does the work. You cannot run one without a
reviewer** — that is rule 1, and `selectVerifier` throws rather than letting it
happen. It is the thing the platform exists to enforce.

## Acceptance criteria are the interface

A task is a work item plus acceptance criteria in Given/When/Then form. Those
criteria are what the reviewer judges against, so they are the actual input to
quality — vague criteria produce a vague verdict, and no amount of model
capability fixes that.

You can write them yourself (`shura submit`, `shura run`), or let the planner
derive them from free-form instructions and approve what it came up with
(`shura build`). Either way they are fixed before any code is written, and the
reviewer judges against those and nothing else.

```
Given a status filter, when orders are listed,
  then only orders with that status are returned
```

## Layout

```
packages/core            the four rules, the state machine, the verdict contract
packages/ports           interfaces only — no vendor appears here
packages/runtimes        anthropic | openai | google | openai-compatible | fake
packages/tool-gateway    permissions, schemas, idempotency, audit
packages/connectors      local VCS and merge queue
packages/sandbox         worktree isolation and the push guard
packages/orchestrator    plan -> approve -> build -> review -> pull request
packages/roles           role definitions and the prompts that go with them
eval/fixtures/target-app the service agents modify
eval/faults              seeded faults, and the known-good control
```
