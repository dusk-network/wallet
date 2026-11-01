import fs from "node:fs/promises";

const DAY_MS = 24 * 60 * 60 * 1000;
const REGISTRY_ORIGIN = "https://registry.npmjs.org";
// JSR's npm registry, which .npmrc names for the @jsr scope.
const JSR_ORIGIN = "https://npm.jsr.io";
const DEFAULT_CONCURRENCY = 16;

const parseArguments = (args) => {
  const options = {
    concurrency: DEFAULT_CONCURRENCY,
    days: undefined,
    exceptions: ".npm-release-age-exceptions.json",
    lockfile: "package-lock.json",
    npmrc: ".npmrc",
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];

    if (argument === "--days") {
      options.days = Number(value);
    } else if (argument === "--exceptions") {
      options.exceptions = value;
    } else if (argument === "--lockfile") {
      options.lockfile = value;
    } else if (argument === "--npmrc") {
      options.npmrc = value;
    } else if (argument === "--concurrency") {
      options.concurrency = Number(value);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }

    if (value === undefined) {
      throw new Error(`Missing value for ${argument}`);
    }

    index += 1;
  }

  if (!Number.isFinite(options.days) || options.days <= 0) {
    throw new Error("--days must be a positive number");
  }

  if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) {
    throw new Error("--concurrency must be a positive integer");
  }

  return options;
};

// The packages .npmrc exempts from npm's own floor (min-release-age-exclude):
// ours, which we publish and take the same day. They are exempt here too.
const readExemptions = async (file) => {
  const text = await fs.readFile(file, "utf8");

  return text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*min-release-age-exclude(?:\[\])?\s*=\s*(.+?)\s*$/)?.[1])
    .filter(Boolean)
    .flatMap((value) => value.split(","))
    .map((pattern) => pattern.trim())
    .filter(Boolean);
};

// A pattern as npm matches it against a package name, "*" standing for any
// part of a name: "@dusk-network/*", "@jsr/dusk__*".
const patternToRegExp = (pattern) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*")}$`,
  );

const packageNameFromPath = (packagePath) => {
  const marker = "node_modules/";
  const markerIndex = packagePath.lastIndexOf(marker);

  if (markerIndex === -1) {
    throw new Error(`Cannot derive a package name from lockfile path: ${packagePath}`);
  }

  const pathParts = packagePath.slice(markerIndex + marker.length).split("/");
  return pathParts[0].startsWith("@") ? pathParts.slice(0, 2).join("/") : pathParts[0];
};

