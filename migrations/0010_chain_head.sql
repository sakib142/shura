-- The chain head, held in a row that is locked rather than read.
--
-- Two separate defects, both found by `shura doctor` reporting a broken chain
-- on a log nothing had tampered with.
--
-- 1. Under READ COMMITTED a statement takes its snapshot when it begins. A
--    second INSERT begins, takes its snapshot, and THEN blocks on the advisory
--    lock. When the first commits and the second proceeds, the second's trigger
--    still reads its old snapshot and cannot see the row just committed, so it
--    chains to the wrong predecessor. The lock serialised execution but not
--    visibility — which is why it only appeared under load: thirty events from
--    two concurrent runs forked the chain where twelve did not.
--
--    `SELECT ... FOR UPDATE` fixes it. In READ COMMITTED a row lock makes the
--    waiter re-read the latest committed version of that row once granted, so
--    the head row is both the mutual exclusion and a guaranteed-current read.
--
-- 2. `bigserial` evaluates its DEFAULT before the BEFORE INSERT trigger runs,
--    so ids were allocated outside the lock and could be numbered against the
--    order the rows were actually linked in. `verify_audit_chain` walks by id,
--    so it reported the mismatch. The id is now assigned inside the lock; the
--    ids allocated before it are abandoned, leaving gaps, which nothing reads
--    as a count.

BEGIN;

CREATE TABLE IF NOT EXISTS chain_heads (
  table_name text PRIMARY KEY,
  hash       text NOT NULL
);

-- Seed from whatever each chain currently ends with, so existing rows stay
-- verifiable and the next append continues from where they left off.
INSERT INTO chain_heads (table_name, hash)
SELECT 'events', coalesce((SELECT hash FROM events ORDER BY id DESC LIMIT 1), repeat('0', 64))
ON CONFLICT (table_name) DO NOTHING;
INSERT INTO chain_heads (table_name, hash)
SELECT 'tool_calls', coalesce((SELECT hash FROM tool_calls ORDER BY id DESC LIMIT 1), repeat('0', 64))
ON CONFLICT (table_name) DO NOTHING;

-- The name matters: this is the function the events_chain and tool_calls_chain
-- triggers actually call.
CREATE OR REPLACE FUNCTION chain_audit_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev      text;
  canonical text;
BEGIN
  SELECT hash INTO prev FROM chain_heads WHERE table_name = TG_TABLE_NAME FOR UPDATE;

  IF prev IS NULL THEN
    INSERT INTO chain_heads (table_name, hash) VALUES (TG_TABLE_NAME, repeat('0', 64));
    prev := repeat('0', 64);
  END IF;

  NEW.id := nextval(pg_get_serial_sequence(TG_TABLE_NAME, 'id'));

  -- jsonb renders its keys in a deterministic order, so this is reproducible.
  canonical := ((to_jsonb(NEW) - 'hash' - 'prev_hash')::text);

  NEW.prev_hash := prev;
  NEW.hash := encode(sha256(convert_to(prev || canonical, 'UTF8')), 'hex');

  UPDATE chain_heads SET hash = NEW.hash WHERE table_name = TG_TABLE_NAME;
  RETURN NEW;
END;
$$;

-- Created by an earlier attempt that replaced the wrong name. Nothing calls it.
DROP FUNCTION IF EXISTS chain_row();

GRANT SELECT, INSERT, UPDATE ON chain_heads TO shura_app;

COMMIT;
