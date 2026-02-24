-- Migration: Upgrade to v90 (Full Schema Update)
-- 
-- This migration brings existing tenant databases up to date with all
-- schema changes through version 90. It's idempotent and safe to run multiple times.
--
-- Changes included:
-- - Add max_capacity column to users (for part-time staff)
-- - Add is_system column to users (protect system accounts)
-- - Add company_events table
-- - Add skills and user_skills tables
-- - Add custom_columns and custom_column_values tables
-- - Add end_date and year columns to bank_holidays
-- - Add updated_at column to users
--
-- Usage:
--   docker exec -it milestone python /app/migrations/run_migration.py upgrade_to_v90
--

-- ============================================================================
-- USERS TABLE UPDATES
-- ============================================================================

-- Add max_capacity column (for part-time workers)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'users' AND column_name = 'max_capacity') THEN
        ALTER TABLE users ADD COLUMN max_capacity INTEGER DEFAULT 100;
        UPDATE users SET max_capacity = 100 WHERE max_capacity IS NULL;
        ALTER TABLE users ALTER COLUMN max_capacity SET NOT NULL;
    END IF;
END $$;

-- Add is_system column (protect system accounts from deletion)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'users' AND column_name = 'is_system') THEN
        ALTER TABLE users ADD COLUMN is_system INTEGER DEFAULT 0;
    END IF;
END $$;

-- Add updated_at column if missing
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'users' AND column_name = 'updated_at') THEN
        ALTER TABLE users ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    END IF;
END $$;

-- ============================================================================
-- BANK HOLIDAYS TABLE UPDATES
-- ============================================================================

-- Add end_date column
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'bank_holidays' AND column_name = 'end_date') THEN
        ALTER TABLE bank_holidays ADD COLUMN end_date DATE;
    END IF;
END $$;

-- Add year column
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'bank_holidays' AND column_name = 'year') THEN
        ALTER TABLE bank_holidays ADD COLUMN year INTEGER;
        -- Populate year from date
        UPDATE bank_holidays SET year = EXTRACT(YEAR FROM date) WHERE year IS NULL;
        ALTER TABLE bank_holidays ALTER COLUMN year SET NOT NULL;
    END IF;
END $$;

-- Add year index
CREATE INDEX IF NOT EXISTS idx_bank_holidays_year ON bank_holidays(site_id, year);

-- ============================================================================
-- COMPANY EVENTS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS company_events (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    end_date DATE,
    name VARCHAR(200) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_company_events_site_date ON company_events(site_id, date);

-- ============================================================================
-- SKILLS TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS skills (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    color VARCHAR(7) DEFAULT '#6366f1',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_skills (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    proficiency INTEGER DEFAULT 3 CHECK (proficiency >= 1 AND proficiency <= 5),
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_user_skills_user ON user_skills(user_id);
CREATE INDEX IF NOT EXISTS idx_user_skills_skill ON user_skills(skill_id);

-- Seed default skills if table is empty
INSERT INTO skills (name, description, color)
SELECT name, description, color FROM (VALUES
    ('Project Management', 'Experience in managing projects and teams', '#3b82f6'),
    ('Data Analysis', 'Statistical analysis and data interpretation', '#8b5cf6'),
    ('Laboratory Work', 'Hands-on laboratory experience', '#10b981'),
    ('Technical Writing', 'Documentation and report writing', '#f59e0b'),
    ('Quality Control', 'QC procedures and compliance', '#ef4444'),
    ('R&D', 'Research and development experience', '#06b6d4')
) AS v(name, description, color)
WHERE NOT EXISTS (SELECT 1 FROM skills LIMIT 1);

-- ============================================================================
-- CUSTOM COLUMNS TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS custom_columns (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    column_type VARCHAR(20) NOT NULL DEFAULT 'text',
    list_options TEXT,
    site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
    display_order INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 120,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS custom_column_values (
    id SERIAL PRIMARY KEY,
    custom_column_id INTEGER NOT NULL REFERENCES custom_columns(id) ON DELETE CASCADE,
    entity_type VARCHAR(20) NOT NULL,
    entity_id INTEGER NOT NULL,
    value TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(custom_column_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_custom_columns_site ON custom_columns(site_id);
CREATE INDEX IF NOT EXISTS idx_custom_column_values_column ON custom_column_values(custom_column_id);
CREATE INDEX IF NOT EXISTS idx_custom_column_values_entity ON custom_column_values(entity_type, entity_id);

-- Add constraints if not exists (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_columns_type_check') THEN
        -- Fix any invalid values first
        UPDATE custom_columns SET column_type = 'text' 
        WHERE column_type IS NULL OR column_type NOT IN ('text', 'boolean', 'list');
        -- Add constraint
        ALTER TABLE custom_columns ADD CONSTRAINT custom_columns_type_check 
            CHECK (column_type IN ('text', 'boolean', 'list'));
    END IF;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_column_values_entity_type_check') THEN
        ALTER TABLE custom_column_values ADD CONSTRAINT custom_column_values_entity_type_check 
            CHECK (entity_type IN ('project', 'phase', 'subphase'));
    END IF;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================================
-- PREDEFINED PHASES UPDATES
-- ============================================================================

-- Add is_system column if missing
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'predefined_phases' AND column_name = 'is_system') THEN
        ALTER TABLE predefined_phases ADD COLUMN is_system INTEGER DEFAULT 0;
        -- Mark existing phases as system phases
        UPDATE predefined_phases SET is_system = 1 
        WHERE name IN ('Preparation', 'Analytics', 'Trial', 'Cleaning', 'Report');
    END IF;
END $$;

-- Add color column if missing
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'predefined_phases' AND column_name = 'color') THEN
        ALTER TABLE predefined_phases ADD COLUMN color VARCHAR(20);
    END IF;
END $$;

-- ============================================================================
-- PROJECT PRESENCE TABLE (for realtime collaboration)
-- ============================================================================

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
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_project_presence_unique') THEN
        CREATE UNIQUE INDEX idx_project_presence_unique ON project_presence(project_id, user_id);
    END IF;
END $$;

-- ============================================================================
-- VERIFICATION
-- ============================================================================

DO $$
DECLARE
    v_table_count INTEGER;
    v_user_cols TEXT;
BEGIN
    -- Count tables
    SELECT COUNT(*) INTO v_table_count 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
    
    -- Get user columns
    SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) INTO v_user_cols
    FROM information_schema.columns
    WHERE table_name = 'users' AND table_schema = 'public';
    
    RAISE NOTICE 'Migration complete! Tables: %, User columns: %', v_table_count, v_user_cols;
END $$;
