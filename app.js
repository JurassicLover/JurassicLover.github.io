import * as db from './db.js';
import { extractPdf, extractText } from './extract.js';
import { chunkBook, Index, pickChunks, findPhrase, tokenize, normalize } from './search.js';
import * as gemini from './gemini.js';
import { PRESETS } from './personas.js';

/* ---------- Utilidades ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isTouch = matchMedia('(pointer: coarse)').matches;
const SPINE_COLORS = ['#7a2e3a', '#2e4a7a', '#3f6b4e', '#8a6a2e', '#5b3a72', '#2f6670', '#8c4a2f', '#46506e', '#6e2f57', '#3d5f3a'];
const FULL_LIMIT = 2_800_000; // caracteres (~700 mil tokens)

function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function md(text) {
  // Markdown mínimo y seguro
  const lines = esc(text).split('\n');
  let html = '', list = null, para = [];
  const inline = s => s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?!\s)(.+?)_(?!\w)/g, '$1<em>$2</em>');
  const flushPara = () => { if (para.length) { html += `<p>${inline(para.join('<br>'))}</p>`; para = []; } };
  const flushList = () => { if (list) { html += `<${list.t}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.t}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { flushPara(); if (!list || list.t !== 'ul') { flushList(); list = { t: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { flushPara(); if (!list || list.t !== 'ol') { flushList(); list = { t: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^&gt;\s?(.*)/))) { flushPara(); flushList(); html += `<blockquote>${inline(m[1])}</blockquote>`; continue; }
    if ((m = line.match(/^#{1,4}\s+(.*)/)) || (m = line.match(/^\*\*([^*]+)\*\*:?$/))) { flushPara(); flushList(); html += `<h4>${inline(m[1])}</h4>`; continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList(); para.push(line);
  }
  flushPara(); flushList();
  return html;
}

/* ---------- Ajustes ---------- */
const DEFAULTS = {
  persona: { ...PRESETS[0] }, userNotes: '', apiKey: '', model: gemini.DEFAULT_MODEL, models: [],
  ctxMode: 'smart', k: 12, temperature: 0.9, autoFicha: true, reading: null, currentChat: null,
};
let settings = loadSettings();
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('margen.settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() { try { localStorage.setItem('margen.settings', JSON.stringify(settings)); } catch { /* */ } }

/* ---------- Estado ---------- */
let books = [];
const texts = new Map();
let indexCache = { key: '', index: null };

async function loadBooks() {
  books = (await db.all('books')).sort((a, b) => a.addedAt - b.addedAt);
}
async function getText(id) {
  if (!texts.has(id)) { const t = await db.get('texts', id); if (t) texts.set(id, t); }
  return texts.get(id);
}
function readingIds() {
  const ids = books.map(b => b.id);
  if (!settings.reading) return ids;
  return settings.reading.filter(id => ids.includes(id));
}
async function getIndex(ids) {
  const key = ids.slice().sort().join(',');
  if (indexCache.key === key && indexCache.index) return indexCache.index;
  let chunks = [];
  for (const id of ids) { const t = await getText(id); if (t) chunks = chunks.concat(chunkBook(id, t.pages)); }
  indexCache = { key, index: new Index(chunks) };
  return indexCache.index;
}
function invalidate() { indexCache = { key: '', index: null }; }

/* ---------- Navegación ---------- */
function showTab(name) {
  $$('.view').forEach(v => (v.hidden = v.dataset.view !== name));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  if (name === 'chat') { renderChatHeader(); if (!messages.length) renderMessages(); scrollMessages(); }
  if (name === 'settings') fillSettings();
}
$$('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));

/* ---------- Hoja inferior ---------- */
function openSheet(html, onMount) {
  $('#sheet-body').innerHTML = html;
  $('#sheet').hidden = false; $('#sheet-backdrop').hidden = false;
  onMount?.($('#sheet-body'));
}
function closeSheet() { $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true; }
$('#sheet-backdrop').addEventListener('click', closeSheet);

/* ---------- Estante ---------- */
function renderShelf() {
  const shelf = $('#shelf');
  $('#shelf-empty').hidden = books.length > 0;
  shelf.hidden = books.length === 0;
  const subset = settings.reading ? new Set(readingIds()) : null;
  shelf.innerHTML = books.map(b => {
    const w = Math.round(Math.min(58, Math.max(28, 26 + (b.pages || 50) / 12)));
    const h = 150 + (hash(b.id) % 42);
    const ribbon = subset && subset.has(b.id) ? '<span class="ribbon"></span>' : '';
    return `<div class="slot"><button class="spine${b.fichaStatus === 'working' ? ' busy' : ''}" style="--c:${b.color};width:${w}px;height:${h}px" data-book="${b.id}" aria-label="${esc(b.title)}">${ribbon}<span class="spine-title">${esc(b.title)}</span></button></div>`;
  }).join('');
}
$('#shelf').addEventListener('click', e => { const s = e.target.closest('.spine'); if (s) openBook(s.dataset.book); });
document.addEventListener('click', e => { if (e.target.closest('[data-action="add-books"]')) $('#file-input').click(); });

$('#file-input').addEventListener('change', async e => {
  const files = [...e.target.files]; e.target.value = '';
  if (files.length) await importFiles(files);
});

async function importFiles(files) {
  const box = $('#import-progress'), label = $('#import-label'), bar = $('#import-bar');
  box.hidden = false;
  const added = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    label.textContent = `Leyendo ${f.name} (${i + 1} de ${files.length})`;
    bar.style.width = '0%';
    try {
      const isPdf = /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name);
      const res = isPdf ? await extractPdf(f, p => (bar.style.width = `${Math.round(p * 100)}%`)) : await extractText(f);
      const chars = res.pages.reduce((n, p) => n + p.length, 0);
      if (books.concat(added).some(b => b.fileName === f.name && b.chars === chars)) {
        toast(`«${res.title}» ya está en tu estante.`); continue;
      }
      if (chars < 200) {
        toast(`«${f.name}» no tiene texto seleccionable (parece escaneado). No se pudo leer.`, 5000);
        continue;
      }
      const id = db.uid();
      const book = {
        id, title: res.title, author: res.author, fileName: f.name, addedAt: Date.now(), pages: res.pages.length,
        chars, color: SPINE_COLORS[(books.length + added.length) % SPINE_COLORS.length], ficha: null, fichaStatus: null,
      };
      await db.put('texts', { id, pages: res.pages });
      if (isPdf) await db.put('files', { id, blob: f });
      await db.put('books', book);
      texts.set(id, { id, pages: res.pages });
      added.push(book);
    } catch (err) {
      console.error(err);
      toast(`No se pudo leer «${f.name}». ¿Está protegido o dañado?`, 5000);
    }
  }
  box.hidden = true;
  await loadBooks(); invalidate();
  if (settings.reading && added.length) { settings.reading.push(...added.map(b => b.id)); saveSettings(); }
  renderShelf();
  if (added.length) {
    toast(added.length === 1 ? `«${added[0].title}» está en tu estante.` : `${added.length} novelas añadidas.`);
    if (settings.autoFicha && settings.apiKey) added.forEach(b => queueFicha(b.id));
  }
  requestPersist();
}

