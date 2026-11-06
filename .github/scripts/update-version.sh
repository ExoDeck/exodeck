#!/bin/bash
# update-version.sh - Update version.go with a new version number
#
# Usage: ./update-version.sh <version>
# Example: ./update-version.sh 1.2.3

set -e

VERSION=${1:-dev}

cat > version.go <<EOF
package main

// Version is set at build time via -ldflags "-X main.Version=<ver>".
// Falls back to "${VERSION}" when built without the flag (e.g. \`go run .\`).
var Version = "${VERSION}"
EOF

echo "Updated version.go with version: ${VERSION}"
