#!/usr/bin/env bash
# Refactor: Move src/ files into layered architecture (core/, framework/, utils/)
set -euo pipefail
cd "$(dirname "$0")/.."

# ── 1. Create directories ──
mkdir -p src/core src/framework src/utils

# ── 2. Move files ──
# core/
mv src/client.ts      src/core/client.ts
mv src/config.ts      src/core/config.ts
mv src/errors.ts      src/core/errors.ts
mv src/logger.ts      src/core/logger.ts
mv src/runtime.ts     src/core/runtime.ts
mv src/update-check.ts src/core/update-check.ts

# framework/
mv src/command-dispatch.ts  src/framework/command-dispatch.ts
mv src/command-framework.ts src/framework/command-framework.ts
mv src/command-registry.ts  src/framework/command-registry.ts
mv src/command-validation.ts src/framework/command-validation.ts
mv src/help.ts              src/framework/help.ts
mv src/completion.ts        src/framework/completion.ts
mv src/plugin-loader.ts     src/framework/plugin-loader.ts
mv src/plugin-registry.ts   src/framework/plugin-registry.ts
mv src/plugin-version.ts    src/framework/plugin-version.ts

# utils/
mv src/date-filter.ts        src/utils/date-filter.ts
mv src/ignore.ts             src/utils/ignore.ts
mv src/mcp-proxy-helpers.ts  src/utils/mcp-proxy-helpers.ts
mv src/open-helpers.ts       src/utils/open-helpers.ts
mv src/resource-extensions.ts src/utils/resource-extensions.ts
mv src/search-helpers.ts     src/utils/search-helpers.ts
mv src/watch-constants.ts    src/utils/watch-constants.ts

echo "Files moved. Now updating imports..."

# ── 3. Update imports in src/core/ files ──
# runtime.ts: logger.ts stays same dir
# logger.ts: runtime.ts stays same dir
# config.ts: logger.ts, runtime.ts stay same dir
# client.ts: config.ts, logger.ts, runtime.ts stay same dir
# errors.ts: logger.ts, runtime.ts stay same dir
# update-check.ts: config.ts, logger.ts, runtime.ts stay same dir
# No cross-directory imports in core/ — all stays same

# ── 4. Update imports in src/framework/ files ──
# All internal imports change from "./X.ts" to "../core/X.ts"
# All framework-internal imports stay "./X.ts"

for f in src/framework/command-dispatch.ts \
         src/framework/command-framework.ts \
         src/framework/command-registry.ts \
         src/framework/command-validation.ts \
         src/framework/help.ts \
         src/framework/completion.ts \
         src/framework/plugin-loader.ts \
         src/framework/plugin-registry.ts \
         src/framework/plugin-version.ts; do
  # Replace "./config.ts" → "../core/config.ts"
  sed -i '' 's|from "./config\.ts"|from "../core/config.ts"|g' "$f"
  # Replace "./logger.ts" → "../core/logger.ts"
  sed -i '' 's|from "./logger\.ts"|from "../core/logger.ts"|g' "$f"
  # Replace "./runtime.ts" → "../core/runtime.ts"
  sed -i '' 's|from "./runtime\.ts"|from "../core/runtime.ts"|g' "$f"
  # Replace "./errors.ts" → "../core/errors.ts"
  sed -i '' 's|from "./errors\.ts"|from "../core/errors.ts"|g' "$f"
  # Replace "./client.ts" → "../core/client.ts"
  sed -i '' 's|from "./client\.ts"|from "../core/client.ts"|g' "$f"
  # Replace "./update-check.ts" → "../core/update-check.ts"
  sed -i '' 's|from "./update-check\.ts"|from "../core/update-check.ts"|g' "$f"
done

# ── 5. Update imports in src/utils/ files ──
# mcp-proxy-helpers.ts: logger.ts → ../core/logger.ts
sed -i '' 's|from "./logger\.ts"|from "../core/logger.ts"|g' src/utils/mcp-proxy-helpers.ts

# ── 6. Update imports in src/commands/ files ──
# All "../X.ts" → "../core/X.ts" for core files
# All "../X.ts" → "../framework/X.ts" for framework files
# All "../X.ts" → "../utils/X.ts" for utils files
# All "./X.ts" stays same (commands-internal)
# All "./helpers/X.ts" stays same

