// 3D Anatomy Trainer (2026-10-31). One class bundle per page: data/<stem>.json + .bin
// (quantized meshes exported from Z-Anatomy / BodyParts3D, plus a few custom meshes).
// Modes: Find it (click the named structure), Name it (type the highlighted
// structure's name), Explore (click anything to see its name).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = (id) => document.getElementById(id);
const stem = new URLSearchParams(location.search).get('c') || '';
const QKEY = 'a3d-quality';
function pickQuality() {
  const u = new URLSearchParams(location.search).get('q'); if (u === 'lo' || u === 'hi') return u;
  try { const v = localStorage.getItem(QKEY); if (v === 'lo' || v === 'hi') return v; } catch (e) {}
  const weak = (navigator.deviceMemory && navigator.deviceMemory <= 4) || (navigator.hardwareConcurrency || 8) <= 4 || matchMedia('(pointer: coarse)').matches;
  return weak ? 'lo' : 'hi';
}
const QUALITY = pickQuality();
const SYS_COLOR = {
  skeletal: 0xe8dcc4, muscular: 0xc7604a, arterial: 0xd22f2f, venous: 0x3563c9, nervous: 0xe6c229,
  lymphatic: 0x3ca561, connective: 0xd8d2c4, respiratory: 0xe9a3a3, digestive: 0xd9a066, cardiac: 0xb8443b,
  urinary: 0x9c4a3a, reproductive: 0xd48aa8, endocrine: 0xa98bd6, sensory: 0x9fc6d9, integumentary: 0xe9c6a8,
  custom: 0x58c4b5
};
const SHELL_OP = 0.18; // enveloping custom organs (lungs, pericardium…) stay see-through unless asked about
const ctxOp = (p) => (p.system === 'skeletal' ? 0.3 : 0.13);
const HIGHLIGHT = 0x84e81a, OK = 0x22c55e, BAD = 0xef4444;

let man, meshes = {}, scene, camera, renderer, controls, ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let redrawUntil = 0; const need = (ms = 400) => { redrawUntil = Math.max(redrawUntil, performance.now() + ms); };
let body = null; // active donor model: scenes are never mixed
const BODY_NAME = { 'z-anatomy': 'Z-Anatomy', bodyparts: 'BodyParts3D' };
let mode = 'find', queue = [], cur = null, attempts = 0, done = false, score = { ok: 0, tried: 0 }, showCtx = true;
const hidden = new Set(), offSys = new Set();
const SYS_LABEL = { skeletal: 'Bones', muscular: 'Muscles', arterial: 'Arteries', venous: 'Veins', nervous: 'Nerves', lymphatic: 'Lymphatics', connective: 'Ligaments & fascia', custom: 'Built for this tool' };

// ---------- matching typed names ----------
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const GENERIC = new Set(['the', 'of', 'm', 'muscle', 'muscles', 'nerve', 'n', 'artery', 'a', 'vein', 'v', 'bone', 'and', 'left', 'right', 'l', 'r']);
const strip = (s) => norm(s).split(' ').filter((w) => !GENERIC.has(w)).join(' ');
function lev(a, b) {
  const m = a.length, n = b.length; let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
const tol = (s) => s.length <= 4 ? 0 : s.length <= 8 ? 1 : s.length <= 15 ? 2 : 3;
function answerForms(item) {
  const s = item.structure;
  const forms = [s, s.replace(/\s*\(.*?\)\s*/g, ' ')];
  (s.match(/\(([^)]*)\)/g) || []).forEach((m) => m.slice(1, -1).split(/[,/;]| or /).forEach((x) => forms.push(x)));
  s.split(/\s*\/\s*/).forEach((x) => forms.push(x));
  return [...new Set(forms.map(strip).filter((x) => x.length > 1))];
}
function typedOk(typed, item) {
  const t = strip(typed); if (!t) return false;
  return answerForms(item).some((f) => lev(t, f) <= tol(f) || (f.length > 10 && t.length >= 6 && f.startsWith(t) && t.length >= f.length * 0.7));
}

