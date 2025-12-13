#!/bin/bash
# Deploy React frontend to backend public folder
# This allows accessing the app through the backend (port 8485)
# which properly handles tenant routing (/t/slug/)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIST="$SCRIPT_DIR/frontend/dist"
PUBLIC_DIR="$SCRIPT_DIR/public"

echo "=== Deploying React Frontend ==="

# Check if dist exists
if [ ! -d "$FRONTEND_DIST" ]; then
    echo "Error: frontend/dist not found. Run 'npm run build' first."
    exit 1
fi

# Remove old vanilla JS files completely
echo "Removing old vanilla JS files..."
rm -rf "$PUBLIC_DIR/admin" 2>/dev/null || true
rm -rf "$PUBLIC_DIR/css" 2>/dev/null || true
rm -rf "$PUBLIC_DIR/js" 2>/dev/null || true
rm -rf "$PUBLIC_DIR/assets" 2>/dev/null || true
rm -f "$PUBLIC_DIR/index.html" 2>/dev/null || true

# Copy React build to public
echo "Copying React build..."
cp -r "$FRONTEND_DIST"/* "$PUBLIC_DIR/"

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Access URLs (all on port 8485):"
echo "  Main app:    http://your-server:8485/"
echo "  Tenant URLs: http://your-server:8485/t/tenant-slug/"
echo "  Admin panel: http://your-server:8485/admin/"
echo ""
echo "Restart the backend container to apply changes:"
echo "  docker-compose restart milestone-api"
echo "  OR"
echo "  docker-compose -f docker-compose.react-dev.yml restart milestone-api"
