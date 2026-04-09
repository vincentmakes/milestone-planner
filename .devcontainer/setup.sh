#!/bin/bash
set -e

echo "=== Milestone Planner — Codespaces Setup ==="

# Install Python dependencies
pip install --no-cache-dir -r requirements.txt -r requirements-dev.txt

# Install frontend dependencies and build
cd frontend && npm install && npm run build && cd ..

# Deploy built frontend to public/ so the backend can serve it
echo "Deploying frontend build to public/..."
cp -r frontend/dist/* public/ 2>/dev/null || true

# Wait for PostgreSQL
echo "Waiting for PostgreSQL..."
for i in $(seq 1 30); do
    if python -c "import socket; s=socket.socket(); s.settimeout(2); s.connect(('db', 5432)); s.close()" 2>/dev/null; then
        echo "PostgreSQL is ready."
        break
    fi
    echo "  Attempt $i/30..."
    sleep 2
done

# Initialize master database (creates schema + platform admin user)
echo "Initializing master database..."
python -m app.scripts.init_db || echo "DB init skipped (may already exist)."

# Seed demo tenant with sample data
echo "Seeding demo tenant..."
python -m app.scripts.seed_demo || echo "Demo seed skipped (may already exist)."

# Start uvicorn in the background so the app is ready immediately
echo "Starting Milestone Planner..."
nohup uvicorn app.main:app --host 0.0.0.0 --port 8485 --reload > /tmp/uvicorn.log 2>&1 &

# Wait for the server to be ready
for i in $(seq 1 15); do
    if curl -sf http://localhost:8485/health > /dev/null 2>&1; then
        break
    fi
    sleep 1
done

echo ""
echo "=============================================="
echo "  Milestone Planner is running!"
echo "=============================================="
echo ""
echo "  App:           http://localhost:8485/t/demo/"
echo "  Admin Portal:  http://localhost:8485/admin/"
echo ""
echo "  ---- Demo Credentials ----"
echo "  Email:         admin@demo.local"
echo "  Password:      demo1234"
echo ""
echo "  Server logs:   tail -f /tmp/uvicorn.log"
echo "=============================================="
echo ""
