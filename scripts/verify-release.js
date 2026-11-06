import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { unzip, zipNames } from "./zip.js";

/**
 * Rebuilds a release's Chrome and Firefox zips from its tag, as the release
 * workflow builds them, and compares them with the zips the release published:
 * byte for byte, then file by file where they differ. The tag is built in a
 * new worktree; --keep keeps it, to look at. --from takes the release's zips
 * from a folder instead of GitHub.
 *
 *   node scripts/verify-release.js v0.4.0 [--from <folder>] [--keep]
 */

const RELEASES = "https://github.com/dusk-network/wallet/releases/download";
const TARGETS = { chrome: "dist", firefox: "dist-firefox" };

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args.splice(at, 2)[1];
};
const from = option("--from");
const keep = args.includes("--keep");
const [tag] = args.filter((arg) => arg !== "--keep");

if (!tag) {
  console.error("Usage: node scripts/verify-release.js <tag> [--from <folder>] [--keep]");
  process.exit(2);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...gitArgs) => execFileSync("git", gitArgs, { encoding: "utf8" }).trim();
const download = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
};

try {
  git("rev-parse", "--verify", "--quiet", `${tag}^{commit}`);
} catch {
  git("fetch", "--quiet", "origin", "tag", tag);
}

const dir = mkdtempSync(join(tmpdir(), "wallet-verify-"));
let differ = 0;

try {
  git("worktree", "add", "--quiet", "--detach", dir, tag);

  const nvmrc = join(dir, ".nvmrc");
  const pinned = existsSync(nvmrc) && readFileSync(nvmrc, "utf8").trim().replace(/^v?/, "v");
  if (pinned && pinned !== process.version) {
    console.warn(`${tag} is built with Node ${pinned}, not ${process.version}: its zips may differ.`);
  }

  // The build reads DUSK_ settings for local debugging: none of them here.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("DUSK_") && key !== "NODE_ENV")
  );
  const npm = (...npmArgs) => {
    try {
      execFileSync("npm", npmArgs, { cwd: dir, env, stdio: ["ignore", "ignore", "pipe"] });
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
    const released = from
      ? readFileSync(join(from, name))
      : await download(`${RELEASES}/${tag}/${name}`);
    const rebuilt = zip?.(join(dir, out));

    console.log(`${sha256(released)}  ${name}, released`);
    if (rebuilt) console.log(`${sha256(rebuilt)}  ${name}, rebuilt`);
    if (rebuilt?.equals(released)) {
      console.log("  The same, byte for byte.");
      continue;
    }

    // File by file: the release's against the rebuild's.
    const files = unzip(released);
    const problems = [];
    for (const [path, data] of files) {
      const own = join(dir, out, path);
      if (!existsSync(own)) problems.push(`${path}: not in the rebuild`);
      else if (!readFileSync(own).equals(data)) problems.push(`${path}: differs`);
    }
    for (const path of rebuilt ? unzip(rebuilt).keys() : zipNames(join(dir, out))) {
      if (!files.has(path)) problems.push(`${path}: not in the release`);
    }

    differ += 1;
    for (const problem of problems) console.log(`  ${problem}`);
    console.log(
      problems.length
        ? `  ${problems.length} files differ.`
        : `  Its ${files.size} files are the rebuild's, zipped ${rebuilt ? "differently" : "before zips were reproducible"}.`
    );
  }
} finally {
  if (keep) console.log(`The rebuild is kept in ${dir}`);
  else git("worktree", "remove", "--force", dir);
}

process.exit(differ ? 1 : 0);
