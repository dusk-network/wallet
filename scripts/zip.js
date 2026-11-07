import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Release zips that come out the same from the same files, wherever and
 * whenever they're made: the files sorted by path, with one time (1980-01-01,
 * the format's first day) and one mode (rw-r--r--), no extra fields and no
 * folder entries. Sourcemaps stay in the build, for debugging, but out of the
 * zip.
 *
 *   node scripts/zip.js <build folder> <zip>
 */

const FIRST_DAY = (1 << 5) | 1; // 1980-01-01 as a DOS date; its time is 0
const FILE_MODE = 0o100644; // a regular file, rw-r--r--

/** Little-endian fields, each [bytes, value]. */
const fields = (...pairs) =>
  Buffer.concat(
    pairs.map(([bytes, value]) => {
      const field = Buffer.alloc(bytes);
      field.writeUIntLE(value, 0, bytes);
      return field;
    })
  );

/** The build's files, but sourcemaps, by their path in it with "/". */
export function zipNames(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".map"))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

/** Zips a build's files, deflated where that makes them smaller. */
export function zip(dir) {
  const paths = zipNames(dir);
  const entries = [];
  const directory = [];
  let offset = 0;

  for (const path of paths) {
    const data = readFileSync(join(dir, path));
    const deflated = deflateRawSync(data, { level: 9 });
    const [method, body] = deflated.length < data.length ? [8, deflated] : [0, data];
    const name = Buffer.from(path, "utf8");
    // Version 2.0, UTF-8 names, the method, 1980-01-01 00:00, the CRC and
    // sizes, the name's length, and no extra field.
    const header = [
      [2, 20], [2, 0x0800], [2, method], [2, 0], [2, FIRST_DAY],
      [4, crc32(data)], [4, body.length], [4, data.length], [2, name.length], [2, 0],
    ];

    entries.push(fields([4, 0x04034b50], ...header), name, body);
    // Made on Unix, so the mode holds; no comment, disk 0, no attributes.
    directory.push(
      fields([4, 0x02014b50], [2, 0x0314], ...header, [2, 0], [2, 0], [2, 0],
        [4, FILE_MODE * 0x10000], [4, offset]),
      name
    );
    offset += 30 + name.length + body.length;
  }

  const listing = Buffer.concat(directory);
  const count = paths.length;

  return Buffer.concat([
    ...entries,
    listing,
    // The end: disk 0, all of the entries, where their listing is, no comment.
    fields([4, 0x06054b50], [2, 0], [2, 0], [2, count], [2, count],
      [4, listing.length], [4, offset], [2, 0]),
  ]);
}

/** A path in a build: folders and a file, in plain text, none "." or "..". */
export const isBuildPath = (path) =>
  typeof path === "string" &&
  path.length <= 512 &&
  path.split("/").every((part) => /^[\x20-\x7e]{1,128}$/.test(part) && !/[\\:]|^\.\.?$/.test(part));

const MAX_INFLATED = 2 ** 28; // All a zip from elsewhere may hold, inflated.

/**
 * A zip's files, by name; folders left out. A zip from elsewhere is read as
 * any reader would read it, or refused: its listing fills the space before
 * its end, and its files the space before the listing, one after another,
 * each as listed. No name twice or reaching out of the build, and no more
 * than 256 MiB inflated, which is known before anything is inflated.
 */
export function unzip(bytes) {
  const refuse = (what) => {
    throw new Error(`The zip ${what}`);
  };
  const u16 = (at) => bytes.readUInt16LE(at);
  const u32 = (at) => bytes.readUInt32LE(at);
  const end = bytes.length - 22;

  if (end < 0 || u32(end) !== 0x06054b50 || u16(end + 20)) refuse("doesn't end as a zip does");

  const count = u16(end + 10);
  const listing = u32(end + 16);

  if (u32(end + 4) || u16(end + 8) !== count || listing + u32(end + 12) !== end) {
    refuse("lists its files oddly");
  }

  const entries = [];
  const seen = new Set();
  let inflated = 0;
  let at = listing;

  // The listing, record by record, which must fill it.
  for (let left = count; left > 0; left -= 1) {
    if (at + 46 > end || u32(at) !== 0x02014b50) refuse("lists its files oddly");

    const name = bytes.toString("utf8", at + 46, at + 46 + u16(at + 28));
    const path = name.replace(/\/$/, "");
    const entry = { flags: u16(at + 8), method: u16(at + 10), crc: u32(at + 16), packed: u32(at + 20) };

    Object.assign(entry, { size: u32(at + 24), local: u32(at + 42), name });
    if (!isBuildPath(path) || seen.has(path.toLowerCase())) refuse("holds a file named oddly, or twice");
    if (entry.flags & 0b1001 || ![0, 8].includes(entry.method)) refuse(`packs ${name} as it isn't read`);
    seen.add(path.toLowerCase());
    inflated += entry.size;
    if (inflated > MAX_INFLATED) refuse("holds more than 256 MiB");
    entries.push(entry);
    at += 46 + u16(at + 28) + u16(at + 30) + u16(at + 32);
  }

  if (at !== end) refuse("lists its files oddly");

  // The files, one after another from the start to the listing, each as listed.
  let next = 0;

  for (const entry of [...entries].sort((a, b) => a.local - b.local)) {
    const { local } = entry;

    if (local !== next || local + 30 > listing || u32(local) !== 0x04034b50) {
      refuse("holds something it doesn't list");
    }

    const nameLength = u16(local + 26);
    const same =
      u16(local + 6) === entry.flags &&
      u16(local + 8) === entry.method &&
      u32(local + 14) === entry.crc &&
      u32(local + 18) === entry.packed &&
      u32(local + 22) === entry.size &&
      bytes.toString("utf8", local + 30, local + 30 + nameLength) === entry.name;

    if (!same) refuse(`says two things of ${entry.name}`);
    entry.start = local + 30 + nameLength + u16(local + 28);
    next = entry.start + entry.packed;
  }

  if (next !== listing) refuse("holds something it doesn't list");

  const files = new Map();

  for (const { crc, method, name, packed, size, start } of entries) {
    const body = bytes.subarray(start, start + packed);
    const data = method === 8 ? inflateRawSync(body, { maxOutputLength: Math.max(size, 1) }) : body;

    if (data.length !== size || crc32(data) !== crc) refuse(`gives ${name} other than it says`);
    if (!name.endsWith("/")) files.set(name, data);
  }

  return files;
}

// Run, not imported by scripts/verify-release.js.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  writeFileSync(out, zip(dir));
}
