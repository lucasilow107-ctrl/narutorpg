'use strict';
/**
 * Naruto RPG — máy chủ online
 *  - Tài khoản: đăng ký / đăng nhập (bcrypt, tương thích users_db.json cũ), phiên đăng nhập lưu bền
 *  - Lưu game theo tài khoản + nhân vật (tự lưu khi thoát qua /api/save-beacon)
 *  - Phòng chơi chung (Socket.IO): tạo / vào bằng mã, mật khẩu, PvP bật/tắt, đồng minh, chat, nhắn riêng
 *  - Phục vụ client từ thư mục public/ (KHÔNG phục vụ file dữ liệu)
 *
 * Lưu trữ: mặc định file users_db.json. Render miễn phí xóa ổ đĩa mỗi lần máy chủ ngủ/khởi động lại,
 * nên hãy đặt biến môi trường MONGODB_URI (MongoDB Atlas miễn phí) để dữ liệu không bị mất.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(process.env.DATA_DIR || __dirname, 'users_db.json');
const CHARS = ['Naruto', 'Sasuke', 'Kakashi'];
const SESSION_MS = 30 * 24 * 3600 * 1000;
const USER_RE = /^[a-z0-9_]{3,20}$/;

let bcrypt = null;
try { bcrypt = require('bcryptjs'); } catch (e) { /* dùng scrypt nếu thiếu bcryptjs */ }

/* ============================ LƯU TRỮ ============================ */
// Định dạng tương thích server cũ: { users: { ten: { username, passwordHash, saves: { Nhanvat: data } } }, sessions: {...} }
function fileStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db = { users: {}, sessions: {} };
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* file mới */ }
  db.users = db.users || {}; db.sessions = db.sessions || {};
  let timer = null;
  const flush = () => {
    timer = null;
    try { fs.writeFileSync(file + '.tmp', JSON.stringify(db)); fs.renameSync(file + '.tmp', file); }
    catch (e) { console.error('Lỗi ghi DB:', e.message); }
  };
  const dirty = () => { if (!timer) timer = setTimeout(flush, 400); };
  const bye = () => { if (timer) { clearTimeout(timer); flush(); } };
  process.on('SIGTERM', () => { bye(); process.exit(0); });
  process.on('SIGINT', () => { bye(); process.exit(0); });
  process.on('exit', bye);
  setInterval(() => {
    const now = Date.now();
    for (const t in db.sessions) if (db.sessions[t].exp < now) delete db.sessions[t];
    dirty();
  }, 3600e3).unref();
  return {
    kind: 'file',
    flush,
    async getUser(u) { return Object.prototype.hasOwnProperty.call(db.users, u) ? db.users[u] : null; },
    async createUser(u, rec) { if (db.users[u]) return false; db.users[u] = Object.assign({ username: u, saves: {} }, rec); dirty(); return true; },
    async getSave(u, c) { const r = db.users[u]; return (r && r.saves && r.saves[c]) || null; },
    async setSave(u, c, data) { const r = db.users[u]; if (!r) return false; (r.saves = r.saves || {})[c] = data; dirty(); return true; },
    async delSave(u, c) { const r = db.users[u]; if (r && r.saves) { delete r.saves[c]; dirty(); } },
    async getSession(t) { const s = db.sessions[t]; if (!s) return null; if (s.exp < Date.now()) { delete db.sessions[t]; dirty(); return null; } return s; },
    async setSession(t, s) { db.sessions[t] = s; dirty(); },
    async delSession(t) { if (db.sessions[t]) { delete db.sessions[t]; dirty(); } },
  };
}

async function mongoStore(uri) {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri);
  await client.connect();
  const d = client.db(process.env.MONGODB_DB || 'naruto');
  const U = d.collection('users'), S = d.collection('sessions');
  await S.createIndex({ exp: 1 }, { expireAfterSeconds: 0 });
  return {
    kind: 'mongo',
    async getUser(u) { return U.findOne({ _id: u }); },
    async createUser(u, rec) {
      try { await U.insertOne(Object.assign({ _id: u, username: u, saves: {} }, rec)); return true; }
      catch (e) { if (e && e.code === 11000) return false; throw e; }
    },
    async getSave(u, c) { const r = await U.findOne({ _id: u }, { projection: { ['saves.' + c]: 1 } }); return (r && r.saves && r.saves[c]) || null; },
    async setSave(u, c, data) { const r = await U.updateOne({ _id: u }, { $set: { ['saves.' + c]: data } }); return r.matchedCount > 0; },
    async delSave(u, c) { await U.updateOne({ _id: u }, { $unset: { ['saves.' + c]: '' } }); },
    async getSession(t) { const s = await S.findOne({ _id: t }); return s ? { u: s.u, exp: s.exp.getTime() } : null; },
    async setSession(t, s) { await S.replaceOne({ _id: t }, { _id: t, u: s.u, exp: new Date(s.exp) }, { upsert: true }); },
    async delSession(t) { await S.deleteOne({ _id: t }); },
  };
}

