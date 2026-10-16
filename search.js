// Fragmentación y búsqueda (BM25) sobre el texto de las novelas.
const STOP = new Set(`a al algo algun alguna algunas alguno algunos ante antes aqui asi aun aunque cada como con contra cual
cuales cuando de del desde donde dos el ella ellas ello ellos en entre era eran eres es esa esas ese eso esos esta estaba
estado estan estar estas este esto estos fue fueron fui ha habia han has hasta hay he la las le les lo los mas me mi mis
mucho muy nada ni no nos nosotros o otra otras otro otros para pero poco por porque que quien quienes se sea ser si sido
sin sobre su sus tambien te tengo ti tiene tienen todo todos tu tus un una unas uno unos usted ya yo the and of to in is it
dime cuentame sabes crees piensas puedes podrias quiero hablame habla sobre libro novela novelas capitulo parte pasa paso`.split(/\s+/));

export function normalize(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function stem(w) {
  if (w.length > 5 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

export function tokenize(s) {
  const m = normalize(s).match(/[a-z0-9]+/g) || [];
  const out = [];
  for (const w of m) if (w.length > 1 && !STOP.has(w)) out.push(stem(w));
  return out;
}

export function chunkBook(bookId, pages, target = 1200) {
  const chunks = [];
  let cur = '', start = 1;
  const flush = (pageNo) => {
    const t = cur.trim();
    if (t) chunks.push({ bookId, idx: chunks.length, text: t, pageStart: start, pageEnd: pageNo });
    cur = '';
  };
  pages.forEach((pageText, i) => {
    const pageNo = i + 1;
    const paras = pageText.split(/\n{2,}/);
    for (let p of paras) {
      p = p.trim();
      if (!p) continue;
      if (!cur) start = pageNo;
      // Párrafos enormes: cortar por oraciones
      if (p.length > target * 1.5) {
        const sentences = p.match(/[^.!?…]+[.!?…]+["»”]?\s*|[^.!?…]+$/g) || [p];
        for (const s of sentences) {
          if (cur.length + s.length > target && cur) { flush(pageNo); start = pageNo; }
          cur += s;
        }
        cur += '\n\n';
        continue;
      }
      if (cur.length + p.length > target && cur) { flush(pageNo); start = pageNo; }
      cur += p + '\n\n';
    }
  });
  flush(pages.length || 1);
  return chunks;
}

export class Index {
  constructor(chunks) {
    this.chunks = chunks;
    this.df = new Map();
    this.tf = [];
    this.len = [];
    let total = 0;
    for (const c of chunks) {
      const toks = tokenize(c.text);
      const m = new Map();
      for (const t of toks) m.set(t, (m.get(t) || 0) + 1);
      this.tf.push(m);
      this.len.push(toks.length);
      total += toks.length;
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.avg = total / Math.max(1, chunks.length);
    this.N = chunks.length;
  }

  // weighted: [{text, w}]
  search(weighted, boostBooks = new Set()) {
    const q = new Map();
    for (const { text, w } of weighted) for (const t of tokenize(text)) q.set(t, Math.max(q.get(t) || 0, w));
    if (!q.size) return [];
    const k1 = 1.2, b = 0.75;
    const scores = [];
    for (let i = 0; i < this.N; i++) {
      const tf = this.tf[i];
      let s = 0;
      for (const [t, w] of q) {
        const f = tf.get(t);
        if (!f) continue;
        const df = this.df.get(t);
        const idf = Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
        s += w * idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * this.len[i] / this.avg));
      }
      if (s > 0) {
        if (boostBooks.has(this.chunks[i].bookId)) s *= 1.35;
        scores.push([i, s]);
      }
    }
    scores.sort((a, b2) => b2[1] - a[1]);
    return scores.map(([i, s]) => ({ ...this.chunks[i], score: s }));
  }
}

// Elige fragmentos hasta un máximo, uniendo vecinos del mismo libro.
export function pickChunks(results, max) {
  const picked = results.slice(0, max);
  picked.sort((a, b) => a.bookId === b.bookId ? a.idx - b.idx : (a.bookId < b.bookId ? -1 : 1));
  const merged = [];
  for (const c of picked) {
    const last = merged[merged.length - 1];
    if (last && last.bookId === c.bookId && c.idx === last.idxEnd + 1) {
      last.text += '\n\n' + c.text; last.pageEnd = c.pageEnd; last.idxEnd = c.idx;
      last.score = Math.max(last.score, c.score);
    } else merged.push({ ...c, idxEnd: c.idx });
  }
  return merged;
}

// Búsqueda literal (sin tildes) para el buscador del estante.
export function findPhrase(books, textsById, query, limit = 60) {
  const q = normalize(query.trim());
  if (q.length < 2) return [];
  const hits = [];
  for (const book of books) {
    const t = textsById.get(book.id);
    if (!t) continue;
    for (let p = 0; p < t.pages.length && hits.length < limit; p++) {
      const page = t.pages[p];
      const norm = normalize(page); // NFD+sin tildes conserva longitudes casi siempre
      let from = 0, pos;
      while ((pos = norm.indexOf(q, from)) !== -1 && hits.length < limit) {
        let s = Math.max(0, pos - 70); const e = Math.min(page.length, pos + q.length + 90);
        if (s > 0) { const sp = page.indexOf(' ', s); if (sp > -1 && sp < pos) s = sp + 1; }
        hits.push({ book, page: p + 1, before: (s > 0 ? '…' : '') + page.slice(s, pos), match: page.slice(pos, pos + q.length), after: page.slice(pos + q.length, e) + (e < page.length ? '…' : '') });
        from = pos + q.length;
      }
    }
  }
  return hits;
}
