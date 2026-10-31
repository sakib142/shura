-- What the project's checks said before anything changed.
--
-- Criterion [19] on a real run demanded "no new error relative to a captured
-- baseline" when nothing in the pipeline captured one. No agent could settle
-- it: a verify task runs read-only and cannot install the tools, so the
-- criterion went round the loop twice and ended with the reviewer committing
-- SHURA-9-verification.md into the user's own repository for want of anywhere
-- to put evidence.
--
-- Deterministic code now runs the gate on the base branch once per plan and
-- keeps the result here. The comparison becomes a subtraction the harness does,
-- and a builder handed a failing check can be told whether it was already
-- failing before it touched anything.
--
-- Nullable: a plan whose repository has no runnable gate has no baseline to
-- take, and that is a legitimate state rather than a missing row.
BEGIN;

ALTER TABLE plans ADD COLUMN IF NOT EXISTS baseline jsonb;

COMMIT;
