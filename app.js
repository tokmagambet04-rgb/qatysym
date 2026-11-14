'use strict';

/* ───────── Тұрақтылар ───────── */
const DEFAULT_LESSONS = 8;
const MAX_LESSONS = 40;
const BACKUP_DAYS = 7;
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
let state = { students: [], courses: [], meta: { created: today(), lastBackup: null } };
let filter = 'all';
let courseFilter = 'all';
let query = '';
let persisted = null;
let listScroll = 0;

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const find = (id) => state.students.find((s) => s.id === id);
const cur = (s) => s.cycles[s.cycles.length - 1];
/* Сабақ түрі (ҰБТ, НИШ, жеке...) және циклдегі сабақ саны */
const course = (s) => state.courses.find((c) => c.id === s.course) || null;
const clampN = (n) => Math.min(MAX_LESSONS, Math.max(1, Math.floor(Number(n)) || DEFAULT_LESSONS));
const total = (s) => { const c = course(s); return clampN(c ? c.lessons : state.meta.lessons); };
const stat = (s) => {
  const n = cur(s).dates.length;
  const t = total(s);
  const done = Math.min(n, t);
  return { done, total: t, extra: Math.max(0, n - t), left: t - done, today: cur(s).dates.includes(today()) };
};
const klass = (st) => (st.left === 0 ? 'due' : st.left <= 2 ? 'warn' : '');

function save() {
  dbSet('state', state).catch(() => toast('Қате: деректер сақталмады'));
}