async function openBook(id) {
  const b = books.find(x => x.id === id); if (!b) return;
  const file = await db.get('files', id);
  const inReading = readingIds().includes(id);
  const fichaHtml = b.ficha ? `<div class="ficha">${md(b.ficha)}</div>`
    : b.fichaStatus === 'working' ? '<p class="hint">Creando la ficha de la novela…</p>'
      : b.fichaStatus === 'error' ? `<p class="hint">No se pudo crear la ficha: ${esc(b.fichaError || '')}</p>` : '';
  openSheet(`
    <h3>${esc(b.title)}</h3>
    <div class="meta">${b.author ? esc(b.author) + ' · ' : ''}${b.pages} páginas</div>
    <div class="actions">
      <button class="btn primary" data-a="read">Leer</button>
      <button class="btn" data-a="chat">Charlar sobre esta</button>
      ${file ? '<button class="btn" data-a="pdf">Abrir PDF</button>' : ''}
    </div>
    <label class="check"><input type="checkbox" data-a="reading" ${inReading ? 'checked' : ''}> Incluir en la charla</label>
    <label class="field">Título<input data-f="title" value="${esc(b.title)}"></label>
    <label class="field">Autor<input data-f="author" value="${esc(b.author || '')}" placeholder="Opcional"></label>
    <div class="actions">
      <button class="btn small" data-a="ficha">${b.ficha ? 'Rehacer ficha' : 'Crear ficha'}</button>
      <button class="btn small danger" data-a="delete">Quitar del estante</button>
    </div>
    ${fichaHtml}
  `, body => {
    body.addEventListener('change', async e => {
      const f = e.target.dataset.f;
      if (f) { b[f] = e.target.value.trim() || (f === 'title' ? b.fileName : ''); await db.put('books', b); renderShelf(); }
      if (e.target.dataset.a === 'reading') {
        let ids = readingIds();
        ids = e.target.checked ? [...new Set([...ids, id])] : ids.filter(x => x !== id);
        settings.reading = ids.length === books.length ? null : ids; saveSettings(); renderShelf(); renderChatHeader();
      }
    });
    body.addEventListener('click', async e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'read') { closeSheet(); openReader(id); }
      if (a === 'pdf') { const url = URL.createObjectURL(file.blob); const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
      if (a === 'chat') { settings.reading = [id]; saveSettings(); renderShelf(); closeSheet(); await newChat(); showTab('chat'); }
      if (a === 'ficha') {
        if (!settings.apiKey) { toast('Primero añade tu clave de Gemini en Ajustes.'); return; }
        closeSheet(); queueFicha(id); toast('Creando la ficha…');
      }
      if (a === 'delete') {
        if (!confirm(`¿Quitar «${b.title}» del estante? Se borra de este teléfono.`)) return;
        await db.deleteBook(id); texts.delete(id); invalidate();
        if (settings.reading) { settings.reading = settings.reading.filter(x => x !== id); saveSettings(); }
        await loadBooks(); renderShelf(); closeSheet(); toast('Novela quitada.');
      }
    });
  });
}

