-- Generate migration commands for all tenant databases
-- Run this in pgAdmin connected to milestone_admin database
-- Then copy the output and run it, or use \gexec in psql

-- Option 1: Generate a list of databases to migrate
SELECT 
    slug as tenant,
    database_name,
    format('\c %s', database_name) as connect_command
FROM tenants 
WHERE status = 'active'
ORDER BY slug;

-- Option 2: Generate full psql commands (for bash/terminal)
-- Copy this output and run in terminal
SELECT format(
    'psql -h localhost -U postgres -d %s -c "CREATE TABLE IF NOT EXISTS company_events (id SERIAL PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE, name VARCHAR(255) NOT NULL, start_date DATE NOT NULL, end_date DATE NOT NULL, description TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP); CREATE INDEX IF NOT EXISTS idx_company_events_site_id ON company_events(site_id); CREATE INDEX IF NOT EXISTS idx_company_events_dates ON company_events(start_date, end_date);"',
    database_name
) as bash_command
FROM tenants 
WHERE status = 'active'
ORDER BY slug;