/* ============================ TÀI KHOẢN (logic thuần, dễ kiểm thử) ============================ */
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
async function hashPw(pw) {
  if (bcrypt) return { passwordHash: await bcrypt.hash(pw, 10) };
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: (await scrypt(pw, salt, 64)).toString('hex') };
}
async function checkPw(user, pw) {
  if (user.passwordHash) return bcrypt ? bcrypt.compare(pw, user.passwordHash) : false;   // tài khoản cũ (bcrypt)
  if (user.hash && user.salt) return safeEq((await scrypt(pw, user.salt, 64)).toString('hex'), user.hash);
  return false;
}

const attempts = new Map();
const tooMany = key => {
  const now = Date.now(), a = attempts.get(key);
  if (!a || now - a.t > 5 * 60e3) { attempts.set(key, { n: 0, t: now }); return false; }
  return a.n >= 10;
};
const failed = key => { const a = attempts.get(key) || { n: 0, t: Date.now() }; a.n++; attempts.set(key, a); };
setInterval(() => { const now = Date.now(); for (const [k, a] of attempts) if (now - a.t > 5 * 60e3) attempts.delete(k); }, 60e3).unref();

function makeApi(store) {
  const err = (status, error) => ({ status, body: { error } });
  const newSession = async username => {
    const token = crypto.randomBytes(32).toString('hex');
    await store.setSession(token, { u: username, exp: Date.now() + SESSION_MS });
    return token;
  };
  const okChar = c => CHARS.includes(c);
  const okData = d => d && typeof d === 'object' && !Array.isArray(d) && JSON.stringify(d).length <= 60000;
  const who = async token => { const s = token ? await store.getSession(String(token)) : null; return s ? s.u : null; };
  return {
    who,
    async register(b) {
      const username = String((b && b.username) || '').trim().toLowerCase(), password = String((b && b.password) || '');
      if (!USER_RE.test(username)) return err(400, 'Tên tài khoản: 3–20 ký tự, chỉ dùng a-z, 0-9, _.');
      if (username.startsWith('khach')) return err(400, 'Tên tài khoản không được bắt đầu bằng "khach".');
      if (password.length < 6 || password.length > 64) return err(400, 'Mật khẩu phải từ 6 đến 64 ký tự.');
      const ok = await store.createUser(username, await hashPw(password));
      if (!ok) return err(409, 'Tài khoản đã tồn tại.');
      return { status: 200, body: { ok: true, username, token: await newSession(username) } };
    },
    async login(b, ip) {
      const username = String((b && b.username) || '').trim().toLowerCase(), password = String((b && b.password) || '');
      const key = (ip || '') + '|' + username;
      if (tooMany(key)) return err(429, 'Thử quá nhiều lần. Hãy đợi vài phút.');
      const u = USER_RE.test(username) ? await store.getUser(username) : null;
      if (!u || !(await checkPw(u, password))) { failed(key); return err(401, 'Sai tên tài khoản hoặc mật khẩu.'); }
      attempts.delete(key);
      return { status: 200, body: { ok: true, username, token: await newSession(username) } };
    },
    async me(token) { const u = await who(token); return { status: 200, body: u ? { loggedIn: true, username: u } : { loggedIn: false } }; },
    async logout(token) { if (token) await store.delSession(String(token)); return { status: 200, body: { ok: true } }; },
    async save(token, b) {
      const u = await who(token); if (!u) return err(401, 'Chưa đăng nhập hoặc phiên đã hết hạn.');
      if (!b || !okChar(b.character)) return err(400, 'Nhân vật không hợp lệ.');
      if (!okData(b.data)) return err(400, 'Dữ liệu lưu không hợp lệ.');
      return (await store.setSave(u, b.character, b.data)) ? { status: 200, body: { ok: true } } : err(404, 'Không tìm thấy tài khoản.');
    },
    async load(token, ch) {
      const u = await who(token); if (!u) return err(401, 'Chưa đăng nhập hoặc phiên đã hết hạn.');
      if (!okChar(ch)) return err(400, 'Nhân vật không hợp lệ.');
      return { status: 200, body: { data: (await store.getSave(u, ch)) || null } };
    },
    async del(token, ch) {
      const u = await who(token); if (!u) return err(401, 'Chưa đăng nhập hoặc phiên đã hết hạn.');
      if (!okChar(ch)) return err(400, 'Nhân vật không hợp lệ.');
      await store.delSave(u, ch); return { status: 200, body: { ok: true } };
    },
  };
}

