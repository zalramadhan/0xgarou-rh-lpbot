/**
 * Reads a live position through the same code path the bot uses.
 *
 *   npm run inspect -- --find          # newest v3 + v4 mints
 *   npm run inspect -- 12345           # auto-detects v3/v4
 *   npm run inspect -- --v4 12345
 */
import { keccak256, toHex } from 'viem';
import { CONTRACTS } from '../src/constants/chain.js';
import { publicClient } from '../src/chain/client.js';
import { detectVersion, readPosition } from '../src/core/positions.js';
import { valuate } from '../src/core/valuation.js';
import { fmtAmount, fmtPrice, fmtUsd, shortAddr } from '../src/utils/format.js';

const transferTopic = keccak256(toHex('Transfer(address,address,uint256)'));
const zeroTopic = `0x${'0'.repeat(64)}` as const;

/**
 * Scans backwards in chunks because the free public RPC caps eth_getLogs at
 * 10k blocks.
 */
async function newestMints(address: `0x${string}`, chunk = 9_000n, maxChunks = 6): Promise<bigint[]> {
  const latest = await publicClient.getBlockNumber();
  const found: bigint[] = [];
  for (let i = 0n; i < maxChunks; i++) {
    const toBlock = latest - i * chunk;
    const fromBlock = toBlock > chunk ? toBlock - chunk : 0n;
    const logs = await publicClient.request({
      method: 'eth_getLogs',
      params: [
        {
          address,
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
          topics: [transferTopic, zeroTopic],
        },
      ],
    });
    for (const log of logs ?? []) {
      const tokenTopic = log.topics[3];
      if (tokenTopic) found.push(BigInt(tokenTopic));
    }
    if (found.length >= 3) break;
  }
  return found.slice(-3);
}

async function report(version: 'v3' | 'v4', tokenId: bigint) {
  const snap = await readPosition(version, tokenId);
  if (!snap) {
    console.log(`${version} #${tokenId}: not found (burned?)`);
    return;
  }
  const v = await valuate(snap);
  const fmt = (raw: bigint, dec: number) => fmtAmount(raw, dec);
  console.log(
    [
      `${version} #${tokenId} ${snap.token0.symbol}/${snap.token1.symbol} ${snap.fee / 10_000}%`,
      `  owner      ${shortAddr(snap.owner)}`,
      `  price      ${fmtPrice(snap.price)} ${snap.token1.symbol} per ${snap.token0.symbol} (tick ${snap.tick})`,
      `  range      [${fmtPrice(v.lowerPrice)}, ${fmtPrice(v.upperPrice)}] ${snap.inRange ? 'IN RANGE' : 'OUT OF RANGE'}`,
      `  liquidity  ${snap.liquidity}`,
      `  amounts    ${fmt(snap.amount0, snap.token0.decimals)} ${snap.token0.symbol} + ${fmt(snap.amount1, snap.token1.decimals)} ${snap.token1.symbol}`,
      `  fees       ${fmt(snap.fees0, snap.token0.decimals)} ${snap.token0.symbol} + ${fmt(snap.fees1, snap.token1.decimals)} ${snap.token1.symbol} = ${fmtUsd(v.feesUsd)}`,
      `  value      ${fmtUsd(v.valueUsd)} (principal ${fmtUsd(v.principalUsd)})`,
      `  nearest    ${v.nearestDistancePct.toFixed(2)}% to bound`,
    ].join('\n'),
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--find' || args.length === 0) {
    const [v3Ids, v4Ids] = await Promise.all([
      newestMints(CONTRACTS.v3PositionManager),
      newestMints(CONTRACTS.v4PositionManager),
    ]);
    console.log(`newest v3 mints: ${v3Ids.join(', ') || 'none'}`);
    console.log(`newest v4 mints: ${v4Ids.join(', ') || 'none'}`);
    for (const id of v3Ids.slice(-2)) await report('v3', id).catch((e) => console.log(`v3 #${id}: ${e.message}`));
    for (const id of v4Ids.slice(-2)) await report('v4', id).catch((e) => console.log(`v4 #${id}: ${e.message}`));
    return;
  }

  const explicit = args[0] === '--v3' ? 'v3' : args[0] === '--v4' ? 'v4' : undefined;
  const idArg = explicit ? args[1] : args[0];
  if (!idArg) throw new Error('usage: inspect --find | inspect <tokenId> | inspect --v4 <tokenId>');
  const tokenId = BigInt(idArg);
  const version = explicit ?? (await detectVersion(tokenId));
  if (!version) throw new Error(`tokenId ${tokenId} is not owned by the v3 or v4 position manager`);
  await report(version, tokenId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
