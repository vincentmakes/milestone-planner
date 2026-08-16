-- Migration: Add Kanban board support (PostgreSQL)
-- Description: Adds a `status` column to project_phases / project_subphases
--              (the Kanban column, kept in sync with `completion`), plus the
--              card_comments and notifications tables.
--
-- USAGE: Run this on each existing tenant database.
-- Example: psql -h localhost -U postgres -d tenant_db -f migrations/add_kanban_tables.sql
--      or: python migrations/run_migration.py add_kanban_tables
--
-- NOTE: Run as database superuser (postgres) to ensure proper grants
--
-- No index is created on `status`: the board is always read per project and
-- idx_project_phases_project_id / idx_project_subphases_project_id already
-- cover that access path. A 4-value column does not benefit from its own index.

-- ---------------------------------------------------------------
-- 1. Kanban status on the two card tables
-- ---------------------------------------------------------------

ALTER TABLE project_phases    ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'todo';
ALTER TABLE project_subphases ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'todo';

-- CHECK constraints are not idempotent via ADD CONSTRAINT, so guard them.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_phases_status_check') THEN
        ALTER TABLE project_phases ADD CONSTRAINT project_phases_status_check
            CHECK (status IN ('todo', 'in_progress', 'blocked', 'done'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_subphases_status_check') THEN
        ALTER TABLE project_subphases ADD CONSTRAINT project_subphases_status_check
            CHECK (status IN ('todo', 'in_progress', 'blocked', 'done'));
    END IF;
END $$;

-- Backfill from the existing completion percentage. Scoped to rows still at the
-- column default so re-running never overwrites a status a user has since set.
UPDATE project_phases SET status = CASE
    WHEN completion IS NULL OR completion <= 0 THEN 'todo'
    WHEN completion >= 100 THEN 'done'
    ELSE 'in_progress'
END
WHERE status = 'todo';

UPDATE project_subphases SET status = CASE
    WHEN completion IS NULL OR completion <= 0 THEN 'todo'
    WHEN completion >= 100 THEN 'done'
    ELSE 'in_progress'
END
WHERE status = 'todo';

-- ---------------------------------------------------------------
-- 2. Card comments
-- ---------------------------------------------------------------
-- entity_type/entity_id mirrors custom_column_values (narrowed to cards).
-- project_id is denormalised so per-project comment counts are one indexed
-- scan, and so a project delete cascades.

CREATE TABLE IF NOT EXISTS card_comments (
    id SERIAL PRIMARY KEY,
    entity_type VARCHAR(20) NOT NULL,
    entity_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    mentioned_user_ids TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT card_comments_entity_type_check CHECK (entity_type IN ('phase', 'subphase'))
);

CREATE INDEX IF NOT EXISTS idx_card_comments_entity ON card_comments(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_card_comments_project ON card_comments(project_id);

-- ---------------------------------------------------------------
-- 3. Notifications
-- ---------------------------------------------------------------
-- title/body hold rendered text on purpose: a notification is a historical
-- record and must not rewrite itself when the card it refers to is renamed.
-- actor_id is SET NULL so deleting one user never deletes another user's inbox.

CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(30) NOT NULL,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    entity_type VARCHAR(20),
    entity_id INTEGER,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    body TEXT,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT notifications_type_check
        CHECK (type IN ('assigned', 'comment', 'mention', 'status_change'))
);

-- Partial index: serves both the unread badge count and the unread list, and
-- stays small because rows fall out of it as soon as they are read.
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
    ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
    ON notifications(user_id, created_at DESC);

-- ---------------------------------------------------------------
-- Grant permissions to the database owner/app user
-- ---------------------------------------------------------------

DO $$
DECLARE
    db_owner TEXT;
BEGIN
    SELECT pg_catalog.pg_get_userbyid(d.datdba) INTO db_owner
    FROM pg_catalog.pg_database d
    WHERE d.datname = current_database();

    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE card_comments TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE notifications TO %I', db_owner);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE card_comments_id_seq TO %I', db_owner);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE notifications_id_seq TO %I', db_owner);

    RAISE NOTICE 'Granted permissions to database owner: %', db_owner;
END $$;

-- Verify migration
DO $$
BEGIN
    RAISE NOTICE 'Kanban migration completed successfully';
    RAISE NOTICE 'Columns added: project_phases.status, project_subphases.status';
    RAISE NOTICE 'Tables created: card_comments, notifications';
END $$;
