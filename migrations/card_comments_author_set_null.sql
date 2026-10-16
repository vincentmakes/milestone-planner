-- Migration: card_comments.author_id -> nullable, ON DELETE SET NULL (PostgreSQL)
-- Description: Deleting a user no longer deletes every Kanban comment they
--              wrote: the comment stays and is shown as written by a deleted
--              user. Drops NOT NULL, replaces any author_id FK with another
--              delete rule, and clears author ids of users already gone
--              (only possible without any FK). Skipped when the
--              card_comments table does not exist.
--
-- USAGE: python migrations/run_migration.py card_comments_author_set_null
--    or: psql -d <tenant_db> -f migrations/card_comments_author_set_null.sql
--
-- Idempotent. The same SQL (tenant_provisioner.CARD_COMMENTS_AUTHOR_FK_SQL)
-- also runs automatically on tenant pool creation
-- (app.services.tenant_data_migrations) and in get_tenant_schema_sql() /
-- setup_databases.sql.

DO $$
DECLARE
    fk_name TEXT;
BEGIN
    IF to_regclass('public.card_comments') IS NULL THEN
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'card_comments'
          AND column_name = 'author_id' AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE card_comments ALTER COLUMN author_id DROP NOT NULL;
    END IF;

    FOR fk_name IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = to_regclass('public.card_comments')
          AND c.contype = 'f'
          AND a.attname = 'author_id'
          AND c.confdeltype <> 'n'
    LOOP
        EXECUTE format('ALTER TABLE card_comments DROP CONSTRAINT %I', fk_name);
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = to_regclass('public.card_comments')
          AND c.contype = 'f'
          AND a.attname = 'author_id'
    ) THEN
        UPDATE card_comments SET author_id = NULL
        WHERE author_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = card_comments.author_id);
        ALTER TABLE card_comments ADD CONSTRAINT card_comments_author_id_fkey
            FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
END $$;