// The registry a lockfile entry comes from, and its name there (an alias's
// real name): https://npm.jsr.io/~/11/@jsr/dusk__w3sper/1.6.0.tgz is
// @jsr/dusk__w3sper on JSR.
const registryPackageFromResolvedUrl = (resolved, packagePath) => {
  let url;

  try {
    url = new URL(resolved);
  } catch {
    throw new Error(`Unsupported resolved source for ${packagePath}: ${resolved}`);
  }

  if (url.origin === REGISTRY_ORIGIN) {
    const packagePathname = url.pathname.split("/-/")[0].replace(/^\//, "");
    return { name: decodeURIComponent(packagePathname), origin: url.origin };
  }

  const jsrName = url.origin === JSR_ORIGIN && url.pathname.match(/^\/~\/\d+\/(@jsr\/[^/]+)\//)?.[1];

  if (jsrName) {
    return { name: decodeURIComponent(jsrName), origin: url.origin };
  }

  throw new Error(`Non-registry dependency in ${packagePath}: ${resolved}`);
};

const collectRegistryPackages = (lockfile, exemptions) => {
  if (!lockfile.packages || typeof lockfile.packages !== "object") {
    throw new Error("Lockfile does not contain a packages map");
  }

  const packages = new Map();
  let entryCount = 0;
  let exemptCount = 0;

  for (const [packagePath, entry] of Object.entries(lockfile.packages)) {
    if (packagePath === "" || entry.link) {
      continue;
    }

    if (!entry.version || typeof entry.version !== "string") {
      throw new Error(`Lockfile entry has no exact version: ${packagePath}`);
    }

    const { name, origin } = entry.resolved
      ? registryPackageFromResolvedUrl(entry.resolved, packagePath)
      : { name: packageNameFromPath(packagePath), origin: REGISTRY_ORIGIN };

    if (exemptions.some((pattern) => pattern.test(name))) {
      exemptCount += 1;
      continue;
    }

    if (!packages.has(name)) {
      packages.set(name, { origin, versions: new Set() });
    }

    packages.get(name).versions.add(entry.version);
    entryCount += 1;
  }

  return { entryCount, exemptCount, packages };
};

const exceptionKey = (name, version) => JSON.stringify([name, version]);

const readExceptions = async (file, now) => {
  const document = JSON.parse(await fs.readFile(file, "utf8"));

  if (!Array.isArray(document.exceptions)) {
    throw new Error(`${file} must contain an exceptions array`);
  }

  const exceptions = new Map();

  for (const exception of document.exceptions) {
    const { package: name, version, reason, expires } = exception;
    const expiresAt = Date.parse(expires);

    if (
      typeof name !== "string" ||
      typeof version !== "string" ||
      typeof reason !== "string" ||
      reason.trim() === "" ||
      !Number.isFinite(expiresAt)
    ) {
      throw new Error(
        `Invalid release-age exception; expected package, version, reason, and expires: ${JSON.stringify(exception)}`,
      );
    }

    if (expiresAt <= now) {
      throw new Error(`Expired release-age exception: ${name}@${version}`);
    }

    const key = exceptionKey(name, version);

    if (exceptions.has(key)) {
      throw new Error(`Duplicate release-age exception: ${name}@${version}`);
    }

    exceptions.set(key, exception);
  }

  return exceptions;
};

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const fetchPackageMetadata = async (name, origin) => {
  const url = `${origin}/${encodeURIComponent(name)}`;
  let lastError;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "dusk-lockfile-release-age-check/1",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (response.ok) {
        return await response.json();
      }

      const error = new Error(`Registry returned HTTP ${response.status} for ${name}`);

      if (response.status !== 429 && response.status < 500) {
        throw error;
      }

      lastError = error;
    } catch (error) {
      lastError = error;
    }

    await wait(250 * 2 ** attempt);
  }

  throw lastError;
};

const verifyReleaseAges = async ({ concurrency, cutoff, exceptions, packages, now }) => {
  const queue = [...packages.entries()];
  const failures = [];
  const usedExceptions = new Set();
  let queueIndex = 0;

  const worker = async () => {
    while (queueIndex < queue.length) {
      const [name, { origin, versions }] = queue[queueIndex];
      queueIndex += 1;

      let metadata;

      try {
        metadata = await fetchPackageMetadata(name, origin);
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
        continue;
      }

      for (const version of versions) {
        const published = metadata.time?.[version];
        const publishedAt = Date.parse(published);

        if (!published || !Number.isFinite(publishedAt)) {
          failures.push(`${name}@${version}: registry publication timestamp is unavailable`);
          continue;
        }

        if (publishedAt >= cutoff) {
          const key = exceptionKey(name, version);

          if (exceptions.has(key)) {
            usedExceptions.add(key);
            continue;
          }

          const age = ((now - publishedAt) / DAY_MS).toFixed(2);
          failures.push(`${name}@${version}: published ${published} (${age} days old)`);
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));

  for (const [key, exception] of exceptions) {
    if (!usedExceptions.has(key)) {
      failures.push(
        `${exception.package}@${exception.version}: exception is unused and must be removed`,
      );
    }
  }

  return failures;
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  const now = Date.now();
  const cutoff = now - options.days * DAY_MS;
  const lockfile = JSON.parse(await fs.readFile(options.lockfile, "utf8"));
  const exceptions = await readExceptions(options.exceptions, now);
  const exemptions = await readExemptions(options.npmrc);
  const { entryCount, exemptCount, packages } = collectRegistryPackages(
    lockfile,
    exemptions.map(patternToRegExp),
  );
  const failures = await verifyReleaseAges({
    concurrency: options.concurrency,
    cutoff,
    exceptions,
    packages,
    now,
  });

  if (failures.length > 0) {
    throw new Error(
      `Package release-age verification failed (minimum ${options.days} days):\n- ${failures
        .sort()
        .join("\n- ")}`,
    );
  }

  console.log(
    `Verified ${entryCount} lockfile entries across ${packages.size} registry packages are at least ${options.days} days old; ${exemptCount} entries of ${exemptions.join(", ") || "no exempt packages"} (.npmrc's min-release-age-exclude) are exempt.`,
  );
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
