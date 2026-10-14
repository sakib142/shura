-- Idempotency, and an audit log that detects tampering.
--
-- The append-only grants in 0001 stop the application rewriting history. They
-- do not stop anyone with direct database access. Chaining each row to its
-- predecessor makes such an edit detectable, which is what "exportable for
-- compliance" and the regulated deployment modes actually require.

BEGIN;

-- ------------------------------------------------------------------ effects

CREATE TABLE IF NOT EXISTS effects (
  key          text PRIMARY KEY,
  tool         text NOT NULL,
  task_id      uuid,
  status       text NOT NULL CHECK (status IN ('in_flight','completed','failed')),
  result       jsonb,
  reason       text,
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
COMMENT ON TABLE effects IS
  'Idempotency keys for side-effecting tool calls. in_flight means a claim nobody '
  'released: the process died mid-effect and whether the effect landed is unknown.';

GRANT SELECT, INSERT, UPDATE, DELETE ON effects TO shura_app;

-- ------------------------------------------------------- hash-chained audit

ALTER TABLE events     ADD COLUMN IF NOT EXISTS prev_hash text;
ALTER TABLE events     ADD COLUMN IF NOT EXISTS hash      text;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS prev_hash text;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS hash      text;

-- Computed in the database, so writing to the table directly cannot skip it.
CREATE OR REPLACE FUNCTION chain_audit_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev      text;
  canonical text;
BEGIN
  -- Serialise appends to this table so two concurrent inserts cannot read the
  -- same predecessor and fork the chain. Audit volume makes the cost irrelevant.
  PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_NAME));

  EXECUTE format('SELECT hash FROM %I ORDER BY id DESC LIMIT 1', TG_TABLE_NAME) INTO prev;
  prev := coalesce(prev, repeat('0', 64));

  -- jsonb renders its keys in a deterministic order, so this is reproducible.
  canonical := ((to_jsonb(NEW) - 'hash' - 'prev_hash')::text);

  NEW.prev_hash := prev;
  NEW.hash := encode(sha256(convert_to(prev || canonical, 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS events_chain ON events;
CREATE TRIGGER events_chain BEFORE INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION chain_audit_row();

DROP TRIGGER IF EXISTS tool_calls_chain ON tool_calls;
CREATE TRIGGER tool_calls_chain BEFORE INSERT ON tool_calls
  FOR EACH ROW EXECUTE FUNCTION chain_audit_row();

-- Walks a chain and returns the first row whose recorded hash disagrees with a
-- recomputation. An empty result means the log is intact.
CREATE OR REPLACE FUNCTION verify_audit_chain(tbl text)
RETURNS TABLE (bad_id bigint, reason text)
LANGUAGE plpgsql AS $$
DECLARE
  r         record;
  prev      text := repeat('0', 64);
  canonical text;
  expected  text;
BEGIN
  FOR r IN EXECUTE format('SELECT * FROM %I ORDER BY id', tbl) LOOP
    canonical := ((to_jsonb(r) - 'hash' - 'prev_hash')::text);
    expected  := encode(sha256(convert_to(prev || canonical, 'UTF8')), 'hex');

    IF r.prev_hash IS DISTINCT FROM prev THEN
      bad_id := r.id; reason := 'prev_hash does not match the previous row'; RETURN NEXT;
      RETURN;
    END IF;
    IF r.hash IS DISTINCT FROM expected THEN
      bad_id := r.id; reason := 'row contents do not match the recorded hash'; RETURN NEXT;
      RETURN;
    END IF;
    prev := r.hash;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION verify_audit_chain(text) TO shura_app;

COMMIT;
