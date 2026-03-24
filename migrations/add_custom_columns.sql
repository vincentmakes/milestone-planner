-- Migration: Add Custom Columns tables
-- Run this on your PostgreSQL database
-- This script handles both fresh installs and updates to existing tables

-- ============================================================
-- STEP 1: Drop existing tables if they have wrong structure
-- (Uncomment these lines if you want to start fresh - THIS DELETES DATA)
-- ============================================================

-- DROP TABLE IF EXISTS custom_column_values CASCADE;
-- DROP TABLE IF EXISTS custom_columns CASCADE;


-- ============================================================
-- STEP 2: Create tables fresh (if they don't exist)
-- ============================================================

CREATE TABLE IF NOT EXISTS custom_columns (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    column_type VARCHAR(20) NOT NULL DEFAULT 'text',
    list_options TEXT,
    site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
    display_order INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 120,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS custom_column_values (
    id SERIAL PRIMARY KEY,
    custom_column_id INTEGER NOT NULL REFERENCES custom_columns(id) ON DELETE CASCADE,
    entity_type VARCHAR(20) NOT NULL,
    entity_id INTEGER NOT NULL,
    value TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- STEP 3: Add missing columns to existing tables
-- ============================================================

DO $$
BEGIN
    -- custom_columns table columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='custom_columns' AND column_name='site_id') THEN
        ALTER TABLE custom_columns ADD COLUMN site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='custom_columns' AND column_name='display_order') THEN
        ALTER TABLE custom_columns ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='custom_columns' AND column_name='width') THEN
        ALTER TABLE custom_columns ADD COLUMN width INTEGER NOT NULL DEFAULT 120;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='custom_columns' AND column_name='created_at') THEN
        ALTER TABLE custom_columns ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='custom_columns' AND column_name='updated_at') THEN
        ALTER TABLE custom_columns ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
    END IF;

    -- custom_column_values table columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='custom_column_values' AND column_name='custom_column_id') THEN
        ALTER TABLE custom_column_values ADD COLUMN custom_column_id INTEGER NOT NULL REFERENCES custom_columns(id) ON DELETE CASCADE;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='custom_column_values' AND column_name='entity_type') THEN
        ALTER TABLE custom_column_values ADD COLUMN entity_type VARCHAR(20) NOT NULL DEFAULT 'phase';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='custom_column_values' AND column_name='entity_id') THEN
        ALTER TABLE custom_column_values ADD COLUMN entity_id INTEGER NOT NULL DEFAULT 0;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='custom_column_values' AND column_name='value') THEN
        ALTER TABLE custom_column_values ADD COLUMN value TEXT;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='custom_column_values' AND column_name='created_at') THEN
        ALTER TABLE custom_column_values ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='custom_column_values' AND column_name='updated_at') THEN
        ALTER TABLE custom_column_values ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
    END IF;
END $$;


-- ============================================================
-- STEP 4: Fix data for check constraint (if needed)
-- Sets any invalid column_type values to 'text'
-- ============================================================

UPDATE custom_columns 
SET column_type = 'text' 
WHERE column_type IS NULL 
   OR column_type NOT IN ('text', 'boolean', 'list');


-- ============================================================
-- STEP 5: Add constraints (ignore errors if they exist)
-- ============================================================

DO $$
BEGIN
    -- Check constraint for column_type
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_columns_type_check') THEN
        ALTER TABLE custom_columns ADD CONSTRAINT custom_columns_type_check 
            CHECK (column_type IN ('text', 'boolean', 'list'));
    END IF;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    -- Check constraint for entity_type
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_column_values_entity_type_check') THEN
        ALTER TABLE custom_column_values ADD CONSTRAINT custom_column_values_entity_type_check 
            CHECK (entity_type IN ('project', 'phase', 'subphase'));
    END IF;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    -- Unique constraint for column values
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_custom_column_value_entity') THEN
        ALTER TABLE custom_column_values ADD CONSTRAINT uq_custom_column_value_entity 
            UNIQUE (custom_column_id, entity_type, entity_id);
    END IF;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;


-- ============================================================
-- STEP 6: Create indexes for performance
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_custom_columns_site_id ON custom_columns(site_id);
CREATE INDEX IF NOT EXISTS idx_custom_column_values_column_id ON custom_column_values(custom_column_id);
CREATE INDEX IF NOT EXISTS idx_custom_column_values_entity ON custom_column_values(entity_type, entity_id);


-- ============================================================
-- VERIFICATION: Check table structure
-- ============================================================

-- Run this to verify:
-- \d custom_columns
-- \d custom_column_values


-- ============================================================
-- STEP 7: Grant permissions (if needed)
-- Replace 'your_app_user' with your actual database username
-- ============================================================

-- Uncomment and modify these lines if you get permission denied errors:
-- GRANT ALL PRIVILEGES ON TABLE custom_columns TO your_app_user;
-- GRANT ALL PRIVILEGES ON TABLE custom_column_values TO your_app_user;
-- GRANT USAGE, SELECT ON SEQUENCE custom_columns_id_seq TO your_app_user;
-- GRANT USAGE, SELECT ON SEQUENCE custom_column_values_id_seq TO your_app_user;

-- Or to give permissions to all tables in public schema:
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO your_app_user;
-- GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO your_app_user;
