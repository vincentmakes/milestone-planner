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

# Initialize the database (creates schemas, seeds admin user)
echo "Initializing database..."
python -m app.scripts.init_db || echo "DB init skipped (may already exist)."

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Start the app:     uvicorn app.main:app --host 0.0.0.0 --port 8485 --reload"
echo "Start frontend:    cd frontend && npm run dev -- --host 0.0.0.0 --port 3333"
echo "Run backend tests: pytest"
echo "Run frontend tests: cd frontend && npm test"
echo ""
echo "Admin portal:  http://localhost:8485/admin/"
echo "Login:         admin@demo.local (check logs for password)"
echo ""
