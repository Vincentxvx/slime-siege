// Password hashing (scrypt) and signed login tokens (HMAC). No extra dependencies.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_DAYS = 30;

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(__dirname, '..', 'data', 'secret.key');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (_) { /* create below */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, s);
  console.warn('[auth] SESSION_SECRET not set — generated data/secret.key (set SESSION_SECRET when hosting)');
  return s;
}
const SECRET = loadSecret();

// Async scrypt so logins never freeze running matches
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(pw, salt)).toString('hex');
  return `${salt}:${hash}`;
}

async function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const h = await scrypt(pw, salt);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === h.length && crypto.timingSafeEqual(h, expected);
}

const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function makeToken(uid) {
  const payload = Buffer.from(JSON.stringify({ uid, exp: Date.now() + TOKEN_DAYS * 864e5 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data.uid : null;
  } catch (_) { return null; }
}

module.exports = { hashPassword, verifyPassword, makeToken, readToken };
