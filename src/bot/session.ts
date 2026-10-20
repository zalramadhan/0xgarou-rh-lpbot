import type { BidAskPlan } from '../core/bidAsk.js';
import type { Pool } from '../core/pools.js';
import type { TokenScan } from '../core/scanner.js';
import type { SortMode } from './poolList.js';
import type { TokenInfo } from '../core/tokens.js';

export interface Draft {
  /** The token the user pasted. */
  token: TokenInfo;
  /** The other side of the pair (USDG or WETH). */
  quote: TokenInfo;
  pool: Pool;
  tickLower: number;
  tickUpper: number;
  /** Which side the deposit spends: both, the quote token only, or the token only. */
  side: SideChoice;
  /** One-sided entries are either a single spot range or a Bid Ask ladder. */
  strategy?: EntryStrategy;
}

/** Both sides, or a one-sided deposit in the quote / the pasted token. */
type SideChoice = 'both' | 'quote' | 'token';

/** A Spot range or a progressive Bid Ask ladder. */
export type EntryStrategy = 'spot' | 'bidAsk';

type Session =
  | { step: 'token' }
  | {
      step: 'range';
      token: TokenInfo;
      scan: TokenScan;
      page: number;
      selected: number;
      sort: SortMode;
      hideBroken: boolean;
      /** Which side the deposit funds; `both` is the classic two-token mint. */
      side: SideChoice;
      strategy?: EntryStrategy;
    }
  | {
      /** Pool picked, waiting for one-sided vs both-sides. */
      step: 'side';
      token: TokenInfo;
      scan: TokenScan;
      page: number;
      selected: number;
      sort: SortMode;
      hideBroken: boolean;
    }
  | {
      /** One-sided side picked, waiting for Spot vs Bid Ask. */
      step: 'strategy';
      token: TokenInfo;
      scan: TokenScan;
      page: number;
      selected: number;
      sort: SortMode;
      hideBroken: boolean;
      side: 'quote' | 'token';
    }
  | {
      step: 'customRange';
      token: TokenInfo;
      scan: TokenScan;
      page: number;
      selected: number;
      sort: SortMode;
      hideBroken: boolean;
      side: SideChoice;
      strategy?: EntryStrategy;
    }
  | { step: 'amount'; draft: Draft }
  | {
      step: 'confirm';
      draft: Draft;
      liquidity: bigint;
      amount0: bigint;
      amount1: bigint;
      valueUsd: number;
      price: number;
      /** Present for a Bid Ask setup; all entries are minted in sequence. */
      bidAsk?: BidAskPlan;
    }
  | { step: 'import' }
  | { step: 'tpsl'; positionId: string }
  | { step: 'cycles'; positionId: string }
  | {
      /** The position was closed; waiting for the swap choice. */
      step: 'closeChoice';
      positionId: string;
      /** The frozen history record of the close. */
      recordId?: string;
      token: TokenInfo;
      amount: bigint;
      valueUsd: number;
      pair: string;
      /** The close receipt, frozen when the position was closed. */
      receipt: string[];
    }
  | {
      /** The user wants to swap; waiting for the route. */
      step: 'closeRoute';
      positionId: string;
      recordId?: string;
      token: TokenInfo;
      amount: bigint;
      valueUsd: number;
      pair: string;
      /** The close receipt, frozen when the position was closed. */
      receipt: string[];
    }
  | { step: 'walletKey' }
  | { step: 'walletPass'; privateKey: `0x${string}` }
  | { step: 'unlock' }
  | { step: 'walletName' }
  | { step: 'addressSearch' }
  | { step: 'bookSearch' }
  | { step: 'autoTpTarget' }
  | { step: 'tpCycle' };

const sessions = new Map<number, Session>();

export function getSession(chatId: number): Session | undefined {
  return sessions.get(chatId);
}

export function setSession(chatId: number, session: Session): void {
  sessions.set(chatId, session);
}

export function clearSession(chatId: number): void {
  sessions.delete(chatId);
}
