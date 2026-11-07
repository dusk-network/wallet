import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unzip, zipNames } from "./zip.js";

/**
 * Rebuilds a release's Chrome and Firefox zips from its tag, as the release
 * workflow builds them, and compares them with the zips the release published:
 * byte for byte, then file by file where they differ. The tag is built in a
 * new worktree, its line endings as committed, with at least the npm it asks
 * for; --keep keeps it, to look at. --from takes the release's zips from a
 * folder instead of GitHub.
 *
 *   node scripts/verify-release.js v0.4.0 [--from <folder>] [--keep]
 */

const RELEASES = "https://github.com/dusk-network/wallet/releases/download";
const TARGETS = { chrome: "dist", firefox: "dist-firefox" };
const MAX_ZIP = 2 ** 28;

/**
 * What's wrong with a release's zip, against its rebuild in a folder and the
 * zip the tag's scripts/zip.js made of it: nothing when the zips are the same
 * byte for byte. A tag from before scripts/zip.js has no rebuilt zip, and only
 * its files are compared.
 */
export function compareRelease(released, rebuilt, folder) {
  if (rebuilt?.equals(released)) return [];

  const files = unzip(released);
  const problems = [];

  for (const [path, data] of files) {
    const own = join(folder, path);

    if (!statSync(own, { throwIfNoEntry: false })?.isFile()) problems.push(`${path}: not in the rebuild`);
    else if (!readFileSync(own).equals(data)) problems.push(`${path}: differs`);
  }

  for (const path of rebuilt ? unzip(rebuilt).keys() : zipNames(folder)) {
    if (!files.has(path)) problems.push(`${path}: not in the release`);
  }

  if (rebuilt && !problems.length) {
    problems.push(`its ${files.size} files are the rebuild's, zipped differently`);
  }

  return problems;
}

/** npm's own script beside this Node, where it's there. */
const npmBeside = () =>
  ["node_modules/npm/bin/npm-cli.js", "../lib/node_modules/npm/bin/npm-cli.js"]
    .map((path) => join(dirname(process.execPath), path))
    .find((path) => existsSync(path));

/**
 * How to run npm with the arguments given: from npm's own script, as this
 * Node, where it's beside it, since on Windows npm and npx are .cmd files,
 * which only a shell runs; npm on the PATH otherwise. With a version, that
 * npm, as npx gets it.
 */
export function npmCommand(version, args, cli = npmBeside()) {
  const own = version ? ["exec", "--yes", `--package=npm@${version}`, "--", "npm", ...args] : args;

  return cli ? [process.execPath, [cli, ...own]] : ["npm", own];
}

// Run, not imported by the tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args.splice(at, 2)[1];
  };
  const from = option("--from");
  const keep = args.includes("--keep");
  const [tag, ...rest] = args.filter((arg) => arg !== "--keep");

  if (!/^\w[\w.-]*$/.test(tag ?? "") || rest.length) {
    console.error("Usage: node scripts/verify-release.js <tag> [--from <folder>] [--keep]");
    process.exit(2);
  }

  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const git = (...gitArgs) => execFileSync("git", gitArgs, { encoding: "utf8", stdio: "pipe" }).trim();
  const download = async (url) => {
    const response = await fetch(url);
    const chunks = [];
    let size = 0;

    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_ZIP) throw new Error(`${url}: over 256 MiB`);
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  };

  try {
    git("rev-parse", "--verify", "--quiet", `${tag}^{commit}`);
  } catch {
    git("fetch", "--quiet", "origin", "tag", tag);
  }

  const dir = mkdtempSync(join(tmpdir(), "wallet-verify-"));
  let differ = 0;

  try {
    // Line endings as committed: Vite copies public/ as it finds it.
    git("-c", "core.autocrlf=false", "worktree", "add", "--quiet", "--detach", dir, tag);

    const nvmrc = join(dir, ".nvmrc");
    const pinned = existsSync(nvmrc) && readFileSync(nvmrc, "utf8").trim().replace(/^v?/, "v");
    if (pinned && pinned !== process.version) {
      console.warn(`${tag} is built with Node ${pinned}, not ${process.version}: its zips may differ.`);
    }

    // At least the npm the tag asks for, which Node's own may not be.
    const { engines } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const floor = engines?.npm?.match(/^>=\s*(\d+\.\d+\.\d+)$/)?.[1];
    // The build reads DUSK_ settings for local debugging: none of them here.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(DUSK_|NODE_ENV$|NODE_OPTIONS$)/.test(key))
    );
    const npm = (...npmArgs) => {
      try {
        execFileSync(...npmCommand(floor, npmArgs), { cwd: dir, env, stdio: ["ignore", "ignore", "pipe"] });
      } catch (error) {
        // What npm or the build said, only when it fails.
        process.stderr.write(error.stderr ?? "");
        throw error;
      }
    };

    console.log(`Building ${tag} in ${dir}`);
    npm("ci", "--ignore-scripts", "--no-audit", "--no-fund");

    // The tag's own packer; a tag from before there was one was zipped otherwise.
    const packer = join(dir, "scripts/zip.js");
    const { zip } = existsSync(packer) ? await import(pathToFileURL(packer)) : {};

    for (const [target, out] of Object.entries(TARGETS)) {
      npm("run", `build:${target}`);

      const name = `dusk-wallet-${target}-${tag}.zip`;
      const released = from ? readFileSync(join(from, name)) : await download(`${RELEASES}/${tag}/${name}`);
      const rebuilt = zip?.(join(dir, out));
      const problems = compareRelease(released, rebuilt, join(dir, out));

      console.log(`${sha256(released)}  ${name}, released`);
      if (rebuilt) console.log(`${sha256(rebuilt)}  ${name}, rebuilt`);
      for (const problem of problems) console.log(`  ${problem}`);
      if (problems.length) differ += 1;
      console.log(
        problems.length
          ? `  It differs from the rebuild.`
          : rebuilt
            ? "  The same, byte for byte."
            : "  Its files are the rebuild's; it was zipped before zips were reproducible."
      );
    }
  } finally {
    if (keep) console.log(`The rebuild is kept in ${dir}`);
    else git("worktree", "remove", "--force", dir);
  }

  process.exit(differ ? 1 : 0);
}
