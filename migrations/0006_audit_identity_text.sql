-- Audit identities are names, not foreign keys.
--
-- 0004 removed the foreign keys so the audit trail could outlive the rows it
-- describes. Leaving the columns as uuid kept the coupling in spirit: an agent
-- called "dev-01" could not be recorded at all, and the insert failed at
-- runtime rather than at schema-review time.
--
-- An audit row says who did what. "dev-01" is a better answer than a uuid that
-- references nothing.

BEGIN;
ALTER TABLE tool_calls ALTER COLUMN agent_id TYPE text USING agent_id::text;
ALTER TABLE tool_calls ALTER COLUMN task_id  TYPE text USING task_id::text;
ALTER TABLE events     ALTER COLUMN task_id  TYPE text USING task_id::text;
COMMIT;
