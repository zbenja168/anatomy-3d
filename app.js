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
let brick = null, brickItems = new Map(), bq = { ok: 0, n: 0 }, hyOnly = false; // brick-by-brick mode (?brick=<id>)
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
    if ((mode === 'name' && !done) || revealDim) dimOthers();
  }
}
function dimOthers() {
  for (const [id, m] of Object.entries(meshes)) {
    if (cur.parts.includes(id)) continue;
    const cap = revealDim ? (m.userData.role === 'context' || m.userData.shell ? 0.04 : 0.1) : 0.2; // Show me: fade harder
    m.material.transparent = true; m.material.opacity = Math.min(m.material.opacity, cap); m.material.depthWrite = false;
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

// ---------- functional notes + split rows (data/<stem>.facts.json) ----------
const esc0 = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FACT_FIELDS = [['function', 'Function'], ['innervation', 'Innervation'], ['attachments', 'Attachments'], ['supply', 'Blood supply']];
let byOrderAll = new Map();
function applyFacts(facts) {
  const out = [];
  for (const it of man.items) {
    const f = facts[String(it.order)] || {};
    it.facts = f.facts || null; out.push(it);
    const subs = (f.subs || []).map((sb) => ({ ...sb, parts: (sb.parts || []).filter((id) => it.parts.includes(id) && meshes[id]) })).filter((sb) => sb.parts.length);
    if (subs.length) { // "Femoral triangle: inguinal ligament, sartorius…" -> the triangle itself is a part too
      const used = new Set(subs.flatMap((sb) => sb.parts)), head = it.structure.split(':')[0].trim().toLowerCase();
      const self = it.parts.filter((id) => !used.has(id) && meshes[id] && head.length > 3 && meshes[id].userData.name.toLowerCase().includes(head));
      if (self.length) subs.unshift({ name: it.structure.split(':')[0].trim(), parts: self, facts: f.facts || null });
    }
    if (subs.length >= 2) {
      it.subs = subs.map((sb, k) => {
        const o = Math.round((it.order + (k + 1) / 100) * 100) / 100;
        out.push({ order: o, structure: sb.name, parts: sb.parts, section: it.section, priority: it.priority, status: 'sub', model: it.model, parent: it.order, facts: sb.facts || null });
        return o;
      });
    }
  }
  man.items = out; byOrderAll = new Map(out.map((i) => [i.order, i]));
}
const leaves = () => man.items.filter((i) => i.parts.length && !(i.subs && i.subs.length));
const expandItem = (it) => (it && it.subs && it.subs.length ? it.subs.map((o) => byOrderAll.get(o)).filter(Boolean) : [it]);
function factsHTML(f, short = false) {
  if (!f) return '';
  const SHORT = { function: 'Function', innervation: 'Nerve', attachments: 'Attach', supply: 'Supply' };
  return FACT_FIELDS.filter(([k]) => f[k]).map(([k, lab]) => short ? `<b>${SHORT[k]}</b> ${esc0(f[k])}` : `<div class="frow"><b>${lab}</b><span>${esc0(f[k])}</span></div>`).join(short ? '<br>' : '');
}
function showFacts(it) {
  const box = $('facts'); if (!box) return;
  const f = it && (it.facts || (it.parent != null ? byOrderAll.get(it.parent)?.facts : null));
  box.innerHTML = f ? `<div class="fhead">${esc0(it.structure)}</div>${factsHTML(f)}` : ''; box.hidden = !f;
}
// missed / marked (for review + the Anki export)
const MKEY = (k) => `a3d-${k}-${stem}`;
const loadSet = (k) => { try { return new Set(JSON.parse(localStorage.getItem(MKEY(k)) || '[]')); } catch (e) { return new Set(); } };
const saveSet = (k, set) => { try { localStorage.setItem(MKEY(k), JSON.stringify([...set])); } catch (e) {} };
let missed = new Set(), marked = new Set();
function setRowFlag(order, cls, on) { document.querySelectorAll(`.checklist [data-o="${order}"]`).forEach((r) => r.classList.toggle(cls, on)); }
function addMissed(it) { if (!it || missed.has(it.order)) return; missed.add(it.order); saveSet('missed', missed); setRowFlag(it.order, 'missed', true); }
function toggleMark() {
  if (!cur) return; const o = cur.order, on = !marked.has(o);
  on ? marked.add(o) : marked.delete(o); saveSet('marked', marked); setRowFlag(o, 'marked', on); markBtn();
}
function markBtn() { const b = $('btnMark'); if (b) { const on = cur && marked.has(cur.order); b.textContent = on ? '★ Marked' : '☆ Mark'; b.classList.toggle('on', !!on); } }
// auto-next
let autoTimer = null, autoNext = true;
try { autoNext = localStorage.getItem('a3d-autonext') !== '0'; } catch (e) {}
function cancelAuto() { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } const b = $('autobar'); if (b) b.hidden = true; }
function autoAdvance(ms) {
  cancelAuto(); if (!autoNext || !cur) return;
  const me = cur, bar = $('autobar'); bar.hidden = false;
  const fill = bar.querySelector('i'); fill.style.transition = 'none'; fill.style.width = '0%';
  requestAnimationFrame(() => { fill.style.transition = `width ${ms}ms linear`; fill.style.width = '100%'; });
  autoTimer = setTimeout(() => { autoTimer = null; bar.hidden = true; if (cur === me) next(); }, ms);
}

// ---------- quiz ----------
function buildQueue() {
  if (brick) {
    // the order shown in the brick guide: group by group, top to bottom
    const seq = (brick.groups && brick.groups.length ? brick.groups.flatMap((g) => g.orders) : brick.items.map((b) => b.order));
    queue = seq.map((o) => brickItems.get(o)).filter((b) => b && (!hyOnly || b.yield !== 'low'))
      .map((b) => byOrderAll.get(b.order)).flatMap(expandItem).filter((it) => it && it.parts.length);
    brickSeq = queue.slice();
    $('sLeft').textContent = `${queue.length} in this brick${hyOnly ? ' (high-yield)' : ''}`; return;
  }
  const sec = $('section').value, core = $('coreOnly').checked;
  queue = leaves().filter((it) => (!sec || it.section === sec) && (!core || it.priority !== 'conceptual'));
  // follow the class sheet top to bottom (row order of the Word sheet; list order until the sheet is drawn)
  const rows = [...document.querySelectorAll('#clist tr[data-o]')].map((r) => +r.dataset.o);
  if (rows.length) { const pos = new Map(rows.map((o, i) => [o, i])); queue.sort((a, b) => (pos.get(a.order) ?? 1e9) - (pos.get(b.order) ?? 1e9)); }
  else queue.sort((a, b) => a.order - b.order);
  brickSeq = queue.slice();
  $('sLeft').textContent = `${queue.length} in this set`;
}
function next() {
  if (cur && brickSeq.includes(cur)) { // continue down the guide / sheet from wherever you are
    const i = brickSeq.indexOf(cur); queue = brickSeq.slice(i + 1);
  }
  ask(queue.shift() || null);
}
function ask(item) {
  feedback('');
  restoreAutoHidden(); $('btnReveal').textContent = 'Show me';
  cancelAuto(); showFacts(null);
  cur = item; attempts = 0; done = false; markCurrent(); markBtn();
  $('mcq').innerHTML = '';
  if (!cur && brick) {
    $('qlabel').textContent = 'Brick complete'; $('qtext').textContent = '🎉 ' + brick.title;
    $('qsec').innerHTML = `Found <b>${score.ok}</b> of ${score.tried} on the first try${bq.n ? ` · questions <b>${bq.ok}</b>/${bq.n}` : ''}. <a href="${document.querySelector('.back').href}">Pick another brick</a> or press Next to go again.`;
    buildQueue(); paint(); return;
  }
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
  showFacts(cur);
  let qs = [];
  if (brick) {
    const par = cur.parent != null ? byOrderAll.get(cur.parent) : null;
    const lastSub = !par || par.subs[par.subs.length - 1] === cur.order; // a split row's questions come after its last part
    qs = lastSub ? ((brickItems.get(cur.parent ?? cur.order) || {}).questions || []) : [];
    showMCQ(qs, 0);
  }
  if (solved && !qs.length) autoAdvance(cur.facts || (cur.parent != null && byOrderAll.get(cur.parent)?.facts) ? 3200 : 1300);
}
function showMCQ(qs, k) {
  const box = $('mcq'); box.innerHTML = ''; if (k >= qs.length) return;
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const q = qs[k];
  box.innerHTML = `<div class="mcqhead">Question ${k + 1} of ${qs.length}</div><div class="mcqq">${esc(q.q)}</div>` +
    q.choices.map((c, i) => `<button class="mcqc" data-i="${i}"><b>${'ABCD'[i]}</b> ${esc(c)}</button>`).join('') + '<div class="mcqx"></div>';
  box.querySelectorAll('.mcqc').forEach((b) => b.addEventListener('click', () => {
    if (box.dataset.done === '1') return; box.dataset.done = '1';
    const i = +b.dataset.i, right = i === q.answer; bq.n++; if (right) bq.ok++;
    $('sQ').textContent = `${bq.ok}/${bq.n}`;
    box.querySelectorAll('.mcqc').forEach((x) => x.classList.add(+x.dataset.i === q.answer ? 'right' : (x === b ? 'wrong' : 'dim')));
    box.querySelector('.mcqx').innerHTML = `${right ? '✓ Correct.' : '✗ Not quite.'} ${esc(q.explain)}` +
      (k + 1 < qs.length ? ' <button class="btn mcqnext">Next question →</button>' : '');
    const nx = box.querySelector('.mcqnext'); if (nx) nx.addEventListener('click', () => { box.dataset.done = ''; showMCQ(qs, k + 1); });
    if (right && window.atTrack) { try { window.atTrack('question_answered'); } catch (e) {} }
    if (right && k + 1 >= qs.length) autoAdvance(2600); // stay put after a miss so the explanation can be read
  }));
  box.dataset.done = '';
}

function pick(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const vis = Object.values(meshes).filter((m) => m.visible && !(m.userData.role === 'context' && m.material.opacity < 0.35 && mode !== 'explore'));
  const hits = ray.intersectObjects(vis, false);
  const hit = hits.find((h) => !h.object.userData.shell) || hits[0]; // click through see-through shells
  lastHits = hits.filter((h) => !h.object.userData.shell); lastHit = hit || null;
  return hit ? hit.object : null;
}
let lastHits = [], lastHit = null, brickSeq = [];
const _v = new THREE.Vector3();
function nearTarget(point, ids, tol) { // is the clicked point within tol (m) of any target vertex?
  for (const id of ids) {
    const m = meshes[id]; if (!m || !m.visible) continue;
    const a = m.geometry.attributes.position;
    for (let i = 0; i < a.count; i++) { _v.fromBufferAttribute(a, i); if (_v.distanceToSquared(point) < tol * tol) return true; }
  }
  return false;
}
// Find-it is forgiving for small or tucked-in targets: a click counts if it lands on the target, on the target just
// behind a thin covering part (e.g. glenoid under the humeral head rim), or within a few mm of it.
function hitsTarget(m) {
  if (cur.parts.includes(m.userData.id)) return true;
  const first = lastHit; if (!first) return false;
  if (lastHits.some((h) => cur.parts.includes(h.object.userData.id) && h.distance - first.distance < 0.025)) return true;
  if (nearTarget(first.point, cur.parts, 0.006)) return true;
  const o = ray.ray.origin, d = ray.ray.direction, H = renderer.domElement.clientHeight;
  const k = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / H * 14; // world size of 14 px per metre of depth
  for (const id of cur.parts) {
    const m = meshes[id]; if (!m || !m.visible) continue;
    const a = m.geometry.attributes.position;
    for (let i = 0; i < a.count; i += 2) {
      _v.fromBufferAttribute(a, i).sub(o); const t = _v.dot(d);
      if (t < first.distance - 0.01 || t > first.distance + 0.04) continue;
      if (_v.addScaledVector(d, -t).lengthSq() < (k * t) ** 2) return true;
    }
  }
  return false;
}
// "Show me": pick the clearest viewing angle, zoom in, and temporarily hide whatever still blocks the structure
const autoHidden = new Set(); let revealDim = false, savedView = null;
function restoreAutoHidden() {
  revealDim = false;
  if (savedView) { camera.position.copy(savedView[0]); controls.target.copy(savedView[1]); controls.update(); savedView = null; need(600); } if (autoHidden.size) { autoHidden.forEach((id) => hidden.delete(id)); autoHidden.clear(); paint(); } }
function blockersFrom(eye, ids, samples) {
  const r = new THREE.Raycaster(), out = new Map();
  const solid = Object.values(meshes).filter((m) => m.visible && !ids.includes(m.userData.id) && m.userData.role !== 'context' && !m.userData.shell);
  for (const p of samples) {
    const dir = p.clone().sub(eye), dist = dir.length(); r.set(eye, dir.normalize()); r.far = dist - 0.002;
    for (const h of r.intersectObjects(solid, false)) out.set(h.object.userData.id, (out.get(h.object.userData.id) || 0) + 1);
  }
  return out;
}
function revealTarget(ids) {
  if (!savedView) savedView = [camera.position.clone(), controls.target.clone()]; // Next puts the view back
  let samples = [];
  ids.forEach((id) => { const a = meshes[id]?.geometry.attributes.position; if (!a || !meshes[id].visible) return; for (let i = 0; i < 40; i++) samples.push(new THREE.Vector3().fromBufferAttribute(a, Math.floor((i + 0.5) / 40 * a.count))); });
  if (!samples.length) return;
  // bilateral structure (left + right): zoom on the side nearer the camera
  const L = samples.filter((p) => p.x > 0.02), Rr = samples.filter((p) => p.x < -0.02);
  if (L.length > 4 && Rr.length > 4) samples = (camera.position.x > 0 ? L : Rr);
  const box = new THREE.Box3().setFromPoints(samples);
  const c = box.getCenter(new THREE.Vector3()), rad = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 0.02);
  const dist = Math.max(rad * (rad < 0.03 ? 3.2 : 1.9) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), 0.09);
  samples = samples.filter((_, i) => i % 3 === 0);
  const curDir = camera.position.clone().sub(controls.target).normalize();
  const dirs = [curDir, [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0.2], [0, -1, 0.2], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [1, 1, 1], [-1, 1, 1], [1, 1, -1], [-1, 1, -1]]
    .map((d) => (d.isVector3 ? d : new THREE.Vector3(...d).normalize()));
  // average surface normal: a flat patch (fossa, notch, septum region) should be seen face-on, not edge-on
  const nrm = new THREE.Vector3();
  ids.forEach((id) => { const g = meshes[id]?.geometry; const n = g?.attributes.normal; if (!n) return;
    for (let i = 0; i < n.count; i += 3) nrm.add(_v.fromBufferAttribute(n, i)); });
  const flat = nrm.length() / Math.max(1, ids.reduce((a, id) => a + ((meshes[id]?.geometry.attributes.normal?.count || 0) / 3), 0));
  nrm.normalize();
  let best = null;
  for (const d of dirs) {
    const eye = c.clone().addScaledVector(d, dist), bl = blockersFrom(eye, ids, samples);
    // fewer blockers is better (they get hidden/dimmed anyway, so this weighs less than seeing a flat patch face-on)
    const cost = 0.4 * [...bl.values()].reduce((a, b) => a + b, 0) + (d === curDir ? -0.5 : 0)
      - (flat > 0.2 ? 12 * Math.abs(d.dot(nrm)) : 0) - (d.z > 0.3 ? 0.5 : 0); // slight preference for anterior views
    if (!best || cost < best.cost) best = { d, eye, bl, cost };
  }
  controls.target.copy(c); camera.position.copy(best.eye); camera.near = 0.001; camera.updateProjectionMatrix(); controls.update();
  best.bl.forEach((n, id) => { if (!hidden.has(id)) { hidden.add(id); autoHidden.add(id); } });
  // also clear the area around it: anything in front of the target that covers a ring 1.8x its size
  const u = new THREE.Vector3(), w = new THREE.Vector3(), d = best.d.clone().negate();
  u.crossVectors(d, Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize(); w.crossVectors(d, u);
  const ring = [];
  for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; ring.push(c.clone().addScaledVector(u, Math.cos(a) * rad * 1.8).addScaledVector(w, Math.sin(a) * rad * 1.8)); }
  const front = best.eye.distanceTo(c) - rad;
  const rr = new THREE.Raycaster(), solid = Object.values(meshes).filter((m) => m.visible && !hidden.has(m.userData.id) && !ids.includes(m.userData.id) && m.userData.role !== 'context' && !m.userData.shell);
  for (const q of ring) { rr.set(best.eye, q.clone().sub(best.eye).normalize()); rr.far = front;
    for (const h of rr.intersectObjects(solid, false)) { const id = h.object.userData.id; if (!hidden.has(id)) { hidden.add(id); autoHidden.add(id); } } }
  revealDim = true; paint(); need(800);
  if (autoHidden.size) feedback(($('feedback').innerHTML || '') + ` <span class="hid">(${autoHidden.size} part${autoHidden.size > 1 ? 's' : ''} in the way hidden for now)</span>`);
}
function onClick(ev) {
  const m = pick(ev); if (!m) return;
  const name = m.userData.name + (m.userData.role === 'custom' ? ' <span class="built">(built for this tool)</span>' : '');
  if (mode === 'explore') { const it = itemFor(m.userData.id); feedback(`<b>${name}</b>${it ? ' · on your list as “' + it.structure + '”' : ''}`); showFacts(it); flash(m); return; }
  if (mode !== 'find' || !cur || done) return;
  attempts++;
  if (hitsTarget(m)) { feedback('✓ Correct!', 'ok'); finish(attempts === 1, true); }
  else { flash(m, BAD); addMissed(cur); feedback(`✗ That's <b>${name}</b>. Try again${attempts >= 2 ? ' — or press “Show me”' : ''}.`, 'bad'); }
}
function itemFor(id) { return man.items.find((it) => it.parent != null && it.parts.includes(id)) || man.items.find((it) => it.parts.includes(id)); }
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
  document.querySelectorAll(`.checklist [data-o="${order}"]`).forEach((r) => { r.classList.add('done', 'pop'); setTimeout(() => r.classList.remove('pop'), 700); });
  const it = byOrderAll.get(order), par = it && it.parent != null ? byOrderAll.get(it.parent) : null;
  if (par && par.subs.every((o) => checked.has(o))) check(par.order); // all parts of a split row found -> the row
  countChecks();
}
function uncheck(order) {
  if (!checked.delete(order)) return; saveChecks();
  document.querySelectorAll(`.checklist [data-o="${order}"]`).forEach((r) => r.classList.remove('done'));
  const it = byOrderAll.get(order); if (it && it.parent != null) uncheck(it.parent);
  countChecks();
}
function toggleCheck(order) { // ticking the box by hand (no quiz needed)
  const it = byOrderAll.get(order); if (!it) return;
  const on = !checked.has(order);
  for (const x of [it, ...(it.subs || []).map((o) => byOrderAll.get(o))]) if (x) (on ? check(x.order) : uncheck(x.order));
}
function countChecks() {
  const inl = leaves();
  $('clCount').textContent = `${inl.filter((i) => checked.has(i.order)).length} / ${inl.length} checked`;
}
function markCurrent() {
  document.querySelectorAll('.checklist .cur').forEach((r) => r.classList.remove('cur'));
  if (!cur || cur.order == null || (mode === 'name' && !done)) return; // never give away a Name-it answer
  document.querySelectorAll(`.checklist [data-o="${cur.order}"]`).forEach((r) => { r.classList.add('cur'); if (r.offsetParent) r.scrollIntoView({ block: 'nearest' }); });
}
async function buildChecklist() {
  loadChecks(); missed = loadSet('missed'); marked = loadSet('marked');
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const byOrder = byOrderAll;
  let sheet = null;
  try { const r = await fetch(`data/${stem}.sheet.json`); if (r.ok) sheet = await r.json(); } catch (e) {}
  if (!sheet) { // no Word sheet for this class (GI's list was a PDF): same layout, built from the list
    const rows = []; let sec = null;
    man.items.filter((it) => it.parent == null).sort((a, b) => a.order - b.order).forEach((it) => {
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
  const hasFn = man.items.some((i) => i.facts), FN = tot * 0.75; // functional notes column (toggle)
  const all = tot + (hasFn ? FN : 0);
  let html = '<colgroup>' + head.map((h, c) => `<col style="width:${(100 * (sheet.grid[c] || 0) / all).toFixed(1)}%">`).join('') +
    (hasFn ? `<col class="fncol" style="width:${(100 * FN / all).toFixed(1)}%">` : '') + '</colgroup>';
  const headRow = (f) => `<tr class="shead" style="${fill(f || sheet.headFill)}">` + head.map((h) => `<th>${esc(h)}</th>`).join('') + (hasFn ? '<th class="fncol">Functional notes</th>' : '') + '</tr>';
  const fnCell = (it) => (hasFn ? `<td class="fncol">${factsHTML(it.facts, true)}</td>` : '');
  const flags = (o) => `${checked.has(o) ? ' done' : ''}${missed.has(o) ? ' missed' : ''}${marked.has(o) ? ' marked' : ''}`;
  const NC = ncol + (hasFn ? 1 : 0);
  html += headRow(sheet.headFill);
  for (const r of sheet.rows) {
    if (r.t === 'sec') html += `<tr class="ssec" style="${fill(r.fill)}"><th colspan="${NC}">${esc(r.text)}</th></tr>`;
    else if (r.t === 'sub') html += `<tr class="ssub" style="${fill(r.fill)}"><th>${esc(r.text)}</th>${(r.cells || []).slice(0, ncol - 1).map((c) => `<td>${esc(c)}</td>`).join('')}${hasFn ? '<td class="fncol"></td>' : ''}</tr>`;
    else if (r.t === 'rep') html += headRow(r.fill);
    else if (r.t === 'blank') html += `<tr class="sblank" style="${fill(r.fill)}"><td colspan="${NC}"></td></tr>`;
    else {
      const it = byOrder.get(r.order); if (!it) continue;
      const na = !it.parts.length;
      const cells = [];
      for (let c = 1; c < ncol; c++) {
        const v = (r.cells || [])[c - 1] || '';
        cells.push(c === indiv ? `<td class="ck"><span></span></td>` : `<td>${esc(v)}</td>`);
      }
      const name = `${indiv < 0 ? '<span class="ckin"></span>' : ''}${esc(it.structure)}${it.status === 'custom' ? ' <i class="bt" title="Built for this tool">◆</i>' : ''}${na ? ' <em>not in 3D</em>' : ''}`;
      html += `<tr data-o="${it.order}" class="sitem${na ? ' na' : ''}${it.subs ? ' hassubs' : ''}${flags(it.order)}" style="${fill(r.fill)}" title="${na ? 'Not in the 3D model' : 'Click to quiz this one'}"><td class="sname">${name}</td>${cells.join('')}${fnCell(it)}</tr>`;
      for (const so of it.subs || []) { // a row listing several structures: one sub-row each
        const sb = byOrder.get(so); if (!sb) continue;
        const sc = []; for (let c = 1; c < ncol; c++) sc.push(c === indiv ? `<td class="ck"><span></span></td>` : '<td></td>');
        html += `<tr data-o="${so}" class="sitem subrow${flags(so)}" style="${fill(r.fill)}" title="Click to quiz this one"><td class="sname">${indiv < 0 ? '<span class="ckin"></span>' : ''}<span class="subarrow">↳</span> ${esc(sb.structure)}</td>${sc.join('')}${fnCell(sb)}</tr>`;
      }
    }
  }
  $('sheetHdr').innerHTML = (sheet.hdr || []).map((h) => `<span>${esc(h)}</span>`).join('');
  $('clist').innerHTML = html; countChecks(); markCurrent();
  if (brick) document.querySelectorAll('#clist tr[data-o]').forEach((r) => { const it = byOrder.get(+r.dataset.o); if (!brickItems.has(it?.parent ?? +r.dataset.o)) r.classList.add('outbrick'); });
  $('clist').classList.toggle('nofn', !fnOn());
  $('clist').addEventListener('click', (e) => {
    const r = e.target.closest('tr[data-o]'); if (!r || r.classList.contains('na') || r.classList.contains('outbrick')) return;
    if (e.target.closest('td.ck, .ckin')) { toggleCheck(+r.dataset.o); return; } // tick by hand
    const it0 = byOrder.get(+r.dataset.o), it = it0.subs ? byOrder.get(it0.subs[0]) : it0; // a split row starts at its first part
    if (mode === 'explore') { cur = it; done = true; setBody(it.model); paint(); feedback(`<b>${esc(it.structure)}</b>`); frame(boxOf(it.parts), 2.6); markCurrent(); return; }
    queue = queue.filter((q) => q !== it); ask(it);
  });
  $('clReset').addEventListener('click', () => { checked.clear(); saveChecks(); missed.clear(); saveSet('missed', missed); document.querySelectorAll('.checklist .done, .checklist .missed').forEach((r) => r.classList.remove('done', 'missed')); countChecks(); });
  $('fnToggle').checked = fnOn(); $('fnToggle').hidden = !hasFn; $('fnToggle').parentElement.hidden = !hasFn;
  $('fnToggle').addEventListener('change', (e) => { try { localStorage.setItem('a3d-fncol', e.target.checked ? '1' : '0'); } catch (x) {} $('clist').classList.toggle('nofn', !e.target.checked); document.querySelector('.layout').classList.toggle('wide', e.target.checked); });
  document.querySelector('.layout').classList.toggle('wide', hasFn && fnOn());
}

function fnOn() { try { return localStorage.getItem('a3d-fncol') !== '0'; } catch (e) { return true; } }

// ---------- export: spreadsheet, printable sheet, Anki ----------
function scopeItems() { // brick mode: the brick (guide order); otherwise the whole class list (sheet order)
  if (brick) {
    const seq = brick.groups && brick.groups.length ? brick.groups.flatMap((g) => g.orders) : brick.items.map((b) => b.order);
    return seq.map((o) => byOrderAll.get(o)).filter(Boolean).flatMap((it) => [it, ...(it.subs || []).map((o) => byOrderAll.get(o))]);
  }
  const rows = [...document.querySelectorAll('#clist tr[data-o]')].map((r) => byOrderAll.get(+r.dataset.o)).filter(Boolean);
  return rows.length ? rows : man.items;
}
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
const fileBase = () => (brick ? brick.title : $('title').textContent).replace(/[^\w&() -]+/g, '').trim().replace(/\s+/g, '_');
const factOf = (it, k) => (it.facts && it.facts[k]) || '';
function exportCSV() {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Section', 'Structure', 'In 3D', 'Checked', 'Missed', 'Marked', 'Function', 'Innervation', 'Attachments', 'Blood supply'].map(q).join(',')];
  for (const it of scopeItems()) lines.push([it.section, (it.parent != null ? '  - ' : '') + it.structure, it.parts.length ? 'yes' : 'no', checked.has(it.order) ? 'yes' : '', missed.has(it.order) ? 'yes' : '', marked.has(it.order) ? 'yes' : '',
    factOf(it, 'function'), factOf(it, 'innervation'), factOf(it, 'attachments'), factOf(it, 'supply')].map(q).join(','));
  download(fileBase() + '.csv', '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}
function exportPrint() {
  const rows = scopeItems().map((it) => `<tr class="${it.parent != null ? 'sub' : ''}"><td class="c">${checked.has(it.order) ? '☑' : '☐'}</td><td><b>${it.parent != null ? '↳ ' : ''}${esc0(it.structure)}</b>${marked.has(it.order) ? ' ★' : ''}${missed.has(it.order) ? ' <span class="m">missed</span>' : ''}<div class="s">${esc0(it.section || '')}</div></td><td>${factsHTML(it.facts, true)}</td></tr>`).join('');
  const w = window.open('', '_blank'); if (!w) return;
  w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc0(brick ? brick.title : $('title').textContent)}</title><style>body{font:12px Calibri,Arial,sans-serif;margin:24px;color:#111}h1{font-size:17px;margin:0 0 4px}p{color:#555;margin:0 0 12px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #000;padding:4px 6px;vertical-align:top}th{background:#d9f2d0}td.c{text-align:center;width:28px;font-size:15px}tr.sub td{background:#f6f6f6}.s{color:#666;font-size:10px}.m{color:#b91c1c;font-size:10px}@media print{button{display:none}}</style>` +
    `<h1>${esc0(brick ? brick.title : $('title').textContent)}</h1><p>${esc0($('eyebrow').textContent)} · ${esc0($('clCount').textContent)} · exported ${new Date().toLocaleDateString()}</p><button onclick="print()">Print / Save as PDF</button>` +
    `<table><tr><th>✓</th><th>Structure</th><th>Functional notes</th></tr>${rows}</table>`);
  w.document.close(); setTimeout(() => { try { w.print(); } catch (e) {} }, 400);
}
function exportAnki(onlyFlagged) {
  const clean = (t) => String(t ?? '').replace(/[\t\r\n]+/g, ' ');
  const title = brick ? brick.title : $('title').textContent;
  let items = scopeItems().filter((it) => it.parts.length || it.facts);
  if (onlyFlagged) items = items.filter((it) => missed.has(it.order) || marked.has(it.order));
  if (!items.length) { feedback('Nothing missed or marked yet. Mark structures with ☆, or export the whole list.'); return; }
  const deck = `Active Transport::3D Anatomy::${clean(title).replace(/::/g, ' ')}`;
  const tagBase = 'AT_3D ' + stem;
  const out = ['#separator:tab', '#html:true', '#notetype:Basic', `#deck:${deck}`, '#tags column:3'];
  for (const it of items) {
    const f = it.facts || (it.parent != null ? byOrderAll.get(it.parent)?.facts : null);
    const ex = brick && brickItems.get(it.parent ?? it.order)?.excerpt;
    const front = `<b>${esc0(it.structure)}</b><br><span style="font-size:12px;color:#888">${esc0(title)}${it.section ? ' · ' + esc0(it.section) : ''}</span><br><br>Function? Innervation? Attachments? Supply?`;
    const back = (f ? FACT_FIELDS.filter(([k]) => f[k]).map(([k, lab]) => `<b>${lab}:</b> ${esc0(f[k])}`).join('<br>') : '') + (ex ? `<br><br><i>“${esc0(ex)}”</i>` : '');
    const tags = [tagBase, missed.has(it.order) ? 'missed' : '', marked.has(it.order) ? 'marked' : ''].filter(Boolean).join(' ');
    out.push([clean(front), clean(back || 'See the 3D model'), tags].join('\t'));
  }
  download(fileBase() + (onlyFlagged ? '_missed_marked' : '') + '_anki.txt', out.join('\n'), 'text/plain;charset=utf-8');
  feedback(`Anki file downloaded (${items.length} cards). In Anki: File → Import → pick the file.`);
}

// ---------- brick guide: the brick's structures grouped as the lecture presents them ----------
function buildGuide() {
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const byOrder = byOrderAll;
  const flags = (o) => `${checked.has(o) ? ' done' : ''}${missed.has(o) ? ' missed' : ''}${marked.has(o) ? ' marked' : ''}`;
  const groups = brick.groups && brick.groups.length ? brick.groups : [{ title: brick.title, orders: brick.items.map((b) => b.order) }];
  const nHi = brick.items.filter((b) => b.yield !== 'low').length;
  let html = `<div class="ghead"><div class="gtitle">${esc(brick.title)}</div><div class="gmeta">Week ${esc(brick.week)} · Session ${esc(brick.session)} · ` +
    `<span class="hy">${nHi} high-yield</span> · <span class="ly">${brick.items.length - nHi} low-yield</span></div>` +
    `<label class="gfilter"><input type="checkbox" id="hyOnly"> Quiz high-yield only</label></div>`;
  for (const g of groups) {
    html += `<div class="ggroup"><div class="gsec">${esc(g.title)}</div>`;
    for (const o of g.orders) {
      const b = brickItems.get(o), it = byOrder.get(o); if (!b || !it) continue;
      const low = b.yield === 'low', nq = (b.questions || []).length;
      html += `<div class="gitem${low ? ' low' : ''}${flags(o)}${it.parts.length ? '' : ' na'}" data-o="${o}">` +
        `<span class="ck"></span><div class="gbody"><div class="gname">${esc(it.structure)}` +
        ` <span class="tag ${low ? 'ly' : 'hy'}">${low ? 'Low yield' : 'High yield'}</span>${nq ? ` <span class="nq">${nq} Q</span>` : ''}</div>` +
        (b.excerpt ? `<div class="gex">“${esc(b.excerpt)}”</div>` : '') + `</div></div>`;
      for (const so of it.subs || []) { const sb = byOrder.get(so); if (!sb) continue;
        html += `<div class="gitem sub${low ? ' low' : ''}${flags(so)}" data-o="${so}"><span class="ck"></span><div class="gbody"><div class="gname">↳ ${esc(sb.structure)}</div></div></div>`; }
    }
    html += '</div>';
  }
  $('guide').innerHTML = html;
  $('guide').addEventListener('click', (e) => {
    const r = e.target.closest('.gitem'); if (!r || r.classList.contains('na')) return;
    if (e.target.closest('.ck')) { toggleCheck(+r.dataset.o); return; } // tick by hand
    const it0 = byOrder.get(+r.dataset.o), it = it0.subs ? byOrder.get(it0.subs[0]) : it0;
    if (mode === 'explore') { cur = it; done = true; setBody(it.model); paint(); feedback(`<b>${esc(it.structure)}</b>`); frame(boxOf(it.parts), 2.6); markCurrent(); return; }
    queue = queue.filter((q) => q !== it); ask(it);
  });
  $('hyOnly').addEventListener('change', (e) => { hyOnly = e.target.checked; $('guide').classList.toggle('hyonly', hyOnly); buildQueue(); next(); });
  // tabs: brick guide <-> class sheet
  document.querySelectorAll('.cltab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.cltab').forEach((x) => x.classList.toggle('on', x === t));
    const g = t.dataset.t === 'guide'; $('guide').hidden = !g; document.querySelector('.clwrap').hidden = g; markCurrent();
  }));
  $('guide').hidden = false; document.querySelector('.clwrap').hidden = true; markCurrent();
}

// ---------- wiring ----------
function wire() {
  const el = renderer.domElement; let down = null, lp = null;
  el.addEventListener('pointerdown', (e) => { if (e.button !== 0) { down = null; lp = null; return; } down = [e.clientX, e.clientY]; lp = setTimeout(() => { const m = pick(e); if (m) { hidden.add(m.userData.id); paint(); } lp = null; }, 650); });
  el.addEventListener('pointerup', (e) => { if (e.button !== 0) return; if (lp) clearTimeout(lp); if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5 && lp !== null) onClick(e); down = null; });
  el.addEventListener('pointermove', (e) => { if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 && lp) { clearTimeout(lp); lp = null; } });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); const m = pick(e); if (m) { hidden.add(m.userData.id); paint(); } });
  document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.mode; document.querySelectorAll('.mode').forEach((x) => x.classList.toggle('on', x === b));
    $('nameForm').hidden = mode !== 'name'; $('btnBody').hidden = mode !== 'explore' || Object.keys(man.models).length < 2; $('qcard').classList.toggle('explore', mode === 'explore');
    if (mode === 'explore') { cur = null; done = false; $('qlabel').textContent = 'Explore'; $('qtext').textContent = 'Click any structure'; $('qsec').textContent = ''; feedback(''); paint(); }
    else { const keep = cur; buildQueue(); if (keep && queue.includes(keep)) { queue = queue.slice(queue.indexOf(keep) + 1); ask(keep); } else next(); } // switching mode keeps your place
  }));
  $('nameForm').addEventListener('submit', (e) => {
    e.preventDefault(); if (!cur || done) return; attempts++;
    if (typedOk($('nameInput').value, cur)) { feedback('✓ Correct!', 'ok'); finish(attempts === 1, true); }
    else { addMissed(cur); feedback(`✗ Not quite${attempts >= 2 ? ' — press “Show me” to see it' : ''}.`, 'bad'); }
  });
  $('btnReveal').addEventListener('click', () => {
    if (!cur) return;
    if (revealDim) { restoreAutoHidden(); paint(); $('btnReveal').textContent = 'Show me'; return; } // toggle off: view + parts back
    cancelAuto();
    if (!done) { addMissed(cur); feedback(`It's <b>${cur.structure}</b>.`); finish(false, false); }
    revealTarget(cur.parts); $('btnReveal').textContent = 'Hide it';
  });
  $('btnNext').addEventListener('click', () => { cancelAuto(); next(); });
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
    const bid = new URLSearchParams(location.search).get('brick');
    if (bid) {
      try {
        const data = await (await fetch(`data/bricks_${SUBJ[stem.split('_')[0]]}.json`)).json();
        brick = data.bricks.find((b) => b.id === bid && b.stem === stem) || null;
      } catch (e) { brick = null; }
      if (brick) {
        brick.items.forEach((b) => brickItems.set(b.order, b));
        $('title').textContent = brick.title; $('eyebrow').textContent = `Brick by brick · Week ${brick.week} · Session ${brick.session} · ${meta.course}`;
        document.title = `${brick.title} | 3D Anatomy Trainer`;
        document.body.classList.add('brickmode');
        $('btnNext').textContent = 'Next structure →';
      }
    }
    // sections + priorities come from the list (attached at build time)
    const secs = [...new Set(man.items.filter((i) => i.parts.length).map((i) => i.section).filter(Boolean))];
    secs.forEach((s) => { const o = document.createElement('option'); o.value = s; o.textContent = s; $('section').appendChild(o); });
    const ms = Object.keys(man.models).map((m) => BODY_NAME[m] || m);
    $('modelNote').textContent = `${man.items.filter((i) => i.parts.length).length} of ${man.items.length} list structures are in 3D. ` +
      (ms.length > 1 ? `They come from two reference bodies (${ms.join(' and ')}); each question shows the body that has that structure, and the two are never mixed in one scene.` : `Model: ${ms[0]}.`);
    let facts = {};
    try { const r = await fetch(`data/${stem}.facts.json`); if (r.ok) facts = (await r.json()).items || {}; } catch (e) {}
    applyFacts(facts);
    $('loading').remove(); wire(); await buildChecklist(); if (brick) buildGuide();
    $('autoNext').checked = autoNext;
    $('autoNext').addEventListener('change', (e) => { autoNext = e.target.checked; try { localStorage.setItem('a3d-autonext', autoNext ? '1' : '0'); } catch (x) {} if (!autoNext) cancelAuto(); });
    $('btnMark').addEventListener('click', toggleMark);
    $('autobar').querySelector('button').addEventListener('click', cancelAuto);
    $('btnExport').addEventListener('click', (e) => { e.stopPropagation(); $('exportMenu').hidden = !$('exportMenu').hidden; });
    document.addEventListener('click', () => { $('exportMenu').hidden = true; });
    $('exportMenu').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; const k = b.dataset.x;
      if (k === 'csv') exportCSV(); else if (k === 'print') exportPrint(); else exportAnki(k === 'anki-flagged'); });
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
    window.__a3dTest = { screenOf: (ids) => { const c = boxOf(ids).getCenter(new THREE.Vector3()).project(camera), r = renderer.domElement.getBoundingClientRect(); return [r.left + (c.x + 1) / 2 * r.width, r.top + (1 - c.y) / 2 * r.height]; }, cur: () => cur, vert: (id, k) => { const a = meshes[id].geometry.attributes.position, v = new THREE.Vector3().fromBufferAttribute(a, Math.floor(k * a.count)).project(camera), r = renderer.domElement.getBoundingClientRect(); return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; }, frameOn: (ids) => frame(boxOf(ids), 2.2), cam: () => [camera.position.toArray(), controls.target.toArray(), boxOf(cur.parts).getCenter(new THREE.Vector3()).toArray(), cur.parts.map((id) => [id, !!meshes[id], meshes[id] && meshes[id].visible])] };
  } catch (e) { $('loadmsg').textContent = 'Could not load this model: ' + e.message; }
})();