/* ---------- Fichas ---------- */
const fichaQueue = [];
let fichaBusy = false;
async function queueFicha(id) {
  if (!fichaQueue.includes(id)) fichaQueue.push(id);
  const b = books.find(x => x.id === id); if (b) { b.fichaStatus = 'working'; await db.put('books', b); renderShelf(); }
  if (!fichaBusy) runFichas();
}
async function runFichas() {
  fichaBusy = true;
  while (fichaQueue.length) {
    const id = fichaQueue.shift();
    const b = books.find(x => x.id === id); if (!b) continue;
    try {
      const t = await getText(id);
      let full = t.pages.map((p, i) => `[p. ${i + 1}]\n${p}`).join('\n\n');
      if (full.length > FULL_LIMIT) full = full.slice(0, FULL_LIMIT) + '\n[…texto truncado…]';
      const prompt = `A continuación tienes el texto completo de la novela «${b.title}»${b.author ? ' de ' + b.author : ''}. Escribe en español una ficha de referencia para otra IA que charlará sobre ella. Usa exactamente estos apartados, cada uno como título en negrita en su propia línea:\n\n**Resumen**\nDe 8 a 12 líneas que cubran toda la trama, incluido el final (con spoilers).\n\n**Personajes principales**\nLista con viñetas: nombre, papel en la historia, rasgos y relaciones clave.\n\n**Ambientación**\nDónde y cuándo transcurre.\n\n**Temas y tono**\nDos o tres líneas.\n\n**Momentos clave**\nLista en orden con la página aproximada entre paréntesis.\n\nNo añadas nada más.\n\n=== TEXTO ===\n${full}`;
      b.ficha = await gemini.generate({ key: settings.apiKey, model: settings.model, contents: [{ role: 'user', parts: [{ text: prompt }] }], temperature: 0.3 });
      b.fichaStatus = 'done'; b.fichaError = null;
    } catch (err) {
      b.fichaStatus = 'error'; b.fichaError = err.message;
      if (err.code === 'rate') toast('Límite gratuito alcanzado: la ficha quedó pendiente. Pruébala más tarde desde la novela.', 5000);
    }
    await db.put('books', b); renderShelf();
  }
  fichaBusy = false;
}

/* ---------- Lector ---------- */
async function openReader(id, page = 1, highlight = '') {
  const b = books.find(x => x.id === id); const t = await getText(id); if (!b || !t) return;
  $('#reader-title').textContent = b.title;
  const body = $('#reader-body');
  const hl = (s, i) => {
    const html = esc(s);
    if (!highlight || i + 1 !== page) return html;
    const q = normalize(highlight); const n = normalize(s); const pos = n.indexOf(q);
    if (pos < 0) return html;
    return esc(s.slice(0, pos)) + '<mark>' + esc(s.slice(pos, pos + q.length)) + '</mark>' + esc(s.slice(pos + q.length));
  };
  body.innerHTML = t.pages.map((p, i) => `<div class="page" id="pg-${i + 1}" data-p="${i + 1}">${hl(p, i)}</div><div class="page-no"><span>${i + 1}</span></div>`).join('');
  $('#reader').hidden = false;
  const target = $(`#pg-${page}`);
  if (target) { target.scrollIntoView(); if (page > 1 || highlight) target.classList.add('flash'); }
  const obs = new IntersectionObserver(entries => {
    for (const en of entries) if (en.isIntersecting) $('#reader-page').textContent = `p. ${en.target.dataset.p} de ${t.pages.length}`;
  }, { root: body, rootMargin: '0px 0px -70% 0px' });
  $$('.page', body).forEach(p => obs.observe(p));
  readerObs?.disconnect(); readerObs = obs;
}
let readerObs = null;
$('#reader-close').addEventListener('click', () => { readerObs?.disconnect(); $('#reader').hidden = true; $('#reader-body').innerHTML = ''; });

