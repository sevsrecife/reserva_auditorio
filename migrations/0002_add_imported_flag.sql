ALTER TABLE reservations ADD COLUMN is_imported INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_reservations_imported ON reservations(is_imported);
