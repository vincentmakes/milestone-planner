-- Migration: Add equipment_blocks table
-- Equipment blocks represent periods when equipment is unavailable due to
-- maintenance, defects, calibration, etc. They are the equipment equivalent
-- of staff vacations. Idempotent - safe to run multiple times.

CREATE TABLE IF NOT EXISTS equipment_blocks (
  id SERIAL PRIMARY KEY,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason VARCHAR(50) NOT NULL DEFAULT 'maintenance',
  description VARCHAR(200) NOT NULL DEFAULT 'Maintenance',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_equipment_blocks_equipment_id') THEN
        CREATE INDEX idx_equipment_blocks_equipment_id ON equipment_blocks(equipment_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_equipment_blocks_dates') THEN
        CREATE INDEX idx_equipment_blocks_dates ON equipment_blocks(start_date, end_date);
    END IF;
END$$;
