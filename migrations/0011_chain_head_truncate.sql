-- Keep the chain head and the log it describes consistent.
--
-- The head is now a row rather than a read of the last append, which is what
-- makes concurrent appends safe. But it also means the two can disagree:
-- truncating the log leaves the head pointing at a hash no row carries, and
-- the next append chains to it — so `verify_audit_chain` reports a break on
-- the very first row of an empty log.
--
-- Truncating an audit log is not something the application does; the grants
-- forbid it. It is something tests do, and a schema that only holds together
-- when nobody touches it is not holding together. So the database keeps the
-- two in step itself.

BEGIN;

CREATE OR REPLACE FUNCTION reset_chain_head() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE chain_heads SET hash = repeat('0', 64) WHERE table_name = TG_TABLE_NAME;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS events_chain_reset ON events;
CREATE TRIGGER events_chain_reset
  AFTER TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION reset_chain_head();

DROP TRIGGER IF EXISTS tool_calls_chain_reset ON tool_calls;
CREATE TRIGGER tool_calls_chain_reset
  AFTER TRUNCATE ON tool_calls
  FOR EACH STATEMENT EXECUTE FUNCTION reset_chain_head();

-- Bring the heads back in step with whatever the tables hold right now, since
-- they have been out of step while this was being worked out.
UPDATE chain_heads SET hash =
  coalesce((SELECT hash FROM events ORDER BY id DESC LIMIT 1), repeat('0', 64))
  WHERE table_name = 'events';
UPDATE chain_heads SET hash =
  coalesce((SELECT hash FROM tool_calls ORDER BY id DESC LIMIT 1), repeat('0', 64))
  WHERE table_name = 'tool_calls';

COMMIT;
