/**
 * Checks the GMGN credentials: what is configured and whether the API
 * accepts it. It only reads.
 *
 *   npm run smoke:gmgn
 */
import { checkGmgnCredentials } from '../src/core/gmgn.js';

const lines = await checkGmgnCredentials();
for (const line of lines) console.log(line);

if (lines.some((line) => line.startsWith('Trending API: ok'))) {
  console.log('\nThe credentials work: the trending screen and the card candles use GMGN.');
} else {
  console.log('\nAdd the credentials to .env:');
  console.log('  GMGN_API_KEY=<key from gmgn.ai/ai>     # queries: trending, candles');
  console.log('  GMGN_PRIVATE_KEY=<ed25519 private key>  # only if GMGN should trade');
}