for f in src/commands/*.ts; do
  sed -i '' 's|from "../client\.ts"|from "../core/client.ts"|g' "$f"
  sed -i '' 's|from "../config\.ts"|from "../core/config.ts"|g' "$f"
  sed -i '' 's|from "../errors\.ts"|from "../core/errors.ts"|g' "$f"
  sed -i '' 's|from "../logger\.ts"|from "../core/logger.ts"|g' "$f"
  sed -i '' 's|from "../runtime\.ts"|from "../core/runtime.ts"|g' "$f"
  sed -i '' 's|from "../command-framework\.ts"|from "../framework/command-framework.ts"|g' "$f"
  sed -i '' 's|from "../command-registry\.ts"|from "../framework/command-registry.ts"|g' "$f"
  sed -i '' 's|from "../command-validation\.ts"|from "../framework/command-validation.ts"|g' "$f"
  sed -i '' 's|from "../help\.ts"|from "../framework/help.ts"|g' "$f"
  sed -i '' 's|from "../completion\.ts"|from "../framework/completion.ts"|g' "$f"
  sed -i '' 's|from "../plugin-loader\.ts"|from "../framework/plugin-loader.ts"|g' "$f"
  sed -i '' 's|from "../plugin-registry\.ts"|from "../framework/plugin-registry.ts"|g' "$f"
  sed -i '' 's|from "../plugin-version\.ts"|from "../framework/plugin-version.ts"|g' "$f"
  sed -i '' 's|from "../date-filter\.ts"|from "../utils/date-filter.ts"|g' "$f"
  sed -i '' 's|from "../ignore\.ts"|from "../utils/ignore.ts"|g' "$f"
  sed -i '' 's|from "../mcp-proxy-helpers\.ts"|from "../utils/mcp-proxy-helpers.ts"|g' "$f"
  sed -i '' 's|from "../open-helpers\.ts"|from "../utils/open-helpers.ts"|g' "$f"
  sed -i '' 's|from "../resource-extensions\.ts"|from "../utils/resource-extensions.ts"|g' "$f"
  sed -i '' 's|from "../search-helpers\.ts"|from "../utils/search-helpers.ts"|g' "$f"
  sed -i '' 's|from "../watch-constants\.ts"|from "../utils/watch-constants.ts"|g' "$f"
done

# Update commands/helpers/deploy-helpers.ts
for f in src/commands/helpers/*.ts; do
  sed -i '' 's|from "../../client\.ts"|from "../../core/client.ts"|g' "$f"
  sed -i '' 's|from "../../config\.ts"|from "../../core/config.ts"|g' "$f"
  sed -i '' 's|from "../../errors\.ts"|from "../../core/errors.ts"|g' "$f"
  sed -i '' 's|from "../../logger\.ts"|from "../../core/logger.ts"|g' "$f"
  sed -i '' 's|from "../../runtime\.ts"|from "../../core/runtime.ts"|g' "$f"
  sed -i '' 's|from "../../ignore\.ts"|from "../../utils/ignore.ts"|g' "$f"
  sed -i '' 's|from "../../resource-extensions\.ts"|from "../../utils/resource-extensions.ts"|g' "$f"
done

# ── 7. Update imports in src/index.ts ──
sed -i '' 's|from "./client\.ts"|from "./core/client.ts"|g' src/index.ts
sed -i '' 's|from "./command-dispatch\.ts"|from "./framework/command-dispatch.ts"|g' src/index.ts
sed -i '' 's|from "./command-framework\.ts"|from "./framework/command-framework.ts"|g' src/index.ts
sed -i '' 's|from "./command-registry\.ts"|from "./framework/command-registry.ts"|g' src/index.ts
sed -i '' 's|from "./command-validation\.ts"|from "./framework/command-validation.ts"|g' src/index.ts
sed -i '' 's|from "./help\.ts"|from "./framework/help.ts"|g' src/index.ts
sed -i '' 's|from "./completion\.ts"|from "./framework/completion.ts"|g' src/index.ts
sed -i '' 's|from "./plugin-loader\.ts"|from "./framework/plugin-loader.ts"|g' src/index.ts
sed -i '' 's|from "./config\.ts"|from "./core/config.ts"|g' src/index.ts
sed -i '' 's|from "./logger\.ts"|from "./core/logger.ts"|g' src/index.ts
sed -i '' 's|from "./runtime\.ts"|from "./core/runtime.ts"|g' src/index.ts
sed -i '' 's|from "./update-check\.ts"|from "./core/update-check.ts"|g' src/index.ts

# ── 8. Update imports in tests/ ──
for f in tests/unit/*.ts; do
  sed -i '' 's|from "../../src/client\.ts"|from "../../src/core/client.ts"|g' "$f"
  sed -i '' 's|from "../../src/config\.ts"|from "../../src/core/config.ts"|g' "$f"
  sed -i '' 's|from "../../src/errors\.ts"|from "../../src/core/errors.ts"|g' "$f"
  sed -i '' 's|from "../../src/logger\.ts"|from "../../src/core/logger.ts"|g' "$f"
  sed -i '' 's|from "../../src/runtime\.ts"|from "../../src/core/runtime.ts"|g' "$f"
  sed -i '' 's|from "../../src/command-framework\.ts"|from "../../src/framework/command-framework.ts"|g' "$f"
  sed -i '' 's|from "../../src/command-registry\.ts"|from "../../src/framework/command-registry.ts"|g' "$f"
  sed -i '' 's|from "../../src/command-validation\.ts"|from "../../src/framework/command-validation.ts"|g' "$f"
  sed -i '' 's|from "../../src/help\.ts"|from "../../src/framework/help.ts"|g' "$f"
  sed -i '' 's|from "../../src/completion\.ts"|from "../../src/framework/completion.ts"|g' "$f"
  sed -i '' 's|from "../../src/plugin-loader\.ts"|from "../../src/framework/plugin-loader.ts"|g' "$f"
  sed -i '' 's|from "../../src/plugin-registry\.ts"|from "../../src/framework/plugin-registry.ts"|g' "$f"
  sed -i '' 's|from "../../src/plugin-version\.ts"|from "../../src/framework/plugin-version.ts"|g' "$f"
  sed -i '' 's|from "../../src/date-filter\.ts"|from "../../src/utils/date-filter.ts"|g' "$f"
  sed -i '' 's|from "../../src/ignore\.ts"|from "../../src/utils/ignore.ts"|g' "$f"
  sed -i '' 's|from "../../src/mcp-proxy-helpers\.ts"|from "../../src/utils/mcp-proxy-helpers.ts"|g' "$f"
  sed -i '' 's|from "../../src/open-helpers\.ts"|from "../../src/utils/open-helpers.ts"|g' "$f"
  sed -i '' 's|from "../../src/resource-extensions\.ts"|from "../../src/utils/resource-extensions.ts"|g' "$f"
  sed -i '' 's|from "../../src/search-helpers\.ts"|from "../../src/utils/search-helpers.ts"|g' "$f"
  sed -i '' 's|from "../../src/update-check\.ts"|from "../../src/core/update-check.ts"|g' "$f"
done

# ── 9. Update imports in default-plugins/ ──
for f in default-plugins/bpmn/lint.ts \
         default-plugins/bpmn/c8ctl-plugin.ts \
         default-plugins/feel/c8ctl-plugin.ts \
         default-plugins/element-template/helpers.ts \
         default-plugins/element-template/c8ctl-plugin.ts; do
  sed -i '' 's|from "../../src/logger\.ts"|from "../../src/core/logger.ts"|g' "$f"
  sed -i '' 's|from "../../src/runtime\.ts"|from "../../src/core/runtime.ts"|g' "$f"
  sed -i '' 's|from "../../src/plugin-loader\.ts"|from "../../src/framework/plugin-loader.ts"|g' "$f"
done

# default-plugins/element-template/commands/*.ts
for f in default-plugins/element-template/commands/*.ts; do
  sed -i '' 's|from "../../../src/runtime\.ts"|from "../../../src/core/runtime.ts"|g' "$f"
done

# ── 10. Update imports in scripts/ ──
sed -i '' 's|from "../src/command-registry\.ts"|from "../src/framework/command-registry.ts"|g' scripts/sync-readme-commands.ts

echo "Import updates complete."
echo ""
echo "Verifying no stale files remain in src/ root..."
ls src/*.ts 2>/dev/null || echo "(none - all moved)"