// ---------- scene ----------
function initScene() {
  const vp = $('viewport');
  renderer = new THREE.WebGLRenderer({ antialias: QUALITY === 'hi', powerPreference: 'high-performance' });
  renderer.setPixelRatio(QUALITY === 'hi' ? Math.min(devicePixelRatio, 2) : 1);
  renderer.setSize(vp.clientWidth, vp.clientHeight);
  vp.prepend(renderer.domElement);
  scene = new THREE.Scene(); scene.background = new THREE.Color(0x0b1220);
  camera = new THREE.PerspectiveCamera(40, vp.clientWidth / vp.clientHeight, 0.001, 50);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.1));
  const d1 = new THREE.DirectionalLight(0xffffff, 1.2); d1.position.set(1, 2, 2); scene.add(d1);
  const d2 = new THREE.DirectionalLight(0xffffff, 0.5); d2.position.set(-2, -1, -1); scene.add(d2);
  controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
  addEventListener('resize', () => { renderer.setSize(vp.clientWidth, vp.clientHeight); camera.aspect = vp.clientWidth / vp.clientHeight; camera.updateProjectionMatrix(); need(); });
  controls.addEventListener('change', () => need());
  ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'click', 'change'].forEach((ev) => addEventListener(ev, () => need(1200), { passive: true }));
  // draw only while something is changing (camera moving, highlight/flash, layer toggles) — idle = no GPU work
  (function loop() { requestAnimationFrame(loop); const moved = controls.update(); if (moved || performance.now() < redrawUntil) renderer.render(scene, camera); })();
}

function baseMaterial(p) {
  const ctx = p.role === 'context' || p.shell;
  return new THREE.MeshStandardMaterial({
    color: SYS_COLOR[p.system] ?? 0xbbbbbb, roughness: 0.65, metalness: 0.0,
    transparent: ctx, opacity: p.shell ? SHELL_OP : ctx ? ctxOp(p) : 1, depthWrite: !ctx, side: THREE.DoubleSide
  });
}

async function loadBundle() {
  man = await (await fetch(`data/${stem}${QUALITY === 'lo' ? '.lo' : ''}.json`)).json();
  $('loadmsg').textContent = 'Loading meshes…';
  const raw = await (await fetch(`data/${stem}${QUALITY === 'lo' ? '.lo' : ''}.bin.gz`)).arrayBuffer();
  const h = new Uint8Array(raw, 0, 2); // the host may already have un-gzipped it
  const buf = h[0] === 0x1f && h[1] === 0x8b
    ? await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : raw;
  for (const p of man.parts) {
    const [lx, ly, lz] = man.models[p.model].lo, [sx, sy, sz] = man.models[p.model].span;
    const q = new Uint16Array(buf, p.pos, p.vc * 3);
    const pos = new Float32Array(p.vc * 3);
    for (let i = 0; i < q.length; i += 3) { pos[i] = lx + q[i] / 65535 * sx; pos[i + 1] = ly + q[i + 1] / 65535 * sy; pos[i + 2] = lz + q[i + 2] / 65535 * sz; }
    const idx = p.wide ? new Uint32Array(buf, p.idx, p.ic) : new Uint16Array(buf, p.idx, p.ic);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals(); g.computeBoundingSphere();
    const m = new THREE.Mesh(g, baseMaterial(p)); m.userData = p; m.renderOrder = p.shell ? 2 : p.role === 'context' ? 1 : 0;
    meshes[p.id] = m; scene.add(m);
  }
  const models = Object.keys(man.models);
  setBody(models.sort((a, b) => man.items.filter((i) => i.model === b).length - man.items.filter((i) => i.model === a).length)[0]);
}

