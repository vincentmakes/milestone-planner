-- Migration: Add is_system column to users table
-- This column protects admin accounts created during tenant provisioning from deletion

-- Add the is_system column (default 0 for existing users)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_system INTEGER DEFAULT 0;

-- Mark the first admin user (lowest ID with admin role) as system user
-- This assumes the first admin was created during provisioning
UPDATE users 
SET is_system = 1 
WHERE id = (
    SELECT id FROM users 
    WHERE role = 'admin' 
    ORDER BY id ASC 
    LIMIT 1
)
AND is_system = 0;

-- Verify the migration
SELECT id, email, role, is_system FROM users WHERE role = 'admin' ORDER BY id;
