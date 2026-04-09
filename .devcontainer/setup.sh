#!/bin/bash
set -e

echo "=== Milestone Planner — Codespaces Setup ==="

# Install Python dependencies
pip install --no-cache-dir -r requirements.txt -r requirements-dev.txt

# Install frontend dependencies
cd frontend && npm install && cd ..

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

echo ""
echo "=============================================="
echo "  Setup complete!"
echo "=============================================="
echo ""
echo "  Start the app:"
echo "    uvicorn app.main:app --host 0.0.0.0 --port 8485 --reload"
echo ""
echo "  Start frontend dev server (optional):"
echo "    cd frontend && npm run dev -- --host 0.0.0.0 --port 3333"
echo ""
echo "  ---- Demo Credentials ----"
echo ""
echo "  Admin Portal:  http://localhost:8485/admin/"
echo "    Email:       admin@demo.local"
echo "    Password:    demo1234"
echo ""
echo "  Demo Tenant:   http://localhost:8485/t/demo/"
echo "    Email:       admin@demo.local"
echo "    Password:    demo1234"
echo ""
echo "  The demo tenant includes 4 projects, 8 staff,"
echo "  8 equipment items, skills, and assignments."
echo "=============================================="
echo ""
