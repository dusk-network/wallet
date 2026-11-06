import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
function build(order, mode, time) {
  const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
  builds.push(dir);
  for (const path of order) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), FILES[path], "latin1");
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
    const files = unzip(zip(build(Object.keys(FILES), 0o600, new Date())));

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
});
