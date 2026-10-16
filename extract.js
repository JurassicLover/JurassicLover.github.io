// Extracción de texto de PDF (pdf.js, incluido en /lib) y de archivos de texto.
let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('./pdf.mjs').then(lib => {
      lib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs', import.meta.url).href;
      return lib;
    });
  }
  return pdfjsPromise;
}

const END_PUNCT = /[.!?¡¿:;…»"”’)\]—–-]$/;

function cleanPage(raw) {
  let lines = raw.split('\n').map(l => l.replace(/[ \t ]+/g, ' ').trim());
  // Quitar números de página sueltos al principio o final
  while (lines.length && /^\d{1,4}$/.test(lines[0])) lines.shift();
  while (lines.length && /^\d{1,4}$/.test(lines[lines.length - 1])) lines.pop();
  const out = [];
  let cur = '';
  for (const line of lines) {
    if (!line) { if (cur) { out.push(cur); cur = ''; } continue; }
    if (!cur) { cur = line; continue; }
    if (/[a-záéíóúñü]-$/i.test(cur) && /^[a-záéíóúñü]/.test(line)) {
      cur = cur.slice(0, -1) + line; // palabra cortada con guion
    } else if (END_PUNCT.test(cur) && (/^[A-ZÁÉÍÓÚÑ¿¡«"“—–-]/.test(line))) {
      out.push(cur); cur = line; // posible fin de párrafo
    } else {
      cur += ' ' + line;
    }
  }
  if (cur) out.push(cur);
  return out.join('\n\n');
}

function cleanName(fileName) {
  return fileName.replace(/\.(pdf|txt|md)$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function extractPdf(file, onProgress) {
  const lib = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await lib.getDocument({ data, isEvalSupported: false }).promise;
  let title = '', author = '';
  try {
    const meta = await doc.getMetadata();
    title = (meta.info?.Title || '').trim();
    author = (meta.info?.Author || '').trim();
  } catch { /* sin metadatos */ }
  if (!title || /^(untitled|microsoft word|documento|document\d*)/i.test(title) || /\.(docx?|pdf)$/i.test(title)) {
    title = cleanName(file.name);
  }
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let raw = '';
    let lastY = null;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const y = item.transform ? item.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !raw.endsWith('\n')) {
        // Salto de línea no marcado; un salto grande indica párrafo
        raw += Math.abs(y - lastY) > (item.height || 10) * 1.8 ? '\n\n' : '\n';
      }
      raw += item.str;
      if (item.hasEOL) raw += '\n';
      if (y !== null) lastY = y;
    }
    pages.push(cleanPage(raw));
    page.cleanup();
    onProgress?.(i / doc.numPages);
  }
  await doc.destroy();
  return { title, author, pages };
}

export async function extractText(file) {
  const text = (await file.text()).replace(/\r\n?/g, '\n');
  const paras = text.split(/\n{2,}/);
  const pages = [];
  let cur = '';
  for (const p of paras) {
    if (cur.length + p.length > 3000 && cur) { pages.push(cur.trim()); cur = ''; }
    cur += p.replace(/\n/g, ' ') + '\n\n';
  }
  if (cur.trim()) pages.push(cur.trim());
  return { title: cleanName(file.name), author: '', pages };
}
