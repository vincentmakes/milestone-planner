"""
Main FastAPI application entry point.
"""

import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone, date
from pathlib import Path
from typing import Any, AsyncGenerator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
import json

from app import __version__
from app.config import get_settings
from app.database import init_db, close_db


def format_datetime_js(dt: datetime) -> str:
    """
    Format datetime to match JavaScript's toISOString().
    
    Node.js outputs: "2025-12-08T09:01:16.715Z"
    """
    if dt is None:
        return None
    
    if dt.tzinfo is None:
        # Assume UTC for naive datetimes
        formatted = dt.strftime('%Y-%m-%dT%H:%M:%S')
        ms = dt.microsecond // 1000
        return f"{formatted}.{ms:03d}Z"
    else:
        # Convert to UTC and format
        utc_dt = dt.astimezone(timezone.utc)
        formatted = utc_dt.strftime('%Y-%m-%dT%H:%M:%S')
        ms = utc_dt.microsecond // 1000
        return f"{formatted}.{ms:03d}Z"


def format_date_js(d: date) -> str:
    """
    Format date to match Node.js date serialization.
    
    Node.js stores dates as timestamps at midnight UTC, which when 
    serialized becomes the previous day at 23:00:00.000Z due to timezone.
    
    For consistency, we'll output as ISO date string since that's what
    the database actually stores, and it's cleaner.
    """
    if d is None:
        return None
    return d.isoformat()


