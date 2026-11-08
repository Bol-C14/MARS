#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
sh teaching/scripts/build.sh
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
bundle="$stage/mars-trace-local"
mkdir -p "$bundle/teaching/scripts" teaching/dist
jar --create --file "$bundle/teaching/mars-trace.jar" -C teaching/build/classes .
cp -R teaching/web teaching/examples "$bundle/teaching/"
cp teaching/scripts/local.sh teaching/scripts/local.ps1 "$bundle/teaching/scripts/"
cp teaching/deploy/LOCAL-README.md "$bundle/README.md"
cat > "$bundle/Start.command" <<'LAUNCH'
#!/bin/sh
cd "$(dirname "$0")"
sh teaching/scripts/local.sh
LAUNCH
cat > "$bundle/Start.cmd" <<'LAUNCH'
@echo off
cd /d "%~dp0"
java -Djava.awt.headless=true -cp teaching/mars-trace.jar mars.ide.Server 8765
pause
LAUNCH
chmod +x "$bundle/Start.command"
jar --create --file teaching/dist/mars-trace-local.zip --no-manifest -C "$stage" mars-trace-local
printf 'Created teaching/dist/mars-trace-local.zip\n'
