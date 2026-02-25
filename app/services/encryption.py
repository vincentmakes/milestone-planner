"""
Encryption utilities for tenant credentials.

Uses AES-256-GCM for secure credential storage.
"""

import hashlib
import os
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import get_settings


def get_encryption_key() -> bytes:
    """
    Get the encryption key for tenant credentials.

    Requires TENANT_ENCRYPTION_KEY (64-char hex) in multi-tenant mode.
    Falls back to session secret derivation only in single-tenant mode.
    """
    settings = get_settings()

    key_hex = os.getenv("TENANT_ENCRYPTION_KEY")
    if key_hex:
        if len(key_hex) != 64:
            raise ValueError(
                "TENANT_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). "
                'Generate with: python -c "import secrets; print(secrets.token_hex(32))"'
            )
        return bytes.fromhex(key_hex)

    if settings.multi_tenant:
        raise ValueError(
            "TENANT_ENCRYPTION_KEY is required in multi-tenant mode. "
            'Generate with: python -c "import secrets; print(secrets.token_hex(32))"'
        )

    # Single-tenant fallback: derive from session secret
    secret = settings.session_secret
    return hashlib.sha256(secret.encode()).digest()


def encrypt(plaintext: str) -> str:
    """
    Encrypt a string using AES-256-GCM.

    Returns format: iv:authTag:ciphertext (hex encoded)
    Compatible with Node.js crypto module.
    """
    key = get_encryption_key()
    aesgcm = AESGCM(key)

    # Generate random IV (96 bits = 12 bytes, recommended for GCM)
    iv = os.urandom(12)

    # Encrypt (AESGCM appends 16-byte auth tag to ciphertext)
    ciphertext_with_tag = aesgcm.encrypt(iv, plaintext.encode(), None)

    # Split into ciphertext and auth tag (last 16 bytes is tag)
    ciphertext = ciphertext_with_tag[:-16]
    auth_tag = ciphertext_with_tag[-16:]

    # Return as hex: iv:authTag:ciphertext (Node.js format)
    return f"{iv.hex()}:{auth_tag.hex()}:{ciphertext.hex()}"


def decrypt(encrypted_data: str) -> str:
    """
    Decrypt a string encrypted with AES-256-GCM.

    Expects format: iv:authTag:ciphertext (hex encoded)
    Compatible with Node.js crypto module.
    """
    key = get_encryption_key()
    aesgcm = AESGCM(key)

    parts = encrypted_data.split(":")
    if len(parts) == 3:
        # Node.js format: iv:authTag:ciphertext
        iv = bytes.fromhex(parts[0])
        auth_tag = bytes.fromhex(parts[1])
        ciphertext = bytes.fromhex(parts[2])
        # Reassemble for AESGCM (expects ciphertext + tag)
        ciphertext_with_tag = ciphertext + auth_tag
    elif len(parts) == 2:
        # Python format: iv:ciphertext+tag
        iv = bytes.fromhex(parts[0])
        ciphertext_with_tag = bytes.fromhex(parts[1])
    else:
        raise ValueError(f"Invalid encrypted data format: expected 2 or 3 parts, got {len(parts)}")

    # Decrypt (auth tag is automatically verified)
    plaintext = aesgcm.decrypt(iv, ciphertext_with_tag, None)

    return plaintext.decode()


# ---------------------------------------------------------
# User password hashing (bcrypt) - for tenant user accounts
# ---------------------------------------------------------


def hash_user_password(password: str) -> str:
    """Hash a user password with bcrypt."""
    import bcrypt as _bcrypt

    return _bcrypt.hashpw(
        password.encode("utf-8"), _bcrypt.gensalt(rounds=12)
    ).decode("utf-8")


def verify_user_password(password: str, stored: str) -> bool:
    """
    Verify a user password against its stored hash.

    Supports multiple formats for backward compatibility:
    - bcrypt ($2b$... or $2a$...)
    - PBKDF2 (salt:hash from tenant provisioner)
    - plain text (legacy, will be upgraded on next login)
    """
    if not stored:
        return False

    # bcrypt hash
    if stored.startswith(("$2b$", "$2a$", "$2y$")):
        import bcrypt as _bcrypt

        return _bcrypt.checkpw(password.encode("utf-8"), stored.encode("utf-8"))

    # PBKDF2 hash (salt:hex_hash, both parts are hex)
    parts = stored.split(":")
    if len(parts) == 2 and len(parts[0]) == 32 and len(parts[1]) == 128:
        return verify_password(password, stored)

    # Plain text fallback (legacy)
    return secrets.compare_digest(stored, password)


def password_needs_upgrade(stored: str) -> bool:
    """Check if a stored password should be re-hashed to bcrypt."""
    if not stored:
        return False
    return not stored.startswith(("$2b$", "$2a$", "$2y$"))


def generate_password(length: int = 32) -> str:
    """
    Generate a secure random password.
    """
    # Use alphanumeric characters (no special chars to avoid SQL issues)
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def hash_password(password: str) -> str:
    """
    Hash a password for admin users.

    Uses PBKDF2 with SHA-512 to match Node.js implementation.
    Format: salt:hash (both hex encoded)
    """
    import hashlib

    # Generate random salt (16 bytes = 32 hex chars)
    salt = secrets.token_hex(16)

    # Hash with PBKDF2 (10000 iterations, 64 bytes output, SHA-512)
    hash_bytes = hashlib.pbkdf2_hmac(
        "sha512", password.encode("utf-8"), salt.encode("utf-8"), 10000, dklen=64
    )
    hash_hex = hash_bytes.hex()

    return f"{salt}:{hash_hex}"


def verify_password(password: str, stored_hash: str) -> bool:
    """
    Verify a password against its PBKDF2 hash.

    Format: salt:hash (both hex encoded)
    """
    import hashlib

    parts = stored_hash.split(":")
    if len(parts) != 2:
        return False

    salt, expected_hash = parts

    # Hash the provided password with the same salt
    hash_bytes = hashlib.pbkdf2_hmac(
        "sha512", password.encode("utf-8"), salt.encode("utf-8"), 10000, dklen=64
    )
    actual_hash = hash_bytes.hex()

    # Constant-time comparison to prevent timing attacks
    return secrets.compare_digest(actual_hash, expected_hash)
