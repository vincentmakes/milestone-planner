#!/bin/bash
# Build script for Cloudflare Pages deployment.
# CF Pages build command: bash docs/build.sh
# CF Pages output directory: site
set -e
pip install -r docs/requirements.txt
mkdocs build --strict
