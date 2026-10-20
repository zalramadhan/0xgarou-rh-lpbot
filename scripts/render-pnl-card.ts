/**
 * Renders the PnL card of a closed position to `data/cards/<id>.png`.
 *
 *   npm run card -- h3
 *   npm run card            # the most recent closed position
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cardDataFromRecord } from '../src/card/data.js';
import { renderPnlCard } from '../src/card/pnlCard.js';
import { store } from '../src/store/store.js';

const id = process.argv[2]?.trim();

await store.init();
const history = store.snapshot.history;
const record = id ? history.find((entry) => entry.id === id) : history[history.length - 1];

if (!record) {
  console.error(id ? `No closed position with id ${id}.` : 'No closed position found.');
  process.exit(1);
}

const png = renderPnlCard(cardDataFromRecord(record));
const out = join('data', 'cards', `${record.id}.png`);
await mkdir(join('data', 'cards'), { recursive: true });
await writeFile(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