function boxOf(ids) {
  const b = new THREE.Box3();
  ids.forEach((id) => meshes[id] && meshes[id].visible && b.expandByObject(meshes[id]));
  return b;
}
function frame(box, pad = 1.6) {
  need(600);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3()), r = box.getBoundingSphere(new THREE.Sphere()).radius || 0.05;
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (!isFinite(dir.x) || dir.length() < 0.5) dir.set(0, 0, 1);
  controls.target.copy(c);
  camera.position.copy(c).add(dir.multiplyScalar(Math.max(r * pad / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), 0.15)));
  camera.near = 0.001; camera.updateProjectionMatrix();
}
function setBody(m) {
  if (!m || m === body) return;
  body = m; $('bodyChip').textContent = `Model: ${BODY_NAME[m] || m}`; layers();
  paint(); frameAll();
}
function frameAll() {
  const b = boxOf(Object.keys(meshes).filter((id) => meshes[id].userData.role !== 'context' && meshes[id].userData.model === body));
  camera.position.set(b.getCenter(new THREE.Vector3()).x, b.getCenter(new THREE.Vector3()).y, b.max.z + 1);
  controls.target.copy(b.getCenter(new THREE.Vector3())); frame(b, 1.15);
}

function paint() {
  need();
  for (const [id, m] of Object.entries(meshes)) {
    const p = m.userData, mat = m.material;
    mat.color.setHex(SYS_COLOR[p.system] ?? 0xbbbbbb); mat.emissive?.setHex(0x000000);
    const ctx = p.role === 'context' || p.shell;
    m.visible = p.model === body && !hidden.has(id) && !offSys.has(p.system) && (showCtx || !ctx);
    mat.opacity = p.shell ? SHELL_OP : ctx ? ctxOp(p) : 1; mat.transparent = ctx; mat.depthWrite = !ctx;
  }
  if (cur && (mode === 'name' || done)) {
    cur.parts.forEach((id) => { const m = meshes[id]; if (!m || m.userData.model !== body) return; m.visible = true; m.material.color.setHex(done ? OK : HIGHLIGHT); m.material.emissive.setHex(0x1c3a06); m.material.opacity = 1; m.material.transparent = false; m.material.depthWrite = true; });
    if (mode === 'name' && !done) dimOthers();
  }
}
function dimOthers() {
  for (const [id, m] of Object.entries(meshes)) {
    if (cur.parts.includes(id)) continue;
    m.material.transparent = true; m.material.opacity = Math.min(m.material.opacity, 0.2); m.material.depthWrite = false;
  }
}

function layers() {
  const sys = {};
  Object.values(meshes).forEach((m) => { const p = m.userData; if (p.model === body) sys[p.system] = 1; });
  const el = $('layers'); el.innerHTML = '';
  const tg = document.createElement('button'); tg.className = 'layer toggle'; tg.textContent = 'Layers';
  tg.onclick = () => el.classList.toggle('open'); el.appendChild(tg);
  Object.keys(sys).sort().forEach((k) => {
    const b = document.createElement('button'); b.className = 'layer' + (offSys.has(k) ? '' : ' on');
    b.innerHTML = `<i style="background:#${(SYS_COLOR[k] ?? 0xbbbbbb).toString(16).padStart(6, '0')}"></i>${SYS_LABEL[k] || k[0].toUpperCase() + k.slice(1)}`;
    b.onclick = () => { offSys.has(k) ? offSys.delete(k) : offSys.add(k); b.classList.toggle('on'); paint(); };
    el.appendChild(b);
  });
}

