#!/usr/bin/env python3
"""
Setup Admin Password Script

Sets the password for the admin user in the master database.
Run this after the fresh install SQL script.

Usage:
    python scripts/setup_admin_password.py [--email EMAIL] [--password PASSWORD]

If password is not provided, you will be prompted to enter it securely.
"""

import argparse
import getpass
import sys
import os
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))


def get_password_hash(password: str) -> str:
    """
    Generate password hash using PBKDF2-SHA512.
    Compatible with app.services.encryption.hash_password()
    """
    try:
        from app.services.encryption import hash_password
        return hash_password(password)
    except ImportError:
        # Fallback if app not available
        import hashlib
        import secrets
        salt = secrets.token_hex(16)
        hash_bytes = hashlib.pbkdf2_hmac(
            'sha512',
            password.encode('utf-8'),
            salt.encode('utf-8'),
            10000,  # Must match app/services/encryption.py
            dklen=64
        )
        return f"{salt}:{hash_bytes.hex()}"


def update_admin_password(email: str, password_hash: str) -> bool:
    """Update admin password in master database."""
    try:
        import psycopg2
        from app.config import get_settings
        
        settings = get_settings()
        
        # Build connection string for master database
        host = settings.master_db_host or settings.db_host
        port = settings.master_db_port
        name = settings.master_db_name
        user = settings.master_db_user or settings.db_user
        password = settings.master_db_password or settings.db_password
        
        conn = psycopg2.connect(
            host=host,
            port=port,
            dbname=name,
            user=user,
            password=password
        )
        
        cur = conn.cursor()
        cur.execute(
            "UPDATE admin_users SET password_hash = %s WHERE email = %s",
            (password_hash, email)
        )
        
        if cur.rowcount == 0:
            # User doesn't exist, create it
            cur.execute(
                """
                INSERT INTO admin_users (email, password_hash, name, role, active)
                VALUES (%s, %s, 'System Admin', 'superadmin', 1)
                """,
                (email, password_hash)
            )
            print(f"Created new admin user: {email}")
        else:
            print(f"Updated password for: {email}")
        
        conn.commit()
        cur.close()
        conn.close()
        return True
        
    except ImportError:
        print("❌ Error: psycopg2 not installed.")
        print("   Install it with: pip install psycopg2-binary")
        return False
    except Exception as e:
        print(f"❌ Database error: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Set up admin password for Milestone master database"
    )
    parser.add_argument(
        "--email",
        type=str,
        default="admin@milestone.app",
        help="Admin email (default: admin@milestone.app)"
    )
    parser.add_argument(
        "--password",
        type=str,
        help="Admin password (prompted if not provided)"
    )
    parser.add_argument(
        "--generate",
        action="store_true",
        help="Generate a random password"
    )
    
    args = parser.parse_args()
    
    print("\n" + "=" * 50)
    print("MILESTONE - ADMIN PASSWORD SETUP")
    print("=" * 50 + "\n")
    
    # Get or generate password
    if args.generate:
        import secrets
        password = secrets.token_urlsafe(16)
        # Write generated password to a secure file instead of stdout
        pw_file = Path(__file__).parent.parent / ".admin_password"
        pw_file.write_text(password)
        pw_file.chmod(0o600)
        print(f"Generated password written to: {pw_file}")
        print("(Read and delete that file after saving the password!)\n")
    elif args.password:
        password = args.password
    else:
        password = getpass.getpass("Enter admin password: ")
        confirm = getpass.getpass("Confirm password: ")
        
        if password != confirm:
            print("❌ Passwords do not match!")
            sys.exit(1)
        
        if len(password) < 8:
            print("❌ Password must be at least 8 characters!")
            sys.exit(1)
    
    # Generate hash
    print("Generating password hash...")
    password_hash = get_password_hash(password)
    
    # Update database
    print(f"Updating database for user: {args.email}")
    if update_admin_password(args.email, password_hash):
        print("\n✅ Admin password set successfully!")
        print(f"\nYou can now login at: http://localhost:8485/admin/")
        print(f"Email: {args.email}")
        if args.generate:
            print(f"Password was saved to .admin_password file")
    else:
        print("\n❌ Failed to set admin password")
        sys.exit(1)
    
    print()


if __name__ == "__main__":
    main()