def custom_json_serializer(obj: Any) -> Any:
    """Custom JSON serializer for non-standard types."""
    if isinstance(obj, datetime):
        return format_datetime_js(obj)
    if isinstance(obj, date):
        return format_date_js(obj)
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def convert_floats_to_ints(obj: Any) -> Any:
    """
    Recursively convert float values that are whole numbers to ints.
    
    This matches Node.js behavior where `0.0` is serialized as `0`.
    """
    if isinstance(obj, dict):
        return {k: convert_floats_to_ints(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_floats_to_ints(item) for item in obj]
    elif isinstance(obj, float):
        # Convert whole number floats to ints (0.0 -> 0, 1.0 -> 1)
        if obj.is_integer():
            return int(obj)
        return obj
    return obj


class CustomJSONResponse(JSONResponse):
    """Custom JSON response that formats datetimes like Node.js."""
    
    def render(self, content: Any) -> bytes:
        # Convert whole number floats to ints for Node.js compatibility
        content = convert_floats_to_ints(content)
        return json.dumps(
            content,
            ensure_ascii=False,
            allow_nan=False,
            indent=None,
            separators=(",", ":"),
            default=custom_json_serializer,
        ).encode("utf-8")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """
    Application lifespan handler.
    Initializes database on startup and closes connections on shutdown.
    """
    # Startup
    settings = get_settings()
    print(f"Starting Milestone API v{__version__}")
    print(f"Mode: {'Multi-Tenant' if settings.multi_tenant else 'Single-Tenant'}")
    print(f"Debug: {settings.debug}")
    
    # Initialize tenant database
    await init_db()
    
    # Initialize master database if in multi-tenant mode
    if settings.multi_tenant:
        from app.services.master_db import master_db
        from app.services.tenant_manager import tenant_connection_manager
        
        await master_db.init_db()
        await master_db.verify_admin_exists()
        tenant_connection_manager.start_cleanup_task()
        print("Master database initialized")
    
    yield
    
    # Shutdown
    await close_db()
    
    if settings.multi_tenant:
        from app.services.master_db import master_db
        from app.services.tenant_manager import tenant_connection_manager
        
        await tenant_connection_manager.close_all()
        await master_db.close()
    
    print("Milestone API shutdown complete")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    settings = get_settings()
    
    app = FastAPI(
        title=settings.app_name,
        version=__version__,
        description="Project management API for multi-site R&D organizations",
        lifespan=lifespan,
        docs_url="/api/docs" if settings.debug else None,
        redoc_url="/api/redoc" if settings.debug else None,
        openapi_url="/api/openapi.json" if settings.debug else None,
        default_response_class=CustomJSONResponse,  # Use custom datetime formatting
    )
    
    # CORS middleware - handle credentials properly
    # When allow_credentials=True, we can't use allow_origins=["*"]
    # Must specify exact origins instead
    allowed_origins = [
        "http://localhost:3333",  # Vite dev server
        "http://localhost:8484",  # Production frontend
        "http://localhost:8485",  # Backend (same-origin)
        "http://127.0.0.1:3333",
        "http://127.0.0.1:8484",
        "http://127.0.0.1:8485",
        # LAN access - common private IP ranges
        "http://192.168.1.131:3333",
        "http://192.168.1.131:8484",
        "http://192.168.1.131:8485",
    ]
    
    # Also allow any 192.168.x.x origin dynamically
    # This is handled by a custom CORS handler below
    
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(:\d+)?$",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    
    # Add request timing middleware (for debugging slowness)
    from starlette.middleware.base import BaseHTTPMiddleware
    import time as time_module
    
    class TimingMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            start = time_module.perf_counter()
            response = await call_next(request)
            duration = (time_module.perf_counter() - start) * 1000
            if duration > 100:  # Only log slow requests (>100ms)
                print(f"SLOW REQUEST: {request.method} {request.url.path} took {duration:.0f}ms")
            return response
    
    app.add_middleware(TimingMiddleware)
    
    # Note: Tenant middleware is added at the end of create_app() by wrapping the app
    
    # Include routers
    from app.routers import (
        health, 
        settings as settings_router, 
        predefined_phases, 
        sites,
        staff,
        equipment,
        vacations,
        notes,
        auth,
        users,
        projects,
        assignments,
        mpp_import,
        export,
        admin,
    )
    
    app.include_router(health.router, tags=["Health"])
    app.include_router(auth.router, prefix="/api", tags=["Authentication"])
    app.include_router(users.router, prefix="/api", tags=["Users"])
    app.include_router(settings_router.router, prefix="/api", tags=["Settings"])
    app.include_router(predefined_phases.router, prefix="/api", tags=["Predefined Phases"])
    app.include_router(sites.router, prefix="/api", tags=["Sites"])
    app.include_router(staff.router, prefix="/api", tags=["Staff"])
    app.include_router(equipment.router, prefix="/api", tags=["Equipment"])
    app.include_router(vacations.router, prefix="/api", tags=["Vacations"])
    app.include_router(notes.router, prefix="/api", tags=["Notes"])
    app.include_router(projects.router, prefix="/api", tags=["Projects"])
    app.include_router(assignments.router, prefix="/api", tags=["Assignments"])
    app.include_router(mpp_import.router, prefix="/api", tags=["Import"])
    app.include_router(export.router, prefix="/api", tags=["Export"])
    
    # Admin router for multi-tenant management (at /api/admin/*)
    app.include_router(admin.router, prefix="/api", tags=["Admin"])
    
    # Static file serving for frontend
    public_dir = Path("/app/public")
    if not public_dir.exists():
        # Also check relative path for local development
        public_dir = Path("./public")
    
    if public_dir.exists():
        # Check which subdirectories exist and mount them
        if (public_dir / "css").exists():
            app.mount("/css", StaticFiles(directory=public_dir / "css"), name="css")
        if (public_dir / "js").exists():
            app.mount("/js", StaticFiles(directory=public_dir / "js"), name="js")
        if (public_dir / "images").exists():
            app.mount("/images", StaticFiles(directory=public_dir / "images"), name="images")
        if (public_dir / "img").exists():
            app.mount("/img", StaticFiles(directory=public_dir / "img"), name="img")
        if (public_dir / "fonts").exists():
            app.mount("/fonts", StaticFiles(directory=public_dir / "fonts"), name="fonts")
        
        # Root route - serve index.html
        @app.get("/")
        async def serve_root():
            """Serve the main index.html."""
            index_file = public_dir / "index.html"
            if index_file.exists():
                return FileResponse(index_file)
            return JSONResponse(
                status_code=404,
                content={"error": "Frontend not found - index.html missing"}
            )
        
        # Admin route - serve main index.html (React SPA handles /admin routing)
        @app.get("/admin")
        @app.get("/admin/")
        async def serve_admin():
            """Serve the admin panel (React SPA)."""
            # For React SPA, admin is handled by client-side routing
            # So we serve the main index.html
            index_file = public_dir / "index.html"
            if index_file.exists():
                return FileResponse(index_file)
            # Fallback to legacy admin if it exists
            admin_index = public_dir / "admin" / "index.html"
            if admin_index.exists():
                return FileResponse(admin_index)
            return JSONResponse(
                status_code=404,
                content={"error": "Admin panel not found"}
            )
        
        # SPA fallback - serve index.html for non-API routes
        @app.get("/{full_path:path}")
        async def serve_spa(request: Request, full_path: str):
            """Serve the SPA frontend for non-API routes."""
            # Don't serve index.html for API routes
            if full_path.startswith("api/"):
                return JSONResponse(
                    status_code=404,
                    content={"error": "Not found"}
                )
            
            # Check for static file first
            static_file = public_dir / full_path
            if static_file.exists() and static_file.is_file():
                return FileResponse(static_file)
            
            # Check for directory with index.html (e.g., /admin/)
            if static_file.is_dir():
                dir_index = static_file / "index.html"
                if dir_index.exists():
                    return FileResponse(dir_index)
            
            # Fall back to index.html for SPA routing
            index_file = public_dir / "index.html"
            if index_file.exists():
                return FileResponse(index_file)
            
            return JSONResponse(
                status_code=404,
                content={"error": "Frontend not found"}
            )
    else:
        # No frontend - return helpful message
        @app.get("/")
        async def no_frontend():
            return JSONResponse(
                status_code=404,
                content={
                    "error": "Frontend not found",
                    "message": "Copy your frontend files to /app/public or ./public",
                    "api_status": "API is running - access /health or /api/* endpoints"
                }
            )
    
    # Global exception handler
    @app.exception_handler(Exception)
    async def global_exception_handler(request: Request, exc: Exception):
        """Handle uncaught exceptions."""
        print(f"Unhandled exception: {exc}")
        return JSONResponse(
            status_code=500,
            content={"error": str(exc)},
        )
    
    return app


def create_wrapped_app():
    """Create app and wrap with tenant middleware if multi-tenant mode."""
    app = create_app()
    settings = get_settings()
    
    if settings.multi_tenant:
        from app.middleware.tenant import TenantMiddleware
        # Wrap the entire app with tenant middleware
        # This ensures URL rewriting happens BEFORE FastAPI routing
        return TenantMiddleware(app)
    
    return app


# Create app instance
app = create_wrapped_app()


if __name__ == "__main__":
    import uvicorn
    
    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=settings.port,
        reload=settings.debug,
    )
