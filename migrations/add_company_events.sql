-- Migration: Add company_events table
-- Company events (audits, meetings, etc.) are similar to holidays but don't affect working days calculation
-- This migration is idempotent - safe to run multiple times

-- Create table if not exists
CREATE TABLE IF NOT EXISTS company_events (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  end_date DATE,
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index if not exists (PostgreSQL 9.5+)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_company_events_site_date') THEN
        CREATE INDEX idx_company_events_site_date ON company_events(site_id, date);
    END IF;
END$$;
