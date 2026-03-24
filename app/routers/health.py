"""
Health check endpoints.
"""

from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app import __version__
from app.config import get_settings
from app.database import get_db

router = APIRouter()


class HealthResponse(BaseModel):
    """Health check response model."""

    status: str
    mode: str
    version: str
    backend: str
    default_tenant: str | None
    timestamp: str
    database: str


@router.get("/health", response_model=HealthResponse)
async def health_check(db: AsyncSession = Depends(get_db)):
    """
    Health check endpoint.
    Returns server status and database connectivity.
    """
    settings = get_settings()

    # Test database connectivity
    db_status = "connected"
    try:
        await db.execute(text("SELECT 1"))
    except Exception as e:
        db_status = f"error: {str(e)}"

    return HealthResponse(
        status="ok",
        mode="multi-tenant" if settings.multi_tenant else "single-tenant",
        version=__version__,
        backend="python-fastapi",
        default_tenant=settings.default_tenant,
        timestamp=datetime.utcnow().isoformat(),
        database=db_status,
    )


@router.get("/api/health")
async def api_health_check(db: AsyncSession = Depends(get_db)):
    """
    API prefixed health check (for consistency with /api/* routes).
    """
    return await health_check(db)