/* ---------- Búsqueda en la biblioteca ---------- */
$('#btn-search-toggle').addEventListener('click', () => {
  const sb = $('#searchbar'); sb.hidden = !sb.hidden; if (!sb.hidden) $('#lib-search').focus();
});
let searchTimer;
$('#lib-search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = e.target.value;
    const out = $('#search-results');
    if (q.trim().length < 2) { out.innerHTML = ''; return; }
    for (const b of books) await getText(b.id);
    const hits = findPhrase(books, texts, q);
    out.innerHTML = hits.length ? hits.map((h, i) => `<button class="hit" data-i="${i}"><div class="hit-meta">${esc(h.book.title)} · p. ${h.page}</div><div class="hit-text">${esc(h.before)}<mark>${esc(h.match)}</mark>${esc(h.after)}</div></button>`).join('')
      : '<p class="hint" style="padding:10px 2px">No aparece en ninguna novela.</p>';
    out.onclick = ev => { const el = ev.target.closest('.hit'); if (!el) return; const h = hits[+el.dataset.i]; openReader(h.book.id, h.page, q); };
  }, 220);
});

/* ---------- Charla ---------- */
let currentChat = null;
let messages = [];
let abortCtl = null;

function renderChatHeader() {
  const p = settings.persona;
  $('#persona-avatar').textContent = p.emoji || '📖';
  $('#persona-name').textContent = p.name || 'Tu compañía';
  const ids = readingIds();
  $('#reading-chip').textContent = !books.length ? 'Sin novelas todavía'
    : !settings.reading ? `Leyendo: todas (${books.length})`
      : ids.length === 1 ? `Leyendo: ${books.find(b => b.id === ids[0])?.title}` : `Leyendo: ${ids.length} novelas`;
}

async function loadChat(id) {
  currentChat = id ? await db.get('chats', id) : null;
  messages = currentChat ? (await db.byIndex('messages', 'chatId', currentChat.id)).sort((a, b) => a.createdAt - b.createdAt) : [];
  settings.currentChat = currentChat?.id || null; saveSettings();
  renderMessages();
}
async function newChat() { currentChat = null; messages = []; settings.currentChat = null; saveSettings(); renderMessages(); }

function renderMessages() {
  const box = $('#messages');
  if (!messages.length) {
    const p = settings.persona;
    const first = books[0]?.title;
    const starters = books.length ? [
      first ? `¿Qué opinas de «${first}»?` : null,
      '¿Cuál es el personaje que más te gusta de lo que he subido y por qué?',
      'Recomiéndame qué escena releer esta noche.',
      'Cuéntame un poco de ti: ¿qué tipo de historias te enganchan?',
    ].filter(Boolean) : ['Cuéntame un poco de ti: ¿qué tipo de historias te enganchan?'];
    box.innerHTML = `<div class="chat-empty"><div class="big">${esc(p.emoji || '📖')}</div><h3>${esc(p.name || 'Hola')}</h3>
      <p>${books.length ? 'Pregúntame lo que quieras de tus novelas o simplemente charlemos.' : 'Añade tus novelas en el Estante para que pueda leerlas contigo.'}</p>
      ${settings.apiKey ? '' : '<p><button class="btn primary" id="go-settings">Conectar con Gemini</button></p>'}
      <div class="starters">${starters.map(s => `<button class="starter">${esc(s)}</button>`).join('')}</div></div>`;
    $$('.starter', box).forEach(b => b.addEventListener('click', () => { $('#input').value = b.textContent; send(); }));
    $('#go-settings', box)?.addEventListener('click', () => showTab('settings'));
    return;
  }
  box.innerHTML = '';
  messages.forEach((m, i) => box.appendChild(messageEl(m, i === messages.length - 1)));
  scrollMessages();
}

function messageEl(m, isLast) {
  const el = document.createElement('div');
  el.className = `msg ${m.role === 'user' ? 'user' : 'ai'}`;
  if (m.role === 'user') { el.textContent = m.text; return el; }
  el.innerHTML = md(m.text);
  if (m.sources?.length) el.appendChild(sourcesEl(m.sources));
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  actions.innerHTML = `<button data-x="copy">Copiar</button>${isLast ? '<button data-x="regen">Otra respuesta</button>' : ''}`;
  actions.addEventListener('click', async e => {
    const x = e.target.dataset.x;
    if (x === 'copy') { try { await navigator.clipboard.writeText(m.text); toast('Copiado.'); } catch { toast('No se pudo copiar.'); } }
    if (x === 'regen') regenerate();
  });
  el.appendChild(actions);
  return el;
}

function sourcesEl(sources) {
  const d = document.createElement('details');
  d.className = 'sources';
  d.innerHTML = `<summary>Consultó ${sources.length} ${sources.length === 1 ? 'pasaje' : 'pasajes'}</summary>` + sources.map((s, i) =>
    `<button class="src" data-i="${i}"><b>${esc(s.title)}</b>, p. ${s.pageStart}${s.pageEnd !== s.pageStart ? '–' + s.pageEnd : ''}<br>${esc(s.preview)}</button>`).join('');
  d.addEventListener('click', e => { const b = e.target.closest('.src'); if (!b) return; const s = sources[+b.dataset.i]; if (books.some(x => x.id === s.bookId)) openReader(s.bookId, s.pageStart); });
  return d;
}

