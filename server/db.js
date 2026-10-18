// Player storage. Uses Postgres when DATABASE_URL is set (recommended for hosting),
// otherwise a JSON file in ./data (fine for local / school-LAN use).
// Both keep user documents cached in memory; the server is the only writer.
const fs = require('fs');
const path = require('path');

class FileStore {
  constructor(file) {
    this.file = file;
    this.users = new Map();
    this.byName = new Map();
    this.timer = null;
  }
  async init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) {
      for (const u of JSON.parse(fs.readFileSync(this.file, 'utf8'))) {
        this.users.set(u.id, u);
        this.byName.set(u.username.toLowerCase(), u.id);
      }
    }
    console.log(`[db] file store: ${this.file} (${this.users.size} users)`);
  }
  async getById(id) { return this.users.get(id) || null; }
  async getByName(name) {
    const id = this.byName.get(String(name).toLowerCase());
    return id ? this.users.get(id) : null;
  }
  async create(doc) {
    const key = doc.username.toLowerCase();
    if (this.byName.has(key)) throw new Error('taken');
    this.users.set(doc.id, doc);
    this.byName.set(key, doc.id);
    this.scheduleSave();
    return doc;
  }
  async save(doc) { this.users.set(doc.id, doc); this.scheduleSave(); }
  async top(n) {
    return [...this.users.values()].sort((a, b) => (b.rating || 1000) - (a.rating || 1000) || b.wins - a.wins || b.xp - a.xp).slice(0, n);
  }
  scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 500);
  }
  flush() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...this.users.values()]));
    fs.renameSync(tmp, this.file);
  }
  async close() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.flush(); }
}

class PgStore {
  constructor(url) {
    const { Pool } = require('pg');
    const local = /localhost|127\.0\.0\.1/.test(url);
    this.pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 5 });
    this.cache = new Map();
  }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name_lower TEXT UNIQUE NOT NULL,
      doc JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now())`);
    console.log('[db] postgres store ready');
  }
  remember(doc) { if (doc) this.cache.set(doc.id, doc); return doc; }
  async getById(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const r = await this.pool.query('SELECT doc FROM users WHERE id=$1', [id]);
    return this.remember(r.rows[0] ? r.rows[0].doc : null);
  }
  async getByName(name) {
    const r = await this.pool.query('SELECT id, doc FROM users WHERE name_lower=$1', [String(name).toLowerCase()]);
    if (!r.rows[0]) return null;
    return this.cache.get(r.rows[0].id) || this.remember(r.rows[0].doc);
  }
  async create(doc) {
    try {
      await this.pool.query('INSERT INTO users (id, name_lower, doc) VALUES ($1,$2,$3)', [doc.id, doc.username.toLowerCase(), doc]);
    } catch (e) {
      if (e.code === '23505') throw new Error('taken');
      throw e;
    }
    return this.remember(doc);
  }
  async save(doc) {
    this.remember(doc);
    await this.pool.query('UPDATE users SET doc=$2, updated_at=now() WHERE id=$1', [doc.id, doc]);
  }
  async top(n) {
    const r = await this.pool.query(
      "SELECT doc FROM users ORDER BY COALESCE((doc->>'rating')::int, 1000) DESC, (doc->>'wins')::int DESC, (doc->>'xp')::int DESC LIMIT $1", [n]);
    return r.rows.map((x) => this.cache.get(x.doc.id) || x.doc);
  }
  async close() { await this.pool.end(); }
}

// Accepts the connection string even if it was pasted with quotes, backticks, spaces or a "psql" prefix.
function cleanDatabaseUrl(raw) {
  if (!raw || !raw.trim()) return null;
  const m = raw.match(/postgres(?:ql)?:\/\/[^\s'"`]+/);
  if (!m) {
    console.error('[db] DATABASE_URL is set but does not contain a postgresql://... connection string. Fix it in your host\'s environment settings.');
    process.exit(1);
  }
  return m[0];
}

async function createStore() {
  const dbUrl = cleanDatabaseUrl(process.env.DATABASE_URL);
  const store = dbUrl
    ? new PgStore(dbUrl)
    : new FileStore(process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'users.json'));
  await store.init();
  return store;
}

module.exports = { createStore };
