/* =====================================================================
 * online.js v2 — lớp online cho Naruto RPG (nạp sau game chính trong index.html)
 *  - Menu chính: Chơi đơn / Tạo phòng / Vào phòng (mã + mật khẩu), phòng chơi chung
 *  - Người chơi khác hiện trong thế giới: bảng tên (cấp·điểm·máu·chakra), đạn, KỸ NĂNG đầy đủ
 *  - PvP (chủ phòng bật/tắt) · Đồng minh (không bắn nhầm, chat riêng, khung đồng đội)
 *  - Khóa mục tiêu (Tab / click / lệnh), tự ngắm có đón đầu, khung mục tiêu
 *  - Chat: Enter mở ô nhập → Enter gửi · lệnh /help · nhắn riêng · bong bóng chat trên đầu
 *  - Tự lưu game (20 giây/lần, khi ẩn tab, khi thoát)
 * Game chính chỉ gọi vào đối tượng NET (xem "NET." trong index.html).
 * ===================================================================== */
(function () {
  'use strict';
  const N = window.NET;
  const G = new Map();                  // id -> ghost (người chơi khác, nằm trong F với cờ remote)
  const reqs = new Map();               // id -> {name, ts}: lời mời đồng minh đang chờ
  const chatLog = [], hist = [];
  let sock = null, myId = null, myNick = '', lastRoom = null, entered = false, lock = null, view = 'main',
      netpOpen = false, ioTries = 0, lastWhisper = '', sidc = 0, lastScn = null, ownerId = null, snapN = 0, bsh = new Map(), hi = -1, soloHinted = false, lastNet = '', lastSide = '';
  const $q = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* bỏ qua */ } };
  const guestName = () => {
    let g = lsGet('nio_guest', '');
    if (!/^Khach\d{3,5}$/.test(g)) { g = 'Khach' + (1000 + (Math.random() * 9000 | 0)); lsSet('nio_guest', g); }
    return g;
  };
  const myName = () => myNick || (guest ? guestName() : currentAccount) || 'Bạn';
  const scene = () => (lobby ? 'L' : dg ? 'R' + myId : 'W');
  const scn = s => ({ L: 'Lobby', W: 'Thế giới', R: 'Raid' }[String(s || '?')[0]] || '?');
  const inRoom = () => !!(N.room && sock && sock.connected);
  const meEntry = () => N.room && N.room.players.find(p => p.id === myId);
  const allyList = () => { const e = meEntry(); return (e && e.al) || []; };
  const isAlly = name => allyList().includes(String(name).toLowerCase());
  const lower = s => String(s || '').toLowerCase();
  const plist = () => (N.room ? N.room.players.filter(p => p.id !== myId) : []);
  function findPlayer(q) {                // tên đầy đủ hoặc tiền tố duy nhất (không phân biệt hoa thường)
    q = lower(q).trim(); if (!q) return null;
    const all = plist(), ex = all.find(p => lower(p.name) === q); if (ex) return ex;
    const c = all.filter(p => lower(p.name).startsWith(q)); return c.length === 1 ? c[0] : null;
  }
  Object.assign(N, { room: null, on: false, assist: lsGet('nio_assist', '1') === '1', pk: null, myName });
  N.rel = f => (f === me ? 'me' : !f.remote ? 'bot' : isAlly(f.name) ? 'ally' : N.pvp ? 'enemy' : 'neutral');

  /* ------------------------------ kết nối ------------------------------ */
  function connect() {
    if (sock) return;
    if (typeof io === 'undefined') {            // CDN lỗi -> thử lấy từ chính máy chủ
      if (ioTries++ > 0) { status('Không tải được thư viện Socket.IO.', 1); return; }
      const s = document.createElement('script');
      s.src = API_BASE + '/socket.io/socket.io.js'; s.onload = connect; s.onerror = () => status('Không tải được thư viện Socket.IO.', 1);
      document.head.appendChild(s); return;
    }
    sock = io(API_BASE, {
      auth: cb => cb({ token: N.tok(), guest: guest ? guestName() : '' }),
      transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 8000,
    });
    sock.on('connect', () => { N.on = true; myId = sock.id; lastScn = null; ownerId = null; status(); if (lastRoom && entered) rejoin(); });
    sock.on('hello', d => { myId = d.id; myNick = d.name || myNick; });
    sock.on('connect_error', e => { N.on = false; status('Chưa kết nối được máy chủ' + (e && e.message ? ' (' + e.message + ')' : '') + ' — đang thử lại…', 1); });
    sock.on('disconnect', () => { N.on = false; status(); if (N.room && run) banner('⚠ Mất kết nối máy chủ — đang thử nối lại…'); });
    sock.on('kicked', m => { sock.io.opts.reconnection = false; sock.disconnect(); leaveLocal(); alert(m); });
    sock.on('room:state', setRoom);
    sock.on('room:kicked', m => { leaveLocal(); if (run) banner('🚪 ' + esc(m)); else vMain(); });
    sock.on('p:s', onState); sock.on('p:sh', onShot); sock.on('p:pk', onPk); sock.on('p:cast', onCast);
    sock.on('p:hit', d => applyHit(d.from, d.d)); sock.on('p:st', onSt); sock.on('p:kill', onKill);
    sock.on('chat', onChat); sock.on('ally:ask', onAsk);
    sock.on('b:own', onOwn); sock.on('b:snap', onSnap); sock.on('b:hit', onBossHit); sock.on('b:atk', onBossAtk);
    sock.on('b:sh', onBossSh); sock.on('b:spawn', onBossSpawn); sock.on('b:dead', onBossDead);
  }
  function rejoin() {
    sock.emit('room:join', { code: lastRoom.code, password: lastRoom.pass }, r => {
      if (r && r.ok) { setRoom(r.room); sock.emit('p:enter', enterInfo()); if (run) banner('✅ Đã nối lại phòng ' + r.room.code); }
      else { leaveLocal(); if (run) banner('Không vào lại được phòng: ' + esc((r && r.error) || '')); }
    });
  }
  const enterInfo = () => ({ ch: me.char, lvl: me.lvl });

  /* ------------------------------ phòng & ghost ------------------------------ */
  function setRoom(r) {
    const pvpWas = N.pvp;
    N.room = r; N.pvp = !!r.pvp;
    if (!lastRoom || lastRoom.code !== r.code) lastRoom = { code: r.code, pass: '' };
    const ids = new Set(r.players.map(p => p.id));
    for (const id of [...G.keys()]) if (!ids.has(id)) removeGhost(id);
    for (const id of [...reqs.keys()]) if (!ids.has(id)) reqs.delete(id);
    for (const p of r.players) { const g = G.get(p.id); if (g) { g.name = p.name; if (p.ch && p.ch !== g.char && PAL[p.ch]) g.char = p.ch; } }
    if (run && pvpWas !== N.pvp) banner(N.pvp ? '⚔ PvP đã BẬT — coi chừng bạn bè (trừ đồng minh)!' : '☮ PvP đã TẮT');
    refreshUI();
  }
  function removeGhost(id) {
    const g = G.get(id); G.delete(id);
    if (g) { if (lock === g) lock = null; F = F.filter(f => f !== g); }
  }
  function leaveLocal() {
    N.room = null; N.pvp = false; lastRoom = null; entered = false; lock = null; reqs.clear(); ownerId = null; lastScn = null;
    for (const L of [F, typeof WL !== 'undefined' ? WL : null, typeof WF !== 'undefined' ? WF : null]) if (L) for (const f of L) if (f.rb) f.rb = 0;   // rời phòng: boss thành của riêng bạn
    for (const id of [...G.keys()]) removeGhost(id);
    refreshUI(); updTgt(); updSide();
  }
  function ensureGhost(d) {
    let g = G.get(d.id); if (g) return g;
    const pl = N.room && N.room.players.find(p => p.id === d.id);
    if (!pl || !pl.ch || !PAL[pl.ch]) return null;
    g = mk(pl.ch, d.x, d.y, 0, pl.name);
    Object.assign(g, { remote: 1, id: d.id, tx: d.x, ty: d.y, vx: 0, vy: 0, pt: performance.now(), scene: d.sn });
    G.set(d.id, g); return g;
  }
  function onState(d) {
    const g = ensureGhost(d); if (!g) return;
    const now = performance.now(), dt = Math.max(1, (now - g.pt) / 16.67);
    if (g.scene !== d.sn) { g.x = d.x; g.y = d.y; g.vx = g.vy = 0; }
    else { g.vx = g.vx * .4 + (d.x - g.tx) / dt * .6; g.vy = g.vy * .4 + (d.y - g.ty) / dt * .6; }
    g.dead = !!d.d; g.pt = now; g.tx = d.x; g.ty = d.y; g.scene = d.sn; g.face = d.f < 0 ? -1 : 1;
    if (d.h != null) g.hp = d.h; if (d.m != null) g.maxHp = d.m; if (d.c != null) g.chakra = d.c; if (d.mc != null) g.maxChakra = d.mc;
    if (d.l != null) g.lvl = d.l; if (d.s != null) g.score = d.s; if (d.k != null) g.kills = d.k;
    g.uc = d.u || '#fff'; const b = d.b | 0;
    g.buff.shield = b & 1 ? 9 : 0; g.buff.dodge = b & 2 ? 9 : 0; g.buff.ult = b & 4 ? 9 : 0; g.buff.fast = b & 8 ? 9 : 0;
    g.arm = d.a ? { dr: d.a } : null;
  }
  /* đạn M1 của người khác: chỉ để nhìn; sát thương do chủ đạn tính rồi gửi p:hit */
  function onShot(d) {
    const g = G.get(d.id); if (!g || d.sn !== scene() || PJ.length > 1100) return;
    PJ.push({ x: d.x, y: d.y, vx: d.vx, vy: d.vy, o: g, dmg: 0, col: d.c, size: d.s, life: d.l, hit: new Set(), a: 0, cos: 1, nt: d.n, cid: d.id, sid: d.i });
  }
  function onPk(d) {
    for (let i = PJ.length - 1; i >= 0; i--) { const p = PJ[i]; if (p.cid === d.id && p.sid === d.i) { burst(p.x, p.y, p.col, 5); PJ.splice(i, 1); break; } }
  }
  /* KỸ NĂNG của người khác: chạy lại đúng kỹ năng đó (chỉ hiệu ứng, không sát thương / không đụng vào quái của bạn) */
  function onCast(d) {
    const g = G.get(d.id); if (!g || d.sn !== scene() || g.scene !== d.sn) return;
    const it = IT[d.k]; if (!it || it.t !== 's' || typeof it.f !== 'function') return;
    const svF = F, svMs = ms, fl = flash, sk = shake;
    F = []; ms = { x: svMs.x, y: svMs.y, wx: d.mx, wy: d.my };
    try { it.f(g, d.a); } catch (e) { console.warn('cast:', e); }
    finally { F = svF; ms = svMs; flash = fl; shake = sk; }
  }

  /* ------------------------------ vòng lặp game gọi vào ------------------------------ */
  function syncF() {
    const sc = scene();
    for (let i = F.length - 1; i >= 0; i--) { const f = F[i]; if (f.remote && (G.get(f.id) !== f || f.scene !== sc)) F.splice(i, 1); }
    for (const g of G.values()) if (g.scene === sc && !g.dead && !F.includes(g)) F.push(g);
  }
  N.tick = function () {
    if (!me) return;
    for (const f of F) if (f.bub && --f.bub.t <= 0) f.bub = null;
    if (G.size || N.room) syncF();
    if (!N.room) return;
    if (lock && (!G.has(lock.id) || lock.scene !== scene() || Math.hypot(lock.x - me.x, lock.y - me.y) > 2600)) { lock = null; updTgt(); }
    if (inRoom() && run) { const sc = scene()[0]; if (sc !== lastScn) { lastScn = sc; sock.emit('p:scn', { s: sc }); } }
    bossTick();
    if (fr % 4 === 0 && inRoom() && run && N.room.players.length > 1) {
      const b = (me.buff.shield > 0 ? 1 : 0) | (me.buff.dodge > 0 ? 2 : 0) | (me.buff.ult > 0 ? 4 : 0) | (me.buff.fast > 0 ? 8 : 0);
      sock.volatile.emit('p:s', {
        x: Math.round(me.x), y: Math.round(me.y), f: me.face, h: Math.round(me.hp), m: me.maxHp, c: Math.round(me.chakra), mc: me.maxChakra,
        l: me.lvl, s: me.score, k: me.kills, sn: scene(), b, u: me.uc, a: me.arm ? me.arm.dr || 0 : 0, d: me.dead ? 1 : 0,
      });
    }
    if (fr % 6 === 0) updTgt();
  };
  N.step = function (f) {                        // thay cho AI: nội suy vị trí ghost + hiệu ứng trạng thái
    const age = Math.min(6, (performance.now() - f.pt) / 16.67), px = f.tx + f.vx * age, py = f.ty + f.vy * age, dx = px - f.x, dy = py - f.y;
    if (Math.abs(dx) + Math.abs(dy) > 900) { f.x = px; f.y = py; }
    else { f.x += dx * .28; f.y += dy * .28; if (Math.hypot(dx, dy) > 1.5) { f.anim += .18; if (fr % 7 === 0) PT.push({ x: f.x, y: f.y + 14, vx: rnd(-.5, .5), vy: -.3, col: '#9e9e9e', sz: 3, t: 14 }); } }
    if (f.hf > 0) f.hf--;
    for (const k in f.buff) if (k !== 'shield' && k !== 'dodge' && k !== 'ult' && k !== 'fast' && f.buff[k] > 0) f.buff[k]--;
    if (f.buff.poison > 0 && fr % 20 === 0) { dmg(f, 3 + (f.pby ? f.pby.lvl : 0), f.pby); burst(f.x, f.y, f.pc || '#76ff03', 3); }
    if (f.buff.ult > 0 && fr % 4 === 0) PT.push({ x: f.x + rnd(-20, 20), y: f.y + 10, vx: 0, vy: -2, col: f.uc, sz: 5, t: 20 });
    if (f.dv) { PT.push({ x: f.x, y: f.y, vx: 0, vy: 0, col: f.dv.col, sz: 8, t: 12 }); if (--f.dv.t <= 0) f.dv = null; }
  };

  /* ------------------------------ phát đạn / kỹ năng ------------------------------ */
  N.shot = function (q) {                        // chỉ đạn M1 và phân thân của bạn; kỹ năng đi qua p:cast
    if (N.cast || !inRoom() || !run || N.room.players.length < 2) return;
    const o = q.o; if (!(o === me || (o && o.o === me))) return;
    q.sid = ++sidc;
    sock.volatile.emit('p:sh', { i: q.sid, x: q.x | 0, y: q.y | 0, vx: +q.vx.toFixed(2), vy: +q.vy.toFixed(2), c: q.col, s: q.size || 5, l: q.life, n: q.nt ? 1 : 0, sn: scene() });
  };
  N.pkHit = p => { if (inRoom()) sock.volatile.emit('p:pk', { i: p.sid }); };   // đạn đã trúng (N.pk = id kẻ vừa hạ gục bạn)
  N.castOut = function (i, a) {
    if (!inRoom() || !run || N.room.players.length < 2) return;
    sock.emit('p:cast', { k: me.sl[i] || (me.char + i), a: +a.toFixed(3), mx: ms.wx | 0, my: ms.wy | 0, sn: scene() });
  };
  N.ct = function (c) {                          // mục tiêu (chỉ để bắn cho đẹp) của phân thân thuộc người chơi khác
    let b = null, bd = 400;
    for (const o of F) { if (o === c.o || o === c || o.dead || (o === me && c.o && isAlly(c.o.name))) continue; const d = Math.hypot(o.x - c.x, o.y - c.y); if (d < bd) { bd = d; b = o; } }
    return b;
  };

  /* ------------------------------ PvP ------------------------------ */
  N.canHit = (t, s) => !!(N.pvp && N.room && s === me && !me.dead && !lobby && !dg && t.scene === 'W' && !isAlly(t.name) && !inSafe(t) && !inSafe(me));
  N.hit = function (t, a) {                      // bạn đánh trúng người khác: gửi sát thương cho nạn nhân
    if (!inRoom()) return;
    sock.emit('p:hit', { to: t.id, d: a, sn: scene() });
    t.hf = 5; t.hp = Math.max(0, t.hp - a); txt(t.x + rnd(-8, 8), t.y - 30, a, '#ffeb3b'); burst(t.x, t.y, '#ff5252', 5); beep(900, .03, 'square');
    if (!lock) setLock(t);
  };
  let lastAtk = 0;
  function applyHit(from, d) {                   // bạn bị người khác đánh trúng
    if (!run || !me || me.dead || lobby || dg || !N.pvp || inSafe(me)) return;
    d = Math.min(500, Math.max(1, d | 0));
    me.hp -= d; me.hf = 5; txt(me.x + rnd(-8, 8), me.y - 30, d, '#ff5252'); shake = Math.max(shake, 5); beep(180, .06, 'sawtooth');
    const g = G.get(from);
    if (g && g.scene === scene()) { if (!lock) setLock(g); if (fr - lastAtk > 90) { lastAtk = fr; txt(me.x, me.y - 64, '⚔ ' + g.name, '#ff8a80'); } }
    if (me.hp <= 0) { N.pk = from; kill(me, null); N.pk = null; }
  }
  N.died = function () {                         // trả về tên người vừa hạ gục bạn (nếu là PvP); game tự hiện màn hồi sinh
    const from = N.pk; N.pk = null; lock = null; updTgt();
    if (!from || !inRoom()) return '';
    sock.emit('p:kill', { to: from, l: me.lvl });
    const pl = N.room.players.find(p => p.id === from);
    return pl ? pl.name : 'Người chơi';
  };
  function onKill(d) {
    const pl = N.room && N.room.players.find(p => p.id === d.from), l = d.l || 1;
    me.score += 100 + l * 20; me.kills++; me.xp += 60 + l * 15; me.hp = Math.min(me.maxHp, me.hp + 25); lvlUp(me);
    txt(me.x, me.y - 70, 'HẠ GỤC ' + (pl ? pl.name : ''), '#ff5252'); beep(660, .12, 'square');
  }
  function onSt() { if (run && me && !me.dead) me.buff.slow = Math.max(me.buff.slow || 0, 150); }
  N.st = t => { if (!inRoom() || fr - (t.lst || -99) < 20) return; t.lst = fr; sock.emit('p:st', { to: t.id, fx: 'slow' }); };


  /* ------------------------------ BOSS DÙNG CHUNG ------------------------------
   * Mỗi phòng có 1 "chủ boss" (người đang ở Thế giới, do máy chủ chọn) chạy AI + sinh boss + gửi ảnh chụp ~7 lần/giây.
   * Người khác thấy boss "ma" (rb), đánh boss = gửi sát thương cho chủ. Đạn/đòn của boss: mỗi máy tự mô phỏng, nạn nhân tự nhận sát thương.
   * Chủ rời Thế giới / thoát -> máy chủ chọn người khác, nhận nguyên boss từ ảnh chụp cuối. */
  N.own = () => !inRoom() || ownerId === myId;
  const worldList = () => (dg ? (typeof WF !== 'undefined' ? WF : null) : lobby ? (typeof WL !== 'undefined' ? WL : null) : F);
  const isRB = f => f.boss && !f.dgb && !f.dgx;
  const BSTUB = { boss: 1, dmgM: 1, buff: {}, name: 'Boss', x: 0, y: 0, mob: 0, remote: 0 };
  function mkBoss(o, rb) {
    const b = mk(typeof SPR !== 'undefined' && SPR[o.ch] ? o.ch : 'Naruto', o.x, o.y, 1, o.n || 'Boss');
    Object.assign(b, { bid: o.i, boss: 1, rb: rb ? 1 : 0, bi: o.bi | 0, wb: o.wb ? 1 : 0, r: o.r || 34, hp: o.h, maxHp: o.m, dmgM: 1, bdr: .15, bk: o.k || 1, uc: o.uc || '#fff', wl: o.wl || 0, t0: 0, tx: o.x, ty: o.y, face: o.f || 1, pt: performance.now() });
    return b;
  }
  const bossById = id => { for (const f of F) if (f.boss && f.bid === id) return f; return null; };
  function onOwn(d) {
    const was = ownerId, w = worldList();
    ownerId = d.id || null;
    if (!w) return;
    if (ownerId === myId && was !== myId) {                    // tôi thành chủ boss: nhận boss từ ảnh chụp cuối của máy chủ
      const list = d.bosses || [], keep = new Set(list.map(b => b.i));
      for (let i = w.length - 1; i >= 0; i--) { const f = w[i]; if (isRB(f) && !keep.has(f.bid)) w.splice(i, 1); }
      for (const o of list) {
        const f = w.find(x => x.boss && x.bid === o.i);
        if (f) { f.rb = 0; f.hp = Math.min(f.hp, o.h) || o.h; } else w.push(mkBoss(o, 0));
      }
      if (run && list.length) banner('👑 Bạn là chủ trận boss — boss đang chạy trên máy bạn');
    } else if (ownerId !== myId && ownerId) {                  // người khác làm chủ: bỏ boss thật cũ của mình, chờ ảnh chụp
      for (let i = w.length - 1; i >= 0; i--) { const f = w[i]; if (isRB(f) && !f.rb) w.splice(i, 1); }
    }
  }
  function onSnap(d) {
    if (N.own() || lobby || dg || !d || !Array.isArray(d.l)) return;
    const seen = new Set(), now = performance.now();
    for (const o of d.l) {
      seen.add(o.i);
      let b = bossById(o.i);
      if (!b) { F.push(mkBoss(o, 1)); continue; }
      if (!b.rb) continue;
      b.tx = o.x; b.ty = o.y; b.hp = o.h; b.maxHp = o.m; b.face = o.f < 0 ? -1 : 1; b.wl = o.wl; b.pt = now;
    }
    for (let i = F.length - 1; i >= 0; i--) { const f = F[i]; if (isRB(f) && !seen.has(f.bid)) F.splice(i, 1); }
  }
  N.stepBoss = function (f) {                                 // boss ma: nội suy theo ảnh chụp
    const dx = f.tx - f.x, dy = f.ty - f.y;
    if (Math.abs(dx) + Math.abs(dy) > 900) { f.x = f.tx; f.y = f.ty; } else { f.x += dx * .3; f.y += dy * .3; }
    if (Math.hypot(dx, dy) > 2) f.anim += .12;
    if (f.hf > 0) f.hf--;
    if (performance.now() - f.pt > 4000) f.dead = true;       // mất tín hiệu từ chủ boss
  };
  function bossTick() {
    if (!inRoom() || !N.own() || N.room.players.length < 2 || lobby || dg) { bsh.clear(); return; }
    if (bsh.size) {
      for (const [id, l] of bsh) if (l.length) sock.volatile.emit('b:sh', { i: id, l: l.slice(0, 40) });
      bsh.clear();
    }
    if (fr % 8 !== 0) return;
    const l = [];
    for (const f of F) if (isRB(f) && !f.rb && !f.dead) l.push({ i: f.bid, x: f.x | 0, y: f.y | 0, h: Math.ceil(f.hp), m: f.maxHp, f: f.face, bi: f.bi, wb: f.wb ? 1 : 0, ch: f.char, n: f.name, uc: f.uc, r: f.r, k: f.bk, wl: f.wl || 0 });
    if (l.length || snapN) { sock.volatile.emit('b:snap', { l }); snapN = l.length; }
  }
  N.bossSh = function (f, q) {
    if (!inRoom() || !N.own() || N.room.players.length < 2 || !f.bid) return;
    let l = bsh.get(f.bid); if (!l) bsh.set(f.bid, l = []);
    if (l.length < 40) l.push({ x: q.x | 0, y: q.y | 0, vx: +q.vx.toFixed(2), vy: +q.vy.toFixed(2), d: q.dmg, c: q.col, s: q.size, l: q.life, a: +(q.a || 0).toFixed(2) });
  };
  function onBossSh(d) {
    if (N.own() || !run || lobby || dg || !d || !Array.isArray(d.l)) return;
    const src = bossById(d.i) || BSTUB;
    for (const q of d.l) { if (PJ.length > 1100) break; PJ.push({ x: q.x, y: q.y, vx: q.vx, vy: q.vy, o: src, dmg: q.d, col: q.c, size: q.s, life: q.l, hit: new Set(), a: q.a, nt: 1 }); }
  }
  N.bossHit = function (t, a) { if (inRoom() && t.bid) sock.volatile.emit('b:hit', { i: t.bid, d: a }); };
  function onBossHit(d) { if (!N.own() || lobby || dg) return; const b = bossById(d.i); if (b && !b.rb) bossRemoteHit(b, d.d, d.from); }
  N.bossAtk = function (f, t, d) { if (inRoom() && t.id) sock.emit('b:atk', { to: t.id, i: f.bid, d }); };
  function onBossAtk(d) {
    if (!run || !me || me.dead || lobby || dg) return;
    dmg(me, d.d, bossById(d.i) || BSTUB);
  }
  N.bossSpawn = function (n, z, wb) { if (inRoom()) sock.emit('b:spawn', { n, z, wb }); };
  function onBossSpawn(d) {
    if (!run || lobby || dg) return;
    banner((d.wb ? '⚠ WORLD BOSS ' : '☠ ') + esc(d.n) + ' xuất hiện tại ' + esc(d.z) + '!'); beep(d.wb ? 80 : 120, .5, 'sawtooth');
  }
  N.bossDied = function (t) {
    if (!inRoom() || !t.bid) return;
    sock.emit('b:dead', { i: t.bid, x: t.x | 0, y: t.y | 0, wb: t.wb ? 1 : 0, bi: t.bi | 0, uc: t.uc, n: t.name, ct: Object.keys(t.ct || {}) });
  };
  function onBossDead(d) {
    const g = bossById(d.i);
    if (g) g.dead = true;
    if (!run || !me || lobby || dg) return;
    bossDeadRemote({ x: d.x, y: d.y, wb: d.wb, bi: d.bi, uc: d.uc, bid: d.i }, !!(g && g.mine) || (d.ct || []).includes(myId));
  }
  function bossList() { return F.filter(f => isRB(f) && !f.dead).sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y)); }

  /* ------------------------------ khóa mục tiêu ------------------------------ */
  function cands() {
    const sc = scene();
    return [...G.values()].filter(g => g.scene === sc && !g.dead && Math.hypot(g.x - me.x, g.y - me.y) < 2000)
      .sort((a, b) => (isAlly(a.name) - isAlly(b.name)) || (Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y)));
  }
  function setLock(g) { lock = g; updTgt(); }
  function cycleLock(dir) {
    const c = cands();
    if (!c.length) { lock = null; updTgt(); if (run) banner('Không có người chơi nào ở gần bạn'); return; }
    const i = lock ? c.indexOf(lock) : -1;
    setLock(i < 0 ? c[dir < 0 ? c.length - 1 : 0] : c[(i + dir + c.length + 1) % (c.length + 1)] || null);
  }
  function updTgt() {
    const el = $q('tgt'); if (!el) return;
    if (!lock || !me || !run) { if (el.style.display !== 'none') el.style.display = 'none'; return; }
    const rel = N.rel(lock), d = Math.round(Math.hypot(lock.x - me.x, lock.y - me.y) / 10),
      tg = { ally: ['ĐỒNG MINH', '#b2ff59'], enemy: ['KẺ ĐỊCH', '#ff6e6e'], neutral: ['HÒA BÌNH', '#4fc3f7'] }[rel] || ['', '#fff'],
      b = lock.buff, bf = [b.shield > 0 ? '🛡' : '', b.dodge > 0 ? '👁' : '', b.ult > 0 ? '🔥' : '', b.fast > 0 ? '💨' : '', b.slow > 0 ? '🐌' : '', b.poison > 0 ? '☠' : ''].filter(Boolean).join(' '),
      hp = Math.max(0, Math.min(100, lock.hp / lock.maxHp * 100)), ck = Math.max(0, Math.min(100, (lock.chakra || 0) / (lock.maxChakra || 1) * 100));
    el.style.display = 'block';
    el.innerHTML = `<div class="tn"><span>🎯 ${esc(lock.name)} <small>${esc(lock.char)} · LV ${lock.lvl}</small></span><span class="rl" style="background:${tg[1]}">${tg[0]}</span></div>
     <div class="bar"><div class="fill" style="width:${hp}%;background:#e53935"></div><div class="bt">${Math.ceil(lock.hp)} / ${lock.maxHp}</div></div>
     <div class="bar k"><div class="fill" style="width:${ck}%;background:#29b6f6"></div></div>
     <div class="tm">${d}m${bf ? ' · ' + bf : ''} · ★${lock.score | 0} ☠${lock.kills | 0}<br>${rel === 'enemy' ? (N.assist ? 'Tự ngắm BẬT' : 'Tự ngắm tắt') : rel === 'ally' ? 'Đồng minh — không thể gây sát thương' : 'PvP đang tắt'} · Tab đổi · Q bỏ khóa</div>`;
  }
  N.aim = function () {                          // tự ngắm có đón đầu khi đang khóa kẻ địch
    if (!lock || !N.pvp || !N.assist || lobby || dg || !me || isAlly(lock.name)) return;
    const d = Math.hypot(lock.x - me.x, lock.y - me.y), t = Math.min(30, d / 13);
    ms.wx = lock.x + (lock.vx || 0) * t; ms.wy = lock.y + (lock.vy || 0) * t;
  };
  N.draw = function (X) {
    if (!G.size) return;
    const sc = scene(), m = 46 / ZE;
    X.save();
    for (const g of G.values()) {
      if (g.scene !== sc) continue;
      const off = g.x < cam.x || g.x > cam.x + VW || g.y < cam.y || g.y > cam.y + VH, rel = N.rel(g);
      if (!off || (g !== lock && rel !== 'ally')) continue;                  // mũi tên chỉ hướng: mục tiêu khóa + đồng minh
      const wx = Math.max(cam.x + m, Math.min(cam.x + VW - m, g.x)), wy = Math.max(cam.y + m, Math.min(cam.y + VH - m, g.y)),
        a = Math.atan2(g.y - (cam.y + VH / 2), g.x - (cam.x + VW / 2)), col = rel === 'ally' ? '#b2ff59' : rel === 'enemy' ? '#ff5252' : '#40c4ff';
      X.save(); X.translate(wx, wy); X.rotate(a); X.fillStyle = col; X.strokeStyle = '#000'; X.lineWidth = 3 / ZE;
      X.beginPath(); X.moveTo(14, 0); X.lineTo(-8, -9); X.lineTo(-8, 9); X.closePath(); X.stroke(); X.fill(); X.restore();
      const t = g.name + ' · ' + Math.round(Math.hypot(g.x - me.x, g.y - me.y) / 10) + 'm';
      X.font = 'bold 12px sans-serif'; X.textAlign = 'center'; X.fillStyle = '#000'; X.fillText(t, wx + 1, wy - 17); X.fillStyle = '#fff'; X.fillText(t, wx, wy - 18);
    }
    if (lock && lock.scene === sc) {                                        // khung khóa mục tiêu
      const rel = N.rel(lock), s = 30 + Math.sin(fr * .15) * 3, x = lock.x, y = lock.y - 8, L = 11;
      X.strokeStyle = rel === 'enemy' ? '#ff1744' : rel === 'ally' ? '#b2ff59' : '#40c4ff'; X.lineWidth = 3;
      for (const [ax, ay] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        X.beginPath(); X.moveTo(x + ax * s, y + ay * (s - L)); X.lineTo(x + ax * s, y + ay * s); X.lineTo(x + ax * (s - L), y + ay * s); X.stroke();
      }
    }
    X.restore();
  };
  addEventListener('mousedown', e => {           // click vào người chơi khác để khóa
    if (e.button || !run || !me || !G.size || e.target.closest('#bar,#inv,#ib,#dlg,#set,#sb,#ob,#netp,#chatin,#party,#reqs,#mainmenu,#start,#auth,#pm,#rsp,#cf,#lo,#ld')) return;
    const wx = e.clientX / ZE + cam.x, wy = e.clientY / ZE + cam.y, sc = scene();
    let best = null, bd = 46;
    for (const g of G.values()) if (g.scene === sc) { const d = Math.hypot(g.x - wx, g.y - 8 - wy); if (d < bd) { bd = d; best = g; } }
    if (best) setLock(best);
  });

  /* ------------------------------ chat ------------------------------ */
  const QUICK = {
    hi: 'Xin chào mọi người! 👋', gg: 'GG! 👏', gl: 'Chúc may mắn! 🍀', ty: 'Cảm ơn nhé! 🙏', sry: 'Xin lỗi nha! 🙇', lol: 'Haha 😂',
    sos: '🆘 Cứu tôi với!', ok: '👌 Ok!', no: '❌ Không nhé.', ready: '✅ Sẵn sàng!', follow: '🏃 Đi theo tôi nào!', wait: '⏳ Chờ tôi chút!', danger: '⚠ Cẩn thận, nguy hiểm!',
  };
  const HELP = [
    '📖 LỆNH CHAT — Enter: mở ô nhập · Enter: gửi · Esc: hủy · ↑↓: tin trước đó · Tab: gợi ý tên',
    '/w <tên> <tin> — nhắn riêng (/r <tin> trả lời) · /a <tin> — chat đồng minh · /me <hành động>',
    '/ally <tên> — kết đồng minh · /unally <tên> — hủy · /allies — danh sách · /who — người trong phòng',
    '/lock <tên> — khóa mục tiêu · /unlock · /tp <tên> — dịch chuyển tới · /pvp on|off — (chủ phòng)',
    '/boss — danh sách boss (/boss tp: tới boss gần nhất) · /code — mã phòng · /leave — rời phòng · /clear — xóa chat',
    '💬 Nói nhanh: /' + Object.keys(QUICK).join(' /'),
  ];
  const sysLine = t => addLine({ k: 's', t, ts: Date.now() });
  function addLine(m) { chatLog.push(m); if (chatLog.length > 60) chatLog.shift(); renderChat(); }
  function fmt(m) {
    const t = esc(m.t), n = esc(m.n || '');
    switch (m.k) {
      case 'a': return `<div class="al"><b>[Đồng minh] ${n}:</b> ${t}</div>`;
      case 'w': return m.dir === 'to' ? `<div class="wh"><b>Bạn → ${n}:</b> ${t}</div>` : `<div class="wh"><b>${n} → bạn:</b> ${t}</div>`;
      case 's': return `<div class="sy">${t}</div>`;
      case 'e': return `<div class="me">* ${n} ${t}</div>`;
      default: return `<div><b>${n}:</b> ${t}</div>`;
    }
  }
  function renderChat() {
    const el = $q('chatbox'), inp = $q('chatin'); if (!el) return;
    const open = inp && inp.style.display === 'block', now = Date.now();
    const rows = chatLog.filter(m => open || now - m.ts < 12000).slice(open ? -12 : -6);
    const html = rows.map(fmt).join('');
    if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; }
    el.style.display = rows.length ? 'flex' : 'none'; el.scrollTop = el.scrollHeight;
  }
  setInterval(renderChat, 1000);
  function setBubble(name, text, k) {
    const f = name === myName() ? me : [...G.values()].find(g => g.name === name);
    if (f) f.bub = { s: text, t: 300, k };
  }
  function onChat(d) {
    const k = d.ch === 's' ? 's' : d.ch === 'w' ? 'w' : d.ch === 'a' ? 'a' : d.a ? 'e' : 'r', t = String(d.t);
    addLine({ k, n: d.n, t, dir: d.dir, ts: Date.now() });
    if (k === 'w' && d.dir === 'from') { lastWhisper = d.n; beep(740, .06, 'triangle'); }
    if (k === 'r' || k === 'a' || k === 'e') setBubble(d.n, d.a ? '*' + t + '*' : t, k === 'a' ? 'a' : 'r');
  }
  function sendMsg(o) {
    if (inRoom()) { sock.emit('chat', o); return; }
    addLine({ k: o.a ? 'e' : 'r', n: myName(), t: o.t, ts: Date.now() });
    if (me) me.bub = { s: o.a ? '*' + o.t + '*' : o.t, t: 300, k: 'r' };
    if (!soloHinted) { soloHinted = true; sysLine('ℹ Bạn đang chơi đơn nên chưa ai nghe thấy. Mở 🌐 Online để tạo/vào phòng chơi cùng bạn bè.'); }
  }
  function runCmd(line) {
    const m = line.match(/^\/(\S+)\s*([\s\S]*)$/); if (!m) return;
    const cmd = lower(m[1]), arg = m[2].trim(), need = () => { if (!inRoom()) { sysLine('Lệnh này chỉ dùng được khi đang ở trong phòng.'); return false; } return true; };
    const who = () => { const p = findPlayer(arg); if (!p) sysLine(arg ? `Không tìm thấy người chơi "${arg}" (hoặc nhiều người khớp).` : 'Hãy nhập tên người chơi.'); return p; };
    switch (cmd) {
      case 'help': case 'h': case '?': HELP.forEach(sysLine); break;
      case 'w': case 't': case 'msg': case 'whisper': {
        if (!need()) break; const i = arg.search(/\s/), nm = i < 0 ? arg : arg.slice(0, i), tx = i < 0 ? '' : arg.slice(i).trim();
        if (!nm || !tx) { sysLine('Cú pháp: /w <tên> <tin nhắn>'); break; } sock.emit('chat', { ch: 'w', to: nm, t: tx }); break;
      }
      case 'r': if (!need()) break; if (!lastWhisper) sysLine('Chưa có ai nhắn riêng cho bạn.'); else if (!arg) sysLine('Cú pháp: /r <tin nhắn>'); else sock.emit('chat', { ch: 'w', to: lastWhisper, t: arg }); break;
      case 'a': case 'ac': case 'ally': case 'allychat':
        if (cmd === 'ally') {                                  // /ally <tên> = kết đồng minh
          if (!need()) break; const p = who(); if (!p) break;
          if (isAlly(p.name)) sysLine(`Bạn và ${p.name} đã là đồng minh rồi.`); else sock.emit('ally:req', { to: p.id }); break;
        }
        if (!need()) break; if (!arg) sysLine('Cú pháp: /a <tin nhắn cho đồng minh>'); else sock.emit('chat', { ch: 'a', t: arg }); break;
      case 'unally': { if (!need()) break; const p = findPlayer(arg); if (p) sock.emit('ally:del', { id: p.id }); else if (arg) sock.emit('ally:del', { name: arg }); else sysLine('Cú pháp: /unally <tên>'); break; }
      case 'allies': { if (!need()) break; const al = allyList(); sysLine(al.length ? '🤝 Đồng minh: ' + al.map(a => { const p = N.room.players.find(q => lower(q.name) === a); return p ? p.name : a + ' (ngoại tuyến)'; }).join(', ') : 'Bạn chưa có đồng minh. Dùng /ally <tên>.'); break; }
      case 'who': { if (!need()) break; N.room.players.forEach(p => sysLine(`${p.id === N.room.host ? '👑' : '•'} ${p.name}${p.id === myId ? ' (bạn)' : ''} — ${p.ch || 'đang chọn nhân vật'} LV ${p.id === myId ? me.lvl : p.lvl}${p.id !== myId && isAlly(p.name) ? ' · 🤝 đồng minh' : ''}`)); break; }
      case 'me': if (!arg) sysLine('Cú pháp: /me <hành động>'); else sendMsg({ t: arg, a: 1 }); break;
      case 'lock': case 'target': { if (!need()) break; const p = who(); if (!p) break; const g = G.get(p.id); if (g && g.scene === scene()) { setLock(g); sysLine('🎯 Đã khóa ' + p.name); } else sysLine(p.name + ' không ở cùng khu vực với bạn.'); break; }
      case 'unlock': lock = null; updTgt(); break;
      case 'tp': { if (!need()) break; const p = who(); if (p) NETUI.tp(p.id); break; }
      case 'pvp': {
        if (!need()) break; if (!arg) { sysLine('PvP hiện đang ' + (N.pvp ? 'BẬT' : 'TẮT') + '.'); break; }
        if (N.room.host !== myId) { sysLine('Chỉ chủ phòng mới bật/tắt được PvP.'); break; }
        sock.emit('room:set', { pvp: /^(on|bat|bật|1|true)$/i.test(arg) }); break;
      }
      case 'boss': {
        if (lobby || dg) { sysLine('Lệnh /boss chỉ dùng ở Thế giới mở.'); break; }
        const L = bossList(); if (!L.length) { sysLine('Hiện chưa có boss nào trong thế giới.'); break; }
        if (/^tp$/i.test(arg.split(/\s+/)[0] || '')) { const b = L[0]; me.x = b.x + 300; me.y = b.y; sysLine('➡ Đã dịch chuyển tới ' + b.name); break; }
        L.forEach(b => sysLine(`${b.wb ? '🌍' : '👹'} ${b.name} — ${Math.round(b.hp / b.maxHp * 100)}% máu · cách ${Math.round(Math.hypot(b.x - me.x, b.y - me.y) / 10)}m`));
        sysLine('Gõ /boss tp để dịch chuyển tới boss gần nhất. Mọi người trong phòng cùng đánh chung boss.'); break;
      }
      case 'code': sysLine(N.room ? 'Mã phòng: ' + N.room.code : 'Bạn chưa ở trong phòng.'); break;
      case 'leave': NETUI.leave(); break;
      case 'clear': chatLog.length = 0; renderChat(); break;
      default:
        if (QUICK[cmd]) sendMsg({ t: QUICK[cmd] });
        else sysLine(`Lệnh "/${cmd}" không tồn tại. Gõ /help để xem danh sách.`);
    }
  }
  function submitChat(raw) {
    const t = String(raw || '').trim(); if (!t) return;
    hist.unshift(t); if (hist.length > 30) hist.pop();
    if (t[0] === '/') runCmd(t); else sendMsg({ t });
  }
  function openChat(pre) {
    const i = $q('chatin'); if (!i) return;
    for (const k in keys) keys[k] = false; down = false;
    i.style.display = 'block'; i.value = pre || ''; hi = -1; i.focus(); renderChat();
  }
  function closeChat() { const i = $q('chatin'); if (!i) return; i.style.display = 'none'; i.blur(); renderChat(); }
  { // gắn sự kiện cho ô nhập
    const i = $q('chatin');
    if (i) i.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); const v = i.value; closeChat(); submitChat(v); }
      else if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (hi + 1 < hist.length) { hi++; i.value = hist[hi]; } }
      else if (e.key === 'ArrowDown') { e.preventDefault(); if (hi > 0) { hi--; i.value = hist[hi]; } else { hi = -1; i.value = ''; } }
      else if (e.key === 'Tab') {                                            // gợi ý tên người chơi
        e.preventDefault(); const mm = i.value.match(/(\S*)$/), pre = lower(mm ? mm[1] : '');
        if (!pre) return; const c = plist().filter(p => lower(p.name).startsWith(pre));
        if (c.length) i.value = i.value.slice(0, i.value.length - pre.length) + c[0].name + ' ';
      }
    });
  }
  addEventListener('keydown', e => {
    if (!run || !me || (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (typeof DS !== 'undefined' && DS) return;                             // đang nói chuyện NPC
    const k = e.key.toLowerCase();
    if (k === 'tab') { e.preventDefault(); if (N.room && G.size) cycleLock(e.shiftKey ? -1 : 1); else banner('Chưa có người chơi nào để khóa mục tiêu'); }
    else if (k === 'q' && lock) { lock = null; updTgt(); }
    else if (e.key === 'Enter') { e.preventDefault(); openChat(); }
    else if (e.key === '/') { e.preventDefault(); openChat('/'); }
  });

  /* ------------------------------ giao diện bên (khung đồng đội, phòng, lời mời) ------------------------------ */
  function onAsk(d) {
    reqs.set(d.from, { name: d.name, ts: Date.now() }); sysLine(`🤝 ${d.name} muốn kết đồng minh với bạn — bấm Đồng ý ở góc trái hoặc gõ /ally ${d.name}`);
    beep(780, .1, 'triangle'); updSide(true);
  }
  function updSide(force) {
    const r = N.room, now = Date.now();
    for (const [id, q] of [...reqs]) if (now - q.ts > 90000) reqs.delete(id);
    const ri = $q('roominfo'), pa = $q('party'), rq = $q('reqs'); if (!ri || !pa || !rq) return;
    let a = '', b = '', c = '';
    if (r && run) {
      a = `<b>PHÒNG ${esc(r.code)}</b>${esc(r.name)}<br><span class="tg ${r.pvp ? 'on' : 'off'}">${r.pvp ? '⚔ PvP' : '☮ Hòa bình'}</span><span class="tg">${r.players.length}/${r.max}</span>`;
      const al = allyList();
      if (al.length) b = '<b>🤝 ĐỒNG ĐỘI</b>' + al.slice(0, 5).map(nm => {
        const p = r.players.find(q => lower(q.name) === nm), g = p && G.get(p.id);
        if (!p) return `<div class="pr"><span>${esc(nm)} <small>ngoại tuyến</small></span></div>`;
        const same = g && g.scene === scene(), hp = g ? Math.max(0, Math.min(100, g.hp / g.maxHp * 100)) : 0;
        return `<div class="pr" onclick="NETUI.lock('${esc(p.id)}')"><span>${esc(p.name)} <small>LV ${g ? g.lvl : p.lvl}${g ? ' · ' + (same ? Math.round(Math.hypot(g.x - me.x, g.y - me.y) / 10) + 'm' : scn(g.scene)) : ''}</small></span><div class="bar"><div class="fill" style="width:${hp}%;background:#7cb342"></div></div></div>`;
      }).join('');
      c = [...reqs].map(([id, q]) => `<div class="rq box"><span>🤝 <b>${esc(q.name)}</b> muốn kết đồng minh</span><div><button onclick="NETUI.ans('${esc(id)}',1)">ĐỒNG Ý</button><button class="x" onclick="NETUI.ans('${esc(id)}',0)">TỪ CHỐI</button></div></div>`).join('');
    }
    const key = a + '|' + b + '|' + c; if (!force && key === lastSide) return; lastSide = key;
    ri.innerHTML = a; ri.style.display = a ? 'block' : 'none'; pa.innerHTML = b; pa.style.display = b ? 'block' : 'none'; rq.innerHTML = c;
  }
  N.hud = () => { if (fr % 12 === 0) updSide(); };

  /* ------------------------------ menu chính / phòng ------------------------------ */
  const OUT = '0 -4px 0 0 var(--ink),0 4px 0 0 var(--ink),-4px 0 0 0 var(--ink),4px 0 0 0 var(--ink)';
  const css = `
#mainmenu{position:fixed;inset:0;z-index:20;display:none;align-items:center;justify-content:center;padding:18px;background:url(${BGU}) center/cover no-repeat;image-rendering:pixelated;overflow:auto}
#mainmenu .auth-card{max-height:96vh;overflow:auto}
.mmb{width:100%;margin-top:12px}
.mmb.g{background:var(--leaf);box-shadow:${OUT},inset 0 -6px 0 0 #2a6a27,inset 0 4px 0 0 #7fd07a}
.mmb.b{background:var(--navy);box-shadow:${OUT},inset 0 -6px 0 0 #1b2650,inset 0 4px 0 0 #6b82c0}
.mmb.s{padding:10px 12px;font-size:9px;margin-top:6px;width:auto}
.nrow{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:7px 8px;border-bottom:2px dotted #8a5a2e;font-size:14px;text-align:left;color:var(--ink)}
.nrow small{color:#6b4a2a;font-size:11px}.nrow button{padding:9px 10px;font-size:9px;min-width:0;margin-left:4px}
.rcode{font:clamp(20px,6vw,30px) 'Press Start 2P',monospace;letter-spacing:4px;color:#b3541e;margin:6px 0 4px}
.tag{display:inline-block;padding:2px 6px;border:2px solid var(--ink);font-size:11px;font-weight:700;margin:0 3px;background:#fff6;color:var(--ink)}
.tag.on{background:#ff8a80}.tag.off{background:#a5d6a7}.tag.al{background:#c5e1a5}
#nlist{max-height:240px;overflow:auto;border:3px solid #5b3a1a;background:#fffbe8;margin:10px 0}
.auth-form select{width:100%;padding:12px;border:4px solid #5b3a1a;background:#fffbe8;color:var(--ink);font-size:15px;border-radius:0;user-select:text}
.ck{display:flex;gap:10px;align-items:center;font-weight:700;font-size:14px;margin-top:8px}.ck input{width:22px;height:22px;accent-color:var(--org)}
#netp{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);z-index:6;pointer-events:auto}
#netp .ip{max-height:88vh}
`;
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css }));
  document.body.insertAdjacentHTML('beforeend', '<div id="mainmenu"><div class="auth-card box" id="mmc"></div></div>');
  $q('ui').insertAdjacentHTML('afterend', '<div id="netp"><div class="ip box"><div class="ih"><b>🌐 ONLINE</b><button class="x" onclick="NETUI.netp()">✕</button></div><div id="nbody"></div></div></div>');
  { const b = document.createElement('button'); b.className = 'x'; b.textContent = '← MENU'; b.onclick = () => NETUI.back(); $q('start').appendChild(b); }

  function status(msg, bad) {
    const el = $q('mmst'); if (!el) return;
    el.style.color = N.on ? '#2e7d32' : bad ? '#b71c1c' : '#8a5a2e';
    el.textContent = msg || (N.on ? '● Đã kết nối máy chủ' : '○ Đang kết nối máy chủ… (máy chủ miễn phí có thể mất ~1 phút để thức dậy)');
  }
  const mm = h => { $q('mmc').innerHTML = h; };
  const logo = `<div class="auth-logo"><img class="lf" src="${LEAF}" alt=""><span>NARUTO RPG</span><img class="lf" src="${LEAF}" alt=""></div>`;
  const msg = (t, ok) => { const e = $q('mmmsg'); if (e) { e.textContent = t || ''; e.style.color = ok ? '#2e7d32' : '#b71c1c'; } };
  const needNet = () => { if (!N.on || !sock) { msg('Chưa kết nối máy chủ — đợi vài giây rồi thử lại.'); return true; } return false; };
  const tags = r => `<span class="tag ${r.pvp ? 'on' : 'off'}">${r.pvp ? '⚔ PvP' : '☮ Hòa bình'}</span>${r.locked ? '<span class="tag">🔒</span>' : ''}`;
  const msgBox = '<div id="mmmsg" style="margin-top:10px;font-weight:700;font-size:13px"></div><div id="mmst" class="auth-note"></div>';

  function vMain() {
    view = 'main';
    if (N.room) return vRoom();
    mm(`${logo}<div class="auth-sub">XIN CHÀO, ${esc(myName().toUpperCase())}</div>
     <button class="mmb" onclick="NETUI.solo()">▶ CHƠI ĐƠN</button>
     <button class="mmb g" onclick="NETUI.vCreate()">🌐 TẠO PHÒNG (SERVER)</button>
     <button class="mmb b" onclick="NETUI.vJoin()">🔑 VÀO PHÒNG BẠN BÈ</button>
     <button class="mmb x" onclick="logoutAccount()">🚪 ĐĂNG XUẤT</button>${msgBox}`);
    status();
  }
  function vCreate() {
    view = 'create';
    mm(`${logo}<div class="auth-sub">TẠO PHÒNG</div>
     <form class="auth-form" onsubmit="NETUI.create(event)">
      <label>Tên phòng</label><input id="crName" maxlength="24" value="${esc('Phòng của ' + myName())}">
      <label>Mật khẩu (bỏ trống = không khóa)</label><input id="crPass" maxlength="16" autocomplete="off">
      <label>Số người tối đa</label><select id="crMax">${[2, 3, 4, 5, 6, 7, 8].map(n => `<option${n === 4 ? ' selected' : ''}>${n}</option>`).join('')}</select>
      <label class="ck"><input type="checkbox" id="crPvp"> ⚔ Bật PvP (đánh nhau — đồng minh không bắn nhầm)</label>
      <label class="ck"><input type="checkbox" id="crPub" checked> 📢 Hiện trong danh sách phòng</label>
      <button type="submit" class="mmb g">TẠO PHÒNG</button>
     </form>
     <button class="mmb x" onclick="NETUI.vMain()">← QUAY LẠI</button>${msgBox}`);
    status();
  }
  function create(ev) {
    ev.preventDefault(); if (needNet()) return;
    const pass = $q('crPass').value;
    sock.emit('room:create', { name: $q('crName').value, password: pass, max: +$q('crMax').value, pvp: $q('crPvp').checked, pub: $q('crPub').checked }, r => {
      if (!r || r.error) return msg((r && r.error) || 'Lỗi tạo phòng.');
      lastRoom = { code: r.room.code, pass }; setRoom(r.room); vRoom();
    });
  }
  function vJoin() {
    view = 'join';
    mm(`${logo}<div class="auth-sub">VÀO PHÒNG</div>
     <form class="auth-form" onsubmit="NETUI.join(event)">
      <label>Mã phòng (5 ký tự)</label><input id="jnCode" maxlength="5" style="text-transform:uppercase" autocomplete="off" required>
      <label>Mật khẩu (nếu phòng có khóa)</label><input id="jnPass" maxlength="16" autocomplete="off">
      <button type="submit" class="mmb g">VÀO PHÒNG</button>
     </form>
     <div class="auth-sub" style="margin:16px 0 4px">PHÒNG CÔNG KHAI <button type="button" class="mmb s" onclick="NETUI.refresh()">↻</button></div>
     <div id="nlist"><div class="nrow">Đang tải…</div></div>
     <button class="mmb x" onclick="NETUI.vMain()">← QUAY LẠI</button>${msgBox}`);
    status(); refresh();
  }
  function refresh() {
    const el = $q('nlist'); if (!el) return;
    if (!sock || !N.on) { el.innerHTML = '<div class="nrow">Chưa kết nối máy chủ…</div>'; setTimeout(() => view === 'join' && refresh(), 2500); return; }
    sock.emit('rooms:list', rs => {
      const e = $q('nlist'); if (!e) return;
      e.innerHTML = rs && rs.length ? rs.map(r => `<div class="nrow"><span><b>${esc(r.name)}</b><br><small>Chủ: ${esc(r.host)} · ${r.n}/${r.max} · mã ${esc(r.code)}</small></span><span>${tags(r)}<button onclick="NETUI.joinCode('${esc(r.code)}',${r.locked ? 1 : 0})">VÀO</button></span></div>`).join('')
        : '<div class="nrow">Chưa có phòng công khai nào. Hãy tạo phòng hoặc nhập mã bạn bè.</div>';
    });
  }
  function doJoin(code, pass) {
    if (needNet()) return;
    sock.emit('room:join', { code, password: pass }, r => {
      if (!r || r.error) return msg((r && r.error) || 'Không vào được phòng.');
      lastRoom = { code: r.room.code, pass }; setRoom(r.room); vRoom();
    });
  }
  function vRoom() {
    view = 'room'; const r = N.room; if (!r) return vMain();
    const host = r.host === myId;
    mm(`${logo}<div class="auth-sub">PHÒNG: ${esc(r.name)}</div>
     <div>Mã phòng — gửi cho bạn bè:</div><div class="rcode">${esc(r.code)}</div>
     <button class="mmb s" onclick="NETUI.copy()">📋 SAO CHÉP MÃ</button>
     <div style="margin-top:8px">${tags(r)}<span class="tag">${r.players.length}/${r.max} người</span></div>
     <div id="nlist">${r.players.map(p => `<div class="nrow"><span>${p.id === r.host ? '👑 ' : ''}<b>${esc(p.name)}</b>${p.id === myId ? ' (bạn)' : ''}${p.id !== myId && isAlly(p.name) ? ' <span class="tag al">🤝</span>' : ''}</span>${host && p.id !== myId ? `<button class="x" onclick="NETUI.kick('${esc(p.id)}')">ĐÁ</button>` : ''}</div>`).join('')}</div>
     ${host ? `<button class="mmb b" onclick="NETUI.pvpToggle()">${r.pvp ? '☮ TẮT PvP' : '⚔ BẬT PvP'}</button>` : ''}
     <button class="mmb" onclick="NETUI.go()">⚔ CHỌN NHÂN VẬT & VÀO GAME</button>
     <button class="mmb x" onclick="NETUI.leave()">RỜI PHÒNG</button>${msgBox}`);
    status();
  }
  function refreshUI() { if (view === 'room' && $q('mainmenu').style.display === 'flex') vRoom(); if (netpOpen) renderNet(true); renderChat(); updSide(true); }

  /* bảng Online trong game (nút 🌐) */
  function renderNet(force) {
    const b = $q('nbody'); if (!b) return;
    const r = N.room;
    let h;
    if (!r) {
      h = `<div class="sub">Bạn đang chơi đơn. Muốn chơi cùng bạn bè: lưu game, về menu chính rồi chọn <b>Tạo phòng</b> hoặc <b>Vào phòng</b>.</div>
       <button onclick="NETUI.toMenu()">🏠 LƯU & VỀ MENU CHÍNH</button>`;
    } else {
      const host = r.host === myId;
      h = `<div class="sub" style="text-align:left"><b>${esc(r.name)}</b> · mã <b style="color:#b3541e;letter-spacing:2px">${esc(r.code)}</b> ${tags(r)}</div>
       <div id="nlist" style="max-height:230px">${r.players.map(p => {
          const g = G.get(p.id), self = p.id === myId, al = !self && isAlly(p.name), pend = reqs.has(p.id);
          return `<div class="nrow"><span>${p.id === r.host ? '👑 ' : ''}<b>${esc(p.name)}</b>${self ? ' (bạn)' : ''}${al ? ' <span class="tag al">🤝 đồng minh</span>' : ''}<br><small>${esc(p.ch || '…')} · LV ${self ? me.lvl : g ? g.lvl : p.lvl} · ${self ? scn(scene()) : g ? scn(g.scene) : 'đang chọn nhân vật'}</small></span>
           <span>${self ? '' : `<button onclick="NETUI.lock('${esc(p.id)}')" title="Khóa mục tiêu">🎯</button><button onclick="NETUI.tp('${esc(p.id)}')" title="Dịch chuyển tới">➡</button>${al ? `<button class="x" onclick="NETUI.unally('${esc(p.id)}')" title="Hủy đồng minh">💔</button>` : `<button onclick="NETUI.ally('${esc(p.id)}')" title="${pend ? 'Đã có lời mời' : 'Kết đồng minh'}">🤝</button>`}`}${host && !self ? `<button class="x" onclick="NETUI.kick('${esc(p.id)}')" title="Mời ra khỏi phòng">✕</button>` : ''}</span></div>`;
        }).join('')}</div>
       <div class="rw" style="gap:8px;flex-wrap:wrap;justify-content:flex-start">
        ${host ? `<button onclick="NETUI.pvpToggle()">${r.pvp ? '☮ TẮT PvP' : '⚔ BẬT PvP'}</button>` : ''}
        <button onclick="NETUI.assist()">🎯 Tự ngắm: ${N.assist ? 'BẬT' : 'TẮT'}</button>
        <button onclick="NETUI.help()">📖 Lệnh chat</button>
       </div>
       <div class="sub" style="text-align:left">Tab: khóa/đổi mục tiêu · Q: bỏ khóa · Enter: chat · /help: danh sách lệnh · Click vào người chơi để khóa. Khu xanh giữa bản đồ là vùng an toàn (không PvP). Boss & World Boss là CHUNG cho cả phòng (/boss để xem vị trí); quái thường là riêng của từng người.</div>
       <div class="rw" style="gap:8px"><button class="x" onclick="NETUI.leave()">RỜI PHÒNG</button><button onclick="NETUI.toMenu()">🏠 LƯU & VỀ MENU</button></div>`;
    }
    if (!force && h === lastNet) return; lastNet = h; b.innerHTML = h;
  }
  setInterval(() => { if (netpOpen) renderNet(); }, 1200);

  window.NETUI = {
    vMain, vCreate, vJoin, create, refresh,
    join(ev) { ev.preventDefault(); doJoin($q('jnCode').value.trim().toUpperCase(), $q('jnPass').value); },
    joinCode(code, locked) {
      if (locked) { $q('jnCode').value = code; $q('jnPass').focus(); msg('Phòng này có mật khẩu — nhập rồi bấm VÀO PHÒNG.'); }
      else doJoin(code, '');
    },
    solo() { if (N.room && sock) sock.emit('room:leave'); leaveLocal(); $q('mainmenu').style.display = 'none'; $q('start').style.display = 'flex'; },
    go() { $q('mainmenu').style.display = 'none'; $q('start').style.display = 'flex'; },
    back() { $q('start').style.display = 'none'; $q('mainmenu').style.display = 'flex'; vMain(); },
    leave() { if (sock) sock.emit('room:leave'); leaveLocal(); if (!run) vMain(); else { if (netpOpen) renderNet(true); banner('Bạn đã rời phòng — tiếp tục chơi đơn'); } },
    kick(id) { if (sock) sock.emit('room:kick', { id }); },
    pvpToggle() { if (sock && N.room) sock.emit('room:set', { pvp: !N.room.pvp }); },
    copy() { const c = N.room && N.room.code; if (!c) return; try { navigator.clipboard.writeText(c); msg('Đã sao chép mã ' + c, 1); } catch (e) { msg('Mã phòng: ' + c, 1); } },
    netp() { const e = $q('netp'); netpOpen = e.style.display !== 'flex'; e.style.display = netpOpen ? 'flex' : 'none'; if (netpOpen) renderNet(true); },
    lock(id) {
      const g = G.get(id); if (g && g.scene === scene()) { setLock(g); if (netpOpen) NETUI.netp(); } else if (run) banner('Người này không ở cùng khu vực với bạn');
    },
    tp(id) {
      const g = G.get(id); if (!g) return banner('Người này chưa vào game');
      if (dg) return banner('Không thể dịch chuyển khi đang trong Raid');
      if (g.scene === 'W') { if (lobby) toWorld(); me.x = g.x + 60; me.y = g.y; }
      else if (g.scene === 'L') { if (!lobby) toLobby(); me.x = g.x - 60; me.y = g.y; }
      else return banner('Người này đang ở trong Raid');
      if (netpOpen) NETUI.netp();
    },
    ally(id) { if (!sock) return; const p = N.room && N.room.players.find(q => q.id === id); sock.emit('ally:req', { to: id }); if (p) banner('🤝 Đã gửi lời mời đồng minh tới ' + esc(p.name)); },
    unally(id) { if (sock) sock.emit('ally:del', { id }); },
    ans(id, ok) { reqs.delete(id); if (sock) sock.emit('ally:ans', { to: id, ok: !!ok }); updSide(true); if (netpOpen) renderNet(true); },
    assist() { N.assist = !N.assist; lsSet('nio_assist', N.assist ? '1' : '0'); renderNet(true); updTgt(); },
    help() { HELP.forEach(sysLine); if (netpOpen) NETUI.netp(); },
    async toMenu() { try { await save(); } catch (e) { /* vẫn thoát */ } run = false; location.reload(); },
  };

  /* ------------------------------ vào menu / vào game ------------------------------ */
  N.menu = function () { connect(); $q('start').style.display = 'none'; $q('mainmenu').style.display = 'flex'; vMain(); return true; };
  N.entered = function () {
    entered = true;
    if (inRoom()) sock.emit('p:enter', enterInfo());
    renderChat(); startAutosave(); updSide(true);
    sysLine('💬 Nhấn Enter để chat · gõ /help xem danh sách lệnh · Tab khóa mục tiêu · cuộn chuột zoom');
  };

  /* ------------------------------ tự lưu ------------------------------ */
  let asOn = false;
  function flush() {
    if (!run || !me) return;
    try {
      const d = N.mkData(); lsSet(lsKey(), JSON.stringify(d));
      if (currentAccount && !guest && !(typeof SYNC !== 'undefined' && SYNC.block)) {   // chưa tải được dữ liệu máy chủ -> không ghi đè
        const body = JSON.stringify({ token: N.tok(), character: me.char, data: d });
        if (navigator.sendBeacon) navigator.sendBeacon(API_BASE + '/api/save-beacon', new Blob([body], { type: 'text/plain' }));
        else save();
      }
    } catch (e) { /* bỏ qua */ }
  }
  function startAutosave() {
    if (asOn) return; asOn = true;
    setInterval(() => { if (run && me) save(); }, 20000);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
    addEventListener('pagehide', flush);
    addEventListener('beforeunload', flush);
  }
})();
