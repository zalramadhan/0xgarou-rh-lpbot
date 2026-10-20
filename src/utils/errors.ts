/**
 * True when a contract call reverted on-chain. Transport problems, rate limits
 * and timeouts deliberately return false so callers do not mistake an RPC hiccup
 * for "position does not exist" or "pool not found".
 */
export function isRevertError(err: unknown): boolean {
  const e = err as { name?: string; message?: string; details?: string };
  const name = e?.name ?? '';
  const text = `${e?.message ?? ''} ${e?.details ?? ''}`.toLowerCase();
  if (name.includes('Revert') || name.includes('ContractFunctionExecutionError')) {
    return text.includes('revert') || text.includes('execution reverted');
  }
  return text.includes('execution reverted') || text.includes('invalid token id');
}

export function errorMessage(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return (e?.shortMessage ?? e?.message ?? String(err)).split('\n')[0] ?? 'unknown error';
}
