#!/bin/sh
# Free, self-hosted static edition: original Java MARS kernel compiled by TeaVM.
set -eu
cd "$(dirname "$0")/../.."
sh teaching/scripts/build.sh
if command -v mvn >/dev/null 2>&1; then
  mars_maven=mvn
else
  mars_tools="$PWD/teaching/build/tools"
  mars_maven="$mars_tools/apache-maven-3.9.11/bin/mvn"
  if [ ! -x "$mars_maven" ]; then
    mkdir -p "$mars_tools"
    curl -fsSL https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.11/apache-maven-3.9.11-bin.tar.gz -o "$mars_tools/maven.tar.gz"
    tar -xzf "$mars_tools/maven.tar.gz" -C "$mars_tools"
    rm "$mars_tools/maven.tar.gz"
  fi
fi
rm -rf teaching/build/browser teaching/dist
mkdir -p teaching/build/browser/classes teaching/dist
cp -R teaching/build/classes/. teaching/build/browser/classes/
python3 teaching/browser/prepare.py
"$mars_maven" -B -ntp -f teaching/browser/pom.xml compile org.teavm:teavm-maven-plugin:0.16.0:compile > teaching/build/browser/compiler.log 2>&1 || {
  cat teaching/build/browser/compiler.log; exit 1;
}
# The IDE lives under app/; the product page is the site's root.
app=teaching/dist/app
mkdir -p "$app"
cp -R teaching/web/. "$app/"
cp teaching/browser/kernel-worker.js "$app/"
cp MARSlicense.txt "$app/"
cp teaching/browser/TEAVM-LICENSE "$app/TEAVM-LICENSE.txt"
python3 teaching/browser/examples.py
mars_build="$(git rev-parse --short HEAD 2>/dev/null || echo local)$(git diff --quiet HEAD -- teaching 2>/dev/null || echo +)"
teaching/node_modules/.bin/esbuild teaching/ui/main.js --bundle --format=esm --define:__MARS_BROWSER__=true --define:__MARS_BUILD__="\"$mars_build\"" --outfile="$app/app.js"
python3 - <<'PY2'
from pathlib import Path
p=Path('teaching/dist/app/index.html')
s=p.read_text().replace('<title>MARS · Trace IDE</title>', '<title>MARS Trace · Browser IDE</title>')
s=s.replace('MARS 4.5 · local core','MARS 4.5 · browser core')
p.write_text(s)
PY2
python3 teaching/site/build.py
printf 'Site built in teaching/dist: product page at /, browser IDE at /app/ (serve with any static HTTP server).\n'
