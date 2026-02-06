import { spawn } from "node:child_process";

function run(cmd, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      env: { ...process.env, ...(env ?? {}) },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(0);
      else resolve(code ?? 1);
    });
  });
}

async function main() {
  let exitCode = 1;
  try {
    exitCode = await run("docker", ["compose", "-f", "docker-compose.rusk.yml", "up", "-d"]);
    if (exitCode !== 0) return exitCode;

    exitCode = await run("node", ["scripts/wait-rusk.js"]);
    if (exitCode !== 0) return exitCode;

    // Note: @playwright/test installs the `playwright` binary.
    exitCode = await run("npx", ["playwright", "test"]);
    return exitCode;
  } finally {
    await run("docker", ["compose", "-f", "docker-compose.rusk.yml", "down"]).catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.message ?? String(e));
    process.exit(1);
  });

