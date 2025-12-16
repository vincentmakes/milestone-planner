-- Create custom_columns and custom_column_values tables
-- Run this on each tenant database

-- Create custom_columns table
CREATE TABLE IF NOT EXISTS custom_columns (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    column_type VARCHAR(20) NOT NULL DEFAULT 'text',
    list_options TEXT,
    site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
    display_order INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 120,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT custom_columns_type_check CHECK (column_type IN ('text', 'boolean', 'list'))
);

-- Create custom_column_values table
CREATE TABLE IF NOT EXISTS custom_column_values (
    id SERIAL PRIMARY KEY,
    custom_column_id INTEGER NOT NULL REFERENCES custom_columns(id) ON DELETE CASCADE,
    entity_type VARCHAR(20) NOT NULL,
    entity_id INTEGER NOT NULL,
    value TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT custom_column_values_entity_type_check CHECK (entity_type IN ('project', 'phase', 'subphase')),
    CONSTRAINT uq_custom_column_value_entity UNIQUE (custom_column_id, entity_type, entity_id)
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_custom_columns_site_id ON custom_columns(site_id);
CREATE INDEX IF NOT EXISTS idx_custom_column_values_column_id ON custom_column_values(custom_column_id);
CREATE INDEX IF NOT EXISTS idx_custom_column_values_entity ON custom_column_values(entity_type, entity_id);
