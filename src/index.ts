import { config } from './config.js';
import { store } from './store/store.js';
import { createBot } from './bot/index.js';
import { startMonitor } from './monitor/monitor.js';
import { createLogger } from './logger.js';
import { botAddress } from './chain/client.js';

const log = createLogger('main');

async function main(): Promise<void> {
  await store.init();
  const bot = createBot();

  await bot.api.setMyCommands([
    { command: 'new', description: 'Open a position (paste token CA)' },
    { command: 'positions', description: 'List tracked positions' },
    { command: 'pos', description: 'Position details and actions' },
    { command: 'import', description: 'Track an existing position by tokenId' },
    { command: 'detect', description: 'Find LP NFTs the wallet holds' },
    { command: 'scan', description: 'Scan v3/v4 pools for a token' },
    { command: 'wallet', description: 'Wallet balances' },
    { command: 'history', description: 'Closed positions and PnL' },
    { command: 'book', description: 'Address book of saved tokens' },
    { command: 'settings', description: 'Dry-run, slippage, alerts' },
    { command: 'status', description: 'RPC, block, gas' },
    { command: 'help', description: 'Commands' },
  ]);

  const me = await bot.api.getMe();
  log.info(`running as @${me.username}`);
  log.info(
    botAddress
      ? `wallet ${botAddress} · execution ${config.dryRun ? 'DRY-RUN' : 'LIVE'}`
      : 'no PRIVATE_KEY — read-only monitoring',
  );

  const stopMonitor = startMonitor();

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    stopMonitor();
    await bot.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await bot.start({
    onStart: (info) => log.info(`polling as @${info.username}`),
  });
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
