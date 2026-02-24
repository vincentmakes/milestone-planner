"""
Application configuration using Pydantic Settings.
Loads from environment variables and .env file.
"""

from functools import lru_cache
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


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
    app_version: str = "2.0.0"
    debug: bool = False
    port: int = 8485  # Different from Node.js (8484) for hybrid running

    # Database
    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "milestone_dev"
    db_user: str = "milestone_dev_user"
    db_password: str = ""
    database_url: Optional[str] = None
    db_ssl: bool = False

    # Connection pool settings
    db_pool_size: int = 20
    db_pool_max_overflow: int = 10
    db_pool_timeout: int = 30

    # Session & Security
    session_secret: str = "rd-planning-secret-key-change-in-production"
    session_cookie_name: str = "connect.sid"  # Match Express default
    session_max_age: int = 86400  # 24 hours in seconds

    # Multi-tenant
    multi_tenant: bool = False
    default_tenant: Optional[str] = None

    # Master database (for multi-tenant mode)
    master_db_host: Optional[str] = None
    master_db_port: int = 5432
    master_db_name: str = "milestone_master"
    master_db_user: Optional[str] = None
    master_db_password: Optional[str] = None

    # PostgreSQL admin credentials (for provisioning tenant databases)
    # Needs CREATEROLE and CREATEDB privileges
    pg_admin_user: Optional[str] = None
    pg_admin_password: Optional[str] = None

    # External APIs
    nager_api_url: str = "https://date.nager.at/api/v3"
    
    # HTTP Proxy (for external API calls)
    # Option 1: Direct proxy URL
    http_proxy: Optional[str] = None  # e.g., "http://proxy.company.com:8080"
    https_proxy: Optional[str] = None  # e.g., "http://proxy.company.com:8080"
    # Proxy authentication (if required)
    proxy_username: Optional[str] = None
    proxy_password: Optional[str] = None
    # Option 2: PAC file URL (will be parsed to find proxy for each request)
    proxy_pac_url: Optional[str] = None  # e.g., "http://mcproxy.sulzer.com:8081/proxy.pac"
    # SSL verification (set to false if proxy does SSL inspection and you don't have the CA cert)
    proxy_verify_ssl: bool = True
    # Path to custom CA certificate for SSL verification (for corporate proxies)
    proxy_ca_cert: Optional[str] = None  # e.g., "/path/to/sulzer-ca.crt"

    # Cookie security (set True when behind HTTPS)
    secure_cookies: bool = False

    # Microsoft Entra SSO
    sso_enabled: bool = False
    sso_client_id: Optional[str] = None
    sso_client_secret: Optional[str] = None
    sso_tenant_id: Optional[str] = None
    sso_redirect_uri: Optional[str] = None

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
        """Build sync database URL for Alembic migrations."""
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
    def master_async_database_url(self) -> Optional[str]:
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
