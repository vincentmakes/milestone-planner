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


# bcrypt only looks at the first 72 bytes of its input. bcrypt 4.x silently
# truncated longer inputs; bcrypt 5.x raises ValueError instead. Both are
# handled explicitly here so neither surfaces as a 500 from a route.
BCRYPT_MAX_PASSWORD_BYTES = 72
PASSWORD_TOO_LONG_MESSAGE = f"Password must be at most {BCRYPT_MAX_PASSWORD_BYTES} bytes"


class PasswordTooLongError(ValueError):
    """Raised by hash_user_password() for passwords bcrypt cannot hash."""

    def __init__(self) -> None:
        super().__init__(PASSWORD_TOO_LONG_MESSAGE)


def password_too_long(password: str) -> bool:
    """True if the password exceeds bcrypt's 72-byte input limit (UTF-8)."""
    return len(password.encode("utf-8")) > BCRYPT_MAX_PASSWORD_BYTES


def _bcrypt_check(password: str, stored_hash: str) -> bool:
    """bcrypt verification that never raises: over-long or malformed input is a mismatch."""
    import bcrypt as _bcrypt

    if password_too_long(password):
        return False
    try:
        return _bcrypt.checkpw(password.encode("utf-8"), stored_hash.encode("utf-8"))
    except ValueError:
        # Malformed stored hash (or a future bcrypt input check).
        return False


def hash_user_password(password: str) -> str:
    """
    Hash a user password with bcrypt.

    Raises PasswordTooLongError (a ValueError) when the password is longer
    than 72 bytes; routers turn that into a 400.
    """
    import bcrypt as _bcrypt

    if password_too_long(password):
        raise PasswordTooLongError()
    return _bcrypt.hashpw(password.encode("utf-8"), _bcrypt.gensalt(rounds=12)).decode("utf-8")


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
        return _bcrypt_check(password, stored)

    # PBKDF2 hash: self-describing (pbkdf2_sha512$...) or legacy salt:hex_hash
    if stored.startswith(_PBKDF2_PREFIX + "$"):
        return verify_password(password, stored)
    parts = stored.split(":")
    if len(parts) == 2 and len(parts[0]) == 32 and len(parts[1]) == 128:
        return verify_password(password, stored)

    # Plain text fallback (legacy). Compare as bytes: compare_digest() raises
    # TypeError for str arguments containing non-ASCII characters.
    return secrets.compare_digest(stored.encode("utf-8"), password.encode("utf-8"))


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


# ---------------------------------------------------------
# Admin-portal password hashing (PBKDF2-SHA512)
# ---------------------------------------------------------

# Current work factor for admin-portal hashes. New hashes are written in the
# self-describing form ``pbkdf2_sha512$<iterations>$<salt>$<hash>`` so the
# iteration count can be raised again later without guessing what an old hash
# used. The legacy ``salt:hash`` form (10 000 iterations, Node-compatible) is
# still verified and upgraded on the next successful login.
ADMIN_PBKDF2_ITERATIONS = 600_000
LEGACY_PBKDF2_ITERATIONS = 10_000
_PBKDF2_PREFIX = "pbkdf2_sha512"


def _pbkdf2_hex(password: str, salt: str, iterations: int) -> str:
    return hashlib.pbkdf2_hmac(
        "sha512", password.encode("utf-8"), salt.encode("utf-8"), iterations, dklen=64
    ).hex()


def _parse_pbkdf2(stored_hash: str) -> tuple[int, str, str] | None:
    """Return ``(iterations, salt, hash_hex)`` for either PBKDF2 format, else None."""
    if stored_hash.startswith(_PBKDF2_PREFIX + "$"):
        parts = stored_hash.split("$")
        if len(parts) != 4:
            return None
        try:
            iterations = int(parts[1])
        except ValueError:
            return None
        if iterations < 1:
            return None
        return iterations, parts[2], parts[3]
    parts = stored_hash.split(":")
    if len(parts) == 2:
        return LEGACY_PBKDF2_ITERATIONS, parts[0], parts[1]
    return None


def hash_password(password: str, iterations: int = ADMIN_PBKDF2_ITERATIONS) -> str:
    """
    Hash a password with PBKDF2-SHA512 (admin-portal accounts, provisioner seeds).

    Format: ``pbkdf2_sha512$<iterations>$<salt>$<hash>`` (salt and hash hex).
    """
    salt = secrets.token_hex(16)
    return f"{_PBKDF2_PREFIX}${iterations}${salt}${_pbkdf2_hex(password, salt, iterations)}"


def verify_password(password: str, stored_hash: str) -> bool:
    """
    Verify a password against its stored hash.

    Supports:
    - PBKDF2, self-describing: pbkdf2_sha512$iterations$salt$hash
    - PBKDF2, legacy: salt:hash (10 000 iterations)
    - bcrypt format: $2b$... / $2a$... / $2y$...
    """
    if not stored_hash:
        return False

    # bcrypt hash (used by setup_databases.sql seed)
    if stored_hash.startswith(("$2b$", "$2a$", "$2y$")):
        return _bcrypt_check(password, stored_hash)

    parsed = _parse_pbkdf2(stored_hash)
    if parsed is None:
        return False
    iterations, salt, expected_hash = parsed

    # Constant-time comparison to prevent timing attacks
    return secrets.compare_digest(
        _pbkdf2_hex(password, salt, iterations).encode(), expected_hash.encode()
    )


def admin_password_needs_upgrade(stored_hash: str) -> bool:
    """True when an admin hash uses an older format or a lower work factor."""
    parsed = _parse_pbkdf2(stored_hash) if stored_hash else None
    if parsed is None:
        # bcrypt (seeded) hashes are left alone; unknown formats cannot verify.
        return False
    return not stored_hash.startswith(_PBKDF2_PREFIX + "$") or parsed[0] < ADMIN_PBKDF2_ITERATIONS


# ---------------------------------------------------------
# Timing equalisation for unknown accounts
# ---------------------------------------------------------

_dummy_bcrypt_hash: str | None = None
_DUMMY_PBKDF2_SALT = "0" * 32


def dummy_verify_user_password(password: str) -> None:
    """
    Spend about as long as a real bcrypt check.

    Login runs this when the e-mail does not exist, so the response time does
    not tell an attacker whether an account exists.
    """
    global _dummy_bcrypt_hash
    if _dummy_bcrypt_hash is None:
        _dummy_bcrypt_hash = hash_user_password(secrets.token_hex(16))
    _bcrypt_check(password, _dummy_bcrypt_hash)


def dummy_verify_admin_password(password: str) -> None:
    """Admin-portal counterpart of dummy_verify_user_password (PBKDF2 cost)."""
    _pbkdf2_hex(password, _DUMMY_PBKDF2_SALT, ADMIN_PBKDF2_ITERATIONS)
