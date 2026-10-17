"""
Application configuration using Pydantic Settings.
Loads from environment variables and .env file.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

# The built-in default and the placeholders shipped in .env.example /
# docker-compose.fresh.yml. They are public, so a deployment using one has a
# guessable secret (forgeable SSO state; in single-tenant mode the key that
# encrypts stored SSO secrets is derived from it). Refused unless DEBUG=true.
DEFAULT_SESSION_SECRET = "rd-planning-secret-key-change-in-production"
INSECURE_SESSION_SECRETS = frozenset(
    {
        "",
        DEFAULT_SESSION_SECRET,
        "change-me-in-production",
        "change-this-to-a-random-64-character-string-in-production",
    }
)


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Application
    app_name: str = "Milestone API"
    debug: bool = False
    port: int = 8485  # Different from Node.js (8484) for hybrid running

    # Database
    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "milestone_dev"
    db_user: str = "milestone_dev_user"
    db_password: str = ""
    database_url: str | None = None
    db_ssl: bool = False

    # Connection pool settings
    db_pool_size: int = 20
    db_pool_max_overflow: int = 10
    db_pool_timeout: int = 30

    # Session & Security
    session_secret: str = DEFAULT_SESSION_SECRET
    session_cookie_name: str = "connect.sid"  # Match Express default
    session_max_age: int = 86400  # 24 hours in seconds

    # Multi-tenant
    multi_tenant: bool = False
    default_tenant: str | None = None

    # Master database (for multi-tenant mode)
    master_db_host: str | None = None
    master_db_port: int = 5432
    master_db_name: str = "milestone_master"
    master_db_user: str | None = None
    master_db_password: str | None = None

    # PostgreSQL admin credentials (for provisioning tenant databases)
    # Needs CREATEROLE and CREATEDB privileges
    pg_admin_user: str | None = None
    pg_admin_password: str | None = None

    # External APIs
    # Nager holiday API. The v3 API (https://date.nager.at/api/v3) is still
    # accepted and auto-detected, but reaches end of life on 2027-01-31.
    nager_api_url: str = "https://nagerholidays.com/api/v4"

    # HTTP Proxy (for external API calls)
    # Option 1: Direct proxy URL
    http_proxy: str | None = None  # e.g., "http://proxy.company.com:8080"
    https_proxy: str | None = None  # e.g., "http://proxy.company.com:8080"
    # Proxy authentication (if required)
    proxy_username: str | None = None
    proxy_password: str | None = None
    # Option 2: PAC file URL (will be parsed to find proxy for each request)
    proxy_pac_url: str | None = None  # e.g., "http://proxy.company.com:8081/proxy.pac"
    # SSL verification (set to false if proxy does SSL inspection and you don't have the CA cert)
    proxy_verify_ssl: bool = True
    # Path to custom CA certificate for SSL verification (for corporate proxies)
    proxy_ca_cert: str | None = None  # e.g., "/path/to/corporate-ca.crt"

    # Cookie security (set True when behind HTTPS)
    secure_cookies: bool = False

    # CORS allowed origins (comma-separated, e.g. "https://app.example.com,https://admin.example.com")
    # If not set, allows localhost origins in debug mode only
    cors_origins: str | None = None

    @property
    def allowed_origins(self) -> list[str]:
        """
        Cross-origin browser origins the app accepts.

        Same rule as the CORS middleware in ``app.main``: ``CORS_ORIGINS`` when
        set, the localhost dev servers under DEBUG, otherwise none (same-origin
        only). The WebSocket Origin check uses it too.
        """
        if self.cors_origins:
            return [o.strip() for o in self.cors_origins.split(",") if o.strip()]
        if self.debug:
            return [
                "http://localhost:3333",  # Vite dev server
                "http://localhost:8484",
                "http://localhost:8485",
                "http://127.0.0.1:3333",
                "http://127.0.0.1:8484",
                "http://127.0.0.1:8485",
            ]
        return []

    @property
    def has_insecure_session_secret(self) -> bool:
        """True when SESSION_SECRET is empty or one of the published placeholders."""
        return self.session_secret.strip() in INSECURE_SESSION_SECRETS

    def check_startup_security(self) -> None:
        """
        Refuse to start production with a published SESSION_SECRET.

        Raises RuntimeError when DEBUG is false and the secret is empty or a
        known default. DEBUG=true only logs (see the lifespan in app.main).
        """
        if self.has_insecure_session_secret and not self.debug:
            raise RuntimeError(
                "SESSION_SECRET is empty or a published default. Refusing to start with "
                "DEBUG=false. Set SESSION_SECRET in .env to a random value, e.g. "
                'python -c "import secrets; print(secrets.token_hex(32))"'
            )

    @property
    def async_database_url(self) -> str:
        """Build async database URL for SQLAlchemy."""
        if self.database_url:
            # Convert standard postgres:// to postgresql+asyncpg://
            url = self.database_url
            if url.startswith("postgres://"):
                url = url.replace("postgres://", "postgresql+asyncpg://", 1)
            elif url.startswith("postgresql://"):
                url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
            return url

        return (
            f"postgresql+asyncpg://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )

    @property
    def sync_database_url(self) -> str:
        """Build sync (non-asyncpg) database URL for scripts and migration runners."""
        if self.database_url:
            url = self.database_url
            if url.startswith("postgres://"):
                url = url.replace("postgres://", "postgresql://", 1)
            return url

        return (
            f"postgresql://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )

    @property
    def master_async_database_url(self) -> str | None:
        """Build async master database URL for multi-tenant mode."""
        if not self.multi_tenant:
            return None

        host = self.master_db_host or self.db_host
        user = self.master_db_user or self.db_user
        password = self.master_db_password or self.db_password

        return (
            f"postgresql+asyncpg://{user}:{password}"
            f"@{host}:{self.master_db_port}/{self.master_db_name}"
        )


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
