# Milestone API - Python/FastAPI Backend
# Multi-stage production build

# ---- Stage 1: Build dependencies ----
FROM python:3.11-slim-bookworm AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev \
    gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ---- Stage 2: Production runtime ----
FROM python:3.11-slim-bookworm AS runtime

LABEL org.opencontainers.image.title="milestone-planner" \
      org.opencontainers.image.description="Multi-tenant SaaS R&D project management" \
      org.opencontainers.image.source="https://github.com/vincentmakes/milestone-planner"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    JAVA_HOME=/usr/lib/jvm/default-java \
    PORT=8485

# Install only runtime dependencies (no gcc needed)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    default-jre-headless \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy installed Python packages from builder
COPY --from=builder /install /usr/local

# Create non-root user
RUN useradd --create-home --shell /bin/bash appuser

WORKDIR /app

# Copy application code
COPY app/ ./app/
COPY migrations/ ./migrations/

# Create directories and set ownership
RUN mkdir -p /app/uploads /app/public && chown -R appuser:appuser /app

USER appuser

EXPOSE 8485

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:${PORT:-8485}/health || exit 1

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8485}"]
