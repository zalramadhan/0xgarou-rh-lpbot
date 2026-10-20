import 'dotenv/config';

function parseChatIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isSafeInteger(n)) throw new Error(`ALLOWED_CHAT_IDS contains a non-numeric id: ${s}`);
      return n;
    });
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`Expected a boolean, got "${raw}"`);
}

function parseNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

/**
 * The RPC endpoints to try, in order.
 *
 * Both `RPC_URLS` and `RPC_URL` may hold a list (comma or newline
 * separated) — a list in either place is split, so an existing `.env` that
 * already has several endpoints in `RPC_URL` works as it is. `RPC_URLS` comes
 * first, then `RPC_URL`, and the same endpoint is never in the list twice.
 */
export function parseRpcUrls(list: string | undefined, first: string | undefined): string[] {
  const urls: string[] = [];
  const add = (value: string | undefined): void => {
    const url = value?.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`RPC URLs must start with http:// or https://, got "${url}"`);
    }
    if (!urls.includes(url)) urls.push(url.replace(/\/$/, ''));
  };
  for (const part of (list ?? '').split(/[,\n]/)) add(part);
  for (const part of (first ?? '').split(/[,\n]/)) add(part);
  if (urls.length === 0) urls.push('https://robinhood.drpc.org');
  return urls;
}

/** Every RPC endpoint, in the order they should be tried. */
const rpcUrls = parseRpcUrls(process.env.RPC_URLS, process.env.RPC_URL);

const privateKeyRaw = process.env.PRIVATE_KEY?.trim() ?? '';
if (privateKeyRaw && !/^0x[0-9a-fA-F]{64}$/.test(privateKeyRaw)) {
  throw new Error('PRIVATE_KEY must be a 0x-prefixed 32-byte hex string');
}

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '',
  privateKey: privateKeyRaw ? (privateKeyRaw as `0x${string}`) : undefined,
  rpcUrl: rpcUrls[0]!,
  /**
   * Every RPC endpoint, in the order they should be tried. `RPC_URLS` holds
   * the list (comma or newline separated) and `RPC_URL` stays the first one,
   * so an existing `.env` keeps working.
   */
  rpcUrls,
  allowedChatIds: parseChatIds(process.env.ALLOWED_CHAT_IDS),
  dryRun: parseBool(process.env.DRY_RUN, true),
  dbPath: process.env.DB_PATH?.trim() || 'data/store.json',
  keystorePath: process.env.KEYSTORE_PATH?.trim() || 'data/keystore.json',
  pollIntervalMs: parseNumber(process.env.POLL_INTERVAL_MS, 15_000, 'POLL_INTERVAL_MS'),
  defaultSlippagePct: parseNumber(process.env.DEFAULT_SLIPPAGE_PCT, 1, 'DEFAULT_SLIPPAGE_PCT'),
  rpcMaxConcurrency: parseNumber(process.env.RPC_MAX_CONCURRENCY, 4, 'RPC_MAX_CONCURRENCY'),
  explorerUrl: (process.env.EXPLORER_URL?.trim() || 'https://robinhoodchain.blockscout.com').replace(/\/$/, ''),
  enableIndexer: parseBool(process.env.ENABLE_INDEXER, true),
  indexerUrl: process.env.INDEXER_URL?.trim() || 'https://api.geckoterminal.com/api/v2',
  /**
   * LP-NFT detection: an RPC with an NFT index (Alchemy) lists a wallet's
   * positions in seconds. Without one the bot walks every minted v4 id
   * on-chain, which is exact but takes minutes.
   */
  detectUseIndexer: parseBool(process.env.DETECT_USE_INDEXER, true),
  detectScanLimit: parseNumber(process.env.DETECT_SCAN_LIMIT, 4_000_000, 'DETECT_SCAN_LIMIT'),
  /**
   * 0x Swap API key. It routes the auto-swap; without it the bot falls back
   * to the Uniswap v3 route. The key is never logged or exposed.
   */
  zeroXApiKey: process.env.ZEROX_API_KEY?.trim() || undefined,
  /** The 0x Swap API base URL. */
  zeroXApiUrl: process.env.ZEROX_API_URL?.trim() || 'https://api.0x.org',
  /**
   * GMGN credentials. The API key is enough for queries; the private key is
   * only needed for trading and is never logged.
   */
  gmgnApiKey: process.env.GMGN_API_KEY?.trim() || undefined,
  gmgnPrivateKey: process.env.GMGN_PRIVATE_KEY?.trim() || undefined,
  /** The GMGN OpenAPI base URL (the market routes). */
  gmgnApiUrl: process.env.GMGN_API_URL?.trim() || 'https://openapi.gmgn.ai',
  /** The Callout API's access key and secret (AK/SK HMAC credentials). */
  gmgnAk: process.env.GMGN_AK?.trim() || undefined,
  gmgnSk: process.env.GMGN_SK?.trim() || undefined,
} as const;

export function assertRuntimeConfig(): void {
  if (!config.telegramToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is missing. Copy .env.example to .env and fill it in.');
  }
  if (config.defaultSlippagePct < 0 || config.defaultSlippagePct > 50) {
    throw new Error('DEFAULT_SLIPPAGE_PCT must be between 0 and 50');
  }
  if (config.pollIntervalMs < 5_000) {
    throw new Error('POLL_INTERVAL_MS must be at least 5000');
  }
}
