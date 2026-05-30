import path from "node:path";

export function localW3sperAlias() {
  const root = process.env.DUSK_W3SPER_LOCAL;
  if (!root) return {};

  return {
    "@dusk/exu": path.resolve("node_modules/@jsr/dusk__exu/src/mod.js"),
    "@dusk/w3sper": path.resolve(root, "src/mod.js"),
  };
}
