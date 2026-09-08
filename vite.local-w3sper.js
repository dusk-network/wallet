import path from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Remove this backport when the published SDK includes its upstream reader fix.
export function w3sperStreamCompat() {
  const entry = createRequire(import.meta.url).resolve("@dusk/w3sper");
  const target = path.join(path.dirname(entry), "protocol-driver/stream.js");
  return {
    name: "dusk-w3sper-stream-compat",
    enforce: "pre",
    // Dev dependency prebundling would otherwise bypass the module load hook.
    config: () => ({ optimizeDeps: { exclude: ["@dusk/w3sper"] } }),
    load(id) {
      if (id !== target) return null;
      const pkg = JSON.parse(readFileSync(path.join(path.dirname(entry), "../package.json"), "utf8"));
      if (pkg.version !== "1.7.0-rc.0") {
        throw new Error("Review/remove the W3sper stream backport when upgrading the SDK");
      }
      return readFileSync(new URL("./src/vendor/w3sper-stream.js", import.meta.url), "utf8");
    },
  };
}

export function localW3sperAlias() {
  const root = process.env.DUSK_W3SPER_LOCAL;
  if (!root) return {};

  return {
    "@dusk/exu": path.resolve("node_modules/@jsr/dusk__exu/src/mod.js"),
    "@dusk/w3sper": path.resolve(root, "src/mod.js"),
  };
}
