export function w3sperOwnedWorkerPlugin() {
  return {
    name: "dusk-w3sper-owned-worker",
    apply: "build",
    enforce: "pre",
    transform(code, id) {
      const normalizedId = String(id || "").replace(/\\/g, "/");
      if (!normalizedId.includes("@dusk/w3sper/src/network/syncer/address.js")) {
        return null;
      }

      let transformed = code;
      let changed = false;

      const workerUrlPattern =
        /function\s+workerURL\(\)\s*\{\s*return\s+new URL\("\.\/owned_worker\.js",\s*import\.meta\.url\);\s*\}/m;

      if (workerUrlPattern.test(transformed)) {
        transformed = transformed.replace(
          workerUrlPattern,
          `function workerURL() {
  throw new Error("W3sper owned-note workers are disabled in extension builds");
}`
        );
        changed = true;
      }

      const readerPattern =
        /([ \t]*)const\s+reader\s*=\s*getBYOBReader\(response\.body\);\s*\n\s*const\s+stream\s*=\s*new ReadableStream\(\{/m;

      if (readerPattern.test(transformed)) {
        transformed = transformed.replace(
          readerPattern,
          `$1const reader = getBYOBReader(response.body);
$1let streamCanceled = false;
$1const cancelSource = async (reason) => {
$1  streamCanceled = true;
$1  workerPool?.close();
$1  try {
$1    await reader.cancel(reason);
$1  } catch {
$1    // ignore cancellation races
$1  }
$1};

$1const stream = new ReadableStream({`
        );
        changed = true;
      }

      const readDonePattern =
        /([ \t]*)const\s+\{\s*done,\s*value\s*\}\s*=\s*await\s+reader\.read\(buffer\);\s*\n\s*if\s*\(done\)\s*\{/m;

      if (readDonePattern.test(transformed)) {
        transformed = transformed.replace(
          readDonePattern,
          `$1const { done, value } = await reader.read(buffer);

$1if (streamCanceled) {
$1  return;
$1}

$1if (done) {`
        );
        changed = true;
      }

      const mapDonePattern =
        /([ \t]*):\s*await\s+ProtocolDriver\.mapOwned\(profiles,\s*value\);\s*\n\s*const\s+progress\s*=\s*Number\(/m;

      if (mapDonePattern.test(transformed)) {
        transformed = transformed.replace(
          mapDonePattern,
          `$1: await ProtocolDriver.mapOwned(profiles, value);

$1if (streamCanceled) {
$1  return;
$1}

$1const progress = Number(`
        );
        changed = true;
      }

      const enqueuePattern =
        /([ \t]*)\/\/ Enqueue the result \[owned, syncInfo\] into the stream\s*\n\s*controller\.enqueue\(\[owned, syncInfo\]\);/m;

      if (enqueuePattern.test(transformed)) {
        transformed = transformed.replace(
          enqueuePattern,
          `$1// Enqueue the result [owned, syncInfo] into the stream.
$1// A consumer can cancel the stream while the async pull is still mapping notes.
$1if (streamCanceled) {
$1  return;
$1}
$1controller.enqueue([owned, syncInfo]);`
        );
        changed = true;
      }

      const catchPattern =
        /([ \t]*)\}\s*catch\s*\(error\)\s*\{\s*\n\s*console\.error\("Error processing stream:",\s*error\);\s*\n\s*workerPool\?\.close\(\);\s*\n\s*await\s+reader\.cancel\(error\);\s*\n\s*controller\.error\(error\);\s*\n\s*\}/m;

      if (catchPattern.test(transformed)) {
        transformed = transformed.replace(
          catchPattern,
          `$1} catch (error) {
$1  if (streamCanceled) {
$1    return;
$1  }
$1  console.error("Error processing stream:", error);
$1  await cancelSource(error);
$1  try {
$1    controller.error(error);
$1  } catch {
$1    // ignore closed-controller races
$1  }
$1}`
        );
        changed = true;
      }

      const cancelPattern =
        /([ \t]*)cancel\(reason\)\s*\{\s*\n\s*workerPool\?\.close\(\);\s*\n\s*console\.log\("Stream canceled:",\s*reason\);\s*\n\s*\}/m;

      if (cancelPattern.test(transformed)) {
        transformed = transformed.replace(
          cancelPattern,
          `$1cancel(reason) {
$1  return cancelSource(reason);
$1}`
        );
        changed = true;
      }

      if (!changed) return null;

      return {
        code: transformed,
        map: null,
      };
    },
  };
}

export function exuSandboxWorkerPlugin() {
  return {
    name: "dusk-exu-sandbox-worker",
    apply: "build",
    transform(code, id) {
      const normalizedId = String(id || "").replace(/\\/g, "/");
      if (!normalizedId.includes("dusk__exu/src/sandbox/mod.js")) {
        return null;
      }

      const blobPattern =
        /const\s+workerUrl\s*=\s*URL\.createObjectURL\([\s\S]*?\);/m;

      if (!blobPattern.test(code)) return null;

      const replacement = `function getWorkerUrl() {
  if (typeof browser !== "undefined" && browser.runtime && browser.runtime.getURL) {
    return browser.runtime.getURL("exu-sandbox-worker.js");
  }
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL("exu-sandbox-worker.js");
  }
  return "exu-sandbox-worker.js";
}
const workerUrl = getWorkerUrl();`;

      const importPattern =
        /import\s+worker\s+from\s+["']\.\/worker\.js["']\s*;?/;

      return {
        code: code.replace(blobPattern, replacement).replace(importPattern, ""),
        map: null,
      };
    },
  };
}
