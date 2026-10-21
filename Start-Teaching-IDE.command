#!/bin/sh
set -eu
cd "$(dirname "$0")"
sh teaching/scripts/start-background.sh
if [ "$(uname)" = "Darwin" ]; then
  open http://127.0.0.1:8765
fi
