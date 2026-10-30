-- Report every break in the chain, not only the first.
--
-- The verifier returned on its first mismatch, which sounds conservative and
-- is the opposite: one old break hides every later one. This log carries a
-- real break at events id=3, from the concurrency bug fixed in 0010 — and
-- while it stands, `shura audit --verify` would report exactly that and stop,
-- whatever happened afterwards.
--
-- A log that cannot be rewritten will accumulate breaks it cannot repair, so
-- the check has to stay useful in spite of them. After a break the walk
-- re-anchors on the row it just read, so each break is reported once rather
-- than every subsequent row being reported as broken too.
--
-- Nothing here lets anyone hide a break: this reports strictly more than
-- before.

BEGIN;

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
    ELSIF r.hash IS DISTINCT FROM expected THEN
      bad_id := r.id; reason := 'row contents do not match the recorded hash'; RETURN NEXT;
    END IF;

    -- Re-anchor on what this row actually recorded, so one break is one
    -- finding rather than making every row after it look broken.
    prev := r.hash;
  END LOOP;
END;
$$;

COMMIT;
