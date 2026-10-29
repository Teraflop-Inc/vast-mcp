#!/bin/sh
# Builds the package file npm would publish (never publishes; package.json is private),
# installs it into an empty project, and checks both entry points work from the install.
set -eu
root=$(pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tarball=$(npm pack --silent --pack-destination "$work")
cd "$work"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "$work/$tarball"
node -e 'import("vast-mcp/hosted").then((m) => { if (typeof m.createHttpHandler !== "function") process.exit(1); })'
node node_modules/vast-mcp/dist/index.js --http --port 8797 &
pid=$!
ok=1
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:8797/health >/dev/null 2>&1; then ok=0; break; fi
  sleep 1
done
kill $pid
[ $ok -eq 0 ] || { echo "pack-check: installed server did not answer /health"; exit 1; }
echo "pack-check: installed package works ($tarball)"
cd "$root"