// ---------- quiz ----------
function buildQueue() {
  const sec = $('section').value, core = $('coreOnly').checked;
  queue = man.items.filter((it) => it.parts.length && (!sec || it.section === sec) && (!core || it.priority !== 'conceptual'));
  for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [queue[i], queue[j]] = [queue[j], queue[i]]; }
  $('sLeft').textContent = `${queue.length} in this set`;
}
function next() { ask(queue.shift() || null); }
function ask(item) {
  feedback('');
  cur = item; attempts = 0; done = false; markCurrent();
  if (!cur) { $('qtext').textContent = 'Set complete!'; $('qsec').textContent = 'Change the section or press Next to go again.'; buildQueue(); paint(); return; }
  $('sLeft').textContent = `${queue.length} left`;
  setBody(cur.model);
  if (mode === 'find') { $('qlabel').textContent = 'Find this structure'; $('qtext').textContent = cur.structure; }
  else { $('qlabel').textContent = 'Name the highlighted structure'; $('qtext').textContent = '?'; $('nameInput').value = ''; setTimeout(() => $('nameInput').focus(), 50); }
  $('qsec').textContent = cur.section ? cur.section : '';
  paint();
  if (mode === 'find' && isInside(cur.parts)) $('qsec').textContent += (cur.section ? ' · ' : '') + 'Tip: it’s inside another structure. Right-click (long-press) outer parts to hide them, or switch off a layer.';
  if (mode === 'name') frame(boxOf(cur.parts), 2.6);
}
function isInside(ids) { // are most sample points of the target enclosed by other solid parts?
  const others = Object.values(meshes).filter((m) => { const p = m.userData; return m.visible && !ids.includes(p.id) && p.role !== 'context' && !p.shell; });
  const pts = [];
  ids.forEach((id) => { const g = meshes[id]?.geometry; if (!g) return; const a = g.attributes.position;
    for (let k = 0; k < 6; k++) { const v = Math.floor((k + 0.5) / 6 * a.count); pts.push(new THREE.Vector3(a.getX(v), a.getY(v), a.getZ(v))); } });
  if (!pts.length) return false;
  const r = new THREE.Raycaster(), dirs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].map((d) => new THREE.Vector3(...d));
  const enclosed = pts.filter((c) => dirs.every((d) => { r.set(c, d); return r.intersectObjects(others, false).length > 0; })).length;
  return enclosed >= pts.length * 0.6;
}
function feedback(html, kind) { const f = $('feedback'); f.innerHTML = html; f.className = 'feedback' + (kind ? ' ' + kind : ''); }
function finish(ok, solved = ok) {
  done = true; if (solved) check(cur.order); markCurrent(); score.tried++; if (ok) score.ok++;
  $('sOk').textContent = score.ok; $('sTry').textContent = score.tried;
  $('qtext').textContent = cur.structure; paint();
  if (ok && window.atTrack) { try { window.atTrack('question_answered'); } catch (e) {} }
}

function pick(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const vis = Object.values(meshes).filter((m) => m.visible && !(m.userData.role === 'context' && m.material.opacity < 0.35 && mode !== 'explore'));
  const hits = ray.intersectObjects(vis, false);
  const hit = hits.find((h) => !h.object.userData.shell) || hits[0]; // click through see-through shells
  return hit ? hit.object : null;
}
function onClick(ev) {
  const m = pick(ev); if (!m) return;
  const name = m.userData.name + (m.userData.role === 'custom' ? ' <span class="built">(built for this tool)</span>' : '');
  if (mode === 'explore') { feedback(`<b>${name}</b>${itemFor(m.userData.id) ? ' · on your list as “' + itemFor(m.userData.id).structure + '”' : ''}`); flash(m); return; }
  if (mode !== 'find' || !cur || done) return;
  attempts++;
  if (cur.parts.includes(m.userData.id)) { feedback('✓ Correct!', 'ok'); finish(attempts === 1, true); }
  else { flash(m, BAD); feedback(`✗ That's <b>${name}</b>. Try again${attempts >= 2 ? ' — or press “Show me”' : ''}.`, 'bad'); }
}
function itemFor(id) { return man.items.find((it) => it.parts.includes(id)); }
function flash(m, color = HIGHLIGHT) {
  const old = m.material.color.getHex(); m.material.color.setHex(color);
  setTimeout(() => { if (!done || !cur?.parts.includes(m.userData.id)) m.material.color.setHex(old); }, 900);
}

