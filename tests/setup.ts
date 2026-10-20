import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Every test file gets its own store and keystore.
 *
 * Without this, a test that writes to the store (the detect flow does) wrote
 * to the **real** `data/store.json` and wiped the production data — the
 * closed positions, the address book, the settings. The path is per worker,
 * so two workers never write to the same file.
 *
 * The test files that manage a store of their own set `DB_PATH` themselves in
 * their module body; that assignment happens after this setup and wins.
 */
const dir = mkdtempSync(join(tmpdir(), 'rhlp-test-'));
const worker = process.env.VITEST_WORKER_ID ?? '0';
process.env.DB_PATH = join(dir, `store-${worker}.json`);
process.env.KEYSTORE_PATH = join(dir, `keystore-${worker}.json`);
