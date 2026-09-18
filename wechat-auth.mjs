// 记得 · 微信小程序登录与令牌鉴权
//
// 背景：网页版用 HttpOnly Cookie 保存会话，并靠 Origin 头防止跨站伪造。
// 小程序两者都做不到 —— 它不管理 Cookie，也发不出可信 Origin。
// 所以这里补一套「令牌」机制：小程序登录后拿一个令牌，之后每次请求放在
// Authorization 头里；Cookie 那条路原样保留，网页版不受影响。

import { randomBytes, createHash, timingSafeEqual, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });

export function createWechatAuth({ db, appid, secret, registrationOpen = false, maxAccounts = 50, hashPassword }) {
  if (!appid || !secret) return null;

  db.exec(`
    CREATE TABLE IF NOT EXISTS wechat_accounts(openid TEXT PRIMARY KEY, unionid TEXT, accountId TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wechat_tokens(tokenHash TEXT PRIMARY KEY, accountId TEXT NOT NULL, expires INTEGER NOT NULL);
  `);

  // 用微信的临时登录凭证换取用户标识
  async function code2session(code) {
    if (typeof code !== 'string' || !/^[a-zA-Z0-9_-]{10,200}$/.test(code)) throw fail(400, '登录凭证无效。');
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.searchParams.set('appid', appid);
    url.searchParams.set('secret', secret);
    url.searchParams.set('js_code', code);
    url.searchParams.set('grant_type', 'authorization_code');
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const value = await res.json();
    // 登录凭证只能使用一次，重复或过期都返回非零 errcode
    if (value.errcode || !value.openid) throw fail(401, '微信登录已失效，请重试。');
    return { openid: value.openid, unionid: value.unionid || '' };
  }

  async function newToken(accountId) {
    db.prepare('DELETE FROM wechat_tokens WHERE expires<?').run(Date.now());
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO wechat_tokens VALUES (?,?,?)').run(digest(token), accountId, Date.now() + 30 * 86400000);
    return token;
  }

  // 令牌 → 账号。找不到就返回 null，交给上层按未登录处理。
  function accountByToken(req) {
    const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(req.headers.authorization || '');
    if (!m) return null;
    const row = db.prepare('SELECT a.* FROM wechat_tokens t JOIN accounts a ON a.id=t.accountId WHERE t.tokenHash=? AND t.expires>?')
      .get(digest(m[1]), Date.now());
    return row || null;
  }

  function revoke(req) {
    const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(req.headers.authorization || '');
    if (m) db.prepare('DELETE FROM wechat_tokens WHERE tokenHash=?').run(digest(m[1]));
  }

  // 微信用户首次进入时自动建号：随机密码，用户永远不会用到它
  async function findOrCreateAccount(openid, unionid) {
    const bound = db.prepare('SELECT accountId FROM wechat_accounts WHERE openid=?').get(openid);
    if (bound) {
      const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(bound.accountId);
      if (account) return account;
    }
    if (!registrationOpen) throw fail(403, '当前暂未开放新用户注册。');
    if (db.prepare('SELECT count(*) AS n FROM accounts').get().n >= maxAccounts) throw fail(403, '本轮名额已满。');

    const salt = randomBytes(16).toString('hex');
    const passwordHash = hashPassword
      ? await hashPassword(randomBytes(24).toString('hex'), salt)
      : (await derive(randomBytes(24).toString('hex'), salt, 64, { N: 16384, r: 8, p: 1 })).toString('hex');
    const recovery = randomBytes(24).toString('hex');
    const id = randomBytes(16).toString('hex');
    const username = 'wx_' + digest(openid).slice(0, 20);

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?,?,?)')
        .run(id, username, '记得用户', salt, passwordHash, digest(recovery), new Date().toISOString());
      db.prepare('INSERT INTO wechat_accounts VALUES (?,?,?,?)')
        .run(openid, unionid, id, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw e;
    }
    return db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  }

  // 老用户输入账号密码，把原账号绑到当前微信上
  async function bindAccount(openid, unionid, username, password, verifyPassword) {
    const name = String(username || '').trim().toLowerCase();
    const account = db.prepare('SELECT * FROM accounts WHERE username=?').get(name);
    if (!account) throw fail(401, '账号或密码不正确。');
    const ok = await verifyPassword(account, password);
    if (!ok) throw fail(401, '账号或密码不正确。');
    const existing = db.prepare('SELECT accountId FROM wechat_accounts WHERE openid=?').get(openid);
    if (existing && existing.accountId !== account.id) throw fail(409, '这个微信已绑定另一个账号。');
    db.prepare('INSERT INTO wechat_accounts VALUES (?,?,?,?) ON CONFLICT(openid) DO UPDATE SET accountId=excluded.accountId')
      .run(openid, unionid, account.id, new Date().toISOString());
    return account;
  }

  const profile = a => ({ id: a.id, username: a.username, displayName: a.displayName });

  async function handleLogin(body) {
    const { openid, unionid } = await code2session(body.code);
    const account = await findOrCreateAccount(openid, unionid);
    return { token: await newToken(account.id), account: profile(account) };
  }

  async function handleBind(body, verifyPassword) {
    const { openid, unionid } = await code2session(body.code);
    const account = await bindAccount(openid, unionid, body.username, body.password, verifyPassword);
    return { token: await newToken(account.id), account: profile(account) };
  }

  return { accountByToken, revoke, handleLogin, handleBind, code2session };
}
