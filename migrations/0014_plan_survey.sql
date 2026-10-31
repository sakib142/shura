-- What the planner found out about the repository, kept.
--
-- The platform must know nothing about any ecosystem, and an operator must not
-- have to maintain facts about a repository that change without telling them.
-- `--checks` was exactly that — `docs/STATE.md` called it "the one thing you
-- must get right per repo" — and on the only repository it was used against, it
-- was wrong: `npm run build` was believed to type-check when that project's
-- tsconfig.json is `{"files": [], "references": [...]}`, so bare `tsc` checks
-- nothing. One criterion then demanded a comparison nothing could evaluate.
--
-- The planner already does the discovery: it reads the manifest, installs, and
-- runs whatever the project has. It simply threw the findings away. They live
-- here now, with the files they were derived from so the survey can be
-- re-derived when those change rather than going quietly stale.
--
-- Nullable, because plans recorded before this column existed have no survey
-- and are still perfectly good plans.
BEGIN;

ALTER TABLE plans ADD COLUMN IF NOT EXISTS survey jsonb;

COMMIT;
