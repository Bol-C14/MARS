#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
mkdir -p teaching/build/classes
find mars teaching/src -name '*.java' > teaching/build/sources.txt
printf '%s\n' Mars.java >> teaching/build/sources.txt
javac --release 17 -encoding UTF-8 -nowarn -d teaching/build/classes @teaching/build/sources.txt 2>teaching/build/compiler.log || { cat teaching/build/compiler.log; exit 1; }
cp *.properties *.txt teaching/build/classes/
cp -R images help teaching/build/classes/
printf 'Built teaching/build/classes\n'
