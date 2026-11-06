// What a migration to Dusk paid on its own chain, BNB Smart Chain's or
// Ethereum's, as app-core reads it there (migrationFacts): its gas, and its
// approval's where the chain says that approval was this migration's. The
// extension signs no migration, so it has no approval's hash: the chain's
// logs are searched, and where its RPC keeps none so old, the migration's gas
// is said alone. For this page only: what's final app-core keeps in `kept`
// and doesn't read again; the rest is read again a minute on.

import { migrationFacts, migrationsOf } from "@dusk-network/app-core/bridge";

import { networkForNode } from "../../shared/nodeNetwork.js";

/** How long a migration's facts stand before they're asked again. */
export const MIGRATION_AGAIN_MS = 60_000;

const kept = new Map();
// By network and migration hash: what was read, when, and whether a read is under way.
const reads = new Map();

/**
 * The facts of the migrations `rows` were paid for, by migration hash: none
 * where the node's network isn't known or none was paid.
 * @param {object} ov - the overview
 * @param {object[]} rows - activity rows
 * @returns {Promise<Map<string, import("@dusk-network/app-core/bridge").MigrationEvm>>}
 */
export async function migrationFactsOf(ov, rows) {
  const network = networkForNode(String(ov?.nodeUrl ?? ""));
  const migrations = migrationsOf(rows ?? []);
  if (!network || !migrations.length) return new Map();
  return migrationFacts({ cache: kept, migrations, network }).catch(() => new Map());
}

/**
 * The facts of the migration a payout paid for, as last read: undefined until
 * they're read, and for a row that pays none. Asked at most once a minute;
 * `render` draws again when an answer comes.
 * @param {object} ov - the overview
 * @param {object} row - an activity row
 * @param {{ render?: () => Promise<unknown> }} [options]
 */
export function migrationFactOf(ov, row, { render } = {}) {
  const [migration] = migrationsOf([row]);
  const network = networkForNode(String(ov?.nodeUrl ?? ""));
  if (!migration || !network) return undefined;
  const key = `${network.chainId}:${migration.hash}`;
  const last = reads.get(key);
  if (!last || (!last.reading && Date.now() - last.at >= MIGRATION_AGAIN_MS)) {
    const read = { at: Date.now(), fact: last?.fact, reading: true };
    reads.set(key, read);
    migrationFacts({ cache: kept, migrations: [migration], network })
      .then((facts) => {
        read.fact = facts.get(migration.hash) ?? read.fact;
      })
      .catch(() => {})
      .finally(() => {
        Object.assign(read, { at: Date.now(), reading: false });
        if (reads.get(key) === read) render?.()?.catch?.(() => {});
      });
  }
  return reads.get(key).fact;
}
