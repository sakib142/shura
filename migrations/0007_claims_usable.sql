-- Claims, made usable.
--
-- The table has existed since 0001 and nothing ever wrote to it: the tool that
-- was supposed to claim returned success and did nothing, so two agents could
-- edit the same files with nothing in the way. It only never happened because
-- runs were sequential.
--
-- agent_id and task_id become text for the same reason they did on tool_calls:
-- an agent is called "dev-01", and a claim that cannot record who holds it is
-- not much of a claim.

BEGIN;

-- The constraints go first: a column cannot change type while a foreign key
-- still ties it to a uuid.
ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_agent_id_fkey;
ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_task_id_fkey;

ALTER TABLE claims ALTER COLUMN agent_id TYPE text USING agent_id::text;
ALTER TABLE claims ALTER COLUMN task_id  TYPE text USING task_id::text;

-- A released claim must not block the next one, so the uniqueness only covers
-- live claims. Already correct in 0001; restated here because it is the thing
-- that makes "one agent per branch" true rather than merely intended.
DROP INDEX IF EXISTS claims_one_live_per_branch;
CREATE UNIQUE INDEX claims_one_live_per_branch
  ON claims (branch) WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS claims_live_idx ON claims (expires_at) WHERE released_at IS NULL;

COMMIT;
