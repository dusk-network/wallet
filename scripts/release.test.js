import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareRelease, npmCommand } from "./verify-release.js";
import { unzip, zip } from "./zip.js";

const FILES = {
  "popup.js": "console.log('popup');\n",
  "popup.js.map": "{}",
  "chunks/b.js": "export const b = 2;\n".repeat(50),
  "chunks/a.js": "export const a = 1;\n",
  // Four bytes deflate can't shrink, so they're stored.
  "icons/dusk-16.png": "\x89PNG",
  "manifest.json": "{}\n",
};
const builds = [];

/** A build's files, written in the order given, with the mode and time given. */
function build(order, mode = 0o644, time = new Date(), files = FILES) {
  const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
  builds.push(dir);
  for (const path of order) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), files[path], "latin1");
    chmodSync(join(dir, path), mode);
    utimesSync(join(dir, path), time, time);
  }
  return dir;
}

afterEach(() => {
  for (const dir of builds.splice(0)) rmSync(dir, { recursive: true });
});

describe("release zips", () => {
  it("come out the same from the same files, whatever their order on disk, times and modes", () => {
    const names = Object.keys(FILES);
    const one = zip(build(names, 0o644, new Date("2026-01-01T00:00:00Z")));
    const other = zip(build([...names].reverse(), 0o664, new Date("2026-11-06T23:59:59+13:00")));

    expect(other.equals(one)).toBe(true);
  });

  it("hold the build's files by path, sorted, and leave the sourcemaps out", () => {
    const files = unzip(zip(build(Object.keys(FILES), 0o600)));

    expect([...files.keys()]).toEqual([
      "chunks/a.js",
      "chunks/b.js",
      "icons/dusk-16.png",
      "manifest.json",
      "popup.js",
    ]);
    for (const [path, data] of files) {
      expect(data.equals(Buffer.from(FILES[path], "latin1"))).toBe(true);
    }
  });

  it("from elsewhere are refused unless any reader would read them alike, and within bounds", () => {
    const files = { "popup.js": "go();\n", "qopup.js": "go();\n", "zz.js": "evil();\n" };
    const packed = zip(build(Object.keys(files), 0o644, new Date(), files));
    const renamed = (from, to) => Buffer.from(packed.toString("latin1").replaceAll(from, to), "latin1");
    const counting = (count) => {
      const bytes = Buffer.from(packed);
      bytes.writeUInt16LE(count, bytes.length - 14);
      bytes.writeUInt16LE(count, bytes.length - 12);
      return bytes;
    };
    // A file's inflated size, said otherwise before its data and in the listing.
    const sized = (bytes, name, size) => {
      const said = Buffer.from(bytes);
      said.writeUInt32LE(size, said.indexOf(name) - 30 + 22);
      said.writeUInt32LE(size, said.lastIndexOf(name) - 46 + 24);
      return said;
    };

    expect([...unzip(packed).keys()]).toEqual(["popup.js", "qopup.js", "zz.js"]);
    expect(() => unzip(renamed("zz.js", "../zz"))).toThrow("named oddly");
    expect(() => unzip(renamed("qopup.js", "popup.js"))).toThrow("or twice");
    expect(() => unzip(renamed("qopup.js", "Popup.js"))).toThrow("or twice");
    expect(() => unzip(counting(2))).toThrow("lists its files oddly");
    expect(() => unzip(sized(packed, "zz.js", 1))).toThrow("other than it says");
    expect(() => unzip(sized(sized(packed, "popup.js", 2 ** 27), "zz.js", 2 ** 27))).toThrow(
      "more than 256 MiB"
    );
  });
});

describe("checking a release", () => {
  it("passes a tag zipped before scripts/zip.js when its files are the rebuild's, and a later tag only byte for byte", () => {
    const folder = build(Object.keys(FILES));
    const ours = zip(folder);
    const changed = zip(build(Object.keys(FILES), 0o644, new Date(), { ...FILES, "popup.js": "steal();\n" }));

    expect(compareRelease(ours, ours, folder)).toEqual([]);
    const rezipped = Buffer.from(ours);

    // The same files, zipped as on another system: other bytes.
    rezipped.writeUInt16LE(0x0014, rezipped.readUInt32LE(rezipped.length - 6) + 4);
    expect(compareRelease(rezipped, ours, folder)).toEqual([
      "its 5 files are the rebuild's, zipped differently",
    ]);
    expect(compareRelease(ours, undefined, folder)).toEqual([]);
    expect(compareRelease(changed, undefined, folder)).toEqual(["popup.js: differs"]);
  });

  it("runs npm as a script of this Node's, which on Windows a .cmd launcher can't be run without a shell", () => {
    const [command, args] = npmCommand(undefined, ["--version"]);

    expect(command).toBe(process.execPath);
    expect(execFileSync(command, args, { encoding: "utf8" })).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect(npmCommand("11.18.0", ["ci"])[1].slice(1)).toEqual([
      "exec",
      "--yes",
      "--package=npm@11.18.0",
      "--",
      "npm",
      "ci",
    ]);
  });

  it("checks out every file as it was committed, whatever the machine's line endings", () => {
    const committed = execFileSync("git", ["cat-file", "blob", "HEAD:public/manifest.json"]);
    const checkedOut = execFileSync("git", [
      "-c",
      "core.autocrlf=true",
      "cat-file",
      "--filters",
      "HEAD:public/manifest.json",
    ]);

    expect(checkedOut.equals(committed)).toBe(true);
  });
});