function scrollMessages() { const b = $('#messages'); requestAnimationFrame(() => (b.scrollTop = b.scrollHeight)); }

function systemPrompt() {
  const p = settings.persona;
  const ids = new Set(readingIds());
  const lib = books.map(b => {
    let s = `- «${b.title}»${b.author ? ' de ' + b.author : ''} (${b.pages} págs.)${ids.has(b.id) ? ' [leyendo ahora]' : ''}`;
    if (b.ficha && ids.has(b.id)) s += `\n  Ficha:\n${b.ficha.split('\n').map(l => '    ' + l).join('\n')}`;
    return s;
  }).join('\n');
  return [
    `Eres ${p.name || 'una compañía de lectura'}. ${p.personality || ''}`.trim(),
    p.likes ? `Te gusta: ${p.likes}` : '',
    p.dislikes ? `No soportas: ${p.dislikes}` : '',
    p.style ? `Forma de hablar: ${p.style}` : '',
    settings.userNotes ? `Sobre la persona con la que hablas: ${settings.userNotes}` : '',
    'Contexto: charlas con esta persona dentro de Margen, una app donde guarda sus novelas. Con cada mensaje la app te pasa fragmentos de sus novelas relacionados con lo que dice; la persona no ve esos fragmentos.',
    books.length ? `Su biblioteca:\n${lib}` : 'Su biblioteca está vacía por ahora.',
    `Reglas:
- Mantente siempre en tu personaje. Tienes gustos y opiniones propias y los expresas con naturalidad.
- Responde en español, salvo que te escriban en otro idioma.
- Cuando hables del contenido de las novelas, básate en las fichas y los fragmentos. Si algo no aparece en ellos, dilo con naturalidad (por ejemplo, «no encuentro esa parte») en lugar de inventarlo. Puedes mencionar la página (p. 34) cuando ayude.
- Cita solo frases breves cuando sea útil; no copies párrafos enteros.
- Es un chat: respuestas de longitud natural, sin encabezados, salvo que te pidan un análisis detallado.`,
  ].filter(Boolean).join('\n\n');
}

async function buildContext(text) {
  const ids = readingIds();
  if (!ids.length) return { block: '', sources: [] };
  if (settings.ctxMode === 'full') {
    let total = 0; const parts = [];
    for (const id of ids) {
      const b = books.find(x => x.id === id); const t = await getText(id); if (!t) continue;
      const body = t.pages.map((p, i) => `[p. ${i + 1}] ${p}`).join('\n\n');
      total += body.length; parts.push(`=== «${b.title}» (texto completo) ===\n${body}`);
    }
    if (total <= FULL_LIMIT) return { block: parts.join('\n\n'), sources: [] };
    toast('Las novelas seleccionadas son demasiado largas para enviarlas completas; usé fragmentos.', 4000);
  }
  const index = await getIndex(ids);
  const earlier = messages.slice(0, -1).reverse();
  const prevUser = earlier.find(m => m.role === 'user')?.text || '';
  const prevAi = earlier.find(m => m.role === 'model')?.text || '';
  const qn = normalize(text);
  const boost = new Set(books.filter(b => ids.includes(b.id) && tokenize(b.title).some(t => t.length > 3 && qn.includes(t))).map(b => b.id));
  const results = index.search([{ text, w: 1 }, { text: prevUser, w: 0.45 }, { text: prevAi.slice(0, 600), w: 0.2 }], boost);
  const picked = pickChunks(results, settings.k);
  if (!picked.length) return { block: '', sources: [] };
  const titleOf = id => books.find(b => b.id === id)?.title || '';
  const block = picked.map(c => `--- «${titleOf(c.bookId)}», p. ${c.pageStart}${c.pageEnd !== c.pageStart ? '–' + c.pageEnd : ''} ---\n${c.text}`).join('\n\n');
  const sources = picked.slice().sort((a, b) => b.score - a.score).map(c => ({
    bookId: c.bookId, title: titleOf(c.bookId), pageStart: c.pageStart, pageEnd: c.pageEnd,
    preview: c.text.slice(0, 140).replace(/\s+/g, ' ') + (c.text.length > 140 ? '…' : ''),
  }));
  return { block, sources };
}

function setSending(on) {
  const b = $('#btn-send');
  b.classList.toggle('stop', on);
  b.setAttribute('aria-label', on ? 'Detener' : 'Enviar');
  b.innerHTML = on ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg>';
}