// ---------- structure list (the class checklist, side by side) ----------
const CKEY = () => `a3d-checked-${stem}`;
let checked = new Set();
function loadChecks() { try { checked = new Set(JSON.parse(localStorage.getItem(CKEY()) || '[]')); } catch (e) { checked = new Set(); } }
function saveChecks() { try { localStorage.setItem(CKEY(), JSON.stringify([...checked])); } catch (e) {} }
function check(order) {
  if (order == null || checked.has(order)) return; checked.add(order); saveChecks();
  const r = document.querySelector(`#clist tr[data-o="${order}"]`); if (r) { r.classList.add('done', 'pop'); setTimeout(() => r.classList.remove('pop'), 700); }
  countChecks();
}
function countChecks() {
  const inl = man.items.filter((i) => i.parts.length);
  $('clCount').textContent = `${inl.filter((i) => checked.has(i.order)).length} / ${inl.length} checked`;
}
function markCurrent() {
  document.querySelectorAll('#clist tr.cur').forEach((r) => r.classList.remove('cur'));
  if (!cur || cur.order == null || (mode === 'name' && !done)) return; // never give away a Name-it answer
  const r = document.querySelector(`#clist tr[data-o="${cur.order}"]`);
  if (r) { r.classList.add('cur'); r.scrollIntoView({ block: 'nearest' }); }
}
async function buildChecklist() {
  loadChecks();
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const byOrder = new Map(man.items.map((i) => [i.order, i]));
  let sheet = null;
  try { const r = await fetch(`data/${stem}.sheet.json`); if (r.ok) sheet = await r.json(); } catch (e) {}
  if (!sheet) { // no Word sheet for this class (GI's list was a PDF): same layout, built from the list
    const rows = []; let sec = null;
    man.items.slice().sort((a, b) => a.order - b.order).forEach((it) => {
      if (it.section !== sec) { sec = it.section; if (sec) rows.push({ t: 'sec', text: sec.split(' > ').pop(), fill: 'D9F2D0' }); }
      rows.push({ t: 'item', order: it.order, fill: '', cells: ['', '', ''] });
    });
    sheet = { hdr: [$('title').textContent], grid: [5000, 1500, 1300, 4000], head: ['Structure', 'Individual', 'Peer', 'Additional Notes'], headFill: 'D9F2D0', rows };
  }
  const head = sheet.head, ncol = head.length;
  const indiv = head.findIndex((h) => /individual/i.test(h)); // the column you tick when you find it
  sheet.grid = sheet.grid.filter((w) => w >= 100); // Word spacer columns (a few twips wide) aren't real columns
  const tot = sheet.grid.slice(0, ncol).reduce((a, b) => a + b, 0) || 1;
  const fill = (f) => (f && f !== 'auto' ? `background:#${f};color:${dark(f) ? '#fff' : '#111'}` : '');
  function dark(f) { const n = parseInt(f, 16); return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 < 120; }
  let html = '<colgroup>' + head.map((h, c) => `<col style="width:${(100 * (sheet.grid[c] || 0) / tot).toFixed(1)}%">`).join('') + '</colgroup>';
  const headRow = (f) => `<tr class="shead" style="${fill(f || sheet.headFill)}">` + head.map((h) => `<th>${esc(h)}</th>`).join('') + '</tr>';
  html += headRow(sheet.headFill);
  for (const r of sheet.rows) {
    if (r.t === 'sec') html += `<tr class="ssec" style="${fill(r.fill)}"><th colspan="${ncol}">${esc(r.text)}</th></tr>`;
    else if (r.t === 'sub') html += `<tr class="ssub" style="${fill(r.fill)}"><th>${esc(r.text)}</th>${(r.cells || []).slice(0, ncol - 1).map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`;
    else if (r.t === 'rep') html += headRow(r.fill);
    else if (r.t === 'blank') html += `<tr class="sblank" style="${fill(r.fill)}"><td colspan="${ncol}"></td></tr>`;
    else {
      const it = byOrder.get(r.order); if (!it) continue;
      const na = !it.parts.length;
      const cells = [];
      for (let c = 1; c < ncol; c++) {
        const v = (r.cells || [])[c - 1] || '';
        cells.push(c === indiv ? `<td class="ck"><span></span></td>` : `<td>${esc(v)}</td>`);
      }
      const name = `${indiv < 0 ? '<span class="ckin"></span>' : ''}${esc(it.structure)}${it.status === 'custom' ? ' <i class="bt" title="Built for this tool">◆</i>' : ''}${na ? ' <em>not in 3D</em>' : ''}`;
      html += `<tr data-o="${it.order}" class="sitem${na ? ' na' : ''}${checked.has(it.order) ? ' done' : ''}" style="${fill(r.fill)}" title="${na ? 'Not in the 3D model' : 'Click to quiz this one'}"><td class="sname">${name}</td>${cells.join('')}</tr>`;
    }
  }
  $('sheetHdr').innerHTML = (sheet.hdr || []).map((h) => `<span>${esc(h)}</span>`).join('');
  $('clist').innerHTML = html; countChecks(); markCurrent();
  $('clist').addEventListener('click', (e) => {
    const r = e.target.closest('tr[data-o]'); if (!r || r.classList.contains('na')) return;
    const it = byOrder.get(+r.dataset.o);
    if (mode === 'explore') { cur = it; done = true; setBody(it.model); paint(); feedback(`<b>${esc(it.structure)}</b>`); frame(boxOf(it.parts), 2.6); markCurrent(); return; }
    queue = queue.filter((q) => q !== it); ask(it);
  });
  $('clReset').addEventListener('click', () => { checked.clear(); saveChecks(); document.querySelectorAll('#clist tr.done').forEach((r) => r.classList.remove('done')); countChecks(); });
}

