-- The plan gate.
--
-- An agent used to go straight from a work item to writing code. Now it plans
-- first, stops, and a human approves the plan before anything is built. The
-- cheapest moment to catch a misread request is before any of it is written.
--
-- Two things here are load-bearing:
--
--   * `plans` carries the acceptance criteria. They are not copied from the
--     work item — they are produced BY the plan, which is the step that turns
--     free-form instructions into something a reviewer can judge. The work
--     item's criteria are then kept in step with the approved plan's, so there
--     is one answer to "what is this judged against".
--   * approval is a row in `approvals`, which has existed since 0001 and has
--     never been written to. A gate whose state lives in application memory is
--     not a gate; this one survives the process exiting between planning and
--     building, which is the whole point of stopping.

BEGIN;

CREATE TABLE IF NOT EXISTS plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id   uuid NOT NULL REFERENCES work_items(id),
  -- text, not a foreign key, for the same reason tool_calls.task_id is: the
  -- audit trail must not depend on a row elsewhere still existing.
  task_id        text NOT NULL,
  -- Where the work happens. Per-run, not from configuration: these agents are
  -- generic, and which repository they are pointed at is an argument.
  repo           text NOT NULL,
  -- The request as the human wrote it, or the ticket key it came from.
  request        text NOT NULL,
  source         text NOT NULL CHECK (source IN ('instructions', 'tracker')),

  understanding  text NOT NULL,
  approach       text NOT NULL,
  files          jsonb NOT NULL DEFAULT '[]'::jsonb,
  out_of_scope   jsonb NOT NULL DEFAULT '[]'::jsonb,
  criteria       jsonb NOT NULL DEFAULT '[]'::jsonb,
  open_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Filled in at approval, one per open question, in order.
  answers        jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Rule 4 applies to a plan as much as to a verdict: a plan nobody can
  -- attribute is a plan nobody can audit, and the approver deserves to know
  -- which model wrote what they are agreeing to.
  author         text NOT NULL,
  vendor         text NOT NULL CHECK (vendor IN ('anthropic','openai','google','local')),
  model          text NOT NULL,
  tokens_in      bigint NOT NULL DEFAULT 0,
  tokens_out     bigint NOT NULL DEFAULT 0,
  cost_usd       numeric(10,4) NOT NULL DEFAULT 0,

  status         text NOT NULL DEFAULT 'awaiting_approval'
                 CHECK (status IN ('awaiting_approval','approved','rejected','built')),
  -- Set when the build runs, so a second `shura build --resume` on an approved
  -- plan is a question we can answer rather than a second branch.
  branch         text,
  change_request text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plans_awaiting_idx
  ON plans (created_at) WHERE status = 'awaiting_approval';

GRANT SELECT, INSERT, UPDATE, DELETE ON plans TO shura_app;

COMMIT;
