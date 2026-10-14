#!/usr/bin/env bash
# Points git at the repo's version-controlled hooks. Run once after cloning.
set -euo pipefail
cd "$(dirname "$0")/.."
git config --local core.hooksPath .githooks
echo "hooks enabled: $(git config --local --get core.hooksPath)"