// ---------- wiring ----------
function wire() {
  const el = renderer.domElement; let down = null, lp = null;
  el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; lp = setTimeout(() => { const m = pick(e); if (m) { hidden.add(m.userData.id); paint(); } lp = null; }, 650); });
  el.addEventListener('pointerup', (e) => { if (lp) clearTimeout(lp); if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5 && lp !== null) onClick(e); down = null; });
  el.addEventListener('pointermove', (e) => { if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 && lp) { clearTimeout(lp); lp = null; } });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); const m = pick(e); if (m) { hidden.add(m.userData.id); paint(); } });
  document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.mode; document.querySelectorAll('.mode').forEach((x) => x.classList.toggle('on', x === b));
    $('nameForm').hidden = mode !== 'name'; $('btnBody').hidden = mode !== 'explore' || Object.keys(man.models).length < 2; $('qcard').classList.toggle('explore', mode === 'explore');
    if (mode === 'explore') { cur = null; done = false; $('qlabel').textContent = 'Explore'; $('qtext').textContent = 'Click any structure'; $('qsec').textContent = ''; feedback(''); paint(); }
    else { buildQueue(); next(); }
  }));
  $('nameForm').addEventListener('submit', (e) => {
    e.preventDefault(); if (!cur || done) return; attempts++;
    if (typedOk($('nameInput').value, cur)) { feedback('✓ Correct!', 'ok'); finish(attempts === 1, true); }
    else feedback(`✗ Not quite${attempts >= 2 ? ' — press “Show me” to see it' : ''}.`, 'bad');
  });
  $('btnReveal').addEventListener('click', () => { if (!cur || done) return; feedback(`It's <b>${cur.structure}</b>.`); finish(false, false); frame(boxOf(cur.parts), 2.6); });
  $('btnNext').addEventListener('click', next);
  $('btnFocus').addEventListener('click', () => frame(boxOf(cur && (mode === 'name' || done) ? cur.parts : Object.keys(meshes).filter((id) => meshes[id].userData.role !== 'context' && meshes[id].userData.model === body)), cur ? 2.6 : 1.15));
  $('btnCtx').addEventListener('click', () => { showCtx = !showCtx; paint(); });
  $('btnUnhide').addEventListener('click', () => { hidden.clear(); paint(); });
  $('btnReset').addEventListener('click', frameAll);
  $('btnBody').addEventListener('click', () => { const ms = Object.keys(man.models); setBody(ms[(ms.indexOf(body) + 1) % ms.length]); });
  $('section').addEventListener('change', () => { buildQueue(); next(); });
  $('coreOnly').addEventListener('change', () => { buildQueue(); next(); });
}

