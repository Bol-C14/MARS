#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
sh teaching/scripts/build.sh
python3 teaching/scripts/start-background.py "${1:-8765}"
