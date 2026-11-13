'use strict';

/* ───────── Тұрақтылар ───────── */
const LESSONS = 8;
const BACKUP_DAYS = 7;
const SEED = ['Алан', 'Ануар', 'Сүлеймен Али', 'Мирас', 'Шахназ', 'Каусар', 'Інжу', 'Амина',
  'Мустафа', 'Ілияс', 'Апайдың қ1', 'Апайдың қ2', 'Адия'];
const MONTHS = ['қаңтар', 'ақпан', 'наурыз', 'сәуір', 'мамыр', 'маусым', 'шілде', 'тамыз',
  'қыркүйек', 'қазан', 'қараша', 'желтоқсан'];
const WD_FULL = ['жексенбі', 'дүйсенбі', 'сейсенбі', 'сәрсенбі', 'бейсенбі', 'жұма', 'сенбі'];
const WD_SHORT = ['Жк', 'Дс', 'Сс', 'Ср', 'Бс', 'Жм', 'Сн'];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ───────── Күндер (жергілікті уақыт, 'YYYY-MM-DD') ───────── */
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && iso(parse(s)) === s;
const fmtShort = (s) => { const d = parse(s); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${WD_SHORT[d.getDay()]}`; };
const fmtFull = (s) => { const d = parse(s); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; };
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);

/* ───────── IndexedDB ───────── */
let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const r = indexedDB.open('qatysym', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbPromise;
}
async function dbGet(key) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const r = db.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbSet(key, val) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = tx.onabort = () => rej(tx.error);
  });
}

/* ───────── Күй ───────── */
let state = { students: [], meta: { created: today(), lastBackup: null } };
let filter = 'all';
let query = '';
let persisted = null;
let listScroll = 0;

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const find = (id) => state.students.find((s) => s.id === id);
const cur = (s) => s.cycles[s.cycles.length - 1];
const stat = (s) => {
  const n = cur(s).dates.length;
  const done = Math.min(n, LESSONS);
  return { done, extra: Math.max(0, n - LESSONS), left: LESSONS - done, today: cur(s).dates.includes(today()) };
};
const klass = (st) => (st.left === 0 ? 'due' : st.left <= 2 ? 'warn' : '');

function save() {
  dbSet('state', state).catch(() => toast('Қате: деректер сақталмады'));
}

/* Әрекетті орындап, «Болдырмау» мүмкіндігі бар хабарлама шығарады */
function act(msg, fn) {
  const snap = JSON.stringify(state.students);
  fn();
  save();
  render();
  toast(msg, () => {
    state.students = JSON.parse(snap);
    save();
    render();
    toast('Әрекет болдырылмады');
  });
}

function addDate(cycle, d) {
  if (!cycle.dates.includes(d)) cycle.dates.push(d);
  cycle.dates.sort();
}

/* Жаңа цикл. Төленбеген артық сабақтар жаңа 8 сабақтың есебіне көшеді. */
function newCycle(s) {
  const c = cur(s);
  c.dates.sort();
  const carry = c.dates.slice(LESSONS);
  c.dates = c.dates.slice(0, LESSONS);
  s.cycles.push({ start: carry[0] || today(), dates: carry });
}

/* ───────── Терезе (alert/confirm орнына) ───────── */
let sheetResolve = null;
function sheet({ title, text = '', input = null, buttons }) {
  closeSheet(null);
  $('sheetTitle').textContent = title;
  $('sheetText').textContent = text;
  $('sheetText').hidden = !text;
  const inp = $('sheetInput');
  inp.hidden = !input;
  if (input) { inp.value = input.value || ''; inp.placeholder = input.placeholder || ''; }
  $('sheetBtns').innerHTML = buttons.map((b) =>
    `<button type="button" class="btn ${b.kind || ''}" data-sheet="${esc(b.value)}">${esc(b.label)}</button>`).join('');
  $('sheet').hidden = false;
  if (input) setTimeout(() => { inp.focus(); inp.select(); }, 50);
  return new Promise((res) => { sheetResolve = res; });
}
function closeSheet(value) {
  $('sheet').hidden = true;
  if (sheetResolve) { const r = sheetResolve; sheetResolve = null; r(value); }
}
$('sheet').addEventListener('click', (e) => {
  if (e.target === $('sheet')) return closeSheet(null);
  const b = e.target.closest('[data-sheet]');
  if (b) closeSheet(b.dataset.sheet === 'cancel' ? null : b.dataset.sheet);
});
$('sheetInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') closeSheet('ok'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(null); });

const CANCEL = { label: 'Бас тарту', value: 'cancel', kind: 'ghost' };

/* ───────── Хабарлама ───────── */
let toastTimer = null;
let toastUndo = null;
function toast(msg, undo = null) {
  clearTimeout(toastTimer);
  toastUndo = undo;
  $('toastText').textContent = msg;
  $('toastUndo').hidden = !undo;
  $('toast').hidden = true;
  void $('toast').offsetWidth; // анимацияны қайта бастау
  $('toast').hidden = false;
  toastTimer = setTimeout(hideToast, 4000);
}
function hideToast() {
  clearTimeout(toastTimer);
  $('toast').hidden = true;
  toastUndo = null;
}
$('toastUndo').addEventListener('click', () => {
  const u = toastUndo;
  hideToast();
  if (u) u();
});

/* ───────── Көрсету ───────── */
function dotsHtml(st) {
  let h = '<span class="dots" aria-hidden="true">';
  for (let i = 0; i < LESSONS; i++) h += `<span class="dot${i < st.done ? ' on' : ''}"></span>`;
  return h + '</span>';
}
function meterHtml(st) {
  return `<span class="meter">${dotsHtml(st)}<span class="count">${st.done}/${LESSONS}</span>` +
    (st.extra ? `<span class="extra">+${st.extra} артық</span>` : '') +
    (st.left === 0 ? '<span class="badge">Төлеу керек</span>' : '') + '</span>';
}

function renderList() {
  const d = new Date();
  $('todayLabel').textContent = `Бүгін: ${d.getDate()} ${MONTHS[d.getMonth()]}, ${WD_FULL[d.getDay()]}`;

  // Сақтық көшірме туралы ескерту
  const since = daysBetween(state.meta.lastBackup || state.meta.created, today());
  const show = since >= BACKUP_DAYS && state.students.length > 0;
  $('banner').hidden = !show;
  if (show) {
    $('bannerText').textContent = state.meta.lastBackup
      ? `Соңғы көшірмеден бері ${since} күн өтті`
      : `Сақтық көшірме әлі жасалмаған (${since} күн)`;
  }

  const stats = state.students.map((s) => ({ s, st: stat(s) }));
  const groups = {
    all: stats,
    soon: stats.filter((x) => x.st.left === 1 || x.st.left === 2),
    due: stats.filter((x) => x.st.left === 0)
  };
  const labels = { all: 'Барлығы', soon: '1–2 сабақ қалды', due: 'Төлеу керек' };
  $('chips').innerHTML = Object.keys(labels).map((k) =>
    `<button type="button" class="chip" role="tab" aria-selected="${filter === k}" data-act="filter" data-f="${k}">` +
    `<b>${groups[k].length}</b>${labels[k]}</button>`).join('');

  const q = query.trim().toLocaleLowerCase('kk');
  const rows = groups[filter].filter((x) => !q || x.s.name.toLocaleLowerCase('kk').includes(q));

  $('list').innerHTML = rows.length ? rows.map(({ s, st }) => `
    <li class="row ${klass(st)}">
      <button type="button" class="row-main" data-act="open" data-id="${s.id}">
        <span class="name">${esc(s.name)}</span>
        ${meterHtml(st)}
      </button>
      <button type="button" class="btn came ${st.today ? 'on' : 'primary'}" data-act="came" data-id="${s.id}"
        aria-pressed="${st.today}">${st.today ? '✓ Бүгін' : 'Келді'}</button>
    </li>`).join('')
    : `<li class="empty">${state.students.length ? 'Оқушы табылмады' : 'Әзірге оқушы жоқ. Төменнен қосыңыз.'}</li>`;
}

function renderStudent(s) {
  const st = stat(s);
  const c = cur(s);
  const hint = st.left === 0
    ? 'Барлық 8 сабақ бітті — төлеу керек.'
    : `${st.left} сабақ қалды.`;
  const dates = c.dates.length ? c.dates.map((d, i) => `
      <li><span>${i + 1}. ${fmtShort(d)}${i >= LESSONS ? '<span class="tag">артық</span>' : ''}</span>
      <button type="button" class="x" data-act="deldate" data-d="${d}" aria-label="${fmtShort(d)} күнін өшіру">✕</button></li>`).join('')
    : '<li class="muted">Әзірге белгі жоқ</li>';
  const past = s.cycles.slice(0, -1).reverse();
  const hist = past.length ? past.map((p) => `
      <div class="hist">
        <b>${fmtFull(p.start)}</b> басталған · ${p.dates.length} сабақ
        <p class="muted">${p.dates.map(fmtShort).join(', ') || '—'}</p>
      </div>`).join('')
    : '<p class="muted">Бұрынғы циклдер жоқ</p>';

  $('v-student').innerHTML = `
    <header class="top">
      <a href="#/" class="btn ghost small">‹ Артқа</a>
      <h2>${esc(s.name)}</h2>
      <span class="spacer"></span>
    </header>

    <div class="card summary ${klass(st)}">
      ${meterHtml(st)}
      <p class="hint">${hint} Цикл ${fmtFull(c.start)} күні басталған.</p>
      <button type="button" class="btn came block ${st.today ? 'on' : 'primary'}" data-act="came" data-id="${s.id}">
        ${st.today ? '✓ Бүгін' : 'Келді'}</button>
    </div>

    <div class="card">
      <h3>Келген күндері</h3>
      <ul class="dates">${dates}</ul>
      <form class="adddate" id="addDateForm">
        <label for="missDate">Белгілеуді ұмытқан күнді қосу</label>
        <input id="missDate" class="field" type="date" max="${today()}" value="${today()}">
        <button type="submit" class="btn">Қосу</button>
      </form>
    </div>

    <button type="button" class="btn primary block" data-act="pay">Төледі — жаңа 8 сабақ</button>

    <div class="card" style="margin-top:12px">
      <h3>Тарих</h3>
      ${hist}
    </div>

    <button type="button" class="btn block" data-act="rename">Атын өзгерту</button>
    <button type="button" class="btn danger block" data-act="delete">Оқушыны өшіру</button>`;
}

function renderSettings() {
  const lb = state.meta.lastBackup;
  $('backupInfo').textContent = lb
    ? `Соңғы көшірме: ${fmtFull(lb)} (${daysBetween(lb, today())} күн бұрын)`
    : 'Көшірме әлі жасалмаған';
  $('persistInfo').textContent =
    `Оқушылар саны: ${state.students.length}. ` +
    (persisted === true ? 'Тұрақты сақтау қосулы — телефон деректерді өздігінен тазаламайды.'
      : persisted === false ? 'Тұрақты сақтауға рұқсат берілмеген. Қосымшаны «Экранға қосу» арқылы орнатып, көшірмені жиі сақтаңыз.'
        : 'Бұл браузер тұрақты сақтауды қолдамайды. Көшірмені жиі сақтаңыз.');
}

let shown = '';
function currentId() {
  const m = location.hash.match(/^#\/s\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}
function render() {
  const id = currentId();
  const s = id && find(id);
  const view = s ? 'student' : location.hash === '#/settings' ? 'settings' : 'list';
  if (id && !s) history.replaceState(null, '', '#/');
  for (const v of ['list', 'student', 'settings']) $('v-' + v).hidden = v !== view;
  if (view === 'student') renderStudent(s);
  else if (view === 'settings') renderSettings();
  else renderList();
  if (view !== shown) {
    const prev = shown;
    shown = view;
    if (prev === 'list') listScroll = window.scrollY;
    window.scrollTo(0, view === 'list' ? listScroll : 0);
  }
}

/* ───────── Әрекеттер ───────── */
async function onCame(id) {
  const s = find(id);
  if (!s) return;
  const t = today();
  const c = cur(s);
  if (c.dates.includes(t)) {
    act(`${s.name}: бүгінгі белгі алынды`, () => { c.dates = c.dates.filter((d) => d !== t); });
    return;
  }
  if (c.dates.length >= LESSONS) {
    const v = await sheet({
      title: `${s.name}: 8 сабақ бітті`,
      text: 'Оқушы жаңа сабақтарға төледі ме?',
      buttons: [
        { label: 'Төледі — жаңа 8 сабаққа жаз', value: 'paid', kind: 'primary' },
        { label: 'Әзірге төлемеді — артық сабақ деп жаз', value: 'extra' },
        CANCEL
      ]
    });
    if (v === 'paid') {
      act(`${s.name}: төледі, жаңа 8 сабақ басталды`, () => { newCycle(s); addDate(cur(s), t); });
    } else if (v === 'extra') {
      act(`${s.name}: артық сабақ жазылды`, () => addDate(c, t));
    }
    return;
  }
  act(`${s.name}: келді (${c.dates.length + 1}/${LESSONS})`, () => addDate(c, t));
}

async function onPay(s) {
  const st = stat(s);
  if (st.left > 0) {
    const v = await sheet({
      title: '8 сабақ әлі біткен жоқ',
      text: `${s.name} әзірге ${st.done}/${LESSONS} сабаққа келді. Сонда да жаңа 8 сабақты бастау керек пе? Қалған ${st.left} сабақ есептелмейді.`,
      buttons: [{ label: 'Иә, жаңа 8 сабақты баста', value: 'yes', kind: 'primary' }, CANCEL]
    });
    if (v !== 'yes') return;
  }
  act(`${s.name}: төледі, жаңа 8 сабақ басталды`, () => newCycle(s));
}

async function onRename(s) {
  const v = await sheet({
    title: 'Атын өзгерту',
    input: { value: s.name, placeholder: 'Оқушының аты' },
    buttons: [{ label: 'Сақтау', value: 'ok', kind: 'primary' }, CANCEL]
  });
  if (v !== 'ok') return;
  const name = $('sheetInput').value.trim();
  if (!name || name === s.name) return;
  act(`Аты өзгертілді: ${name}`, () => { s.name = name; });
}

async function onDelete(s) {
  const v = await sheet({
    title: `${s.name} өшірілсін бе?`,
    text: 'Оқушының барлық сабақтары мен тарихы өшеді.',
    buttons: [{ label: 'Иә, өшір', value: 'yes', kind: 'danger-fill' }, CANCEL]
  });
  if (v !== 'yes') return;
  location.hash = '#/';
  act(`${s.name} өшірілді`, () => { state.students = state.students.filter((x) => x.id !== s.id); });
}

function onAddDate(s, d) {
  if (!isDate(d)) return toast('Күнді таңдаңыз');
  if (d > today()) return toast('Болашақ күнді қосуға болмайды');
  if (cur(s).dates.includes(d)) return toast(`${fmtShort(d)} бұрыннан белгіленген`);
  act(`${s.name}: ${fmtShort(d)} қосылды`, () => addDate(cur(s), d));
}

/* ───────── Сақтық көшірме ───────── */
function download(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function backup() {
  const data = JSON.stringify({
    app: 'qatysym', version: 1, exported: new Date().toISOString(), students: state.students
  }, null, 2);
  const file = new File([data], `qatysym-${today()}.json`, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
    } else {
      download(file);
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return toast('Көшірме сақталмады');
    download(file);
  }
  state.meta.lastBackup = today();
  save();
  render();
  toast('Көшірме дайын. Оны сенімді жерде сақтаңыз.');
}

function normalize(raw) {
  const list = Array.isArray(raw) ? raw : raw && raw.students;
  if (!Array.isArray(list)) throw new Error('format');
  return list.map((s) => {
    if (!s || typeof s.name !== 'string' || !s.name.trim() || !Array.isArray(s.cycles)) throw new Error('format');
    const cycles = s.cycles.map((c) => {
      if (!c || !Array.isArray(c.dates)) throw new Error('format');
      const dates = [...new Set(c.dates.filter(isDate))].sort();
      return { start: isDate(c.start) ? c.start : dates[0] || today(), dates };
    });
    if (!cycles.length) cycles.push({ start: today(), dates: [] });
    return { id: typeof s.id === 'string' && s.id ? s.id : newId(), name: s.name.trim().slice(0, 60), cycles };
  });
}

async function restore(file) {
  let students;
  try {
    students = normalize(JSON.parse(await file.text()));
  } catch (e) {
    await sheet({
      title: 'Файл жарамсыз',
      text: 'Бұл «Қатысым» қосымшасының сақтық көшірмесі емес немесе файл бүлінген.',
      buttons: [{ label: 'Түсінікті', value: 'cancel', kind: 'primary' }]
    });
    return;
  }
  const v = await sheet({
    title: 'Көшірмені қалпына келтіру',
    text: `Қазіргі деректер (${state.students.length} оқушы) файлдағы деректермен (${students.length} оқушы) толық алмастырылады.`,
    buttons: [{ label: 'Иә, алмастыр', value: 'yes', kind: 'primary' }, CANCEL]
  });
  if (v !== 'yes') return;
  act(`Қалпына келтірілді: ${students.length} оқушы`, () => { state.students = students; });
}

/* ───────── Оқиғалар ───────── */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const a = el.dataset.act;
  const s = find(currentId());
  if (a === 'filter') { filter = el.dataset.f; renderList(); }
  else if (a === 'open') location.hash = '#/s/' + encodeURIComponent(el.dataset.id);
  else if (a === 'came') onCame(el.dataset.id);
  else if (a === 'backup') backup();
  else if (a === 'restore') $('restoreFile').click();
  else if (!s) return;
  else if (a === 'pay') onPay(s);
  else if (a === 'rename') onRename(s);
  else if (a === 'delete') onDelete(s);
  else if (a === 'deldate') {
    const d = el.dataset.d;
    act(`${s.name}: ${fmtShort(d)} өшірілді`, () => { cur(s).dates = cur(s).dates.filter((x) => x !== d); });
  }
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 'addForm') {
    const name = $('addName').value.trim();
    if (!name) return $('addName').focus();
    $('addName').value = '';
    $('addName').blur();
    act(`${name} қосылды`, () => {
      state.students.push({ id: newId(), name, cycles: [{ start: today(), dates: [] }] });
    });
  } else if (e.target.id === 'addDateForm') {
    const s = find(currentId());
    if (s) onAddDate(s, $('missDate').value);
  }
});

$('search').addEventListener('input', (e) => { query = e.target.value; renderList(); });
$('restoreFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) restore(f);
});
window.addEventListener('hashchange', () => { closeSheet(null); render(); });
// Түн ортасынан кейін ашылса, «бүгін» жаңарсын
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

/* ───────── Іске қосу ───────── */
async function init() {
  try {
    const saved = await dbGet('state');
    if (saved && Array.isArray(saved.students)) {
      state = saved;
      state.meta = Object.assign({ created: today(), lastBackup: null }, saved.meta);
    } else {
      state.students = SEED.map((name) => ({ id: newId(), name, cycles: [{ start: today(), dates: [] }] }));
      await dbSet('state', state);
    }
  } catch (e) {
    render();
    toast('Қате: деректер қоймасы ашылмады');
    return;
  }
  render();

  if (navigator.storage && navigator.storage.persist) {
    try {
      persisted = await navigator.storage.persisted() || await navigator.storage.persist();
    } catch (e) { persisted = false; }
    if (shown === 'settings') renderSettings();
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}

init();
