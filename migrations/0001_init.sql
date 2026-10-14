-- Shura schema, slice 1.
--
-- Two things here are load-bearing rather than cosmetic:
--
--   * events and tool_calls are append-only, enforced by grants rather than by
--     convention: the application role holds no UPDATE or DELETE on them. An
--     audit trail an application can rewrite is not an audit trail.
--   * verdicts carry both vendors and both models (rule 4), not null, so no
--     verdict can exist that the eval harness cannot attribute to a pair.

BEGIN;

CREATE TABLE IF NOT EXISTS work_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                 text NOT NULL UNIQUE,
  type                text NOT NULL,
  title               text NOT NULL,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  state               text NOT NULL DEFAULT 'draft',
  parent_id           uuid REFERENCES work_items(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name    text NOT NULL UNIQUE,
  role    text NOT NULL,
  kind    text NOT NULL CHECK (kind IN ('produce','verify','admit')),
  runtime text,
  model   text,
  vendor  text CHECK (vendor IN ('anthropic','openai','google','local')),
  -- Rule 3: an admit actor is deterministic code, so it carries no model.
  CONSTRAINT admit_actors_carry_no_model
    CHECK ((kind = 'admit') = (vendor IS NULL AND model IS NULL))
);

CREATE TABLE IF NOT EXISTS tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id   uuid NOT NULL REFERENCES work_items(id),
  artifact_type  text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('produce','verify','admit')),
  role           text NOT NULL,
  agent_id       uuid REFERENCES agents(id),
  status         text NOT NULL DEFAULT 'pending',
  attempt        integer NOT NULL DEFAULT 1,
  parent_task_id uuid REFERENCES tasks(id),
  budget_tokens  bigint,
  budget_usd     numeric(10,4),
  deadline_at    timestamptz,
  claimed_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_pending_idx ON tasks (status, created_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS artifacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      uuid NOT NULL REFERENCES tasks(id),
  type         text NOT NULL,
  locator      text NOT NULL,
  content_hash text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verdicts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id      uuid NOT NULL REFERENCES artifacts(id),
  verifier_task_id uuid NOT NULL REFERENCES tasks(id),
  decision         text NOT NULL CHECK (decision IN ('PASS','CHANGES_REQUESTED','BLOCKED')),
  -- true when the submitted decision disagreed with its own findings and was rewritten
  overridden       boolean NOT NULL DEFAULT false,
  findings         jsonb NOT NULL DEFAULT '[]'::jsonb,
  producer_vendor  text NOT NULL,
  producer_model   text NOT NULL,
  verifier_vendor  text NOT NULL,
  verifier_model   text NOT NULL,
  prompt_hash      text NOT NULL,
  tokens_in        bigint NOT NULL,
  tokens_out       bigint NOT NULL,
  cost_usd         numeric(10,4) NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Rule 1, at rest. Even a bug in the scheduler cannot land a same-vendor verdict.
  CONSTRAINT verifier_vendor_differs CHECK (verifier_vendor <> producer_vendor)
);

CREATE TABLE IF NOT EXISTS claims (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents(id),
  task_id      uuid NOT NULL REFERENCES tasks(id),
  branch       text NOT NULL,
  file_globs   text[] NOT NULL,
  expires_at   timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS claims_one_live_per_branch
  ON claims (branch) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gate         text NOT NULL,
  subject_type text NOT NULL,
  subject_id   text NOT NULL,
  approver     text NOT NULL,
  decision     text NOT NULL,
  note         text,
  at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS timers (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id  uuid NOT NULL REFERENCES tasks(id),
  fire_at  timestamptz NOT NULL,
  kind     text NOT NULL,
  payload  jsonb NOT NULL DEFAULT '{}'::jsonb,
  fired_at timestamptz
);
CREATE INDEX IF NOT EXISTS timers_due_idx ON timers (fire_at) WHERE fired_at IS NULL;

CREATE TABLE IF NOT EXISTS lessons (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project        text NOT NULL,
  text           text NOT NULL,
  source_task_id uuid REFERENCES tasks(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- append-only

CREATE TABLE IF NOT EXISTS events (
  id           bigserial PRIMARY KEY,
  task_id      uuid REFERENCES tasks(id),
  work_item_id uuid REFERENCES work_items(id),
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_work_item_idx ON events (work_item_id, id);

CREATE TABLE IF NOT EXISTS tool_calls (
  id            bigserial PRIMARY KEY,
  task_id       uuid REFERENCES tasks(id),
  agent_id      uuid REFERENCES agents(id),
  tool          text NOT NULL,
  args_hash     text NOT NULL,
  allowed       boolean NOT NULL,
  denial_reason text,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tool_calls_denied_idx ON tool_calls (task_id) WHERE allowed = false;

-- The application connects as shura_app, which can append to the audit tables
-- but cannot rewrite them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'shura_app') THEN
    CREATE ROLE shura_app LOGIN PASSWORD 'shura_app';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO shura_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  work_items, agents, tasks, artifacts, verdicts, claims, approvals, timers, lessons
  TO shura_app;
GRANT SELECT, INSERT ON events, tool_calls TO shura_app;
REVOKE UPDATE, DELETE ON events, tool_calls FROM shura_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shura_app;

COMMIT;
