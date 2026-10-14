# Forge

A platform where an agent's output is never admitted on its own word. A
different agent, running a **different vendor's model**, verifies it, and
admission follows from that verdict.

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
| `pnpm forge doctor` | Checks Postgres, git, the audit chain, the tool catalog, the roles, and which vendor pairs your keys allow | free |
| `pnpm test` | 216 unit and integration tests | free |
| `pnpm forge smoke` | One real tool-calling round-trip per configured vendor. Proves the adapters work against the live APIs | ~$0.01 |
| `pnpm forge run ORD-12 --reset` | The whole loop: an agent builds a feature, a different-vendor agent reviews it, a merge queue merges it | ~$0.25 |
| `pnpm forge probe` | Seeds known faults that pass the test suite and measures whether the reviewer catches them | ~$0.12 |
| `pnpm forge audit --verify` | Walks the hash-chained audit log for tampering | free |

### Checking the work afterwards

```bash
GIT=/Library/Developer/CommandLineTools/usr/bin/git   # or just `git` if yours works

# What was merged, and by whom
$GIT -C .forge/target.git log --format='%h %an %s' main

# What the agent actually wrote
$GIT -C .forge/target.git diff main~1 main

# Do the merged tests pass, independently of the agents?
$GIT -C .forge/target.git worktree add -q /tmp/check main
(cd /tmp/check && node --test --experimental-strip-types test/orders.test.ts)
$GIT -C .forge/target.git worktree remove --force /tmp/check
```

```bash
# The verdict, with full attribution (rule 4)
docker compose exec -T postgres psql -U forge -d forge -x -c \
  "SELECT decision, overridden, producer_vendor, producer_model,
          verifier_vendor, verifier_model, cost_usd
     FROM verdicts ORDER BY created_at DESC LIMIT 1;"

# Every tool call, allowed and denied
docker compose exec -T postgres psql -U forge -d forge -c \
  "SELECT agent_id, tool, allowed, denial_reason FROM tool_calls ORDER BY id;"
```

### What to watch for in the output

- `verifying  rev-01  (vendor openai != anthropic)` — rule 1, checked before a
  token is spent.
- `DENIED` lines — rule 2 in public. A verifier that reaches for a write is
  refused by the gateway, not by a prompt asking it nicely.
- `merge-queue (admit)` as the merge commit's author — admission is
  deterministic code, and is neither the producer nor the reviewer.

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
packages/orchestrator    the produce -> verify -> admit loop
eval/fixtures/target-app the service agents modify
eval/faults              seeded faults, and the known-good control
```
