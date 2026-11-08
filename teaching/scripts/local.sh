#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
command -v java >/dev/null 2>&1 || { echo 'Install Java 17 or newer.' >&2; exit 1; }
if [ -f teaching/mars-trace.jar ]; then
  exec java -Djava.awt.headless=true -cp teaching/mars-trace.jar mars.ide.Server "${1:-8765}"
fi
command -v javac >/dev/null 2>&1 || { echo 'Source checkout needs JDK 17 or newer (including javac).' >&2; exit 1; }
exec sh teaching/scripts/start.sh "${1:-8765}"
