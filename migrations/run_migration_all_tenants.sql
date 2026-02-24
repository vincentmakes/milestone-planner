-- Run migration across all tenant databases using dblink
-- Execute this in pgAdmin connected to the milestone_admin database

-- First, ensure dblink extension is available
CREATE EXTENSION IF NOT EXISTS dblink;

-- The migration SQL to run on each tenant (escaped for use in dynamic SQL)
-- This is the company_events table creation
DO $$
DECLARE
    tenant_record RECORD;
    db_name TEXT;
    migration_sql TEXT;
    conn_string TEXT;
BEGIN
    -- The migration to apply (company_events table)
    migration_sql := $migration$
        CREATE TABLE IF NOT EXISTS company_events (
            id SERIAL PRIMARY KEY,
            site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
            name VARCHAR(255) NOT NULL,
            start_date DATE NOT NULL,
            end_date DATE NOT NULL,
            description TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE INDEX IF NOT EXISTS idx_company_events_site_id ON company_events(site_id);
        CREATE INDEX IF NOT EXISTS idx_company_events_dates ON company_events(start_date, end_date);
    $migration$;

    -- Loop through all active tenants
    FOR tenant_record IN 
        SELECT slug, database_name 
        FROM tenants 
        WHERE status = 'active'
        ORDER BY slug
    LOOP
        db_name := tenant_record.database_name;
        
        -- Build connection string (assumes same host, port, and superuser access)
        -- Adjust credentials as needed
        conn_string := format(
            'dbname=%s host=localhost port=5432 user=postgres password=YOUR_PASSWORD',
            db_name
        );
        
        BEGIN
            -- Execute migration on tenant database
            PERFORM dblink_exec(conn_string, migration_sql);
            RAISE NOTICE 'Migration completed for tenant: % (database: %)', tenant_record.slug, db_name;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'Migration FAILED for tenant: % (database: %) - Error: %', 
                tenant_record.slug, db_name, SQLERRM;
        END;
    END LOOP;
    
    RAISE NOTICE 'All tenant migrations completed!';
END $$;
