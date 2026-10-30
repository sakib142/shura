-- A revised plan keeps what it revised.
--
-- `approve --answer` re-derives the acceptance criteria from the answers. It
-- has to: criteria are the only thing the reviewer judges against, so an
-- answer that reaches the builder as prose and leaves the criteria alone
-- changes nothing the work will be judged on. A plan whose criteria named
-- `profiles.your_detail` would fail a builder that correctly created `bio`
-- because the approver said so — the agent punished for obeying the human.
--
-- But a rewrite at the approval gate must stay inspectable: an approval that
-- moved the goal posts has to show where they stood. Each revision appends the
-- plan body as it was, so the planner's first answer survives the second and
-- "what did I actually approve" is answerable from the row.
BEGIN;

ALTER TABLE plans ADD COLUMN IF NOT EXISTS revisions jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
