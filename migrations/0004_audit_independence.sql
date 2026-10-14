-- An audit log must not depend on referential integrity to mutable tables.
--
-- With these foreign keys in place, deleting a task could cascade into or block
-- inserts of the very rows that record what happened to it. The audit trail has
-- to outlive the things it describes, so the ids stay as plain columns and the
-- hash chain — not a constraint — is what guarantees integrity.

BEGIN;
ALTER TABLE tool_calls DROP CONSTRAINT IF EXISTS tool_calls_task_id_fkey;
ALTER TABLE tool_calls DROP CONSTRAINT IF EXISTS tool_calls_agent_id_fkey;
ALTER TABLE events     DROP CONSTRAINT IF EXISTS events_task_id_fkey;
ALTER TABLE events     DROP CONSTRAINT IF EXISTS events_work_item_id_fkey;
COMMIT;
