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

# Verify the build has index.html before touching public/
if [ ! -f "$FRONTEND_DIST/index.html" ]; then
    echo "Error: frontend/dist/index.html not found. Build may have failed."
    exit 1
fi

# Deploy atomically: copy to temp dir, verify, then swap
TEMP_DIR="$SCRIPT_DIR/.public_deploy_tmp"
rm -rf "$TEMP_DIR"
mkdir -p "$TEMP_DIR"

echo "Copying React build to staging directory..."
cp -r "$FRONTEND_DIST"/* "$TEMP_DIR/"

# Preserve non-build assets (e.g., images uploaded at runtime)
if [ -d "$PUBLIC_DIR/img" ] && [ ! -d "$TEMP_DIR/img" ]; then
    cp -r "$PUBLIC_DIR/img" "$TEMP_DIR/img"
fi

# Swap: remove old public contents and move new ones in
echo "Swapping into public/..."
rm -rf "$PUBLIC_DIR/admin" "$PUBLIC_DIR/css" "$PUBLIC_DIR/js" "$PUBLIC_DIR/assets" "$PUBLIC_DIR/index.html" 2>/dev/null || true
cp -r "$TEMP_DIR"/* "$PUBLIC_DIR/"
rm -rf "$TEMP_DIR"

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
