#!/bin/bash
# SessionStart hook for BuildFlow (Claude Code on the web).
#
# BuildFlow is intentionally ZERO-dependency — pure Node + browser ES modules,
# no npm install, no build step — so there is nothing to fetch here. We just
# verify the toolchain so tests (`npm test`) and lint (`npm run lint`) are ready,
# and report status. Synchronous + idempotent.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "SessionStart: node not found on PATH" >&2
  exit 1
fi

echo "BuildFlow ready — Node $(node --version), zero dependencies."
echo "  • run the app:  npm start    (http://localhost:8000)"
echo "  • lint:         npm run lint"
echo "  • tests:        npm test"
