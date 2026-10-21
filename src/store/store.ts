import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import {
  BID_ASK_DEFAULT_ENTRIES,
  normalizeBidAskEntries,
} from '../constants/bidAsk.js';
import { normalizeCurrency } from '../constants/currency.js';
import { DEFAULT_TIME_ZONE, normalizeTimeZone } from '../constants/timezone.js';
import { DEFAULT_AUTO_SWAP_MIN_USD, normalizeAutoSwapMin } from '../constants/autoSwap.js';
import { DEFAULT_MAX_ROUTE_DISCOUNT_PCT, normalizeRouteDiscount } from '../constants/routeImpact.js';
import type { PositionVersion } from '../core/positions.js';

const log = createLogger('store');

interface EntryRecord {
  amount0: string;
  amount1: string;
  valueUsd: number;
  price: number;
  openedAt: number;
  txHash?: string;
  /**
   * The ETH price when the position was opened. The open's gas is then priced
   * at the time it was spent instead of at the price of the close.
   */
  ethPriceUsd?: number;
}

/** Why a position was closed, as shown in the history. */
export type CloseReason = 'manual' | 'takeProfit' | 'stopLoss' | 'oorTakeProfit' | 'autoTakeProfit';

export interface TrackedPosition {
  id: string;
  chatId: number;
  version: PositionVersion;
  tokenId: string;
  label?: string;
  entry: EntryRecord;
  /** Total capital put in: initial deposit + compounded fees. */
  basisUsd: number;
  /** Fees collected out to the wallet. */
  feesWithdrawnUsd: number;
  /** Fees re-added to the position (already included in basisUsd). */
  compoundedFeesUsd: number;
  alerts: boolean;
  autoCompound: boolean;
  compoundIntervalMs: number;
  compoundMinFeeUsd: number;
  /** Close automatically at this PnL % of the cost basis (e.g. 30 = +30%). */
  takeProfitPct?: number;
  /** Close automatically at this PnL % of the cost basis (e.g. -20 = -20%). */
  stopLossPct?: number;
  /** Take profit, then re-enter the same pool with the same width and size. */
  autoTakeProfit?: boolean;
  /** Cycle limit for auto-TP; the initial position is cycle 1. */
  tpCycles?: number;
  /** Current cycle, 1-based. */
  cycle?: number;
  /** Take profit when price leaves the range on the upper side. */
  oorTakeProfit?: boolean;
  /** Range captured at the last open, reused by auto-TP re-entry. */
  range?: { tickLower: number; tickUpper: number };
  /** The configured range, exactly as it was set, e.g. "-20% to -10%". */
  rangeLabel?: string;
  /** The entry strategy that opened this position. */
  strategy?: 'spot' | 'bidAsk' | 'curve';
  /** The traded token's market cap when the position was opened. */
  entryMcapUsd?: number;
  /** The traded token's contract, for the PnL card. */
  contract?: string;
  /** Price samples for the PnL card, oldest first. */
  priceSamples?: { t: number; p: number }[];
  /** Last time an exit automation fired, so a failing close is not retried every tick. */
  lastExitAt?: number;
  /** Set when the position was closed by an automation, for the receipt. */
  closedReason?: CloseReason | 'rebalance';
  lastInRange?: boolean;
  lastCompoundAt?: number;
  lastRebalanceAt?: number;
  createdAt: number;
}

