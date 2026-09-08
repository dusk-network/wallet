import { expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { getBYOBReader } from "./w3sper-stream.js";
import { w3sperStreamCompat } from "../../vite.local-w3sper.js";
import chrome from "../../vite.config.js";
import firefox from "../../vite.firefox.config.js";
import tauri from "../../vite.tauri.config.js";

it("backports only the pinned SDK reader in every build target", () => {
  const entry = createRequire(import.meta.url).resolve("@dusk/w3sper");
  const plugin = w3sperStreamCompat();
  expect(plugin.load(path.join(path.dirname(entry), "protocol-driver/stream.js"))).toContain("const chunk = await reader.read()");
  expect(plugin.load("/unrelated/stream.js")).toBeNull();
  expect(plugin.config().optimizeDeps.exclude).toContain("@dusk/w3sper");
  for (const config of [chrome, firefox, tauri]) {
    expect(config.plugins.some(p => p.name === plugin.name)).toBe(true);
  }
});

it("rejects a partially filled read and reader.closed when the source fails", async () => {
  let controller;
  const reader = getBYOBReader(new ReadableStream({ start(c) { controller = c; } }));
  const pending = expect(reader.read(new Uint8Array(8))).rejects.toThrow("Connection ended");
  const closed = expect(reader.closed).rejects.toThrow("Connection ended");
  controller.enqueue(new Uint8Array([1, 2]));
  await Promise.resolve();
  controller.error(new Error("Connection ended"));
  await Promise.all([pending, closed]);
});

it("preserves leftovers and closes queued reads after a partial final view", async () => {
  const reader = getBYOBReader(new ReadableStream({ start(c) {
    c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3, 4, 5])); c.close();
  } }));
  const results = await Promise.all([0, 1, 2].map(() => reader.read(new Uint8Array(4))));
  expect(results.map(r => [...r.value])).toEqual([[1, 2, 3, 4], [5], []]);
  expect(results.map(r => r.done)).toEqual([false, false, true]);
  await reader.closed;
});

it("cancels pending reads without returning bytes and forwards the reason", async () => {
  let controller, reason;
  const reader = getBYOBReader(new ReadableStream({
    start(c) { controller = c; }, cancel(value) { reason = value; },
  }));
  const pending = reader.read(new Uint8Array(4));
  await Promise.resolve();
  controller.enqueue(new Uint8Array([1, 2, 3, 4]));
  await reader.cancel("Stopped");
  expect(reason).toBe("Stopped");
  expect(await pending).toMatchObject({ done: true });
  expect((await reader.read(new Uint8Array(4))).done).toBe(true);
});

it("propagates cancellation failures to the caller", async () => {
  const reader = getBYOBReader(new ReadableStream({ cancel() { throw new Error("Cancel failed"); } }));
  await expect(reader.cancel()).rejects.toThrow("Cancel failed");
});
