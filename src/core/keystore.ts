import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createLogger } from '../logger.js';
import { config } from '../config.js';

const log = createLogger('keystore');

/** scrypt cost parameters; N must be a power of two. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keyLen: 32 } as const;
const VERSION = 1 as const;

interface KeystoreFile {
  version: typeof VERSION;
  address: Address;
  label: string;
  createdAt: number;
  crypto: {
    kdf: 'scrypt';
    salt: string;
    N: number;
    r: number;
    p: number;
    iv: string;
    tag: string;
    ciphertext: string;
  };
}

function path(): string {
  return config.keystorePath;
}

function derive(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, SCRYPT.keyLen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * 1024 * 1024,
  });
}

/** Encrypts a private key with AES-256-GCM under a scrypt-derived passphrase. */
export async function encryptKey(privateKey: Hex, passphrase: string, label: string): Promise<KeystoreFile> {
  if (passphrase.length < 8) throw new Error('Passphrase must be at least 8 characters');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = derive(passphrase, salt, SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(privateKey.replace(/^0x/, ''), 'hex');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const account = privateKeyToAccount(privateKey);

  return {
    version: VERSION,
    address: account.address,
    label,
    createdAt: Date.now(),
    crypto: {
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    },
  };
}

export async function saveKeystore(file: KeystoreFile): Promise<void> {
  await mkdir(dirname(path()), { recursive: true });
  const tmp = `${path()}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path());
  log.info(`keystore written for ${file.address}`);
}

export async function loadKeystore(): Promise<KeystoreFile | undefined> {
  try {
    const raw = await readFile(path(), 'utf8');
    const parsed = JSON.parse(raw) as KeystoreFile;
    if (parsed.version !== VERSION || !parsed.crypto?.ciphertext) return undefined;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('could not read keystore', err);
    return undefined;
  }
}

/** Decrypts the keystore; throws a readable error on a wrong passphrase. */
export async function decryptKeystore(file: KeystoreFile, passphrase: string): Promise<Hex> {
  const salt = Buffer.from(file.crypto.salt, 'base64');
  const key = derive(passphrase, salt, file.crypto);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.crypto.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(file.crypto.tag, 'base64'));
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(file.crypto.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return `0x${plaintext.toString('hex')}` as Hex;
  } catch {
    throw new Error('Wrong passphrase (the key could not be decrypted)');
  }
}

export async function renameWallet(label: string): Promise<KeystoreFile> {
  const file = await loadKeystore();
  if (!file) throw new Error('No keystore on disk');
  const clean = label.trim().slice(0, 32);
  if (!clean) throw new Error('Name cannot be empty');
  const next = { ...file, label: clean };
  await saveKeystore(next);
  return next;
}

/** Constant-time comparison helper, exported for the tests. */