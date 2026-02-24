-- Migration: Add max_capacity column to users table
-- This column allows part-time workers to have a reduced maximum capacity (e.g., 80% for 4 days/week)
-- Date: 2025-01-14

-- Add max_capacity column with default value of 100 (full-time)
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_capacity INTEGER DEFAULT 100;

-- Ensure existing users have the default value
UPDATE users SET max_capacity = 100 WHERE max_capacity IS NULL;

-- Add NOT NULL constraint after populating
ALTER TABLE users ALTER COLUMN max_capacity SET NOT NULL;
