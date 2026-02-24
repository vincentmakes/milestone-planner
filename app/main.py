"""
Main FastAPI application entry point.
"""

import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.config import get_settings
from app.database import close_db, init_db


def format_datetime_js(dt: datetime) -> str:
    """
    Format datetime to match JavaScript's toISOString().

    Node.js outputs: "2025-12-08T09:01:16.715Z"
    """
    if dt is None:
        return None

    if dt.tzinfo is None:
        # Assume UTC for naive datetimes
        formatted = dt.strftime("%Y-%m-%dT%H:%M:%S")
        ms = dt.microsecond // 1000
        return f"{formatted}.{ms:03d}Z"
    else:
        # Convert to UTC and format
        utc_dt = dt.astimezone(UTC)
        formatted = utc_dt.strftime("%Y-%m-%dT%H:%M:%S")
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

    # Log proxy configuration
    if settings.https_proxy or settings.http_proxy or settings.proxy_pac_url:
        print("Proxy Configuration:")
        if settings.https_proxy:
            print(f"  HTTPS_PROXY: {settings.https_proxy}")
        if settings.http_proxy:
            print(f"  HTTP_PROXY: {settings.http_proxy}")
        if settings.proxy_pac_url:
            print(f"  PROXY_PAC_URL: {settings.proxy_pac_url}")
    else:
        print("Proxy Configuration: None")

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
        # Disable default docs - we'll add protected versions
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        default_response_class=CustomJSONResponse,  # Use custom datetime formatting
    )

    # CORS middleware - handle credentials properly
    # When allow_credentials=True, we can't use allow_origins=["*"]
    if settings.cors_origins:
        # Production: use explicitly configured origins
        allowed_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
    elif settings.debug:
        # Debug only: allow localhost dev servers
        allowed_origins = [
            "http://localhost:3333",  # Vite dev server
            "http://localhost:8484",
            "http://localhost:8485",
            "http://127.0.0.1:3333",
            "http://127.0.0.1:8484",
            "http://127.0.0.1:8485",
        ]
    else:
        # Production without explicit config: same-origin only (empty list)
        allowed_origins = []

    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Accept", "Authorization"],
    )

    # Note: Request timing middleware removed because @app.middleware("http")
    # uses BaseHTTPMiddleware internally which interferes with WebSocket connections.
    # If timing middleware is needed, implement as pure ASGI middleware.

    # Note: Tenant middleware is added at the end of create_app() by wrapping the app

    # Include routers
    from app.routers import (
        admin,
        admin_organizations,
        assignments,
        auth,
        custom_columns,
        equipment,
        export,
        health,
        mpp_import,
        notes,
        predefined_phases,
        projects,
        sites,
        skills,
        staff,
        users,
        vacations,
    )
    from app.routers import (
        settings as settings_router,
    )
    from app.websocket import router as websocket_router

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
    app.include_router(custom_columns.router, prefix="/api", tags=["Custom Columns"])
    app.include_router(skills.router, prefix="/api", tags=["Skills"])

    # WebSocket for real-time collaboration
    app.include_router(websocket_router, tags=["WebSocket"])

    # Admin routers for multi-tenant management (at /api/admin/*)
    app.include_router(admin.router, prefix="/api", tags=["Admin"])
    app.include_router(admin_organizations.router, prefix="/api", tags=["Admin Organizations"])

    # Protected API documentation endpoints (require admin authentication)
    from fastapi.openapi.docs import get_redoc_html, get_swagger_ui_html
    from fastapi.openapi.utils import get_openapi

    from app.middleware.auth import get_current_user_from_session

    @app.get("/api/openapi.json", include_in_schema=False)
    async def get_openapi_schema(request: Request):
        """Get OpenAPI schema - requires authentication."""
        user = await get_current_user_from_session(request)
        if not user or user.get("role") != "admin":
            return JSONResponse(
                status_code=401, content={"error": "Authentication required. Admin access only."}
            )
        return JSONResponse(
            get_openapi(
                title=app.title,
                version=app.version,
                description=app.description,
                routes=app.routes,
            )
        )

    @app.get("/api/docs", include_in_schema=False)
    async def get_docs(request: Request):
        """Swagger UI - requires authentication."""
        user = await get_current_user_from_session(request)
        if not user or user.get("role") != "admin":
            return HTMLResponse(
                content="""
                <html>
                <head><title>API Docs - Authentication Required</title></head>
                <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a1a; color: #fff;">
                    <div style="text-align: center;">
                        <h1>🔒 Authentication Required</h1>
                        <p>You must be logged in as an admin to access API documentation.</p>
                        <p><a href="/" style="color: #4a90e2;">← Go to Login</a></p>
                    </div>
                </body>
                </html>
                """,
                status_code=401,
            )
        return get_swagger_ui_html(
            openapi_url="/api/openapi.json", title=f"{app.title} - Swagger UI"
        )

    @app.get("/api/redoc", include_in_schema=False)
    async def get_redoc(request: Request):
        """ReDoc - requires authentication."""
        user = await get_current_user_from_session(request)
        if not user or user.get("role") != "admin":
            return HTMLResponse(
                content="""
                <html>
                <head><title>API Docs - Authentication Required</title></head>
                <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a1a; color: #fff;">
                    <div style="text-align: center;">
                        <h1>🔒 Authentication Required</h1>
                        <p>You must be logged in as an admin to access API documentation.</p>
                        <p><a href="/" style="color: #4a90e2;">← Go to Login</a></p>
                    </div>
                </body>
                </html>
                """,
                status_code=401,
            )
        return get_redoc_html(openapi_url="/api/openapi.json", title=f"{app.title} - ReDoc")

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
        # Vite builds to /assets folder
        if (public_dir / "assets").exists():
            app.mount("/assets", StaticFiles(directory=public_dir / "assets"), name="assets")

        # Root route - serve index.html
        @app.get("/")
        async def serve_root():
            """Serve the main index.html."""
            index_file = public_dir / "index.html"
            if index_file.exists():
                return FileResponse(index_file)
            return JSONResponse(
                status_code=404, content={"error": "Frontend not found - index.html missing"}
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
            return JSONResponse(status_code=404, content={"error": "Admin panel not found"})

        # SPA fallback - serve index.html for non-API routes
        @app.get("/{full_path:path}")
        async def serve_spa(request: Request, full_path: str):
            """Serve the SPA frontend for non-API routes."""
            # Debug: log all requests hitting this endpoint
            print(f"[SPA Fallback] path={full_path}, method={request.method}")

            # Don't serve index.html for API routes
            if full_path.startswith("api/"):
                return JSONResponse(status_code=404, content={"error": "Not found"})

            # Don't serve index.html for WebSocket endpoint
            # Handle both /ws and /t/{tenant}/ws patterns
            if (
                full_path == "ws"
                or full_path.startswith("ws/")
                or full_path.endswith("/ws")
                or "/ws" in full_path
            ):
                print(f"[SPA Fallback] WebSocket path detected: {full_path}, returning 426")
                return JSONResponse(
                    status_code=426,  # Upgrade Required
                    content={"error": "WebSocket endpoint - use ws:// or wss:// protocol"},
                    headers={"Upgrade": "websocket"},
                )

            # Check for static file first (with path traversal protection)
            public_root = public_dir.resolve()
            static_file = (public_root / full_path.lstrip("/")).resolve()
            try:
                static_file.relative_to(public_root)
            except ValueError:
                return JSONResponse(status_code=400, content={"error": "Invalid path"})

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

            return JSONResponse(status_code=404, content={"error": "Frontend not found"})
    else:
        # No frontend - return helpful message
        @app.get("/")
        async def no_frontend():
            return JSONResponse(
                status_code=404,
                content={
                    "error": "Frontend not found",
                    "message": "Copy your frontend files to /app/public or ./public",
                    "api_status": "API is running - access /health or /api/* endpoints",
                },
            )

    # Global exception handler
    @app.exception_handler(Exception)
    async def global_exception_handler(request: Request, exc: Exception):
        """Handle uncaught exceptions."""
        import traceback

        print(f"Unhandled exception on {request.method} {request.url.path}: {exc}")
        traceback.print_exc()
        # Don't leak internal error details to clients
        return JSONResponse(
            status_code=500,
            content={"error": "Internal server error"},
        )

    return app


def create_wrapped_app():
    """Create app and wrap with tenant middleware if multi-tenant mode."""
    app = create_app()
    settings = get_settings()

    print(f"[App Startup] MULTI_TENANT setting = {settings.multi_tenant}")

    if settings.multi_tenant:
        print("[App Startup] Wrapping app with TenantMiddleware")
        from app.middleware.tenant import TenantMiddleware

        # Wrap the entire app with tenant middleware
        # This ensures URL rewriting happens BEFORE FastAPI routing
        return TenantMiddleware(app)

    print("[App Startup] Running in single-tenant mode (no middleware)")
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
