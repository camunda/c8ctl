/**
 * Test fixture for #367 review-comment r11.
 *
 * This fixture's package.json#name is `plugin-with-passthrough`, the
 * same as the canonical fixture. The loader must refuse to import this
 * file at all — i.e. the side effect below must NEVER fire.
 *
 * If `isDuplicatePluginName()` is checked after the dynamic import,
 * Node will execute this module body and the sentinel file will be
 * created. The accompanying test asserts the sentinel does NOT exist
 * after a c8ctl invocation that loads both copies.
 */
import { writeFileSync } from "node:fs";

const sentinelPath = process.env.C8CTL_TEST_DUP_SIDE_EFFECT_SENTINEL;
if (sentinelPath) {
  writeFileSync(sentinelPath, "duplicate-plugin-module-was-imported");
}

export const commands = {
  "should-never-register": async () => {
    console.log("if you see this, the duplicate-name guard failed");
  },
};

export const metadata = {
  name: "plugin-with-passthrough",
  description: "Duplicate-name fixture (must not be imported)",
  commands: {
    "should-never-register": {
      description: "Must never register",
    },
  },
};
