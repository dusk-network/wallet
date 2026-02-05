import fs from "node:fs";
import path from "node:path";

/**
 * Build-time generator for HTML shells.
 *
 * Why:
 * - Extension builds ship static HTML shells from /public (popup/full/options/etc.)
 * - Tauri dev uses the project root index.html (Vite serves / from repo root)
 * - These shells were drifting as they are mostly copy/paste
 *
 * This script makes the shells deterministic from a single source.
 */

const ROOT = process.cwd();

function withTrailingNewline(s) {
  return s.endsWith("\n") ? s : `${s}\n`;
}

function writeIfChanged(relPath, contents) {
  const absPath = path.resolve(ROOT, relPath);
  const next = withTrailingNewline(contents);

  let prev = null;
  try {
    prev = fs.readFileSync(absPath, "utf8");
  } catch {
    // ignore
  }

  if (prev === next) return false;
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, next, "utf8");
  return true;
}

function networkPill(label = "Loading…") {
  return [
    `<button`,
    `  class="panel-subtitle network-pill"`,
    `  id="network-pill"`,
    `  type="button"`,
    `  aria-haspopup="menu"`,
    `  aria-expanded="false"`,
    `>`,
    `  <span class="network-pill__label">${label}</span>`,
    `  <span class="network-pill__chev" aria-hidden="true">▾</span>`,
    `</button>`,
  ];
}

function brandMarkIcon() {
  return [
    `<div class="brand-mark" aria-hidden="true">`,
    `  <img class="brand-mark__glyph" src="icons/dusk-glyph.svg" alt="" />`,
    `</div>`,
  ];
}

function brandText() {
  return [
    `<div class="brand-text">`,
    `  <div class="panel-title">Dusk Wallet</div>`,
    `</div>`,
  ];
}

function walletShell({
  bodyClass,
  entrySrc,
  cssHref = "ui.css",
  variant, // "popup" | "full"
  extraBeforeScript = "",
  title = "Dusk Wallet",
  initialNetworkLabel = "Loading…",
} = {}) {
  const isFull = variant === "full";

  const lines = [];
  lines.push(`<!doctype html>`);
  lines.push(`<html>`);
  lines.push(`  <head>`);
  lines.push(`    <meta charset="UTF-8" />`);
  lines.push(
    `    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />`
  );
  lines.push(`    <title>${title}</title>`);
  lines.push(`    <link rel="stylesheet" href="${cssHref}" />`);
  lines.push(`  </head>`);
  lines.push(``);
  lines.push(`  <body class="${bodyClass}">`);

  const bodyIndent = "    ";
  const innerIndent = isFull ? "        " : "      ";

  if (isFull) {
    lines.push(`    <div class="full-wrap">`);
    lines.push(`      <div class="panel">`);
  } else {
    lines.push(`    <div class="panel">`);
  }

  // Header
  lines.push(`${innerIndent}<div class="panel-header">`);
  lines.push(`${innerIndent}  <div class="brand">`);
  for (const l of brandMarkIcon()) lines.push(`${innerIndent}    ${l}`);
  if (isFull) {
    for (const l of brandText()) lines.push(`${innerIndent}    ${l}`);
  }
  for (const l of networkPill(initialNetworkLabel)) lines.push(`${innerIndent}    ${l}`);
  lines.push(`${innerIndent}  </div>`);
  lines.push(``);
  lines.push(`${innerIndent}  <div class="header-actions" id="header-actions"></div>`);
  lines.push(`${innerIndent}</div>`);
  lines.push(``);

  // Content
  lines.push(`${innerIndent}<div class="panel-content">`);
  lines.push(`${innerIndent}  <div id="app"></div>`);
  lines.push(`${innerIndent}</div>`);

  // Close wrappers
  if (isFull) {
    lines.push(`      </div>`);
    lines.push(`    </div>`);
  } else {
    lines.push(`    </div>`);
  }

  if (extraBeforeScript) {
    lines.push(``);
    lines.push(`${bodyIndent}${extraBeforeScript}`);
  }

  lines.push(``);
  lines.push(`${bodyIndent}<script type="module" src="${entrySrc}"></script>`);
  lines.push(`  </body>`);
  lines.push(`</html>`);
  return lines.join("\n");
}

function tauriDevIndex() {
  const devComment = `<!--
  Development entrypoint for the Tauri desktop/mobile app.

  Why this file exists:
  - Vite dev server serves \`/\` from the project root's index.html.
  - The extension build uses HTML files in /public (popup.html/full.html/etc.)
    which reference built JS filenames (popup.js) and are copied to dist.
  - In dev mode, those built filenames don't exist; modules are served from /src.

  So this file mirrors the production UI shell but loads /src/popup.js.

  TODO: Find a way to mount this file in a nicer way
-->`;

  return `<!doctype html>
${devComment}
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>Dusk Wallet</title>
    <link rel="stylesheet" href="/ui.css" />
  </head>

  <body class="page--full">
    <div class="full-wrap">
      <div class="panel">
        <div class="panel-header">
          <div class="brand">
            <div class="brand-mark" aria-hidden="true">
              <img class="brand-mark__glyph" src="icons/dusk-glyph.svg" alt="" />
            </div>
            <div class="brand-text">
              <div class="panel-title">Dusk Wallet</div>
            </div>
            <button
              class="panel-subtitle network-pill"
              id="network-pill"
              type="button"
              aria-haspopup="menu"
              aria-expanded="false"
            >
              <span class="network-pill__label">Loading…</span>
              <span class="network-pill__chev" aria-hidden="true">▾</span>
            </button>
          </div>

          <div class="header-actions" id="header-actions"></div>
        </div>

        <div class="panel-content">
          <div id="app"></div>
        </div>
      </div>
    </div>

    <script type="module" src="/src/popup.js"></script>
  </body>
</html>`;
}

const changed = [];

if (
  writeIfChanged(
    "public/popup.html",
    walletShell({
      variant: "popup",
      bodyClass: "page--popup",
      entrySrc: "popup.js",
    })
  )
) {
  changed.push("public/popup.html");
}

if (
  writeIfChanged(
    "public/full.html",
    walletShell({
      variant: "full",
      bodyClass: "page--full",
      entrySrc: "popup.js",
    })
  )
) {
  changed.push("public/full.html");
}

if (
  writeIfChanged(
    "public/index.html",
    walletShell({
      variant: "full",
      bodyClass: "page--full",
      entrySrc: "popup.js",
      extraBeforeScript:
        "<!-- For the extension, this is also used by full.html/popup.html. For Tauri desktop/mobile, it's convenient to have a default index.html. -->",
    })
  )
) {
  changed.push("public/index.html");
}

if (
  writeIfChanged(
    "public/options.html",
    walletShell({
      variant: "full",
      bodyClass: "page--full page--options",
      entrySrc: "popup.js",
    })
  )
) {
  changed.push("public/options.html");
}

// Tauri dev server entrypoint.
if (writeIfChanged("index.html", tauriDevIndex())) {
  changed.push("index.html");
}

if (changed.length) {
  // eslint-disable-next-line no-console
  console.log(`Generated shells: ${changed.join(", ")}`);
}
