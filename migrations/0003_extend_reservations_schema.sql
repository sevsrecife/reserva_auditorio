ALTER TABLE reservations ADD COLUMN source_origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE reservations ADD COLUMN source_reference TEXT;
ALTER TABLE reservations ADD COLUMN audit_payload_json TEXT;
ALTER TABLE reservations ADD COLUMN recurrence_pattern TEXT NOT NULL DEFAULT 'single';
ALTER TABLE reservations ADD COLUMN recurrence_series_id TEXT;
ALTER TABLE reservations ADD COLUMN recurrence_occurrence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reservations ADD COLUMN recurrence_until TEXT;
ALTER TABLE reservations ADD COLUMN recurrence_weekdays_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE reservations ADD COLUMN created_by_role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE reservations ADD COLUMN updated_by_role TEXT NOT NULL DEFAULT 'user';

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_source_reference
  ON reservations(source_origin, source_reference);
CREATE INDEX IF NOT EXISTS idx_reservations_series
  ON reservations(recurrence_series_id, recurrence_occurrence);
