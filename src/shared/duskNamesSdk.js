// The SDK's lens reader and its check of what a name points to, imported by
// name so the bundler keeps only these. Loaded on the first lookup through a
// dynamic import: the account check carries the curve's code.
export { createLensReader, decodeBase58 } from "@duskdomains/sdk/lens-reader";
export { resolveAccounts } from "@duskdomains/sdk/accounts";
