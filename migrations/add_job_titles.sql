-- Migration: Add job_titles table (PostgreSQL)
-- Description: Managed list of user job titles, surfaced as a dropdown when
-- creating users. SSO-provisioned users still receive raw job_title values
-- from the Entra ID claim and bypass this list by design.
--
-- USAGE: python migrations/run_migration.py add_job_titles

CREATE TABLE IF NOT EXISTS job_titles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0 NOT NULL,
    is_active INTEGER DEFAULT 1 NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Grant permissions to the database owner/app user
DO $$
DECLARE
    db_owner TEXT;
BEGIN
    SELECT pg_catalog.pg_get_userbyid(d.datdba) INTO db_owner
    FROM pg_catalog.pg_database d
    WHERE d.datname = current_database();

    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE job_titles TO %I', db_owner);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE job_titles_id_seq TO %I', db_owner);

    RAISE NOTICE 'Granted permissions to database owner: %', db_owner;
END $$;
