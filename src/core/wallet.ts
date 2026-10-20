import type { Address, Hex } from 'viem';
import { erc20Abi, permit2Abi } from '../constants/abis.js';
import { CONTRACTS } from '../constants/chain.js';
import { publicClient, requireWallet } from '../chain/client.js';

export async function ethBalance(owner: Address): Promise<bigint> {
  return publicClient.getBalance({ address: owner });
}

export async function erc20BalanceOf(token: Address, owner: Address): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
}

export async function erc20Allowance(token: Address, spender: Address, owner: Address): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  });
}

async function waitSuccess(hash: Hex): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`Transaction ${hash} reverted`);
}

/** Approves `spender` for `amount` when the current allowance is insufficient. */
export async function ensureErc20Allowance(
  token: Address,
  spender: Address,
  amount: bigint,
  owner: Address,
  dryRun: boolean,
): Promise<Hex | undefined> {
  const current = await erc20Allowance(token, spender, owner);
  if (current >= amount) return undefined;
  const { walletClient, account } = requireWallet();
  if (dryRun) return '0xdryrun' as Hex;
  const hash = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, (1n << 256n) - 1n],
    account,
    chain: walletClient.chain,
  });
  await waitSuccess(hash);
  return hash;
}

/** Uniswap v4 pulls tokens through Permit2, so both hops need approval. */
export async function ensurePermit2Allowance(
  token: Address,
  spender: Address,
  amount: bigint,
  owner: Address,
  dryRun: boolean,
): Promise<Hex[]> {
  const hashes: Hex[] = [];
  const erc20Hash = await ensureErc20Allowance(token, CONTRACTS.permit2, amount, owner, dryRun);
  if (erc20Hash) hashes.push(erc20Hash);

  const [, expiration, nonce] = await publicClient.readContract({
    address: CONTRACTS.permit2,
    abi: permit2Abi,
    functionName: 'allowance',
    args: [owner, token, spender],
  });
  void nonce;
  const expired = Number(expiration) !== 0 && Number(expiration) * 1000 < Date.now();
  const allowanceAmount = (
    await publicClient.readContract({
      address: CONTRACTS.permit2,
      abi: permit2Abi,
      functionName: 'allowance',
      args: [owner, token, spender],
    })
  )[0];

  if (allowanceAmount >= amount && !expired) return hashes;

  const { walletClient, account } = requireWallet();
  if (dryRun) {
    hashes.push('0xdryrun' as Hex);
    return hashes;
  }
  const hash = await walletClient.writeContract({
    address: CONTRACTS.permit2,
    abi: permit2Abi,
    functionName: 'approve',
    args: [token, spender, (1n << 160n) - 1n, Math.floor(Date.now() / 1000) + 30 * 86_400],
    account,
    chain: walletClient.chain,
  });
  await waitSuccess(hash);
  hashes.push(hash);
  return hashes;
}
