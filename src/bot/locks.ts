import { KeyedMutex } from '../utils/async.js';

/** Serializes transactions per chat so double taps cannot fire twice. */
export const txLock = new KeyedMutex();
