const queues = new Map();

export function withStorageLock(key, fn) {
  if (globalThis.navigator?.locks?.request) {
    return globalThis.navigator.locks.request(`dusk-wallet:${key}`, fn);
  }

  const result = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(key, result.catch(() => {}));
  return result;
}