/* ============================ HTTP ============================ */
function buildApp(store, rooms) {
  const express = require('express');
  const cors = require('cors');
  const api = makeApi(store);
  const app = express();
  app.set('trust proxy', 1);
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '128kb' }));
  const bearer = req => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; };
  const send = fn => async (req, res, next) => { try { const r = await fn(req); res.status(r.status).json(r.body); } catch (e) { next(e); } };

  app.get('/healthz', (req, res) => res.json({ ok: true, store: store.kind }));
  app.post('/api/register', send(req => api.register(req.body)));
  app.post('/api/login', send(req => api.login(req.body, req.ip)));
  app.get('/api/me', send(req => api.me(bearer(req))));
  app.post('/api/logout', send(req => api.logout(bearer(req))));
  app.post('/api/save', send(req => api.save(bearer(req), req.body)));
  app.get('/api/save/:char', send(req => api.load(bearer(req), req.params.char)));
  app.delete('/api/save/:char', send(req => api.del(bearer(req), req.params.char)));
  // sendBeacon khi đóng tab: text/plain (tránh preflight CORS), token nằm trong body
  app.post('/api/save-beacon', express.text({ type: '*/*', limit: '128kb' }), async (req, res, next) => {
    try {
      let b = {}; try { b = JSON.parse(req.body || '{}'); } catch (e) { /* bỏ qua */ }
      const r = await api.save(String(b.token || ''), { character: b.character, data: b.data });
      res.status(r.status).json(r.body);
    } catch (e) { next(e); }
  });
  app.get('/api/rooms', (req, res) => res.json({ rooms: rooms ? rooms() : [] }));

  // Chỉ phục vụ file client. Tuyệt đối không dùng express.static(__dirname): sẽ lộ users_db.json.
  const pub = path.join(__dirname, 'public');
  if (fs.existsSync(path.join(pub, 'index.html'))) app.use(express.static(pub));
  else {
    const f = n => (req, res) => res.sendFile(path.join(__dirname, n));
    app.get(['/', '/index.html'], f('index.html')); app.get('/online.js', f('online.js'));
  }
  app.use((e, req, res, next) => { console.error(e); res.status(500).json({ error: 'Lỗi máy chủ.' }); }); // eslint-disable-line no-unused-vars
  return app;
}

