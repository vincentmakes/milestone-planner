-- Migration: Add the audit log (PostgreSQL)
-- Description: Creates audit_log, one immutable row per recorded action:
-- sign-ins, failed attempts and sign-outs (category auth), user, role,
-- approval-policy, settings, site and team changes (admin), exports
-- (access) and project, booking and other content changes (change). Each
-- row names its actor (actor_user_id, SET NULL when the user is deleted;
-- actor_email and actor_name are snapshots), the account acted upon
-- (subject_email), its target (type, id, label), its project (project_id,
-- no foreign key: the row outlives the project), the client's ip and user
-- agent, its origin (web / system) and its details as JSON text (reason,
-- changes, items, context; credentials masked). Requires users (2.4.0).
--
-- USAGE: Run this on each existing tenant database
-- Example: python migrations/run_migration.py add_audit_log
--   or:    psql -h localhost -U postgres -d tenant_db -f migrations/add_audit_log.sql
--
-- Idempotent (IF NOT EXISTS everywhere). The tenant auto-migration
-- (tenant_manager._run_auto_migrations) applies the same statements
-- (tenant_provisioner.AUDIT_LOG_SCHEMA_STATEMENTS) when a tenant pool is
-- created and the table is missing; nothing is seeded.
--
-- NOTE: Run as database superuser (postgres) to ensure proper grants

-- The audit log
CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    category VARCHAR(16) NOT NULL,
    action VARCHAR(100) NOT NULL,
    outcome VARCHAR(16) NOT NULL DEFAULT 'success',
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_email VARCHAR(255),
    actor_name VARCHAR(255),
    subject_email VARCHAR(255),
    target_type VARCHAR(50),
    target_id VARCHAR(100),
    target_label VARCHAR(255),
    project_id INTEGER,
    ip VARCHAR(45),
    user_agent VARCHAR(255),
    origin VARCHAR(20) NOT NULL DEFAULT 'web',
    details TEXT,
    CONSTRAINT audit_log_category_check
        CHECK (category IN ('auth', 'admin', 'access', 'change')),
    CONSTRAINT audit_log_outcome_check
        CHECK (outcome IN ('success', 'failure'))
);

-- Indexes (the list's filters and its newest-first order)
CREATE INDEX IF NOT EXISTS ix_audit_log_created_at ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS ix_audit_log_category_created_at ON audit_log(category, created_at);
CREATE INDEX IF NOT EXISTS ix_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS ix_audit_log_actor_user_id ON audit_log(actor_user_id);
CREATE INDEX IF NOT EXISTS ix_audit_log_subject_email ON audit_log(subject_email);
CREATE INDEX IF NOT EXISTS ix_audit_log_ip ON audit_log(ip);
CREATE INDEX IF NOT EXISTS ix_audit_log_project_id ON audit_log(project_id);

-- Grant permissions to the database owner/app user
DO $$
DECLARE
    db_owner TEXT;
BEGIN
    SELECT pg_catalog.pg_get_userbyid(d.datdba) INTO db_owner
    FROM pg_catalog.pg_database d
    WHERE d.datname = current_database();

    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE audit_log TO %I', db_owner);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO %I', db_owner);

    RAISE NOTICE 'Granted permissions to database owner: %', db_owner;
END $$;

-- Verify migration
DO $$
BEGIN
    RAISE NOTICE 'Audit log migration completed successfully';
    RAISE NOTICE 'Table created: audit_log';
END $$;
