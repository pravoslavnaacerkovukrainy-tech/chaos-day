import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ApiError, MESSAGES } from './errors.ts';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const MAX_MEM = 128 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 512;

export const COOKIE_NAME = 'chaos_day_session';

/**
 * Пароль хранится только как проверка: scrypt с отдельной солью.
 * Формат записи scrypt$N$r$p$<salt-hex>$<hash-hex>.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(normalize(password), salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(String(parts[4]), 'hex');
  const expected = Buffer.from(String(parts[5]), 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(normalize(password), salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: MAX_MEM,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function assertPasswordShape(password: unknown): string {
  if (typeof password !== 'string') {
    throw new ApiError(400, 'invalid_password', MESSAGES.invalidPassword);
  }
  const value = normalize(password);
  if (value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) {
    throw new ApiError(400, 'invalid_password', MESSAGES.invalidPassword);
  }
  return value;
}

function normalize(password: string): string {
  return password.normalize('NFKC');
}

export interface SessionToken {
  token: string;
  tokenHash: string;
}

export function createSessionToken(): SessionToken {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/** В базе лежит только отпечаток токена: утечка файла не даёт чужую сессию. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CookieOptions {
  maxAgeSec: number;
  secure: boolean;
}

export function sessionCookie(token: string, options: CookieOptions): string {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(options.maxAgeSec)}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const chunk of header.split(';')) {
    const index = chunk.indexOf('=');
    if (index <= 0) continue;
    const key = chunk.slice(0, index).trim();
    if (!key) continue;
    result[key] = chunk.slice(index + 1).trim();
  }
  return result;
}

/**
 * Простое ограничение подбора пароля: скользящее окно неудач по адресу клиента.
 * Держится в памяти процесса и не переживает перезапуск — на этапе 1 этого достаточно.
 */
export class LoginThrottle {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly hits: Map<string, number[]> = new Map();

  constructor(limit = 5, windowMs = 15 * 60 * 1000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  blocked(key: string, now: number = Date.now()): boolean {
    const recent = this.recent(key, now);
    return recent.length >= this.limit;
  }

  recordFailure(key: string, now: number = Date.now()): void {
    const recent = this.recent(key, now);
    recent.push(now);
    this.hits.set(key, recent);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private recent(key: string, now: number): number[] {
    const seen = this.hits.get(key) ?? [];
    return seen.filter((at) => now - at < this.windowMs);
  }
}
