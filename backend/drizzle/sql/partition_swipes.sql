-- Production only: convert "swipes" into a table partitioned by month.
-- Run once during a maintenance window, before launch traffic.
-- A monthly job (BullMQ "maintenance" queue) creates next month's partition in advance.

BEGIN;

ALTER TABLE swipes RENAME TO swipes_old;

CREATE TABLE swipes (
  swiper_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action     swipe_action NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (swiper_id, target_id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX swipes_target_action_idx ON swipes (target_id, action);
CREATE INDEX swipes_swiper_target_idx ON swipes (swiper_id, target_id);

-- Example partitions - the maintenance job creates these automatically
CREATE TABLE swipes_2026_11 PARTITION OF swipes FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE swipes_2026_12 PARTITION OF swipes FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE swipes_default PARTITION OF swipes DEFAULT;

INSERT INTO swipes SELECT swiper_id, target_id, action, created_at FROM swipes_old;
DROP TABLE swipes_old;

COMMIT;
