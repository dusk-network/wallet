const GENERIC_EXECUTION_ERROR = "Transaction execution failed";

function hasError(value) {
  return value !== undefined && value !== null && value !== false && value !== "";
}

function eventLayers(event) {
  if (!event || typeof event !== "object") return [];

  try {
    return [
      event,
      event.payload,
      event.result,
      event.payload?.result,
    ].filter((value) => value && typeof value === "object");
  } catch {
    return [event];
  }
}

function errorMessage(value) {
  if (!hasError(value) || value === true) return "";
  if (typeof value === "string") return value;
  if (typeof value?.message === "string") return value.message;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Interpret a w3sper transaction execution event.
 *
 * Current RUES events expose the node result under `event.payload`, while
 * older/test event shapes placed the same fields on the event or `result`.
 */
export function executionEventOk(event) {
  try {
    return !eventLayers(event).some(
      (layer) =>
        layer.success === false ||
        hasError(layer.err) ||
        hasError(layer.error)
    );
  } catch {
    return true;
  }
}

export async function waitForTxExecution(executedPromise, removedPromise, onRemoved) {
  const executed = Promise.resolve(executedPromise);
  const first = await Promise.race([
    executed.then((event) => ({ type: "executed", event })),
    Promise.resolve(removedPromise).then((event) => ({ type: "removed", event })),
  ]);
  if (first.type === "executed") return first.event;
  Promise.resolve().then(() => onRemoved?.(first.event)).catch(() => {});
  return executed;
}

export function executionEventError(event) {
  try {
    const layers = eventLayers(event);
    for (const layer of layers) {
      const message = errorMessage(layer.err) || errorMessage(layer.error);
      if (message) return message;
    }
    if (layers.some((layer) => layer.success === false || layer.err === true || layer.error === true)) {
      return GENERIC_EXECUTION_ERROR;
    }
  } catch {
    // Treat malformed event details as absent. The caller still has the
    // execution status returned by executionEventOk().
  }
  return "";
}
