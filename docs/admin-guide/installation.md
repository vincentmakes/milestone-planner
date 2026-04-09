# Installation

## Quick Start (Fresh Install)

The fastest way to get Milestone running with a self-contained PostgreSQL instance:

```bash
# Clone the repository
git clone https://github.com/vincentmakes/milestone-planner.git
cd milestone-planner

# Create environment file
cp .env.example .env
# Edit .env — at minimum set SESSION_SECRET to a random string

# Start everything (PostgreSQL + app)
docker compose -f docker-compose.fresh.yml up -d
```

The fresh install will:

1. Start a PostgreSQL 15 container
2. Wait for database readiness
3. Auto-create databases and apply schema
4. Seed a default admin user
5. Start the application

Check the logs for the generated admin password:

```bash
docker logs milestone-fresh
```

Access the application at `http://localhost:8486/`.

## Production Deployment

For production with an external PostgreSQL instance:

### 1. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your production settings:

```bash
# Database
DB_HOST=your-db-host
DB_PORT=5432
DB_NAME=milestone
DB_USER=milestone
DB_PASSWORD=<strong-password>

# Security (generate with: python -c "import secrets; print(secrets.token_hex(32))")
SESSION_SECRET=<64-char-random-string>
SECRET_KEY=<64-char-random-string>

# HTTPS
SECURE_COOKIES=true
```

### 2. Set Up Database

```bash
psql -U postgres -f setup_databases.sql
```

Or manually:

```sql
CREATE DATABASE milestone;
CREATE USER milestone WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE milestone TO milestone;
\c milestone
-- Run the tenant schema from setup_databases.sql
```

### 3. Start the Application

```bash
docker compose up -d
```

### 4. Create First User

```bash
psql -U milestone -d milestone

INSERT INTO users (email, password, first_name, last_name, role)
VALUES (
    'admin@example.com',
    '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/X4.G6J8EHyFj2YQXW',
    'Admin', 'User', 'admin'
);
```

!!! warning
    Change the default password immediately after first login.

### 5. Enable Multi-Tenant Mode (Optional)

See [Multi-Tenant Management](multi-tenant.md) for SaaS deployment configuration.

## GitHub Codespaces (Demo / Development)

Launch a fully configured development environment in your browser:

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/vincentmakes/milestone-planner?quickstart=1)

The Codespace includes:

- Python 3.11 with all backend dependencies
- Node.js 20 with frontend dependencies
- PostgreSQL 15 (auto-configured)
- VS Code extensions for Python, TypeScript, Docker
- Forwarded ports: 8485 (app), 3333 (Vite dev), 5432 (PostgreSQL)
- **Pre-seeded demo tenant** with sample projects, staff, and equipment

After the Codespace starts, run:

```bash
# Start the backend
uvicorn app.main:app --host 0.0.0.0 --port 8485 --reload

# In a separate terminal, start the frontend dev server
cd frontend && npm run dev -- --host 0.0.0.0 --port 3333
```

### Demo Credentials

| Access | URL | Email | Password |
|--------|-----|-------|----------|
| **Admin Portal** | `/admin/` | `admin@demo.local` | `demo1234` |
| **Demo Tenant** | `/t/demo/` | `admin@demo.local` | `demo1234` |

The demo tenant includes:

- **2 sites**: Winterthur (CH), Frankfurt (DE)
- **4 projects** with phases, staff assignments, and timeline data
- **8 staff members** with skills and site assignments
- **8 equipment items** across both sites
- **6 skills** (Project Management, HPLC, Data Analysis, Cell Culture, Technical Writing, Quality Control)

All staff accounts use password `demo1234`.

## Reverse Proxy (SSL/TLS)

For production, place a reverse proxy (nginx, Caddy, or Cloudflare Tunnel) in front of port 8485:

=== "nginx"

    ```nginx
    server {
        listen 443 ssl http2;
        server_name milestone.example.com;

        ssl_certificate     /etc/ssl/certs/milestone.pem;
        ssl_certificate_key /etc/ssl/private/milestone.key;

        location / {
            proxy_pass http://127.0.0.1:8485;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;

            # WebSocket support
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
        }
    }
    ```

=== "Caddy"

    ```
    milestone.example.com {
        reverse_proxy localhost:8485
    }
    ```

Set `SECURE_COOKIES=true` in `.env` when serving over HTTPS.

## Ports

| Port | Service | Description |
|------|---------|-------------|
| 8485 | FastAPI | Production application (API + frontend) |
| 8486 | FastAPI | Fresh install default (configurable via `FRESH_APP_PORT`) |
| 3333 | Vite | Frontend dev server with hot reload |
| 5432 | PostgreSQL | Database (default) |
| 5433 | PostgreSQL | Fresh install DB (configurable via `FRESH_DB_PORT`) |
