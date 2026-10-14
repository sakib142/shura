# How one run works, step by step

One command, traced through the files that handle it.

```bash
pnpm forge run KAN-7 --role frontend-developer
```

There is no "agent program" anywhere in this codebase. An agent is **a role
file, a prompt, and a set of tool grants**, handed to a model. Everything below
is ordinary code deciding what that model is allowed to do next.

---

## Step 1 — the command starts a Node process

`package.json:16`

```json
"forge": "node --env-file-if-exists=.env --import tsx apps/cli/src/main.ts"
```

`--env-file-if-exists` loads `.env` into the environment. No code reads that
file; the runtime does it, so secret loading never enters application code.

## Step 2 — dispatch

`apps/cli/src/main.ts:135` sends `run` to `run()` in `apps/cli/src/run.ts`.

## Step 3 — which agent, and is the pair legal

`apps/cli/src/run.ts`

| Line | What happens |
|---|---|
| `110` | `--role frontend-developer` → `producerId` (default `backend-developer`) |
| `114` | `roles.get(producerId)` loads `packages/roles/definitions/frontend-developer.yaml` |
| `131` | `withPrompt()` replaces `instructions: prompts/…md` with the file's contents |
| `135` | **If producer and verifier are the same vendor, stop here.** Before any spend |

That last check is rule 1, enforced at the cheapest possible moment.

## Step 4 — read the ticket

`apps/cli/src/run.ts:177` calls `tracker.get('KAN-7')`, which in
`packages/connectors/src/tracker-jira.ts` fetches the issue and pulls
Given/When/Then lines out of the description. ADF is Jira's node-tree format,
converted in `packages/connectors/src/adf.ts`.

`run.ts:183` — **a ticket with no checkable criteria is refused here**, before
an agent starts. A verdict against vague criteria cannot mean anything, so it is
better to refuse than to spend and disappoint.

## Step 5 — the loop

`apps/cli/src/run.ts:257` calls `runWorkItem()` in
`packages/orchestrator/src/run-item.ts`. Per attempt:

| Line | What happens |
|---|---|
| `152` | attempt loop, capped by `budgets.loop_cap` |
| `158` | create the branch |
| `161` | create a worktree — an isolated checkout, `packages/sandbox/src/worktree.ts` |
| `170` | build a gateway bound to that worktree and that role's grants |
| `185` | run the producer |
| `213` | publish the branch — nothing locally, a push on GitHub |
| `246` | **`selectVerifier()` — the only place a verify task is created** |
| `286` | run the verifier |

## Step 6 — the bridge between the loop and the model

`packages/orchestrator/src/run-item.ts:390`

```ts
const invoke = async (tool: string, args: unknown) => { … return o.gateway.call(req); };
```

This is the hinge. The adapter is handed `invoke` and nothing else — no
gateway, no credentials, no database. **Every tool call an agent makes goes
through this one function**, so there is no route to a tool that skips the
checks.

## Step 7 — one model turn

`packages/runtimes/src/anthropic.ts`

| Line | What happens |
|---|---|
| `78` | `client.messages.create(...)` — the HTTPS call, the only remote step |
| `103` | pull `tool_use` blocks out of the response |
| `126` | `done` when `stop_reason === 'end_turn'` |
| `134` | tool results go back as a single user message |

Termination is structural. Nothing reads prose looking for a model saying it has
finished.

## Step 8 — the shared loop

`packages/runtimes/src/loop.ts` holds the parts that are identical across
vendors and easy to get wrong: settling exactly once, honouring abort, stopping
on budget, giving up after repeated identical denials.

| Line | What happens |
|---|---|
| `134` | finished → emit the result, stop |
| `163` | the model wants a tool |
| `165` | `invokeSafely(req.invoke, call)` → Step 6 |
| `206` | all results from one turn submitted together |

## Step 9 — the gateway: four checks on every call

`packages/tool-gateway/src/gateway.ts`

| Line | Check |
|---|---|
| `107` | **Permission.** Is this tool granted to this role? A verifier calling `repo.write` dies here |
| `121` | **Schema.** Validated against the tool's zod schema; `../etc/passwd` dies here |
| `137` | **Idempotency.** Derive the effect key; an effect already done is replayed, not repeated |
| `165` | **Audit — before acting.** Something we cannot record must not happen |
| `180` | only now does the handler run |

## Step 10 — what a tool actually does

`packages/orchestrator/src/handlers.ts` — `repo.read` (`38`), `repo.write`
(`40`), `test.run` (`47`), `verdict.submit` (`69`). Each is bound to one
worktree, so there is no path parameter that reaches the real filesystem.

## Step 11 — rule 1

`packages/core/src/invariant.ts:49-62`. `selectVerifier()` throws if the
verifier shares a vendor with the producer, or is the same agent. Called from
`run-item.ts:246` and nowhere else.

## Step 12 — admission

`packages/connectors/src/vcs-local.ts:143` — `LocalMergeQueue`, deterministic
code with no model. It rebases on the current base (`162`), re-runs the checks
against the merged result (`225`), and merges only if still green (`237`).

`Vcs` has **no `merge()` method at all** — see `packages/ports/src/vcs.ts`. The
capability is absent from the port agent tools are built from, so no prompt can
reach it.

---

## The shape of it

```
you ──► CLI ──► loop ──► model (HTTPS)
                 ▲          │
                 │          ▼ "I want repo.write"
                 │     ┌─────────┐
                 └─────│ gateway │  permission → schema → idempotency → audit
                       └────┬────┘
                            ▼
                        handler ──► worktree on disk
```

The model never touches anything. It asks; the gateway decides; a handler acts.
