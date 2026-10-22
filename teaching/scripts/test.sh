#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
sh teaching/scripts/build.sh
rm -rf teaching/build/upstream && mkdir -p teaching/build/upstream
git archive ac3d34ea65c3b8349c4f6c00306bade9e3fec5c9 | tar -x -C teaching/build/upstream
python3 teaching/tests/core_test.py
npm test --prefix teaching
python3 teaching/tests/differential.py
python3 teaching/tests/step_parity.py
