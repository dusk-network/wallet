// Minimal EIP-1193-ish error helpers
export function rpcError(code, message, data) {
  const err = new Error(message);
  err.code = code;
  if (data !== undefined) err.data = data;
  return err;
}

export const ERROR_CODES = {
  USER_REJECTED: 4001,
  UNAUTHORIZED: 4100,
  UNSUPPORTED: 4200,
  INTERNAL: -32603,
  INVALID_PARAMS: -32602,
  METHOD_NOT_FOUND: -32601,
};
