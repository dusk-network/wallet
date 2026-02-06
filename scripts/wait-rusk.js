const base = String(process.env.DUSK_RUSK_HTTP ?? "http://127.0.0.1:8080").trim();
const timeoutMs = Number(process.env.DUSK_RUSK_WAIT_MS ?? 60_000);
const intervalMs = Number(process.env.DUSK_RUSK_WAIT_INTERVAL_MS ?? 500);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtErr(e) {
  return e?.message ? String(e.message) : String(e);
}

async function main() {
  let url;
  try {
    url = new URL("/on/node/info", base).toString();
  } catch {
    console.error(`Invalid DUSK_RUSK_HTTP: ${base}`);
    process.exit(2);
  }

  const started = Date.now();
  let lastErr = "";

  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { method: "POST" });
      if (res.ok) {
        process.stdout.write(`Rusk ready: ${base}\n`);
        process.exit(0);
      }
      lastErr = `HTTP ${res.status}: ${String(await res.text()).slice(0, 200)}`;
    } catch (e) {
      lastErr = fmtErr(e);
    }

    await sleep(intervalMs);
  }

  console.error(`Timed out waiting for Rusk (${base}). Last error: ${lastErr || "(none)"}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(fmtErr(e));
  process.exit(1);
});

