-- Phase 1b: five-minute fleet snapshots for the trend charts, and an index
-- for pruning old seen nonces.

-- +goose Up
CREATE TABLE fleet_snapshots (
    at       timestamptz PRIMARY KEY,
    approved integer NOT NULL,
    online   integer NOT NULL,
    pending  integer NOT NULL,
    sessions integer NOT NULL
);

CREATE INDEX seen_nonces_seen_at_idx ON seen_nonces (seen_at);

-- +goose Down
DROP INDEX seen_nonces_seen_at_idx;
DROP TABLE fleet_snapshots;
