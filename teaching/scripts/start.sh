#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
sh teaching/scripts/build.sh
exec java -Djava.awt.headless=true -cp teaching/build/classes mars.ide.Server "${1:-8765}"