async function send(textArg) {
  if (abortCtl) { abortCtl.abort(); return; }
  const input = $('#input');
  const text = (textArg ?? input.value).trim();
  if (!text) return;
  if (!settings.apiKey) { toast('Añade tu clave de Gemini en Ajustes para charlar.'); showTab('settings'); return; }
  if (textArg == null) { input.value = ''; autosize(); }

  if (!currentChat) {
    currentChat = { id: db.uid(), title: text.slice(0, 48), createdAt: Date.now(), updatedAt: Date.now() };
    await db.put('chats', currentChat); settings.currentChat = currentChat.id; saveSettings();
  }
  const history = messages.slice(-20);
  let userMsg = messages[messages.length - 1];
  if (textArg == null || !userMsg || userMsg.role !== 'user') {
    userMsg = { id: db.uid(), chatId: currentChat.id, role: 'user', text, createdAt: Date.now() };
    await db.put('messages', userMsg); messages.push(userMsg);
  }
  renderMessages();

  const box = $('#messages');
  const live = document.createElement('div');
  live.className = 'msg ai';
  live.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  box.appendChild(live); scrollMessages();

  abortCtl = new AbortController(); setSending(true);
  let partial = '';
  let sources = [];
  try {
    const ctx = await buildContext(text);
    sources = ctx.sources;
    const prior = (history[history.length - 1]?.id === userMsg.id ? history.slice(0, -1) : history)
      .map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
    const finalText = ctx.block
      ? `[Fragmentos de la biblioteca relacionados con este mensaje; la persona no los ve]\n${ctx.block}\n[Fin de los fragmentos]\n\nMensaje de la persona:\n${text}`
      : text;
    const contents = [...prior, { role: 'user', parts: [{ text: finalText }] }];
    const full = await gemini.stream({
      key: settings.apiKey, model: settings.model, system: systemPrompt(), contents,
      temperature: settings.temperature, signal: abortCtl.signal,
    }, t => { partial = t; live.innerHTML = md(t); scrollMessages(); });
    await saveAi(full, sources);
  } catch (err) {
    if (err.name === 'AbortError') {
      if (partial) await saveAi(partial + ' …', sources); else live.remove();
    } else {
      live.className = 'msg ai error';
      live.innerHTML = `<b>No se pudo responder.</b> ${esc(err.message)}`;
      const retry = document.createElement('div'); retry.className = 'msg-actions';
      retry.innerHTML = '<button>Reintentar</button>';
      retry.firstChild.addEventListener('click', () => { live.remove(); send(text); });
      live.appendChild(retry);
    }
  } finally {
    abortCtl = null; setSending(false); scrollMessages();
  }
}

async function saveAi(text, sources) {
  const m = { id: db.uid(), chatId: currentChat.id, role: 'model', text, sources, createdAt: Date.now() };
  await db.put('messages', m); messages.push(m);
  currentChat.updatedAt = Date.now(); await db.put('chats', currentChat);
  renderMessages();
}

async function regenerate() {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'model') return;
  await db.del('messages', last.id); messages.pop();
  const lastUser = messages[messages.length - 1];
  if (lastUser?.role === 'user') send(lastUser.text);
}

