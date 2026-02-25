# Milestone API - Python/FastAPI Backend
# Multi-stage production build

# ---- Stage 1: Build Python dependencies ----
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

# ---- Stage 2: Build React frontend ----
FROM node:20-alpine AS frontend

WORKDIR /build

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# ---- Stage 3: Production runtime ----
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

# Copy entrypoint and application code
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY app/ ./app/
COPY migrations/ ./migrations/

# Copy frontend build output from Node.js stage
COPY --from=frontend /build/dist/ ./public/
# Copy static images (logos etc.) not produced by Vite
COPY public/img/ ./public/img/

# Create directories, set ownership, and make entrypoint executable
RUN mkdir -p /app/uploads \
    && chmod +x /usr/local/bin/docker-entrypoint.sh \
    && chown -R appuser:appuser /app

USER appuser

ENTRYPOINT ["docker-entrypoint.sh"]

EXPOSE 8485

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:${PORT:-8485}/health || exit 1

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8485}"]
