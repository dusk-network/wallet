// Small wrapper around chrome.runtime messaging.

/**
 * Send a message to the extension background and return the raw response.
 * Rejects if chrome.runtime.lastError is set.
 * @param {any} msg
 */
export function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      const le = chrome.runtime.lastError;
      if (le) {
        reject(new Error(le.message));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Send a message and throw if the response has an {error} field.
 * @param {any} msg
 */
export async function callBackground(msg) {
  const resp = await sendMessage(msg);
  if (resp?.error) {
    const err = new Error(resp.error.message ?? "Request failed");
    err.code = resp.error.code;
    err.data = resp.error.data;
    throw err;
  }
  return resp;
}
