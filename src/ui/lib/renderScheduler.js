/**
 * Create a microtask-based render scheduler.
 * Coalesces multiple state updates into a single render.
 *
 * @param {(opts:any)=>Promise<void>|void} renderFn
 */
export function createRenderScheduler(renderFn) {
  let scheduled = false;
  let lastOpts = undefined;

  async function flush() {
    const opts = lastOpts;
    lastOpts = undefined;
    scheduled = false;
    await renderFn(opts);
  }

  return function scheduleRender(opts) {
    lastOpts = opts;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      // Run async without blocking microtask queue.
      Promise.resolve(flush()).catch((e) => {
        console.error("Render error", e);
      });
    });
  };
}
