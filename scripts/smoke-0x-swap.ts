/**
 * Checks what 0x would do for a TOKEN → USDG swap. It only quotes: no
 * allowance is set and no transaction is sent.
 *
 *   npm run smoke:0x -- 0xTokenAddress
 *   npm run smoke:0x -- 0xTokenAddress --amount 1000000000000000
 */
import { isAddress, type Address } from 'viem';
import { config } from '../src/config.js';
import { TOKENS } from '../src/constants/chain.js';
import { erc20BalanceOf } from '../src/core/wallet.js';
import { botAddress } from '../src/chain/client.js';
import { quoteZeroXSwap, ZeroXError } from '../src/core/zeroXSwap.js';

const args = process.argv.slice(2);
const rawAddress = args.find((arg) => !arg.startsWith('--'))?.trim();
const amountIndex = args.findIndex((arg) => arg === '--amount' || arg === '-a');
const rawAmount = amountIndex >= 0 ? args[amountIndex + 1] : undefined;

if (!rawAddress) {
  console.error('Usage: npm run smoke:0x -- <token address> [--amount <base units>]');
  process.exit(1);
}
if (!isAddress(rawAddress)) {
  console.error(`"${rawAddress}" is not a contract address (0x + 40 hex characters).`);
  process.exit(1);
}
if (!config.zeroXApiKey) {
  console.error('ZEROX_API_KEY is not set — the bot would use the Uniswap v3 route instead.');
  process.exit(1);
}
if (!botAddress) {
  console.error('No wallet configured: set PRIVATE_KEY (or import a keystore) first.');
  process.exit(1);
}

const address = rawAddress as Address;

// The amount to sell: the wallet's balance, or the one that was given.
let sellAmount = 0n;
if (rawAmount) {
  try {
    sellAmount = BigInt(rawAmount);
  } catch {
    console.error(`"--amount ${rawAmount}" is not a number of base units.`);
    process.exit(1);
  }
} else {
  try {
    sellAmount = await erc20BalanceOf(address, botAddress);
  } catch (err) {
    console.error(
      `Could not read the balance of ${address}: ${(err as Error).message.split('\n')[0]}\n` +
        'It may not be a token contract on this chain.',
    );
    process.exit(1);
  }
  if (sellAmount <= 0n) {
    console.error(
      `The wallet holds no ${address}. Pass --amount <base units> to check the route anyway.`,
    );
    process.exit(1);
  }
}

try {
  const quote = await quoteZeroXSwap({
    sellToken: address,
    buyToken: TOKENS.USDG,
    sellAmount,
    taker: botAddress,
    slippageBps: Math.round(config.defaultSlippagePct * 100),
  });
  const usdg = 10 ** 6;
  console.log('0x route found');
  console.log(`  selling        ${quote.sellAmount} of ${address}`);
  console.log(`  buying (est)   ${Number(quote.buyAmount) / usdg} USDG`);
  console.log(`  minimum        ${Number(quote.minBuyAmount) / usdg} USDG`);
  console.log(`  0x fee         ${Number(quote.zeroExFee) / usdg} USDG (buy token)`);
  console.log(`  network fee    ${quote.totalNetworkFee} wei (native)`);
  console.log(`  gas estimate   ${quote.gas ?? 'not given'}`);
  console.log(`  approve        ${quote.allowanceTarget}`);
  console.log(`  entry point    ${quote.entryPoint}`);
  console.log(`  native value   ${quote.value}`);
} catch (err) {
  const reason = err instanceof ZeroXError ? err.reason : 'error';
  console.error(`0x could not route this swap (${reason}): ${(err as Error).message}`);
  process.exit(1);
}
