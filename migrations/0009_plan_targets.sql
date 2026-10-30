-- A plan carries its own target.
--
-- `plans` already recorded WHICH repository a plan is for. It did not record
-- how to build it, so `shura build --resume` fell back to shura.config.yaml for
-- the base branch and the check command — which is another project's branch and
-- another project's test runner.
--
-- The failure was quiet, which is what made it worth a migration rather than a
-- flag: a plan for repo X, resumed, would branch from repo Y's base and run
-- repo Y's tests against X's code. Either the branch is wrong or the checks are
-- meaningless, and nothing says so.
--
-- A plan is now self-contained. Approve one today, resume it next week against a
-- config that has moved on, and it still builds what it said it would.

BEGIN;

-- 'main' matches the default everywhere else (config, GitHubVcs.base) so an
-- existing row keeps the behaviour it was created under.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS base text NOT NULL DEFAULT 'main';

-- An argv array, not a shell string: the check command is exec'd without a
-- shell, so ["sh","-c","..."] is how a pipeline gets expressed. Empty means
-- "none configured", which runChecks already reports rather than failing on.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS checks jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