/* ============================ PHÒNG CHƠI (Socket.IO) ============================ */
function attachRealtime(io, store) {
  const rooms = new Map();            // mã -> phòng
  const byName = new Map();           // tên tài khoản -> socket (chống đăng nhập 2 nơi)
  const MAX_ROOMS = 300, ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const key = s => String(s == null ? '' : s).toLowerCase();
  const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
  const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null; };
  const sockOf = id => io.sockets.sockets.get(id);

  function newCode() {
    for (let i = 0; i < 50; i++) {
      let c = ''; for (let k = 0; k < 5; k++) c += ALPHA[crypto.randomInt(ALPHA.length)];
      if (!rooms.has(c)) return c;
    }
    return null;
  }
  const alliesOf = (r, name) => [...(r.allies.get(key(name)) || [])];
  const allied = (r, a, b) => { const s = r.allies.get(key(a)); return !!(s && s.has(key(b))); };
  function setAlly(r, a, b, on) {
    for (const [x, y] of [[key(a), key(b)], [key(b), key(a)]]) {
      let s = r.allies.get(x); if (!s) r.allies.set(x, s = new Set());
      on ? s.add(y) : s.delete(y);
      if (!s.size) r.allies.delete(x);
    }
  }
  const view = r => ({
    code: r.code, name: r.name, host: r.host, pvp: r.pvp, max: r.max, locked: !!r.pass, pub: r.pub,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, ch: p.ch, lvl: p.lvl, al: alliesOf(r, p.name) })),
  });
  const pushRoom = r => io.to(r.code).emit('room:state', view(r));
  const sys = (r, t) => io.to(r.code).emit('chat', { n: '', t, ch: 's', ts: Date.now() });
  const listRooms = () => [...rooms.values()].filter(r => r.pub).sort((a, b) => b.created - a.created).slice(0, 50).map(r => ({
    code: r.code, id: r.code, name: r.name, n: r.players.size, count: r.players.size, max: r.max, pvp: r.pvp, locked: !!r.pass,
    host: (r.players.get(r.host) || {}).name || '',
  }));

  // chủ mô phỏng boss: một người đang ở Thế giới (W); mất thì chuyển sang người khác
  function elect(r) {
    const cur = r.owner && r.players.get(r.owner);
    if (cur && cur.scn === 'W') return;
    let nid = null;
    for (const p of r.players.values()) if (p.scn === 'W') { nid = p.id; break; }
    if (nid === r.owner) return;
    r.owner = nid;
    if (nid) io.to(r.code).emit('b:own', { id: nid, bosses: r.bosses });
    else r.bosses = [];
  }
  function leave(socket, why) {
    const code = socket.data.room; if (!code) return;
    socket.data.room = null; socket.leave(code);
    const r = rooms.get(code); if (!r) return;
    const p = r.players.get(socket.id); r.players.delete(socket.id);
    if (!r.players.size) { rooms.delete(code); return; }
    if (r.owner === socket.id) { r.owner = null; elect(r); }
    if (r.host === socket.id) r.host = r.players.keys().next().value;
    if (p) sys(r, `${p.name} ${why || 'đã rời phòng'}.`);
    pushRoom(r);
  }
  function join(socket, r) {
    leave(socket);
    r.players.set(socket.id, { id: socket.id, name: socket.data.name, ch: null, lvl: 1, scn: null });
    socket.data.room = r.code; socket.join(r.code);
    sys(r, `${socket.data.name} đã vào phòng.`);
    pushRoom(r);
  }
  // giới hạn tốc độ (token bucket): perSec lượt/giây, tối đa `burst` lượt dồn
  function allow(socket, k, perSec, burst) {
    const now = Date.now(), b = (socket.data.rl = socket.data.rl || {});
    const cap = burst || perSec, x = b[k] || (b[k] = { t: now, n: cap });
    x.n = Math.min(cap, x.n + (now - x.t) / 1000 * perSec); x.t = now;
    if (x.n < 1) return false; x.n -= 1; return true;
  }

  io.use(async (socket, next) => {
    try {
      const a = socket.handshake.auth || {};
      let name = '', acct = false;
      if (a.token) { const s = await store.getSession(String(a.token)); if (s) { name = s.u; acct = true; } }
      if (!name) { const g = String(a.guest || ''); name = /^Khach\d{3,5}$/.test(g) ? g : 'Khach' + (1000 + crypto.randomInt(9000)); }
      socket.data.name = name; socket.data.acct = acct; socket.data.room = null;
      next();
    } catch (e) { next(e); }
  });

  io.on('connection', socket => {
    const S = socket.data;
    S.reqIn = new Map(); S.reqOut = new Map();
    if (S.acct) {
      const old = byName.get(S.name);
      if (old && old.id !== socket.id) { old.emit('kicked', 'Tài khoản vừa đăng nhập ở nơi khác.'); old.disconnect(true); }
      byName.set(S.name, socket);
    }
    socket.emit('hello', { id: socket.id, name: S.name });
    const myRoom = () => (S.room ? rooms.get(S.room) : null);
    const inRoomWith = (r, id) => { const t = sockOf(String(id)); return t && t.data.room === r.code && r.players.has(t.id) ? t : null; };

    socket.on('rooms:list', ack => { if (typeof ack === 'function') ack(listRooms()); });

    socket.on('room:create', (d, ack) => {
      if (typeof ack !== 'function') return;
      d = d || {};
      if (rooms.size >= MAX_ROOMS) return ack({ error: 'Máy chủ đang đầy phòng, thử lại sau.' });
      const code = newCode(); if (!code) return ack({ error: 'Không tạo được mã phòng.' });
      const r = {
        code, name: clean(d.name, 24) || `Phòng của ${S.name}`, pass: clean(d.password, 16),
        max: Math.round(num(d.max, 2, 8) || 4), pvp: !!d.pvp, pub: d.pub !== false,
        host: socket.id, players: new Map(), allies: new Map(), created: Date.now(), owner: null, bosses: [], mdefs: new Map(),
      };
      rooms.set(code, r); join(socket, r);
      ack({ ok: true, room: view(r), you: socket.id });
    });

    socket.on('room:join', (d, ack) => {
      if (typeof ack !== 'function') return;
      d = d || {};
      const r = rooms.get(clean(d.code, 8).toUpperCase());
      if (!r) return ack({ error: 'Không tìm thấy phòng với mã này.' });
      if (r.players.has(socket.id)) return ack({ ok: true, room: view(r), you: socket.id });
      if (r.players.size >= r.max) return ack({ error: 'Phòng đã đầy.' });
      if (r.pass && !safeEq(r.pass, clean(d.password, 16))) return ack({ error: 'Sai mật khẩu phòng.' });
      join(socket, r);
      ack({ ok: true, room: view(r), you: socket.id });
    });

    socket.on('room:leave', () => { leave(socket); });

    socket.on('room:set', d => {
      const r = myRoom(); if (!r || r.host !== socket.id || !d) return;
      if (typeof d.pvp === 'boolean') { r.pvp = d.pvp; sys(r, r.pvp ? '⚔ PvP đã BẬT.' : '☮ PvP đã TẮT.'); }
      pushRoom(r);
    });

    socket.on('room:kick', d => {
      const r = myRoom(); if (!r || r.host !== socket.id || !d || d.id === socket.id) return;
      const t = inRoomWith(r, d.id); if (!t) return;
      t.emit('room:kicked', 'Bạn đã bị chủ phòng mời ra khỏi phòng.');
      leave(t, 'đã bị mời ra khỏi phòng');
    });

    socket.on('p:enter', d => {
      const r = myRoom(); if (!r || !d) return;
      const p = r.players.get(socket.id); if (!p) return;
      if (CHARS.includes(d.ch)) p.ch = d.ch;
      p.lvl = Math.round(num(d.lvl, 1, 99) || 1);
      pushRoom(r);
    });

    /* ---- trạng thái / đạn / kỹ năng / hiệu ứng: chỉ chuyển tiếp trong phòng ---- */
    socket.on('p:s', d => {
      const r = myRoom(); if (!r || !d || r.players.size < 2 || !allow(socket, 's', 40, 40)) return;
      const x = num(d.x, -1e5, 1e5), y = num(d.y, -1e5, 1e5); if (x === null || y === null) return;
      const p = r.players.get(socket.id); if (p) { if (d.l) p.lvl = Math.round(num(d.l, 1, 99) || p.lvl); p.px = x; p.py = y; }
      socket.to(r.code).volatile.emit('p:s', {
        id: socket.id, x, y, f: d.f < 0 ? -1 : 1, h: num(d.h, 0, 1e6), m: num(d.m, 1, 1e6), c: num(d.c, 0, 1e6), mc: num(d.mc, 1, 1e6),
        l: num(d.l, 1, 99), s: num(d.s, 0, 1e9), k: num(d.k, 0, 1e7), sn: clean(d.sn, 24), b: num(d.b, 0, 15), u: clean(d.u, 9), a: num(d.a, 0, 1), d: d.d ? 1 : 0,
      });
    });
    socket.on('p:sh', d => {
      const r = myRoom(); if (!r || !d || r.players.size < 2 || !allow(socket, 'sh', 60, 80)) return;
      const x = num(d.x, -1e5, 1e5), y = num(d.y, -1e5, 1e5), vx = num(d.vx, -60, 60), vy = num(d.vy, -60, 60);
      if ([x, y, vx, vy].includes(null)) return;
      socket.to(r.code).volatile.emit('p:sh', {
        id: socket.id, i: num(d.i, 0, 1e9), x, y, vx, vy, c: clean(d.c, 9), s: num(d.s, 1, 40) || 5, l: num(d.l, 1, 400) || 60, n: d.n ? 1 : 0, sn: clean(d.sn, 24),
      });
    });
    socket.on('p:pk', d => { // đạn đã trúng mục tiêu: người xem xóa đạn tương ứng
      const r = myRoom(); if (!r || !d || !allow(socket, 'pk', 60, 80)) return;
      socket.to(r.code).volatile.emit('p:pk', { id: socket.id, i: num(d.i, 0, 1e9) });
    });
    socket.on('p:cast', d => {
      const r = myRoom(); if (!r || !d || r.players.size < 2 || !allow(socket, 'cast', 12, 14)) return;
      const k = clean(d.k, 24), a = num(d.a, -7, 7), mx = num(d.mx, -1e5, 1e5), my = num(d.my, -1e5, 1e5);
      if (!k || [a, mx, my].includes(null)) return;
      socket.to(r.code).emit('p:cast', { id: socket.id, k, a, mx, my, sn: clean(d.sn, 24) });
    });
    socket.on('p:fx', d => {
      const r = myRoom(); if (!r || !d || r.players.size < 2 || !allow(socket, 'fx', 30, 40)) return;
      const o = { id: socket.id, t: num(d.t, 0, 9), sn: clean(d.sn, 24), col: clean(d.col, 9) };
      for (const k of ['x', 'y', 'a', 'b']) { const v = num(d[k], -1e5, 1e5); if (v !== null) o[k] = v; }
      socket.to(r.code).volatile.emit('p:fx', o);
    });


    /* ---- QUÁI / KẺ ĐỊCH DÙNG CHUNG: chủ phòng mô phỏng, snapshot lọc theo khoảng cách người nhận ---- */
    const near = (p, x, y, R) => p.px != null && Math.hypot(p.px - x, p.py - y) < R;
    const wPlayers = (r, exceptId) => [...r.players.values()].filter(p => p.id !== exceptId && p.scn === 'W');
    socket.on('m:def', d => {
      const r = myRoom(); if (!r || !d || !isOwner(r) || !Array.isArray(d.l) || !allow(socket, 'mdef', 20, 30)) return;
      const l = [], now = Date.now();
      for (const o of d.l.slice(0, 80)) {
        if (!o) continue;
        const e = { i: clean(o.i, 12), k: o.k === 'b' ? 'b' : 'm', z: num(o.z, 0, 40) | 0, di: num(o.di, 0, 40) | 0, el: o.el ? 1 : 0, ch: clean(o.ch, 16), n: clean(o.n, 24), lv: num(o.lv, 0, 99) | 0, mh: num(o.mh, 1, 1e6) || 100, t: num(o.t, 0, 20) | 0 };
        if (!e.i) continue;
        r.mdefs.set(e.i, Object.assign(e, { ts: now })); l.push(e);
      }
      if (r.mdefs.size > 3000) for (const k of [...r.mdefs.keys()].slice(0, 500)) r.mdefs.delete(k);
      if (l.length) for (const p of wPlayers(r, socket.id)) io.to(p.id).emit('m:def', { l });
    });
    socket.on('m:need', d => {
      const r = myRoom(); if (!r || !d || !Array.isArray(d.l) || !allow(socket, 'mneed', 6, 10)) return;
      const l = []; for (const id of d.l.slice(0, 60)) { const e = r.mdefs.get(clean(id, 12)); if (e) l.push(e); }
      if (l.length) socket.emit('m:def', { l });
    });
    socket.on('m:snap', d => {
      const r = myRoom(); if (!r || !d || !isOwner(r) || !Array.isArray(d.l) || !allow(socket, 'msnap', 14, 20)) return;
      const rows = [];
      for (const q of d.l.slice(0, 700)) {
        if (!Array.isArray(q)) continue;
        const x = num(q[1], -1e5, 1e5), y = num(q[2], -1e5, 1e5), h = num(q[3], 0, 1e7);
        if ([x, y, h].includes(null)) continue;
        rows.push([clean(q[0], 12), Math.round(x), Math.round(y), Math.round(h), q[4] < 0 ? -1 : 1]);
      }
      const seen = new Set(rows.map(q => q[0])), now = Date.now();
      for (const [k, e] of r.mdefs) if (!seen.has(k) && now - e.ts > 6000) r.mdefs.delete(k);
      for (const p of wPlayers(r, socket.id)) {
        if (p.px == null) continue;
        const l = rows.filter(q => near(p, q[1], q[2], 3000));
        io.to(p.id).volatile.emit('m:snap', { l });
      }
    });
    socket.on('m:hit', d => {                                   // người khác đánh quái -> gửi cho chủ phòng
      const r = myRoom(); if (!r || !d || !r.owner || r.owner === socket.id || !Array.isArray(d.l) || !allow(socket, 'mhit', 20, 30)) return;
      const l = [], now = Date.now(), w = (S.mw = S.mw || { t: now, n: 0 });
      if (now - w.t > 1000) { w.t = now; w.n = 0; }
      for (const q of d.l.slice(0, 40)) {
        if (!Array.isArray(q)) continue;
        const dm = num(q[1], 1, 1500); if (dm === null) continue;
        if ((w.n += dm) > 12000) break;
        l.push([clean(q[0], 12), Math.round(dm)]);
      }
      if (l.length) io.to(r.owner).emit('m:hit', { from: socket.id, l });
    });
    socket.on('m:fx', d => {
      const r = myRoom(); if (!r || !d || !r.owner || r.owner === socket.id || !allow(socket, 'mfx', 10, 20)) return;
      io.to(r.owner).emit('m:fx', { i: clean(d.i, 12), k: clean(d.k, 8) });
    });
    socket.on('m:atk', d => {                                   // chủ phòng -> nạn nhân: đòn cận chiến của quái
      const r = myRoom(); if (!r || !d || !isOwner(r) || !allow(socket, 'matk', 60, 80)) return;
      const t = inRoomWith(r, d.to); if (!t || t.id === socket.id) return;
      t.emit('m:atk', { i: clean(d.i, 12), d: Math.round(num(d.d, 1, 300) || 5) });
    });
    socket.on('m:sh', d => {                                    // đạn của quái/kẻ địch
      const r = myRoom(); if (!r || !d || !isOwner(r) || !Array.isArray(d.l) || !allow(socket, 'msh', 40, 80)) return;
      const l = [];
      for (const q of d.l.slice(0, 60)) {
        if (!Array.isArray(q)) continue;
        const v = [num(q[0], -1e5, 1e5), num(q[1], -1e5, 1e5), num(q[2], -60, 60), num(q[3], -60, 60), num(q[4], 1, 200), num(q[5], 1, 30), num(q[6], 1, 600)];
        if (v.includes(null)) continue;
        l.push(v.map(n => Math.round(n * 100) / 100).concat([clean(q[7], 9), num(q[8], 0, 9) | 0, num(q[9], 0, 200) || 0, num(q[10], 0, 2) || 0, num(q[11], -7, 7) || 0, num(q[12], 0, 9) | 0]));
      }
      if (!l.length) return;
      for (const p of wPlayers(r, socket.id)) if (near(p, l[0][0], l[0][1], 2600)) io.to(p.id).volatile.emit('m:sh', { i: clean(d.i, 12), l });
    });
    socket.on('m:dead', d => {                                  // chủ phòng báo người hạ gục quái để chia thưởng
      const r = myRoom(); if (!r || !d || !isOwner(r) || !allow(socket, 'mdead', 30, 60)) return;
      const t = inRoomWith(r, d.to); if (!t || t.id === socket.id) return;
      t.emit('m:dead', { i: clean(d.i, 12), x: num(d.x, -1e5, 1e5), y: num(d.y, -1e5, 1e5), k: d.k === 'b' ? 'b' : 'm', t: num(d.t, 0, 20) | 0, el: d.el ? 1 : 0, lv: num(d.lv, 0, 99) | 0 });
    });

    /* ---- PvP: người tấn công tính sát thương, nạn nhân áp dụng; đồng minh không đánh nhau ---- */
    socket.on('p:hit', d => {
      const r = myRoom(); if (!r || !d || !r.pvp || !allow(socket, 'hit', 40, 60)) return;
      const t = inRoomWith(r, d.to); if (!t || t.id === socket.id || allied(r, S.name, t.data.name)) return;
      const dm = num(d.d, 1, 500); if (dm === null) return;
      const now = Date.now(), w = (S.dw = S.dw || { t: now, n: 0 });
      if (now - w.t > 1000) { w.t = now; w.n = 0; }
      if ((w.n += dm) > 3000) return;                                        // trần sát thương mỗi giây
      t.data.lastHit = { from: socket.id, ts: now };
      (S.atk = S.atk || new Map()).set(t.id, now);
      t.emit('p:hit', { from: socket.id, d: Math.round(dm) });
    });
    socket.on('p:st', d => {                                                  // hiệu ứng trạng thái (làm chậm)
      const r = myRoom(); if (!r || !d || !r.pvp || d.fx !== 'slow' || !allow(socket, 'st', 10, 12)) return;
      const t = inRoomWith(r, d.to); if (!t || allied(r, S.name, t.data.name)) return;
      if (!S.atk || Date.now() - (S.atk.get(t.id) || 0) > 1500) return;
      t.emit('p:st', { from: socket.id, fx: 'slow' });
    });
    socket.on('p:kill', d => {                                                // nạn nhân báo: bị `to` hạ gục
      const r = myRoom(); if (!r || !d) return;
      const lh = S.lastHit; if (!lh || lh.from !== String(d.to) || Date.now() - lh.ts > 20000) return;
      S.lastHit = null;
      const killer = r.players.get(lh.from); if (!killer) return;
      io.to(killer.id).emit('p:kill', { from: socket.id, l: num(d.l, 1, 99) || 1 });
      sys(r, `⚔ ${killer.name} đã hạ gục ${S.name}!`);
    });

    /* ---- BOSS DÙNG CHUNG: chủ phòng mô phỏng (owner) phát snapshot; người khác gửi sát thương về owner ---- */
    socket.on('p:scn', d => {
      const r = myRoom(); if (!r || !d) return;
      const p = r.players.get(socket.id); if (!p) return;
      p.scn = ['L', 'W', 'R'].includes(String(d.s)[0]) ? String(d.s)[0] : null;
      elect(r);
      if (p.scn === 'W' && r.owner && r.owner !== socket.id) socket.emit('b:own', { id: r.owner, bosses: [] });   // người mới vào Thế giới biết ai là chủ boss
    });
    const isOwner = r => r.owner === socket.id;
    socket.on('b:snap', d => {
      const r = myRoom(); if (!r || !d || !isOwner(r) || !Array.isArray(d.l) || !allow(socket, 'bsnap', 14, 20)) return;
      const l = [];
      for (const b of d.l.slice(0, 8)) {
        if (!b) continue;
        const x = num(b.x, -1e5, 1e5), y = num(b.y, -1e5, 1e5), h = num(b.h, 0, 1e9), m = num(b.m, 1, 1e9);
        if ([x, y, h, m].includes(null)) continue;
        l.push({ i: clean(b.i, 12), x: Math.round(x), y: Math.round(y), h: Math.round(h), m: Math.round(m), f: b.f < 0 ? -1 : 1, bi: num(b.bi, 0, 40) | 0,
          wb: b.wb ? 1 : 0, ch: clean(b.ch, 16), n: clean(b.n, 40), uc: clean(b.uc, 9), r: num(b.r, 10, 120) || 34, k: num(b.k, 1, 9) || 1, wl: num(b.wl, 0, 1e6) || 0 });
      }
      r.bosses = l;
      socket.to(r.code).volatile.emit('b:snap', { l });
    });
    socket.on('b:hit', d => {                       // người không phải owner đánh boss -> chuyển cho owner
      const r = myRoom(); if (!r || !d || !r.owner || isOwner(r) || !allow(socket, 'bhit', 30, 40)) return;
      const dm = num(d.d, 1, 3000); if (dm === null) return;
      const w = (S.bw = S.bw || { t: 0, n: 0 }), now = Date.now();
      if (now - w.t > 1000) { w.t = now; w.n = 0; }
      if ((w.n += dm) > 9000) return;
      io.to(r.owner).emit('b:hit', { from: socket.id, i: clean(d.i, 12), d: Math.round(dm) });
    });
    socket.on('b:atk', d => {                       // owner -> nạn nhân: đòn cận chiến của boss (nạn nhân tự áp dụng)
      const r = myRoom(); if (!r || !d || !isOwner(r) || !allow(socket, 'batk', 20, 30)) return;
      const t = inRoomWith(r, d.to); if (!t) return;
      const dm = num(d.d, 1, 200); if (dm === null) return;
      t.emit('b:atk', { i: clean(d.i, 12), d: Math.round(dm) });
    });
    socket.on('b:sh', d => {                        // owner phát đạn boss: mỗi người tự mô phỏng đạn trên máy mình (nạn nhân tự tính trúng)
      const r = myRoom(); if (!r || !d || !isOwner(r) || !Array.isArray(d.l) || !allow(socket, 'bsh', 30, 60)) return;
      const l = [];
      for (const q of d.l.slice(0, 40)) {
        if (!q) continue;
        const x = num(q.x, -1e5, 1e5), y = num(q.y, -1e5, 1e5), vx = num(q.vx, -40, 40), vy = num(q.vy, -40, 40);
        if ([x, y, vx, vy].includes(null)) continue;
        l.push({ x: Math.round(x), y: Math.round(y), vx: +vx.toFixed(2), vy: +vy.toFixed(2), d: num(q.d, 1, 200) || 4, c: clean(q.c, 9), s: num(q.s, 2, 20) || 6, l: num(q.l, 1, 600) || 200, a: num(q.a, -7, 7) || 0 });
      }
      if (l.length) socket.to(r.code).emit('b:sh', { i: clean(d.i, 12), l });
    });
    socket.on('b:spawn', d => {                     // owner báo boss mới (để mọi người thấy banner)
      const r = myRoom(); if (!r || !d || !isOwner(r) || !allow(socket, 'bsp', 2, 4)) return;
      socket.to(r.code).emit('b:spawn', { n: clean(d.n, 40), z: clean(d.z, 40), wb: d.wb ? 1 : 0 });
    });
    socket.on('b:dead', d => {                      // owner báo boss chết: mỗi người tự nhận rương/XP nếu đã đánh hoặc ở gần
      const r = myRoom(); if (!r || !d || !isOwner(r) || !allow(socket, 'bdd', 3, 6)) return;
      const x = num(d.x, -1e5, 1e5), y = num(d.y, -1e5, 1e5); if (x === null || y === null) return;
      const ct = (Array.isArray(d.ct) ? d.ct : []).slice(0, 8).map(v => clean(v, 40));
      socket.to(r.code).emit('b:dead', { i: clean(d.i, 12), x, y, wb: d.wb ? 1 : 0, bi: num(d.bi, 0, 40) | 0, uc: clean(d.uc, 9), n: clean(d.n, 40), ct });
      r.bosses = r.bosses.filter(b => b.i !== clean(d.i, 12));
    });

    /* ---- chat: phòng / đồng minh / nhắn riêng ---- */
    socket.on('chat', d => {
      const r = myRoom(); if (!r || !d || !allow(socket, 'chat', 1.2, 4)) return;
      const t = clean(d.t, 120); if (!t) return;
      const m = { n: S.name, t, ts: Date.now(), a: d.a ? 1 : 0 };
      if (d.ch === 'w') {
        const q = key(clean(d.to, 24)), all = [...r.players.values()].filter(p => p.id !== socket.id);
        let tg = all.find(p => key(p.name) === q);
        if (!tg) { const c = all.filter(p => key(p.name).startsWith(q)); if (c.length === 1) tg = c[0]; }
        if (!q || !tg) return socket.emit('chat', { n: '', t: `Không tìm thấy người chơi "${clean(d.to, 24)}" trong phòng.`, ch: 's', ts: Date.now() });
        io.to(tg.id).emit('chat', Object.assign({ ch: 'w', dir: 'from' }, m));
        return socket.emit('chat', { ch: 'w', dir: 'to', n: tg.name, t, ts: m.ts });
      }
      if (d.ch === 'a') {
        const al = alliesOf(r, S.name);
        if (!al.length) return socket.emit('chat', { n: '', t: 'Bạn chưa có đồng minh nào. Dùng /ally <tên> để kết đồng minh.', ch: 's', ts: Date.now() });
        socket.emit('chat', Object.assign({ ch: 'a' }, m));
        for (const p of r.players.values()) if (p.id !== socket.id && al.includes(key(p.name))) io.to(p.id).emit('chat', Object.assign({ ch: 'a' }, m));
        return;
      }
      io.to(r.code).emit('chat', Object.assign({ ch: 'r' }, m));
    });

    /* ---- đồng minh ---- */
    socket.on('ally:req', d => {
      const r = myRoom(); if (!r || !d || !allow(socket, 'ally', 2, 5)) return;
      const t = inRoomWith(r, d.to); if (!t || t.id === socket.id) return;
      if (allied(r, S.name, t.data.name)) return socket.emit('chat', { n: '', t: `Bạn và ${t.data.name} đã là đồng minh rồi.`, ch: 's', ts: Date.now() });
      const now = Date.now();
      if (S.reqIn.has(t.id) && now - S.reqIn.get(t.id) < 90e3) {              // họ đã mời bạn trước -> tự chấp nhận
        S.reqIn.delete(t.id); t.data.reqOut.delete(socket.id);
        setAlly(r, S.name, t.data.name, true);
        sys(r, `🤝 ${S.name} và ${t.data.name} đã trở thành đồng minh!`); return pushRoom(r);
      }
      S.reqOut.set(t.id, now); t.data.reqIn.set(socket.id, now);
      t.emit('ally:ask', { from: socket.id, name: S.name });
      socket.emit('chat', { n: '', t: `🤝 Đã gửi lời mời đồng minh tới ${t.data.name}.`, ch: 's', ts: now });
    });
    socket.on('ally:ans', d => {
      const r = myRoom(); if (!r || !d) return;
      const f = inRoomWith(r, d.to); if (!f) return;
      const ts = S.reqIn.get(f.id); if (!ts || Date.now() - ts > 90e3) return;
      S.reqIn.delete(f.id); f.data.reqOut.delete(socket.id);
      if (d.ok) { setAlly(r, S.name, f.data.name, true); sys(r, `🤝 ${S.name} và ${f.data.name} đã trở thành đồng minh!`); pushRoom(r); }
      else f.emit('chat', { n: '', t: `${S.name} đã từ chối lời mời đồng minh.`, ch: 's', ts: Date.now() });
    });
    socket.on('ally:del', d => {
      const r = myRoom(); if (!r || !d) return;
      const t = d.id ? inRoomWith(r, d.id) : null, nm = t ? t.data.name : clean(d.name, 24);
      if (!nm || !allied(r, S.name, nm)) return;
      setAlly(r, S.name, nm, false);
      sys(r, `💔 ${S.name} đã hủy liên minh với ${nm}.`); pushRoom(r);
    });

    socket.on('disconnect', () => {
      leave(socket, 'đã mất kết nối');
      if (S.acct && byName.get(S.name) === socket) byName.delete(S.name);
    });
  });
  return { rooms, list: listRooms };
}

/* ============================ KHỞI ĐỘNG ============================ */
async function main() {
  const store = process.env.MONGODB_URI ? await mongoStore(process.env.MONGODB_URI) : fileStore(DB_FILE);
  const { Server } = require('socket.io');
  let rt = null;
  const server = http.createServer(buildApp(store, () => (rt ? rt.list() : [])));
  const io = new Server(server, { cors: { origin: true, credentials: true }, maxHttpBufferSize: 1e5, pingInterval: 15000, pingTimeout: 20000 });
  rt = attachRealtime(io, store);
  server.listen(PORT, () => {
    console.log(`Naruto RPG server :${PORT} · lưu trữ: ${store.kind}${store.kind === 'file' ? ' (' + DB_FILE + ')' : ''}`);
    if (store.kind === 'file' && process.env.RENDER) console.warn('⚠ Đang lưu bằng file trên Render: dữ liệu sẽ mất khi máy chủ khởi động lại. Hãy đặt MONGODB_URI.');
  });
  return { server, store, io };
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main, makeApi, buildApp, attachRealtime, fileStore };
