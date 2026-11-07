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

/**
 * A zip's files, by name, from its central directory; folders left out. A
 * zip from elsewhere is refused where a name could reach out of the build, or
 * a file holds other than what the zip says.
 */
export function unzip(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const files = new Map();

  if (end === -1) throw new Error("It isn't a zip");

  let at = bytes.readUInt32LE(end + 16);

  for (let left = bytes.readUInt16LE(end + 10); left > 0; left -= 1) {
    const method = bytes.readUInt16LE(at + 10);
    const crc = bytes.readUInt32LE(at + 16);
    const [packed, size] = [bytes.readUInt32LE(at + 20), bytes.readUInt32LE(at + 24)];
    const nameLength = bytes.readUInt16LE(at + 28);
    const name = bytes.toString("utf8", at + 46, at + 46 + nameLength);
    const local = bytes.readUInt32LE(at + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const body = bytes.subarray(start, start + packed);

    if (!isBuildPath(name.replace(/\/$/, "")) || ![0, 8].includes(method) || size > 2 ** 28) {
      throw new Error("It holds a file it names oddly");
    }

    const data = method === 8 ? inflateRawSync(body, { maxOutputLength: Math.max(size, 1) }) : body;

    if (data.length !== size || crc32(data) !== crc) throw new Error(`${name} isn't what the zip says`);
    if (!name.endsWith("/")) files.set(name, data);
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }

  return files;
}

// Run, not imported by scripts/verify-release.js.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  writeFileSync(out, zip(dir));
}
