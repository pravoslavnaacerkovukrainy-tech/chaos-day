import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COOKIE_NAME,
  LoginThrottle,
  assertPasswordShape,
  clearedSessionCookie,
  hashPassword,
  hashToken,
  parseCookies,
  sessionCookie,
  verifyPassword,
} from '../src/server/auth.ts';
import { createClock, createTestStore, throwsCode } from './helpers.ts';

const PASSWORD = 'вымышленный-пароль-проверки';

describe('Пароль хранится как проверка, а не как текст', () => {
  it('хеш не содержит пароль и зависит от соли', () => {
    const first = hashPassword(PASSWORD);
    const second = hashPassword(PASSWORD);

    assert.match(first, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    assert.notEqual(first, second, 'соль случайная, хеши различаются');
    assert.ok(!first.includes(PASSWORD));
    assert.ok(verifyPassword(PASSWORD, first));
    assert.ok(verifyPassword(PASSWORD, second));
  });

  it('неверный пароль не проходит проверку', () => {
    const stored = hashPassword(PASSWORD);
    assert.equal(verifyPassword('другой-пароль-проверки', stored), false);
    assert.equal(verifyPassword('', stored), false);
    assert.equal(verifyPassword(PASSWORD, 'не-хеш'), false);
    assert.equal(verifyPassword(PASSWORD, 'scrypt$16384$8$1$$'), false);
  });

  it('проверяет длину пароля', () => {
    assert.equal(assertPasswordShape('12345678'), '12345678');
    throwsCode(() => assertPasswordShape('1234567'), 'invalid_password');
    throwsCode(() => assertPasswordShape(''), 'invalid_password');
    throwsCode(() => assertPasswordShape('x'.repeat(513)), 'invalid_password');
    throwsCode(() => assertPasswordShape(undefined), 'invalid_password');
  });

  it('в базе лежит только хеш', () => {
    const { store } = createTestStore();
    assert.equal(store.setupRequired(), true);

    store.setupPassword(PASSWORD);
    const stored = store.passwordHash();
    assert.ok(stored !== null);
    assert.ok(stored?.startsWith('scrypt$'));
    assert.ok(!stored?.includes(PASSWORD));
    assert.equal(store.setupRequired(), false);
  });

  it('повторная настройка недоступна', () => {
    const { store } = createTestStore();
    store.setupPassword(PASSWORD);
    throwsCode(() => store.setupPassword('ещё-один-пароль-123'), 'setup_already_done');
  });

  it('проверка пароля и смена пароля', () => {
    const { store } = createTestStore();
    store.setupPassword(PASSWORD);
    assert.equal(store.checkPassword(PASSWORD), true);
    assert.equal(store.checkPassword('неверный-пароль-123'), false);
    assert.equal(store.checkPassword(undefined), false);

    throwsCode(() => store.changePassword('неверный-пароль-123', 'новый-пароль-123'), 'unauthorized');
    store.changePassword(PASSWORD, 'новый-пароль-123');
    assert.equal(store.checkPassword(PASSWORD), false);
    assert.equal(store.checkPassword('новый-пароль-123'), true);
  });

  it('смена пароля отзывает прежние сессии', () => {
    const { store } = createTestStore();
    store.setupPassword(PASSWORD);
    const { token } = store.createSession();
    assert.notEqual(store.touchSession(token), null);

    store.changePassword(PASSWORD, 'новый-пароль-123');
    assert.equal(store.touchSession(token), null);
  });
});

describe('Сессия заканчивается', () => {
  it('живая сессия продлевается, истёкшая отклоняется', () => {
    const clock = createClock();
    const { store } = createTestStore({ clock });
    store.setupPassword(PASSWORD);
    const { token, expiresAt } = store.createSession();

    const touched = store.touchSession(token);
    assert.notEqual(touched, null);
    assert.ok((touched?.expiresAt ?? 0) >= expiresAt);

    clock.advanceSeconds(30);
    assert.notEqual(store.touchSession(token), null, 'в пределах времени жизни сессия жива');

    clock.advanceSeconds(600);
    assert.equal(store.touchSession(token), null, 'сессия истекла');
  });

  it('отозванная сессия не работает', () => {
    const { store } = createTestStore();
    store.setupPassword(PASSWORD);
    const { token } = store.createSession();
    store.revokeSession(token);
    assert.equal(store.touchSession(token), null);
  });

  it('чужой и пустой токен не принимают', () => {
    const { store } = createTestStore();
    store.setupPassword(PASSWORD);
    store.createSession();
    assert.equal(store.touchSession(undefined), null);
    assert.equal(store.touchSession(''), null);
    assert.equal(store.touchSession('выдуманный-токен'), null);
  });

  it('в базе лежит отпечаток токена, а не сам токен', () => {
    const { store } = createTestStore();
    store.setupPassword(PASSWORD);
    const { token } = store.createSession();
    const row = store.db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
    assert.equal(row.token_hash, hashToken(token));
    assert.ok(!row.token_hash.includes(token));
  });
});

describe('Cookie сессии', () => {
  it('httpOnly, SameSite=Strict, без Secure на http и с Secure на https', () => {
    const plain = sessionCookie('abc', { maxAgeSec: 43200, secure: false });
    assert.equal(plain, `${COOKIE_NAME}=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`);

    const secure = sessionCookie('abc', { maxAgeSec: 43200, secure: true });
    assert.ok(secure.endsWith('; Secure'));
  });

  it('очистка cookie обнуляет срок жизни', () => {
    assert.equal(clearedSessionCookie(false), `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    assert.ok(clearedSessionCookie(true).endsWith('; Secure'));
  });

  it('разбирает заголовок cookie', () => {
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies(''), {});
    assert.deepEqual(parseCookies(`${COOKIE_NAME}=tok; other=1`), { [COOKIE_NAME]: 'tok', other: '1' });
    assert.deepEqual(parseCookies('broken; =novalue; a=b'), { a: 'b' });
  });
});

describe('Ограничение подбора пароля', () => {
  it('блокирует после порога и отпускает по истечении окна', () => {
    const throttle = new LoginThrottle(3, 1000);
    let now = 1_000_000;

    assert.equal(throttle.blocked('127.0.0.1', now), false);
    throttle.recordFailure('127.0.0.1', now);
    throttle.recordFailure('127.0.0.1', now + 1);
    assert.equal(throttle.blocked('127.0.0.1', now + 2), false);

    throttle.recordFailure('127.0.0.1', now + 2);
    assert.equal(throttle.blocked('127.0.0.1', now + 3), true);
    assert.equal(throttle.blocked('10.0.0.1', now + 3), false, 'другой адрес не заблокирован');

    assert.equal(throttle.blocked('127.0.0.1', now + 5000), false, 'окно истекло');
  });

  it('успешный вход снимает счётчик', () => {
    const throttle = new LoginThrottle(2, 60_000);
    const now = 5_000_000;
    throttle.recordFailure('ip', now);
    throttle.recordFailure('ip', now);
    assert.equal(throttle.blocked('ip', now), true);
    throttle.reset('ip');
    assert.equal(throttle.blocked('ip', now), false);
  });
});
