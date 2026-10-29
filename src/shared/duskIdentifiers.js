import { decodeBase58 } from "@dusk-network/networks/account";

const base58DecodedLength = (value) => decodeBase58(String(value ?? ""))?.length ?? 0;

export function classifyDuskIdentifier(value) {
  const len = base58DecodedLength(value);
  if (len === 96) return "account";
  if (len === 64) return "address";
  return "undefined";
}