/** A finished position, frozen at close so history never changes. */
export interface ClosedRecord {
  id: string;
  chatId: number;
  version: PositionVersion;
  tokenId: string;
  pair: string;
  fee: number;
  reason: CloseReason;
  entryPrice: number;
  exitPrice: number;
  entryValueUsd: number;
  exitValueUsd: number;
  pnlUsd: number;
  pnlPct: number;
  feesUsd: number;
  /** USD → IDR rate captured when the position closed. NaN when unknown. */
  idrRate: number;
  openedAt: number;
  closedAt: number;
  txHash?: string;
  cycle?: number;
  dryRun: boolean;
  /** The capital that was invested: the initial deposit plus compounded fees. */
  basisUsd?: number;
  /**
   * The gas of the whole round trip: the open, the close and the swap.
   *
   * NaN when a part could not be measured (an imported position has no entry
   * transaction) — an unknown cost is never counted as zero.
   */
  feesAndGasUsd?: number;
  /** The gas of the transaction that opened the position, in USD. */
  openGasUsd?: number;
  /** The gas of the transaction that closed the position, in USD. */
  closeGasUsd?: number;
  /** The gas of the swap that followed the close, in USD. */
  swapGasUsd?: number;
  /**
   * The fee the swap provider charged, in USD. It is already netted out of
   * the received amount, so it is never subtracted a second time.
   */
  swapFeeUsd?: number;
  /** The route the swap took. */
  swapRoute?: '0x' | 'uniswap-v3';
  /** The swap transaction. */
  swapHash?: string;
  /** The USDG the swap delivered, in USD. */
  swapReceivedUsd?: number;
  /**
   * The PnL after every cost: the value the position ended up worth, minus
   * the gas of the open, the close and the swap. Undefined when a cost is
   * unknown.
   */
  pnlNetUsd?: number;
  /** The net PnL in percent of the cost basis. */
  pnlNetPct?: number;
  /** The traded token's market cap when the position was opened. */
  entryMcapUsd?: number;
  /** The traded token's market cap when the position was closed. */
  exitMcapUsd?: number;
  /** The configured range, exactly as it was set, e.g. "-20% to -10%". */
  rangeLabel?: string;
  /** The entry strategy that was used. */
  strategy?: 'spot' | 'bidAsk' | 'curve';
  /** The display currency chosen when the position was closed. */
  currency?: 'USD' | 'IDR' | 'SOL';
  /** USD per SOL, frozen at close time. */
  solRateUsd?: number;
  /** The price path over the position's life, frozen at close time. */
  priceSamples?: { t: number; p: number }[];
  /** The range bounds in price terms, for the card's chart. */
  rangePriceLower?: number;
  rangePriceUpper?: number;
  /** The traded token's contract. */
  contract?: string;
  /** The chain the position was closed on; old records default to Robinhood. */
  chain?: string;
}

export interface AddressBookEntry {
  chatId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  lastUsedAt: number;
}

export interface ChatSettings {
  dryRun: boolean;
  slippagePct: number;
  alertsEnabled: boolean;
  /** Swap the position's own token proceeds into USDG once a LIVE close lands. */
  autoSwapToUsdg: boolean;
  /**
   * The smallest amount worth swapping into USDG, in USD. A close that leaves
   * less than this behind keeps the tokens in the wallet instead of spending
   * more gas on the swap than the swap is worth.
   */
  autoSwapMinUsd: number;
  /**
   * How far below the market a swap route may be priced, in percent.
   *
   * Above it the tokens stay in the wallet: the route would cost more than
   * swapping them by hand.
   */
  maxRouteDiscountPct: number;
  /** Profit % that arms an auto take-profit close. */
  autoTpTargetPct: number;
  /** Default cycle limit for new positions (the initial position is cycle 1). */
  tpCycleLimit: number;
  /** Number of entries used by the next Bid Ask ladder (4–10). */
  bidAskEntries: number;
  /** How the PnL card shows money. */
  currency: 'USD' | 'IDR' | 'SOL';
  /** The timezone the calendar buckets days in. */
  timezone: string;
}

interface StoreData {
  version: 1;
  nextPositionNumber: number;
  nextCloseNumber: number;
  allowedChatIds: number[];
  chats: Record<string, ChatSettings>;
  positions: TrackedPosition[];
  history: ClosedRecord[];
  addressBook: AddressBookEntry[];
}

const defaultData = (): StoreData => ({
  version: 1,
  nextPositionNumber: 1,
  nextCloseNumber: 1,
  allowedChatIds: [...config.allowedChatIds],
  chats: {},
  positions: [],
  history: [],
  addressBook: [],
});

const MAX_HISTORY = 200;
const MAX_ADDRESSES = 50;

class Store {
  private data: StoreData = defaultData();
  private saveChain: Promise<void> = Promise.resolve();
  private saveSeq = 0;
  /** Bumped whenever a closed record is written, so caches can be dropped. */
  private historySeq = 0;

