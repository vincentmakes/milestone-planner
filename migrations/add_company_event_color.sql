-- Migration: Add color column to company_events
-- Allows users to choose a theme color for each company event marker.
-- Idempotent - safe to run multiple times.

ALTER TABLE company_events
    ADD COLUMN IF NOT EXISTS color VARCHAR(20);
