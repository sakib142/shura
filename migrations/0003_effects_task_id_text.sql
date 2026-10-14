-- effects.task_id is a breadcrumb for debugging, not a relation: a merge key is
-- derived from the change request and the verdict, and belongs to no one task.
BEGIN;
ALTER TABLE effects ALTER COLUMN task_id TYPE text USING task_id::text;
COMMIT;
