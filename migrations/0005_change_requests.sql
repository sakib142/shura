-- Change requests, the local stand-in for a pull request.
--
-- Deliberately shaped like what GitHub returns, so the GitHub adapter is a
-- mapping rather than a new concept: a branch, a base, a body, a status, and
-- the commit that merged it.

BEGIN;

CREATE TABLE IF NOT EXISTS change_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        bigserial UNIQUE,
  work_item_id  uuid REFERENCES work_items(id),
  branch        text NOT NULL,
  base          text NOT NULL,
  title         text NOT NULL,
  body          text NOT NULL DEFAULT '',
  author        text NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','merged','closed')),
  merge_commit  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  merged_at     timestamptz
);
CREATE INDEX IF NOT EXISTS change_requests_open_idx ON change_requests (status) WHERE status = 'open';

-- What the merge queue has been authorised to merge, and on whose verdict.
CREATE TABLE IF NOT EXISTS merge_queue (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_request_id uuid NOT NULL REFERENCES change_requests(id),
  verdict_id        text NOT NULL,
  status            text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','merged','rejected')),
  reason            text,
  queued_at         timestamptz NOT NULL DEFAULT now(),
  settled_at        timestamptz,
  UNIQUE (change_request_id, verdict_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON change_requests, merge_queue TO forge_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO forge_app;

COMMIT;
