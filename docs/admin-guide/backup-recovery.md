# Backup & Recovery

## Backup Strategy

### Single-Tenant

Back up the single database:

```bash
# Full backup
pg_dump -U milestone -d milestone -Fc -f milestone_$(date +%Y%m%d).dump

# Schema only
pg_dump -U milestone -d milestone --schema-only -f milestone_schema.sql
```

### Multi-Tenant

Back up the master database and all tenant databases:

```bash
#!/bin/bash
BACKUP_DIR="/backups/milestone/$(date +%Y%m%d)"
mkdir -p "$BACKUP_DIR"

# Master database
pg_dump -U postgres -d milestone_admin -Fc -f "$BACKUP_DIR/master.dump"

# All tenant databases
psql -U postgres -d milestone_admin -t -c \
    "SELECT database_name FROM tenants WHERE status = 'active'" | \
while read db; do
    db=$(echo "$db" | xargs)  # trim whitespace
    [ -z "$db" ] && continue
    pg_dump -U postgres -d "$db" -Fc -f "$BACKUP_DIR/${db}.dump"
done

echo "Backup complete: $BACKUP_DIR"
```

### Automated Backups

Set up a cron job for regular backups:

```bash
# Daily at 2 AM
0 2 * * * /opt/milestone/backup.sh >> /var/log/milestone-backup.log 2>&1
```

## Recovery

### Restore a Single Database

```bash
# Drop and recreate
dropdb -U postgres milestone
createdb -U postgres -O milestone milestone

# Restore
pg_restore -U postgres -d milestone milestone_20260401.dump
```

### Restore a Tenant Database

```bash
# Drop and recreate the tenant DB
dropdb -U postgres milestone_acme
createdb -U postgres milestone_acme

# Restore
pg_restore -U postgres -d milestone_acme milestone_acme.dump

# Re-grant permissions to the tenant user
psql -U postgres -d milestone_acme -c "GRANT ALL ON ALL TABLES IN SCHEMA public TO milestone_acme;"
psql -U postgres -d milestone_acme -c "GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO milestone_acme;"
```

### Disaster Recovery (Full Restore)

1. Restore the master database first
2. Restore each tenant database
3. Verify tenant connections from the admin portal using "Test Connection"

## File Backups

All application data lives in PostgreSQL — there are no user-uploaded files stored on disk, so database backups cover everything. Back up your `.env` file (or however you manage the environment variables) separately: it holds `SESSION_SECRET` and `TENANT_ENCRYPTION_KEY`, and the encrypted tenant credentials in the master database cannot be decrypted without the original `TENANT_ENCRYPTION_KEY`.

## Testing Backups

Regularly verify backups by restoring to a test environment:

```bash
# Create test database from backup
createdb -U postgres milestone_test
pg_restore -U postgres -d milestone_test milestone_20260401.dump

# Verify data
psql -U postgres -d milestone_test -c "SELECT count(*) FROM projects;"

# Clean up
dropdb -U postgres milestone_test
```
