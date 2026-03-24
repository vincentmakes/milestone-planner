-- Migration: Add skills tables (PostgreSQL)
-- Description: Creates skills and user_skills tables for staff skill management
-- 
-- USAGE: Run this on each existing tenant database that needs the skills feature
-- Example: psql -h localhost -U postgres -d tenant_db -f migrations/add_skills_tables.sql
-- 
-- NOTE: Run as database superuser (postgres) to ensure proper grants

-- Skills table (global, shared across all sites)
CREATE TABLE IF NOT EXISTS skills (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    color VARCHAR(7) NOT NULL DEFAULT '#6366f1',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User skills association table (many-to-many)
CREATE TABLE IF NOT EXISTS user_skills (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    proficiency INTEGER NOT NULL DEFAULT 3 CHECK(proficiency >= 1 AND proficiency <= 5),
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, skill_id)
);

-- Indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_user_skills_user ON user_skills(user_id);
CREATE INDEX IF NOT EXISTS idx_user_skills_skill ON user_skills(skill_id);

-- Grant permissions to the database owner/app user
-- This dynamically grants to the current database owner
DO $$
DECLARE
    db_owner TEXT;
BEGIN
    -- Get the owner of the current database
    SELECT pg_catalog.pg_get_userbyid(d.datdba) INTO db_owner
    FROM pg_catalog.pg_database d
    WHERE d.datname = current_database();
    
    -- Grant permissions on new tables
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE skills TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE user_skills TO %I', db_owner);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE skills_id_seq TO %I', db_owner);
    
    RAISE NOTICE 'Granted permissions to database owner: %', db_owner;
END $$;

-- Insert default skills (skip if already exist)
INSERT INTO skills (name, description, color) VALUES
    ('Project Management', 'Experience in managing projects and teams', '#3b82f6'),
    ('Data Analysis', 'Statistical analysis and data interpretation', '#8b5cf6'),
    ('Laboratory Work', 'Hands-on laboratory experience', '#10b981'),
    ('Technical Writing', 'Documentation and report writing', '#f59e0b'),
    ('Quality Control', 'QC procedures and compliance', '#ef4444'),
    ('R&D', 'Research and development experience', '#06b6d4')
ON CONFLICT (name) DO NOTHING;

-- Verify migration
DO $$
BEGIN
    RAISE NOTICE 'Skills migration completed successfully';
    RAISE NOTICE 'Tables created: skills, user_skills';
    RAISE NOTICE 'Default skills seeded: 6 skills';
END $$;