/* Әрекетті орындап, «Болдырмау» мүмкіндігі бар хабарлама шығарады */
function act(msg, fn) {
  const snap = JSON.stringify({ s: state.students, c: state.courses, l: state.meta.lessons });
  fn();
  state.meta.unsaved = (state.meta.unsaved || 0) + 1; // көшірмеге әлі түспеген өзгерістер
  save();
  render();
  tgSchedule();
  toast(msg, () => {
    const old = JSON.parse(snap);
    state.meta.unsaved = (state.meta.unsaved || 0) + 1;
    tgSchedule();
    state.students = old.s;
    state.courses = old.c;
    state.meta.lessons = old.l;
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
function newCycle(s, amount) {
  const c = cur(s);
  c.dates.sort();
  const t = total(s);
  const carry = c.dates.slice(t);
  c.dates = c.dates.slice(0, t);
  s.cycles.push({ start: carry[0] || today(), dates: carry, paid: { date: today(), amount } });
  if (amount) state.meta.lastAmount = amount;
}

/* ───────── Төлем ───────── */
const money = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₸';
const paidText = (p) => (p.amount ? money(p.amount) : 'сомасы көрсетілмеген');
function lastAmount(s) {
  for (let i = s.cycles.length - 1; i >= 0; i--) {
    const p = s.cycles[i].paid;
    if (p && p.amount) return p.amount;
  }
  const c = course(s);
  return (c && c.price) || state.meta.lastAmount || 0;
}
/* Соманы сұрайды. Бас тартылса null, әйтпесе {amount} немесе {remove:true} қайтарады */
async function askAmount(s, current = null) {
  const preset = current ? current.amount : lastAmount(s);
  const buttons = [{ label: 'Сақтау', value: 'ok', kind: 'primary' }];
  if (current) buttons.push({ label: 'Төлем жазбасын өшіру', value: 'remove', kind: 'danger' });
  buttons.push(CANCEL);
  const v = await sheet({
    title: `${s.name}: төлем сомасы`,
    text: 'Қанша теңге төледі? Соманы бос қалдыруға да болады.',
    input: { value: preset ? String(preset) : '', placeholder: 'Мысалы, 20000', mode: 'numeric' },
    buttons
  });
  if (v === 'remove') return { remove: true };
  if (v !== 'ok') return null;
  return { amount: parseInt($('sheetInput').value.replace(/\D/g, ''), 10) || 0 };
}
async function onSetPay(s) {
  const c = cur(s);
  const r = await askAmount(s, c.paid || null);
  if (!r) return;
  if (r.remove) return act(`${s.name}: төлем жазбасы өшірілді`, () => { delete c.paid; });
  act(`${s.name}: төлем жазылды — ${paidText(r)}`, () => {
    c.paid = { date: c.paid ? c.paid.date : today(), amount: r.amount };
    if (r.amount) state.meta.lastAmount = r.amount;
  });
}

/* ───────── Терезе (alert/confirm орнына) ───────── */
let sheetResolve = null;
function sheet({ title, text = '', input = null, fields = null, buttons }) {
  closeSheet(null);
  // Жазу өрісі бар терезе жоғарыда тұрады — пернетақта жаппайды
  $('sheet').classList.toggle('top', !!(input || fields));
  $('sheetFields').hidden = !fields;
  $('sheetFields').innerHTML = (fields || []).map((f) =>
    `<label for="sf-${f.key}">${esc(f.label)}</label>` +
    `<input id="sf-${f.key}" class="field" type="text" maxlength="40" inputmode="${f.mode || 'text'}" ` +
    `value="${esc(f.value)}" placeholder="${esc(f.placeholder || '')}">`).join('');
  $('sheetTitle').textContent = title;
  $('sheetText').textContent = text;
  $('sheetText').hidden = !text;
  const inp = $('sheetInput');
  inp.hidden = !input;
  if (input) {
    inp.value = input.value || '';
    inp.placeholder = input.placeholder || '';
    inp.inputMode = input.mode || 'text';
  }
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
  for (let i = 0; i < st.total; i++) h += `<span class="dot${i < st.done ? ' on' : ''}"></span>`;
  return h + '</span>';
}
function meterHtml(st) {
  return `<span class="meter">${dotsHtml(st)}<span class="count">${st.done}/${st.total}</span>` +
    (st.extra ? `<span class="extra">+${st.extra} артық</span>` : '') +
    (st.left === 0 ? '<span class="badge">Төлеу керек</span>' : '') + '</span>';
}

function renderList() {
  const d = new Date();
  $('todayLabel').textContent = `Бүгін: ${d.getDate()} ${MONTHS[d.getMonth()]}, ${WD_FULL[d.getDay()]}`;

  // Сақтық көшірме туралы ескерту
  const since = daysBetween(state.meta.lastBackup || state.meta.created, today());
  const unsaved = state.meta.unsaved || 0;
  const overdue = since >= BACKUP_DAYS && state.students.length > 0;
  const show = overdue || unsaved > 0;
  $('banner').hidden = !show;
  $('banner').classList.toggle('soft', !overdue);
  if (show) {
    $('bannerText').textContent = !overdue ? `Көшірмеге түспеген өзгеріс: ${unsaved}`
      : state.meta.lastBackup ? `Соңғы көшірмеден бері ${since} күн өтті`
        : `Сақтық көшірме әлі жасалмаған (${since} күн)`;
  }

  // Сабақ түрі бойынша сүзгі
  if (courseFilter !== 'all' && courseFilter !== 'none' && !state.courses.some((c) => c.id === courseFilter)) courseFilter = 'all';
  const inCourse = (s) => courseFilter === 'all' || (courseFilter === 'none' ? !course(s) : s.course === courseFilter);
  const cnt = (f) => state.students.filter(f).length;
  const pills = [['all', 'Бәрі', state.students.length]]
    .concat(state.courses.map((c) => [c.id, c.name, cnt((s) => s.course === c.id)]));
  const noCourse = cnt((s) => !course(s));
  if (noCourse) pills.push(['none', 'Түрі жоқ', noCourse]);
  else if (courseFilter === 'none') courseFilter = 'all';
  $('courses').hidden = !state.courses.length;
  $('courses').innerHTML = pills.map(([id, name, n]) =>
    `<button type="button" class="pill" aria-pressed="${courseFilter === id}" data-act="course" data-c="${id}">${esc(name)} <b>${n}</b></button>`).join('');

  const stats = state.students.filter(inCourse).map((s) => ({ s, st: stat(s) }));
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
        <span class="name">${esc(s.name)}${course(s) && courseFilter === 'all' ? `<span class="ctag">${esc(course(s).name)}</span>` : ''}</span>
        ${meterHtml(st)}
      </button>
      <button type="button" class="btn came ${st.today ? 'on' : 'primary'}" data-act="came" data-id="${s.id}"
        aria-pressed="${st.today}">${st.today ? '✓ Бүгін' : 'Келді'}</button>
    </li>`).join('')
    : `<li class="empty">${state.students.length ? 'Оқушы табылмады' : 'Әзірге оқушы жоқ. Төмендегі жолға атын жазып қосыңыз. Сабақ түрлерін (ҰБТ, НИШ, жеке...) «Баптау» бөлімінде құруға болады.'}</li>`;
}

function renderStudent(s) {
  const st = stat(s);
  const c = cur(s);
  const hint = st.left === 0
    ? `Барлық ${st.total} сабақ бітті — төлеу керек.`
    : `${st.left} сабақ қалды.`;
  const dates = c.dates.length ? c.dates.map((d, i) => `
      <li><span>${i + 1}. ${fmtShort(d)}${i >= st.total ? '<span class="tag">артық</span>' : ''}</span>
      <button type="button" class="x" data-act="deldate" data-d="${d}" aria-label="${fmtShort(d)} күнін өшіру">✕</button></li>`).join('')
    : '<li class="muted">Әзірге белгі жоқ</li>';
  const past = s.cycles.slice(0, -1).reverse();
  const hist = past.length ? past.map((p) => `
      <div class="hist">
        <b>${fmtFull(p.start)}</b> басталған · ${p.dates.length} сабақ
        <p>${p.paid ? `Төлем: ${paidText(p.paid)} (${fmtFull(p.paid.date)})` : 'Төлем жазылмаған'}</p>
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

    <div class="card">
      <h3>Сабақ түрі</h3>
      ${state.courses.length ? `
      <select id="courseSel" class="field" aria-label="Сабақ түрі">
        <option value="">Түрі жоқ (${clampN(state.meta.lessons)} сабақ)</option>
        ${state.courses.map((k) => `<option value="${k.id}"${s.course === k.id ? ' selected' : ''}>${esc(k.name)} (${clampN(k.lessons)} сабақ)</option>`).join('')}
      </select>` : '<p class="muted">Сабақ түрлерін (ҰБТ, НИШ, жеке...) «Баптау» бөлімінде қосыңыз.</p>'}
    </div>

    <div class="card">
      <h3>Осы циклдің төлемі</h3>
      ${c.paid
        ? `<p>Төленді: <b>${paidText(c.paid)}</b> · ${fmtFull(c.paid.date)}</p>
           <button type="button" class="btn block" data-act="setpay">Төлемді өзгерту</button>`
        : `<p class="unpaid">Төлем жазылмаған</p>
           <button type="button" class="btn block" data-act="setpay">Осы циклге төлемді жазу</button>`}
    </div>

    <button type="button" class="btn primary block" data-act="pay">Төледі — жаңа ${st.total} сабақ</button>

    <div class="card" style="margin-top:12px">
      <h3>Тарих</h3>
      ${hist}
    </div>

    <button type="button" class="btn block" data-act="rename">Атын өзгерту</button>
    <button type="button" class="btn danger block" data-act="delete">Оқушыны өшіру</button>`;
}

/* ───────── Сабақ түрлері ───────── */
async function onEditCourse(c) {
  const buttons = [{ label: 'Сақтау', value: 'ok', kind: 'primary' }];
  if (c) buttons.push({ label: 'Сабақ түрін өшіру', value: 'remove', kind: 'danger' });
  buttons.push(CANCEL);
  const v = await sheet({
    title: c ? 'Сабақ түрін өзгерту' : 'Жаңа сабақ түрі',
    fields: [
      { key: 'name', label: 'Атауы', value: c ? c.name : '', placeholder: 'Мысалы, ҰБТ' },
      { key: 'lessons', label: 'Бір төлемге неше сабақ', value: String(c ? clampN(c.lessons) : clampN(state.meta.lessons)), mode: 'numeric' },
      { key: 'price', label: 'Бағасы, ₸ (бос қалдыруға болады)', value: c && c.price ? String(c.price) : '', mode: 'numeric', placeholder: 'Мысалы, 25000' }
    ],
    buttons
  });
  if (v === 'remove') {
    const used = state.students.filter((s) => s.course === c.id).length;
    const sure = await sheet({
      title: `«${c.name}» өшірілсін бе?`,
      text: used ? `Осы түрдегі ${used} оқушы өшпейді, тек «Түрі жоқ» болып қалады.` : 'Бұл түрде оқушы жоқ.',
      buttons: [{ label: 'Иә, өшір', value: 'yes', kind: 'danger-fill' }, CANCEL]
    });
    if (sure !== 'yes') return;
    act(`«${c.name}» өшірілді`, () => {
      state.courses = state.courses.filter((x) => x.id !== c.id);
      for (const s of state.students) if (s.course === c.id) delete s.course;
    });
    return;
  }
  if (v !== 'ok') return;
  const name = $('sf-name').value.trim().slice(0, 40);
  if (!name) return toast('Атауын жазыңыз');
  const lessons = clampN($('sf-lessons').value.replace(/\D/g, ''));
  const price = parseInt($('sf-price').value.replace(/\D/g, ''), 10) || 0;
  if (c) act(`«${name}» сақталды`, () => { Object.assign(c, { name, lessons, price }); });
  else act(`«${name}» қосылды`, () => { state.courses.push({ id: newId(), name, lessons, price }); });
}

/* Тізімді мәтінмен қосу. Әр жол: «Түрі: аты, аты» немесе тек «аты, аты» */
async function onBulk() {
  const lower = (x) => x.toLocaleLowerCase('kk');
  const groups = [];
  for (const line of $('bulkText').value.split(/\r?\n/)) {
    const i = line.indexOf(':');
    const cname = i >= 0 ? line.slice(0, i).trim().slice(0, 40) : '';
    const names = (i >= 0 ? line.slice(i + 1) : line).split(/[,;]/).map((x) => x.trim().slice(0, 60)).filter(Boolean);
    if (names.length) groups.push({ cname, names });
  }
  const all = groups.reduce((a, g) => a.concat(g.names), []);
  if (!all.length) return toast('Алдымен тізімді жазыңыз');
  const has = (n) => state.students.some((s) => lower(s.name) === lower(n));
  const fresh = [...new Set(all.map(lower))].filter((n) => !has(n)).length;
  const newCourses = [...new Set(groups.map((g) => g.cname).filter(Boolean).map(lower))]
    .filter((n) => !state.courses.some((c) => lower(c.name) === n)).length;
  const v = await sheet({
    title: 'Тізімді қосу',
    text: `${fresh} жаңа оқушы және ${newCourses} жаңа сабақ түрі қосылады.` +
      (all.length - fresh > 0 ? ' Бұрыннан бар оқушылар қайталанбайды, тек түрі жаңарады.' : ''),
    buttons: [{ label: 'Қосу', value: 'yes', kind: 'primary' }, CANCEL]
  });
  if (v !== 'yes') return;
  act(`Тізім қосылды: ${fresh} жаңа оқушы`, () => {
    for (const g of groups) {
      let k = null;
      if (g.cname) {
        k = state.courses.find((c) => lower(c.name) === lower(g.cname));
        if (!k) { k = { id: newId(), name: g.cname, lessons: clampN(state.meta.lessons), price: 0 }; state.courses.push(k); }
      }
      for (const name of g.names) {
        let s = state.students.find((x) => lower(x.name) === lower(name));
        if (!s) { s = { id: newId(), name, cycles: [{ start: today(), dates: [] }] }; state.students.push(s); }
        if (k) s.course = k.id;
      }
    }
  });
  $('bulkText').value = '';
}

function renderSettings() {
  $('courseList').innerHTML = state.courses.length ? state.courses.map((c) => `
    <li><button type="button" class="payrow" data-act="editcourse" data-id="${c.id}">
      <span class="name">${esc(c.name)}</span>
      <span class="payamt"><b>${clampN(c.lessons)} сабақ</b>
        <small>${c.price ? money(c.price) : 'бағасы жоқ'} · ${state.students.filter((s) => s.course === c.id).length} оқушы</small></span>
    </button></li>`).join('')
    : '<li class="muted">Әзірге сабақ түрі жоқ. Мысалы: ҰБТ, НИШ, жеке сабақ.</li>';
  if (document.activeElement !== $('defLessons')) $('defLessons').value = clampN(state.meta.lessons);
  renderTg();
  const lb = state.meta.lastBackup;
  $('backupInfo').textContent = (lb
    ? `Соңғы көшірме: ${fmtFull(lb)} (${daysBetween(lb, today())} күн бұрын).`
    : 'Көшірме әлі жасалмаған.') +
    (state.meta.unsaved ? ` Содан бергі өзгеріс: ${state.meta.unsaved}.` : lb ? ' Барлық өзгеріс көшірмеде.' : '');
  $('persistInfo').textContent =
    `Оқушылар саны: ${state.students.length}. ` +
    (persisted === true ? 'Тұрақты сақтау қосулы — телефон деректерді өздігінен тазаламайды.'
      : persisted === false ? 'Тұрақты сақтауға рұқсат берілмеген. Қосымшаны «Экранға қосу» арқылы орнатып, көшірмені жиі сақтаңыз.'
        : 'Бұл браузер тұрақты сақтауды қолдамайды. Көшірмені жиі сақтаңыз.');
}

function renderPay() {
  const rows = state.students.map((s) => ({ s, p: cur(s).paid || null }));
  const paid = rows.filter((r) => r.p);
  const unpaid = rows.filter((r) => !r.p);
  const sum = paid.reduce((a, r) => a + (r.p.amount || 0), 0);

  const months = {};
  for (const s of state.students) {
    for (const c of s.cycles) {
      if (!c.paid) continue;
      const k = c.paid.date.slice(0, 7);
      if (!months[k]) months[k] = { sum: 0, n: 0 };
      months[k].sum += c.paid.amount || 0;
      months[k].n++;
    }
  }
  const monthRows = Object.keys(months).sort().reverse().map((k) => {
    const [y, m] = k.split('-').map(Number);
    return `<li><span>${MONTHS[m - 1]} ${y} · ${months[k].n} төлем</span><b>${money(months[k].sum)}</b></li>`;
  }).join('');

  const line = ({ s, p }) => `
    <li><button type="button" class="payrow" data-act="open" data-id="${s.id}">
      <span class="name">${esc(s.name)}</span>
      ${p ? `<span class="payamt"><b>${paidText(p)}</b><small>${fmtFull(p.date)}</small></span>`
          : '<span class="badge">Төленбеген</span>'}
    </button></li>`;

  const all = rows.length > 0 && unpaid.length === 0;
  $('payBody').innerHTML = `
    <div class="card summary ${all ? 'ok' : ''}">
      <p class="muted">Ағымдағы циклге төлегендер</p>
      <p class="big">${paid.length} / ${rows.length}${all ? ' ✓' : ''}</p>
      <p class="hint">Жиналған сома: <b>${money(sum)}</b></p>
      ${all ? '<p class="hint">Барлығы төледі.</p>' : ''}
    </div>
    ${unpaid.length ? `<div class="card"><h3>Төлемегендер (${unpaid.length})</h3><ul class="paylist">${unpaid.map(line).join('')}</ul></div>` : ''}
    ${paid.length ? `<div class="card"><h3>Төлегендер (${paid.length})</h3><ul class="paylist">${paid.map(line).join('')}</ul></div>` : ''}
    <div class="card"><h3>Айлар бойынша түскен төлем</h3>
      ${monthRows ? `<ul class="paylist months">${monthRows}</ul>` : '<p class="muted">Әзірге төлем жазылмаған</p>'}
    </div>`;
}

let shown = '';
function currentId() {
  const m = location.hash.match(/^#\/s\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}
function render() {
  const id = currentId();
  const s = id && find(id);
  const view = s ? 'student' : location.hash === '#/settings' ? 'settings' : location.hash === '#/pay' ? 'pay' : 'list';
  if (id && !s) history.replaceState(null, '', '#/');
  for (const v of ['list', 'student', 'settings', 'pay']) $('v-' + v).hidden = v !== view;
  if (view === 'student') renderStudent(s);
  else if (view === 'settings') renderSettings();
  else if (view === 'pay') renderPay();
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
  const n = total(s);
  if (c.dates.length >= n) {
    const v = await sheet({
      title: `${s.name}: ${n} сабақ бітті`,
      text: 'Оқушы жаңа сабақтарға төледі ме?',
      buttons: [
        { label: `Төледі — жаңа ${n} сабаққа жаз`, value: 'paid', kind: 'primary' },
        { label: 'Әзірге төлемеді — артық сабақ деп жаз', value: 'extra' },
        CANCEL
      ]
    });
    if (v === 'paid') {
      const r = await askAmount(s);
      if (!r) return;
      act(`${s.name}: төледі (${paidText(r)}), жаңа цикл басталды`, () => { newCycle(s, r.amount); addDate(cur(s), t); });
    } else if (v === 'extra') {
      act(`${s.name}: артық сабақ жазылды`, () => addDate(c, t));
    }
    return;
  }
  act(`${s.name}: келді (${c.dates.length + 1}/${n})`, () => addDate(c, t));
}

async function onPay(s) {
  const st = stat(s);
  if (st.left > 0) {
    const v = await sheet({
      title: `${st.total} сабақ әлі біткен жоқ`,
      text: `${s.name} әзірге ${st.done}/${st.total} сабаққа келді. Сонда да жаңа циклді бастау керек пе? Қалған ${st.left} сабақ есептелмейді.`,
      buttons: [{ label: 'Иә, жаңа циклді баста', value: 'yes', kind: 'primary' }, CANCEL]
    });
    if (v !== 'yes') return;
  }
  const r = await askAmount(s);
  if (!r) return;
  act(`${s.name}: төледі (${paidText(r)}), жаңа цикл басталды`, () => newCycle(s, r.amount));
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

function backupFile() {
  const data = JSON.stringify({
    app: 'qatysym', version: 2, exported: new Date().toISOString(),
    lessons: clampN(state.meta.lessons), courses: state.courses, students: state.students
  }, null, 2);
  return new File([data], `qatysym-${today()}.json`, { type: 'application/json' });
}

/* ───────── Telegram боты: көшірмені өздігінен жіберу ─────────
   Кілт (token) тек осы құрылғыда сақталады, көшірме файлына кірмейді. */
const TG_DELAY = 30000; // соңғы өзгерістен кейін 30 секунд күтеді
let tgTimer = null;
let tgBusy = false;
const tgReady = () => !!(state.meta.tg && state.meta.tg.chatId);

async function tgCall(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, body ? { method: 'POST', body } : undefined);
  const j = await r.json().catch(() => null);
  if (!j || !j.ok) throw new Error((j && j.description) || `HTTP ${r.status}`);
  return j.result;
}

async function tgSend(manual = false) {
  const tg = state.meta.tg;
  if (!tgReady() || tgBusy) return false;
  clearTimeout(tgTimer);
  tgTimer = null;
  tgBusy = true;
  const sent = state.meta.unsaved || 0;
  try {
    const fd = new FormData();
    fd.append('chat_id', tg.chatId);
    fd.append('document', backupFile());
    fd.append('caption', `Қатысым — сақтық көшірме, ${fmtFull(today())}. Оқушы саны: ${state.students.length}`);
    fd.append('disable_notification', 'true');
    const msg = await tgCall(tg.token, 'sendDocument', fd);
    // Бір күнде бір ғана файл қалсын: сол күнгі алдыңғысын өшіреміз
    if (tg.lastMsg && tg.lastDay === today()) {
      const del = new FormData();
      del.append('chat_id', tg.chatId);
      del.append('message_id', tg.lastMsg);
      tgCall(tg.token, 'deleteMessage', del).catch(() => {});
    }
    tg.lastMsg = msg.message_id;
    tg.lastDay = today();
    tg.lastAt = Date.now();
    tg.error = '';
    state.meta.lastBackup = today();
    state.meta.unsaved = Math.max(0, (state.meta.unsaved || 0) - sent);
    save();
    if (manual) toast('Көшірме Telegram-ға жіберілді');
    if (shown !== 'student') render();
    return true;
  } catch (e) {
    tg.error = navigator.onLine === false ? 'интернет жоқ' : String((e && e.message) || e);
    save();
    if (manual) toast(`Telegram-ға жіберілмеді: ${tg.error}`);
    if (shown === 'settings') renderSettings();
    return false;
  } finally {
    tgBusy = false;
  }
}
function tgSchedule() {
  if (!tgReady()) return;
  clearTimeout(tgTimer);
  tgTimer = setTimeout(() => tgSend(), TG_DELAY);
}

async function tgConnect() {
  const token = $('tgToken').value.trim();
  if (!/^\d+:[\w-]{30,}$/.test(token)) return toast('Кілт дұрыс емес сияқты. BotFather берген кілтті толық көшіріңіз.');
  try {
    const me = await tgCall(token, 'getMe');
    state.meta.tg = { token, bot: me.username };
    save();
    renderSettings();
    toast(`Бот табылды: @${me.username}`);
  } catch (e) {
    toast(`Бот табылмады: ${navigator.onLine === false ? 'интернет жоқ' : e.message}`);
  }
}
async function tgFindChat() {
  const tg = state.meta.tg;
  if (!tg) return;
  try {
    const ups = await tgCall(tg.token, 'getUpdates');
    const m = ups.map((u) => u.message).filter((x) => x && x.chat && x.chat.type === 'private').pop();
    if (!m) return toast('Хабарлама табылмады. Ботты ашып, «Start» басыңыз да, қайта көріңіз.');
    tg.chatId = m.chat.id;
    tg.name = m.chat.first_name || '';
    save();
    renderSettings();
    await tgSend(true);
  } catch (e) {
    toast(`Қате: ${navigator.onLine === false ? 'интернет жоқ' : e.message}`);
  }
}
async function tgOff() {
  if (tgReady()) {
    const v = await sheet({
      title: 'Ботты ажырату керек пе?',
      text: 'Көшірме Telegram-ға өздігінен жіберілмейтін болады. Бұрын жіберілген файлдар Telegram-да қалады.',
      buttons: [{ label: 'Иә, ажырат', value: 'yes', kind: 'danger-fill' }, CANCEL]
    });
    if (v !== 'yes') return;
  }
  clearTimeout(tgTimer);
  delete state.meta.tg;
  save();
  renderSettings();
}
function renderTg() {
  if (document.activeElement && document.activeElement.id === 'tgToken') return;
  const tg = state.meta.tg;
  if (!tg) {
    $('tgBody').innerHTML = `
      <ol class="steps">
        <li>Telegram-да <b>@BotFather</b> ботын ашып, <b>/newbot</b> деп жазыңыз.</li>
        <li>Ботқа ат және <b>bot</b> деп аяқталатын пайдаланушы атын беріңіз.</li>
        <li>BotFather жіберген ұзын кілтті көшіріп, төменге қойыңыз.</li>
      </ol>
      <input id="tgToken" class="field" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
        placeholder="123456789:AAH..." aria-label="Бот кілті">
      <button type="button" class="btn block" data-act="tgconnect">Ботты тексеру</button>
      <p class="muted" style="margin-top:10px">Кілт тек осы телефонда сақталады. Оны ешкімге бермеңіз.</p>`;
  } else if (!tg.chatId) {
    $('tgBody').innerHTML = `
      <p class="info">Бот табылды: @${esc(tg.bot)}</p>
      <ol class="steps">
        <li><a href="https://t.me/${esc(tg.bot)}" target="_blank" rel="noopener">Ботты Telegram-да ашып</a>, <b>Start</b> басыңыз.</li>
        <li>Осы бетке қайтып, төмендегі батырманы басыңыз.</li>
      </ol>
      <button type="button" class="btn primary block" data-act="tgchat">Чатты табу және сынап жіберу</button>
      <button type="button" class="btn block" data-act="tgoff">Бас тарту</button>`;
  } else {
    const d = tg.lastAt ? new Date(tg.lastAt) : null;
    const when = d ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : 'әлі жоқ';
    $('tgBody').innerHTML = `
      <p class="info">Қосулы: @${esc(tg.bot)}${tg.name ? ` → ${esc(tg.name)}` : ''}</p>
      <p class="muted">Өзгеріс болған соң жарты минутта көшірме ботқа өзі жіберіледі. Соңғы жіберілгені: ${when}.</p>
      ${tg.error ? `<p class="unpaid">Соңғы әрекет сәтсіз: ${esc(tg.error)}. Интернет қосылғанда қайталанады.</p>` : ''}
      <button type="button" class="btn block" data-act="tgsend">Қазір жіберу</button>
      <button type="button" class="btn danger block" data-act="tgoff">Ботты ажырату</button>`;
  }
}

async function backup() {
  const file = backupFile();
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
  state.meta.unsaved = 0;
  save();
  render();
  toast('Көшірме дайын. Оны сенімді жерде сақтаңыз.');
}

function normalize(raw) {
  const list = Array.isArray(raw) ? raw : raw && raw.students;
  if (!Array.isArray(list)) throw new Error('format');
  const courses = (raw && Array.isArray(raw.courses) ? raw.courses : [])
    .filter((c) => c && typeof c.name === 'string' && c.name.trim())
    .map((c) => ({
      id: typeof c.id === 'string' && c.id ? c.id : newId(),
      name: c.name.trim().slice(0, 40),
      lessons: clampN(c.lessons),
      price: Math.max(0, Math.floor(Number(c.price)) || 0)
    }));
  const lessons = clampN(raw && raw.lessons);
  const students = list.map((s) => {
    if (!s || typeof s.name !== 'string' || !s.name.trim() || !Array.isArray(s.cycles)) throw new Error('format');
    const cycles = s.cycles.map((c) => {
      if (!c || !Array.isArray(c.dates)) throw new Error('format');
      const dates = [...new Set(c.dates.filter(isDate))].sort();
      const cycle = { start: isDate(c.start) ? c.start : dates[0] || today(), dates };
      if (c.paid && isDate(c.paid.date)) {
        cycle.paid = { date: c.paid.date, amount: Math.max(0, Math.floor(Number(c.paid.amount)) || 0) };
      }
      return cycle;
    });
    if (!cycles.length) cycles.push({ start: today(), dates: [] });
    const out = { id: typeof s.id === 'string' && s.id ? s.id : newId(), name: s.name.trim().slice(0, 60), cycles };
    if (courses.some((c) => c.id === s.course)) out.course = s.course;
    return out;
  });
  return { students, courses, lessons };
}

async function restore(file) {
  let data;
  try {
    data = normalize(JSON.parse(await file.text()));
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
    text: `Қазіргі деректер (${state.students.length} оқушы) файлдағы деректермен (${data.students.length} оқушы) толық алмастырылады.`,
    buttons: [{ label: 'Иә, алмастыр', value: 'yes', kind: 'primary' }, CANCEL]
  });
  if (v !== 'yes') return;
  act(`Қалпына келтірілді: ${data.students.length} оқушы`, () => {
    state.students = data.students;
    state.courses = data.courses;
    state.meta.lessons = data.lessons;
  });
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
  else if (a === 'course') { courseFilter = el.dataset.c; renderList(); }
  else if (a === 'addcourse') onEditCourse(null);
  else if (a === 'bulk') onBulk();
  else if (a === 'tgconnect') tgConnect();
  else if (a === 'tgchat') tgFindChat();
  else if (a === 'tgsend') tgSend(true);
  else if (a === 'tgoff') tgOff();
  else if (a === 'editcourse') { const c = state.courses.find((x) => x.id === el.dataset.id); if (c) onEditCourse(c); }
  else if (a === 'backup') backup();
  else if (a === 'restore') $('restoreFile').click();
  else if (!s) return;
  else if (a === 'pay') onPay(s);
  else if (a === 'setpay') onSetPay(s);
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
    // Сабақ түрі сүзгісі таңдалып тұрса, жаңа оқушы сол түрге қосылады
    const k = state.courses.find((c) => c.id === courseFilter);
    act(k ? `${name} қосылды (${k.name})` : `${name} қосылды`, () => {
      const s = { id: newId(), name, cycles: [{ start: today(), dates: [] }] };
      if (k) s.course = k.id;
      state.students.push(s);
    });
  } else if (e.target.id === 'addDateForm') {
    const s = find(currentId());
    if (s) onAddDate(s, $('missDate').value);
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'courseSel') {
    const s = find(currentId());
    if (!s) return;
    const k = state.courses.find((x) => x.id === e.target.value);
    act(k ? `${s.name}: ${k.name}` : `${s.name}: сабақ түрі алынды`, () => { if (k) s.course = k.id; else delete s.course; });
  } else if (e.target.id === 'defLessons') {
    const n = clampN(e.target.value.replace(/\D/g, ''));
    e.target.value = n;
    if (n === clampN(state.meta.lessons)) return;
    act(`Түрі жоқ оқушылар: ${n} сабақ`, () => { state.meta.lessons = n; });
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
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) render();
  // Қосымша жабылып бара жатса, күтіп тұрған көшірмені бірден жіберуге тырысамыз
  if (tgReady() && (state.meta.unsaved || 0) > 0) tgSend();
});
window.addEventListener('online', () => { if (tgReady() && (state.meta.unsaved || 0) > 0) tgSend(); });

/* ───────── Іске қосу ───────── */
async function init() {
  try {
    const saved = await dbGet('state');
    if (saved && Array.isArray(saved.students)) {
      state = saved;
      if (!Array.isArray(state.courses)) state.courses = [];
      state.meta = Object.assign({ created: today(), lastBackup: null }, saved.meta);
    } else {
      await dbSet('state', state); // бірінші ашылу: тізім бос
    }
  } catch (e) {
    render();
    toast('Қате: деректер қоймасы ашылмады');
    return;
  }
  render();
  if (tgReady() && (state.meta.unsaved || 0) > 0) tgSend(); // өткен жолы жіберілмей қалғаны

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