function autosize() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(140, t.scrollHeight) + 'px'; }
$('#input').addEventListener('input', autosize);
$('#input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !isTouch) { e.preventDefault(); send(); } });
$('#composer').addEventListener('submit', e => { e.preventDefault(); send(); });
$('#btn-new-chat').addEventListener('click', () => { if (abortCtl) return; newChat(); });

$('#btn-chats').addEventListener('click', async () => {
  const chats = (await db.all('chats')).sort((a, b) => b.updatedAt - a.updatedAt);
  const fmt = ts => new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short' });
  openSheet(`<h3>Conversaciones</h3>
    <div class="actions"><button class="btn primary" data-new>Nueva conversación</button></div>
    ${chats.length ? chats.map(c => `<div class="list-item"><button class="chat-row grow${c.id === currentChat?.id ? ' current' : ''}" data-open="${c.id}"><div class="t">${esc(c.title)}</div><div class="s">${fmt(c.updatedAt)}</div></button><button class="icon-btn" data-del="${c.id}" aria-label="Borrar conversación"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button></div>`).join('') : '<p class="hint">Todavía no hay conversaciones.</p>'}`,
  body => body.addEventListener('click', async e => {
    if (e.target.closest('[data-new]')) { closeSheet(); newChat(); }
    const o = e.target.closest('[data-open]'); if (o) { closeSheet(); await loadChat(o.dataset.open); }
    const d = e.target.closest('[data-del]');
    if (d && confirm('¿Borrar esta conversación?')) {
      await db.deleteChat(d.dataset.del);
      if (currentChat?.id === d.dataset.del) newChat();
      d.closest('.list-item').remove();
    }
  }));
});

$('#reading-chip').addEventListener('click', () => {
  if (!books.length) { showTab('shelf'); return; }
  const ids = new Set(readingIds());
  openSheet(`<h3>¿Qué está leyendo?</h3><p class="meta">Solo consultará las novelas marcadas.</p>
    <div class="actions"><button class="btn small" data-all>Todas</button><button class="btn small" data-none>Ninguna</button></div>
    ${books.map(b => `<label class="list-item"><span class="dot" style="--c:${b.color}"></span><span class="grow"><span class="t" style="display:block">${esc(b.title)}</span><span class="s">${b.pages} págs.</span></span><input type="checkbox" value="${b.id}" ${ids.has(b.id) ? 'checked' : ''}></label>`).join('')}`,
  body => {
    const sync = () => {
      const sel = $$('input[type=checkbox]', body).filter(c => c.checked).map(c => c.value);
      settings.reading = sel.length === books.length ? null : sel; saveSettings(); renderChatHeader(); renderShelf();
    };
    body.addEventListener('change', sync);
    body.addEventListener('click', e => {
      if (e.target.closest('[data-all]')) { $$('input[type=checkbox]', body).forEach(c => (c.checked = true)); sync(); }
      if (e.target.closest('[data-none]')) { $$('input[type=checkbox]', body).forEach(c => (c.checked = false)); sync(); }
    });
  });
});

/* ---------- Ajustes ---------- */
function renderPresets() {
  $('#presets').innerHTML = PRESETS.map(p => `<button class="preset" type="button" data-k="${p.key}"><span class="e">${p.emoji}</span><span class="n">${esc(p.name)}</span><span class="d">${esc(p.blurb)}</span></button>`).join('');
}
$('#presets').addEventListener('click', e => {
  const b = e.target.closest('.preset'); if (!b) return;
  const p = PRESETS.find(x => x.key === b.dataset.k);
  const hasEdits = settings.persona.personality && !PRESETS.some(x => x.personality === settings.persona.personality);
  if (hasEdits && !confirm('Esto reemplaza la personalidad que escribiste. ¿Continuar?')) return;
  settings.persona = { ...p, name: p.key === 'blank' ? '' : p.name };
  saveSettings(); fillSettings(); renderChatHeader();
});

function fillModels() {
  const sel = $('#s-model');
  const list = settings.models?.length ? settings.models : gemini.FALLBACK_MODELS.map(id => ({ id, label: id }));
  const ids = list.map(m => m.id);
  if (!ids.includes(settings.model)) list.unshift({ id: settings.model, label: settings.model });
  sel.innerHTML = list.map(m => `<option value="${esc(m.id)}">${esc(m.label)}${m.label !== m.id ? ' (' + esc(m.id) + ')' : ''}</option>`).join('');
  sel.value = settings.model;
}

function fillSettings() {
  const p = settings.persona;
  $('#p-name').value = p.name || ''; $('#p-emoji').value = p.emoji || '';
  $('#p-personality').value = p.personality || ''; $('#p-likes').value = p.likes || '';
  $('#p-dislikes').value = p.dislikes || ''; $('#p-style').value = p.style || '';
  $('#p-user').value = settings.userNotes || '';
  $('#s-key').value = settings.apiKey || '';
  fillModels();
  $$('input[name=ctx]').forEach(r => (r.checked = r.value === settings.ctxMode));
  $('#s-k').value = settings.k; $('#s-k-val').textContent = settings.k;
  $('#s-temp').value = settings.temperature; $('#s-temp-val').textContent = settings.temperature;
  $('#s-autoficha').checked = settings.autoFicha;
  updateStorageInfo();
}

const personaFields = { 'p-name': 'name', 'p-emoji': 'emoji', 'p-personality': 'personality', 'p-likes': 'likes', 'p-dislikes': 'dislikes', 'p-style': 'style' };
Object.entries(personaFields).forEach(([id, f]) => $('#' + id).addEventListener('input', e => { settings.persona[f] = e.target.value; saveSettings(); renderChatHeader(); }));
$('#p-user').addEventListener('input', e => { settings.userNotes = e.target.value; saveSettings(); });
$('#s-key').addEventListener('change', e => { settings.apiKey = e.target.value.trim(); saveSettings(); if (settings.apiKey) testConnection(); });
$('#btn-key-show').addEventListener('click', e => { const k = $('#s-key'); k.type = k.type === 'password' ? 'text' : 'password'; e.target.textContent = k.type === 'password' ? 'Ver' : 'Ocultar'; });
$('#s-model').addEventListener('change', e => { settings.model = e.target.value; saveSettings(); });
$$('input[name=ctx]').forEach(r => r.addEventListener('change', () => { settings.ctxMode = r.value; saveSettings(); }));
$('#s-k').addEventListener('input', e => { settings.k = +e.target.value; $('#s-k-val').textContent = settings.k; saveSettings(); });
$('#s-temp').addEventListener('input', e => { settings.temperature = +e.target.value; $('#s-temp-val').textContent = settings.temperature; saveSettings(); });
$('#s-autoficha').addEventListener('change', e => { settings.autoFicha = e.target.checked; saveSettings(); });
$('#btn-test').addEventListener('click', () => { settings.apiKey = $('#s-key').value.trim(); saveSettings(); testConnection(); });

async function testConnection() {
  const st = $('#test-status');
  if (!settings.apiKey) { st.className = 'status bad'; st.textContent = 'Escribe tu clave primero.'; return; }
  st.className = 'status'; st.textContent = 'Probando…';
  try {
    const models = await gemini.listModels(settings.apiKey);
    if (models.length) {
      settings.models = models;
      if (!models.some(m => m.id === settings.model)) {
        const pick = gemini.FALLBACK_MODELS.find(id => models.some(m => m.id === id))
          || models.find(m => /flash/.test(m.id) && !/lite/.test(m.id))?.id || models[0].id;
        settings.model = pick;
      }
      saveSettings(); fillModels();
    }
    await gemini.generate({ key: settings.apiKey, model: settings.model, contents: [{ role: 'user', parts: [{ text: 'Responde solo: listo' }] }], maxOutputTokens: 400 });
    st.className = 'status ok'; st.textContent = `Conectado. Usando ${settings.model}.`;
    renderMessages();
    // Fichas pendientes de novelas añadidas sin clave
    if (settings.autoFicha) books.filter(b => !b.ficha && b.fichaStatus !== 'working').forEach(b => queueFicha(b.id));
  } catch (err) {
    st.className = 'status bad'; st.textContent = err.message;
  }
}

async function updateStorageInfo() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) $('#storage-info').textContent = `Todo se guarda en este teléfono. ${books.length} ${books.length === 1 ? 'novela' : 'novelas'}, ${(est.usage / 1048576).toFixed(1)} MB usados.`;
  } catch { /* */ }
}
async function requestPersist() { try { await navigator.storage?.persist?.(); } catch { /* */ } }