(async function main() {
  try {
    const classes = await (await fetch('data/classes.json')).json();
    const meta = classes.find((c) => c.stem === stem);
    if (!meta) { $('title').textContent = 'Class not found'; return; }
    const SUBJ = { '206': 'msk', '183': 'cv', '181': 'resp', '185': 'renal', '204': 'gi', '205': 'repro', '210': 'endo' };
    if (SUBJ[stem.split('_')[0]]) document.querySelector('.back').href = `index.html?s=${SUBJ[stem.split('_')[0]]}`;
    $('title').textContent = meta.title; $('eyebrow').textContent = `3D Anatomy Trainer · ${meta.course}`;
    document.title = `${meta.title} | 3D Anatomy Trainer`;
    initScene(); await loadBundle();
    // sections + priorities come from the list (attached at build time)
    const secs = [...new Set(man.items.filter((i) => i.parts.length).map((i) => i.section).filter(Boolean))];
    secs.forEach((s) => { const o = document.createElement('option'); o.value = s; o.textContent = s; $('section').appendChild(o); });
    const ms = Object.keys(man.models).map((m) => BODY_NAME[m] || m);
    $('modelNote').textContent = `${man.items.filter((i) => i.parts.length).length} of ${man.items.length} list structures are in 3D. ` +
      (ms.length > 1 ? `They come from two reference bodies (${ms.join(' and ')}); each question shows the body that has that structure, and the two are never mixed in one scene.` : `Model: ${ms[0]}.`);
    $('loading').remove(); wire(); buildChecklist();
    const qs = $('quality'); qs.value = QUALITY;
    qs.addEventListener('change', () => { try { localStorage.setItem(QKEY, qs.value); } catch (e) {} const u = new URL(location.href); u.searchParams.delete('q'); location.href = u.toString(); });
    need(1500);
    const sp = new URLSearchParams(location.search), show = (sp.get('show') || '').split(',').filter((x) => meshes[x]);
    if (show.length) { // debug/preview: highlight given parts
      if (sp.get('ctx') === '0') showCtx = false;
      (sp.get('off') || '').split(',').filter(Boolean).forEach((x) => offSys.add(x));
      setBody(meshes[show[0]].userData.model); document.querySelector('.mode[data-mode=explore]').click();
      cur = { parts: show, structure: show.map((x) => meshes[x].userData.name).join(' + ') }; done = true; paint();
      const V = { front: [0, 0, 1], back: [0, 0, -1], left: [1, 0, 0], right: [-1, 0, 0], top: [0, 1, 0.001], bottom: [0, -1, 0.001] }[sp.get('view') || 'front'];
      const b = boxOf(show), c = b.getCenter(new THREE.Vector3()); controls.target.copy(c);
      camera.position.copy(c).add(new THREE.Vector3(...V)); frame(b, 3.2 / (+sp.get('zoom') || 1)); layers(); controls.update();
      window.__a3dReady = true; return;
    }
    buildQueue(); next(); window.__a3dReady = true;
  } catch (e) { $('loadmsg').textContent = 'Could not load this model: ' + e.message; }
})();
