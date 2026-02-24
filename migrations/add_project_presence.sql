-- Migration: Add project_presence table for tracking active viewers
-- Run this on each tenant database

CREATE TABLE IF NOT EXISTS project_presence (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity VARCHAR(20) DEFAULT 'viewing' NOT NULL,
    last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_project_presence_project ON project_presence(project_id);
CREATE INDEX IF NOT EXISTS idx_project_presence_user ON project_presence(user_id);
CREATE INDEX IF NOT EXISTS idx_project_presence_last_seen ON project_presence(last_seen_at);

-- Unique constraint - one presence record per user per project
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_presence_unique 
ON project_presence(project_id, user_id);
