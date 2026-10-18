// Custom maps made in the map editor. Stored in the meta table under "maps" and registered into GD.MAPS.
const crypto = require('crypto');
const GD = require('../shared/data');

const MAX_MAPS = 60;
let custom = []; // [{ id, name, path, themeId, author, authorId, at }]

async function load(store) {
  custom = (await store.getMeta('maps')) || [];
  for (const m of custom) {
    if (GD.validatePath(m.path)) continue;
    GD.registerMap(m.id, { name: m.name, path: m.path, theme: GD.THEMES[m.themeId] || GD.THEMES.meadow });
  }
  if (custom.length) console.log(`[maps] loaded ${custom.length} custom maps`);
}

// Map definitions the browser needs to draw and pick maps
function list() {
  const builtin = GD.BUILTIN_MAPS.map((id) => ({ id, name: GD.MAPS[id].name, path: GD.MAPS[id].path, theme: GD.MAPS[id].theme, custom: false }));
  return builtin.concat(custom.filter((m) => GD.MAPS[m.id]).map((m) => ({
    id: m.id, name: m.name, path: m.path, theme: GD.MAPS[m.id].theme, themeId: m.themeId, custom: true, author: m.author, authorId: m.authorId,
  })));
}

const validMap = (id) => (id && GD.MAPS[id] ? id : undefined);

function mount(app, { store, authed, wrap, canEdit, isAdmin }) {
  const save = () => store.setMeta('maps', custom);

  app.get('/api/maps', authed, (req, res) => res.json({ maps: list() }));

  app.post('/api/maps', authed, wrap(async (req, res) => {
    if (!canEdit(req.user)) return res.status(403).json({ error: 'You do not have map editor access' });
    const b = req.body || {};
    const name = String(b.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 3 || name.length > 24) return res.status(400).json({ error: 'Map name: 3 to 24 characters' });
    if (!/^[\p{L}\p{N} _\-'!?.]+$/u.test(name)) return res.status(400).json({ error: 'Use letters, numbers and simple punctuation in the name' });
    const err = GD.validatePath(b.path);
    if (err) return res.status(400).json({ error: err });
    const themeId = GD.THEMES[b.themeId] ? b.themeId : 'meadow';
    if (custom.length >= MAX_MAPS) return res.status(400).json({ error: `Map limit reached (${MAX_MAPS}). Delete an old map first.` });
    if (custom.some((m) => m.name.toLowerCase() === name.toLowerCase()) || GD.BUILTIN_MAPS.some((id) => GD.MAPS[id].name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ error: 'A map with that name already exists' });
    }
    const m = { id: 'c_' + crypto.randomBytes(4).toString('hex'), name, path: b.path, themeId, author: req.user.username, authorId: req.user.id, at: Date.now() };
    custom.push(m);
    GD.registerMap(m.id, { name, path: m.path, theme: GD.THEMES[themeId] });
    await save();
    console.log(`[maps] ${req.user.username} created map "${name}"`);
    res.json({ maps: list(), id: m.id });
  }));

  app.post('/api/maps/:id/delete', authed, wrap(async (req, res) => {
    const m = custom.find((x) => x.id === String(req.params.id));
    if (!m) return res.status(404).json({ error: 'Map not found' });
    if (m.authorId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'You can only delete your own maps' });
    custom = custom.filter((x) => x !== m);
    delete GD.MAPS[m.id]; // running matches keep their own reference
    await save();
    console.log(`[maps] ${req.user.username} deleted map "${m.name}"`);
    res.json({ maps: list() });
  }));
}

module.exports = { load, list, mount, validMap };