/* Respaldo */
function blobToBase64(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
}
$('#btn-export').addEventListener('click', async () => {
  const btn = $('#btn-export'); btn.disabled = true; btn.textContent = 'Preparando…';
  try {
    const { apiKey, models, ...safeSettings } = settings;
    const parts = ['{"app":"margen","version":1,"settings":', JSON.stringify(safeSettings)];
    for (const s of ['books', 'texts', 'chats', 'messages']) parts.push(`,"${s}":`, JSON.stringify(await db.all(s)));
    parts.push(',"files":[');
    const files = await db.all('files');
    for (let i = 0; i < files.length; i++) {
      parts.push((i ? ',' : '') + JSON.stringify({ id: files[i].id, type: files[i].blob.type || 'application/pdf', name: files[i].blob.name || '', data: await blobToBase64(files[i].blob) }));
    }
    parts.push(']}');
    const name = `margen-respaldo-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File(parts, name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Respaldo de Margen' }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) { toast('No se pudo exportar: ' + err.message, 4000); }
  finally { btn.disabled = false; btn.textContent = 'Exportar respaldo'; }
});
$('#btn-import').addEventListener('click', () => $('#backup-input').click());
$('#backup-input').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'margen') throw new Error('Ese archivo no es un respaldo de Margen.');
    if (!confirm('Se añadirán las novelas y conversaciones del respaldo (las que ya existen se reemplazan). ¿Continuar?')) return;
    for (const s of ['books', 'texts', 'chats', 'messages']) for (const v of data[s] || []) await db.put(s, v);
    for (const fl of data.files || []) {
      const bin = Uint8Array.from(atob(fl.data), c => c.charCodeAt(0));
      await db.put('files', { id: fl.id, blob: new File([bin], fl.name || 'novela.pdf', { type: fl.type }) });
    }
    const keep = { apiKey: settings.apiKey, models: settings.models };
    settings = { ...DEFAULTS, ...data.settings, ...keep }; saveSettings();
    texts.clear(); invalidate(); await loadBooks(); renderShelf(); fillSettings();
    await loadChat(settings.currentChat); toast('Respaldo importado.');
  } catch (err) { toast(err.message || 'No se pudo importar.', 4000); }
});
$('#btn-wipe').addEventListener('click', async () => {
  if (!confirm('¿Borrar todas las conversaciones? Tus novelas se quedan.')) return;
  await db.clear('messages'); await db.clear('chats'); newChat(); toast('Conversaciones borradas.');
});

/* ---------- Inicio ---------- */
async function init() {
  renderPresets();
  await loadBooks();
  // Fichas que quedaron a medias si se cerró la app
  for (const b of books) if (b.fichaStatus === 'working') { b.fichaStatus = null; await db.put('books', b); }
  renderShelf();
  await loadChat(settings.currentChat);
  renderChatHeader();
  if (books.length && settings.apiKey) showTab('chat');
}
init();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => { /* sin modo offline */ }));
}

// Para pruebas
window.__margen = { settings: () => settings, importFiles, buildContext, systemPrompt };