  async init(): Promise<void> {
    try {
      const raw = await readFile(config.dbPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      this.data = {
        ...defaultData(),
        ...parsed,
        chats: parsed.chats ?? {},
        positions: parsed.positions ?? [],
        history: parsed.history ?? [],
        addressBook: parsed.addressBook ?? [],
      };
      for (const id of config.allowedChatIds) {
        if (!this.data.allowedChatIds.includes(id)) this.data.allowedChatIds.push(id);
      }
      log.info(
        `loaded ${this.data.positions.length} tracked · ${this.data.history.length} closed · ${this.data.addressBook.length} address(es)`,
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // No store yet: start a fresh one.
        this.data = defaultData();
        await this.persist();
        return;
      }
      // A store that exists but cannot be read is not overwritten: that
      // would throw away every tracked position. Keep the bad file for
      // inspection and start empty.
      log.error(`could not read ${config.dbPath}; starting with an empty store`, err);
      this.data = defaultData();
    }
  }

  private persist(): Promise<void> {
    // A test must never write to the production store. The test setup points
    // every worker at a temp dir; this guard catches the case where a test
    // sets DB_PATH too late — after the config was already loaded — and
    // would otherwise wipe the real data.
    if (process.env.VITEST && resolve(config.dbPath) === resolve('data/store.json')) {
      throw new Error(`refusing to write to the production store from a test (${config.dbPath})`);
    }
    // A failed write must not poison the chain: the next save starts clean.
    this.saveChain = this.saveChain.catch(() => undefined).then(async () => {
      try {
        await mkdir(dirname(config.dbPath), { recursive: true });
        // A unique temp name keeps concurrent test workers (or a second
        // process) from renaming the same `.tmp` file out from under each other.
        const tmp = `${config.dbPath}.${process.pid}.${++this.saveSeq}.tmp`;
        await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
        await rename(tmp, config.dbPath);
      } catch (err) {
        log.error(`could not write ${config.dbPath}`, err);
      }
    });
    return this.saveChain;
  }

  get snapshot(): Readonly<StoreData> {
    return this.data;
  }

  /** Changes whenever the closed history changes. */
  get historyVersion(): number {
    return this.historySeq;
  }

  isAllowed(chatId: number): boolean {
    return this.data.allowedChatIds.includes(chatId);
  }

  /**
   * First-run claim: with no configured allowlist the first chat to /start owns
   * the bot. This keeps an unconfigured deployment from being usable by anyone
   * who stumbles onto it.
   */
  async claim(chatId: number): Promise<boolean> {
    if (this.data.allowedChatIds.length > 0) return this.isAllowed(chatId);
    this.data.allowedChatIds.push(chatId);
    this.settingsFor(chatId);
    await this.persist();
    log.info(`chat ${chatId} claimed the bot`);
    return true;
  }

  settingsFor(chatId: number): ChatSettings {
    const existing = this.data.chats[String(chatId)];
    if (existing) {
      // Older records predate the automation settings; fill them in once.
      const defaults: Partial<ChatSettings> = {
        autoSwapToUsdg: false,
        autoTpTargetPct: 1,
        tpCycleLimit: 3,
        bidAskEntries: BID_ASK_DEFAULT_ENTRIES,
        currency: 'USD',
        timezone: DEFAULT_TIME_ZONE,
        autoSwapMinUsd: DEFAULT_AUTO_SWAP_MIN_USD,
        maxRouteDiscountPct: DEFAULT_MAX_ROUTE_DISCOUNT_PCT,
      };
      return {
        ...defaults,
        ...existing,
        bidAskEntries: normalizeBidAskEntries(existing.bidAskEntries),
        currency: normalizeCurrency(existing.currency),
        timezone: normalizeTimeZone(existing.timezone),
        autoSwapMinUsd: normalizeAutoSwapMin(existing.autoSwapMinUsd),
        maxRouteDiscountPct: normalizeRouteDiscount(existing.maxRouteDiscountPct),
      };
    }
    const fresh: ChatSettings = {
      dryRun: config.dryRun,
      slippagePct: config.defaultSlippagePct,
      alertsEnabled: true,
      autoSwapToUsdg: false,
      autoTpTargetPct: 1,
      tpCycleLimit: 3,
      bidAskEntries: BID_ASK_DEFAULT_ENTRIES,
      currency: 'USD',
      timezone: DEFAULT_TIME_ZONE,
      autoSwapMinUsd: DEFAULT_AUTO_SWAP_MIN_USD,
      maxRouteDiscountPct: DEFAULT_MAX_ROUTE_DISCOUNT_PCT,
    };
    this.data.chats[String(chatId)] = fresh;
    return fresh;
  }

  async updateSettings(chatId: number, patch: Partial<ChatSettings>): Promise<ChatSettings> {
    const next = { ...this.settingsFor(chatId), ...patch };
    if (patch.bidAskEntries !== undefined) {
      next.bidAskEntries = normalizeBidAskEntries(patch.bidAskEntries);
    }
    if (patch.currency !== undefined) {
      next.currency = normalizeCurrency(patch.currency);
    }
    if (patch.timezone !== undefined) {
      next.timezone = normalizeTimeZone(patch.timezone);
    }
    if (patch.autoSwapMinUsd !== undefined) {
      next.autoSwapMinUsd = normalizeAutoSwapMin(patch.autoSwapMinUsd);
    }
    if (patch.maxRouteDiscountPct !== undefined) {
      next.maxRouteDiscountPct = normalizeRouteDiscount(patch.maxRouteDiscountPct);
    }
    this.data.chats[String(chatId)] = next;
    await this.persist();
    return next;
  }

  positionsFor(chatId: number): TrackedPosition[] {
    return this.data.positions.filter((p) => p.chatId === chatId);
  }

  allPositions(): TrackedPosition[] {
    return [...this.data.positions];
  }

  find(chatId: number, ref: string): TrackedPosition | undefined {
    const needle = ref.trim().toLowerCase();
    const list = this.positionsFor(chatId);
    return (
      list.find((p) => p.id.toLowerCase() === needle) ??
      list.find((p) => p.tokenId === needle) ??
      list.find((p) => p.label?.toLowerCase() === needle)
    );
  }

  /**
   * A position NFT tracked anywhere in the bot, by manager and id. The v3 and
   * v4 managers hand out ids independently, so `#7` of one is not `#7` of the
   * other — but the same id in the same manager is always the same NFT.
   */
  findByToken(version: PositionVersion, tokenId: string): TrackedPosition | undefined {
    return this.data.positions.find((p) => p.version === version && p.tokenId === tokenId);
  }

  async add(position: Omit<TrackedPosition, 'id' | 'createdAt'>): Promise<TrackedPosition> {
    const id = `p${this.data.nextPositionNumber++}`;
    const record: TrackedPosition = { ...position, id, createdAt: Date.now() };
    this.data.positions.push(record);
    await this.persist();
    return record;
  }

  async update(id: string, patch: Partial<TrackedPosition>): Promise<TrackedPosition | undefined> {
    const idx = this.data.positions.findIndex((p) => p.id === id);
    if (idx === -1) return undefined;
    const next = { ...this.data.positions[idx]!, ...patch };
    this.data.positions[idx] = next;
    await this.persist();
    return next;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.data.positions.length;
    this.data.positions = this.data.positions.filter((p) => p.id !== id);
    if (this.data.positions.length === before) return false;
    await this.persist();
    return true;
  }

  /** Appends a frozen close record, newest last, capped at MAX_HISTORY. */
  async addClosed(record: Omit<ClosedRecord, 'id' | 'closedAt'> & { closedAt?: number }): Promise<ClosedRecord> {
    const closed: ClosedRecord = {
      ...record,
      id: `h${this.data.nextCloseNumber++}`,
      closedAt: record.closedAt ?? Date.now(),
    };
    this.data.history.push(closed);
    if (this.data.history.length > MAX_HISTORY) {
      this.data.history = this.data.history.slice(-MAX_HISTORY);
    }
    this.historySeq++;
    await this.persist();
    return closed;
  }

  /**
   * Adds what a swap did to a closed record.
   *
   * The frozen values stay as they are; the swap only adds what happened
   * after the close.
   */
  async updateClosed(id: string, patch: Partial<ClosedRecord>): Promise<ClosedRecord | undefined> {
    const idx = this.data.history.findIndex((r) => r.id === id);
    if (idx === -1) return undefined;
    const next = { ...this.data.history[idx]!, ...patch };
    this.data.history[idx] = next;
    this.historySeq++;
    await this.persist();
    return next;
  }

  /** Every closed record, newest first. */
  allHistory(): ClosedRecord[] {
    return this.data.history.slice().reverse();
  }

  /** Closed positions for a chat, newest first. */
  historyFor(chatId: number): ClosedRecord[] {
    return this.data.history.filter((r) => r.chatId === chatId).slice().reverse();
  }

  findClosed(chatId: number, ref: string): ClosedRecord | undefined {
    const needle = ref.trim().toLowerCase();
    return this.historyFor(chatId).find((r) => r.id.toLowerCase() === needle);
  }

  /** Remembers a pasted token, newest first, deduplicated by address. */
  async rememberToken(chatId: number, token: { address: string; symbol: string; name: string; decimals: number }): Promise<void> {
    const address = token.address.toLowerCase();
    this.data.addressBook = this.data.addressBook.filter(
      (entry) => !(entry.chatId === chatId && entry.address === address),
    );
    this.data.addressBook.push({
      chatId,
      address,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      lastUsedAt: Date.now(),
    });
    const mine = this.data.addressBook.filter((e) => e.chatId === chatId);
    if (mine.length > MAX_ADDRESSES) {
      const drop = new Set(
        mine
          .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
          .slice(0, mine.length - MAX_ADDRESSES)
          .map((e) => e.address),
      );
      this.data.addressBook = this.data.addressBook.filter(
        (e) => !(e.chatId === chatId && drop.has(e.address)),
      );
    }
    await this.persist();
  }

  addressesFor(chatId: number): AddressBookEntry[] {
    return this.data.addressBook
      .filter((e) => e.chatId === chatId)
      .slice()
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  addressFor(chatId: number, address: string): AddressBookEntry | undefined {
    const needle = address.toLowerCase();
    return this.data.addressBook.find((e) => e.chatId === chatId && e.address === needle);
  }

  async forgetAddress(chatId: number, address: string): Promise<void> {
    const needle = address.toLowerCase();
    this.data.addressBook = this.data.addressBook.filter(
      (e) => !(e.chatId === chatId && e.address === needle),
    );
    await this.persist();
  }
}

export const store = new Store();
