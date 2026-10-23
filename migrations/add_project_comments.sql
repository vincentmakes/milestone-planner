-- Migration: Project comment threads (PostgreSQL, 2.0.0)
-- Description: card_comments holds the comment threads of Kanban cards
-- (phase / subphase). A project gains its own thread, shown in the dialog of
-- its project-level bookings: the entity-type CHECK
-- (card_comments_entity_type_check) gains 'project'. Skipped when the
-- constraint already allows it, so it is safe to run more than once.
-- A project thread's comments carry entity_type = 'project' and
-- entity_id = project_id; they go with the project through the project_id FK
-- cascade, so the orphan cleanup (cleanup_orphaned_values.sql) is unchanged.
--
-- Same SQL as tenant_provisioner.PROJECT_COMMENTS_CHECK_SQL, which the tenant
-- auto-migration also runs on every pool creation (and single-tenant startup).
--
-- USAGE:
--   python migrations/run_migration.py add_project_comments
-- or, against one database:
--   psql -U <user> -d <database> -f migrations/add_project_comments.sql

DO $$
BEGIN
    IF to_regclass('public.card_comments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.card_comments')
          AND conname = 'card_comments_entity_type_check'
          AND strpos(pg_get_constraintdef(oid), 'project') > 0
    ) THEN
        ALTER TABLE card_comments DROP CONSTRAINT IF EXISTS card_comments_entity_type_check;
        ALTER TABLE card_comments ADD CONSTRAINT card_comments_entity_type_check
            CHECK (entity_type IN ('phase', 'subphase', 'project'));
    END IF;
END $$;
