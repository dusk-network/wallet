import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareRelease } from "./verify-release.js";
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

  it("from elsewhere are refused where a name reaches out of the build, or a file holds more than the zip says", () => {
    const named = zip(build(["zz/x.js"], 0o644, new Date(), { "zz/x.js": "x" }));
    const escaping = Buffer.from(named.toString("latin1").replaceAll("zz/x.js", "../x.js"), "latin1");
    const packed = zip(build(Object.keys(FILES)));
    const bomb = Buffer.from(packed);

    // The central directory's own record of chunks/b.js, 46 bytes before its name, says 1 byte.
    bomb.writeUInt32LE(1, packed.lastIndexOf(Buffer.from("chunks/b.js")) - 46 + 24);

    expect(() => unzip(escaping)).toThrow("names oddly");
    expect(() => unzip(bomb)).toThrow();
    expect(unzip(packed).size).toBe(5);
  });
});

describe("checking a release", () => {
  it("passes a tag zipped before scripts/zip.js when its files are the rebuild's, and a later tag only byte for byte", () => {
    const folder = build(Object.keys(FILES));
    const ours = zip(folder);
    const changed = zip(build(Object.keys(FILES), 0o644, new Date(), { ...FILES, "popup.js": "steal();\n" }));

    expect(compareRelease(ours, ours, folder)).toEqual([]);
    expect(compareRelease(Buffer.concat([ours, Buffer.from([0])]), ours, folder)).toEqual([
      "its 5 files are the rebuild's, zipped differently",
    ]);
    expect(compareRelease(ours, undefined, folder)).toEqual([]);
    expect(compareRelease(changed, undefined, folder)).toEqual(["popup.js: differs"]);
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
