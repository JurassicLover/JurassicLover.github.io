// Cliente mínimo de la API de Gemini (Google AI Studio).
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3-flash-preview'];

const SAFETY = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
  .map(category => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

export class GeminiError extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

function explain(status, body) {
  const msg = body?.error?.message || '';
  if (status === 400 && /api key/i.test(msg)) return new GeminiError('La clave de API no es válida. Revísala en Ajustes.', 'key', status);
  if (status === 403) return new GeminiError('Google rechazó la clave (permiso denegado). Crea una nueva en AI Studio.', 'key', status);
  if (status === 404) return new GeminiError('Ese modelo no está disponible para tu clave. Elige otro en Ajustes.', 'model', status);
  if (status === 429) return new GeminiError('Llegaste al límite del nivel gratuito. Espera un minuto e inténtalo de nuevo; si usas «Novela completa», cambia a «Fragmentos relevantes».', 'rate', status);
  if (status >= 500) return new GeminiError('Los servidores de Gemini no respondieron. Inténtalo de nuevo en un momento.', 'server', status);
  return new GeminiError(msg || `Error ${status} de Gemini.`, 'other', status);
}

async function post(url, key, body, signal) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new GeminiError('Sin conexión a internet, o Gemini no está accesible.', 'network');
  }
  if (!res.ok) {
    let b = null; try { b = await res.json(); } catch { /* */ }
    throw explain(res.status, b);
  }
  return res;
}

export async function listModels(key) {
  let res;
  try {
    res = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new GeminiError('Gemini no respondió en 20 segundos. Revisa tu conexión o prueba abrir la app desde Chrome.', 'timeout');
    throw new GeminiError('Sin conexión a internet, o el navegador bloqueó la conexión con Gemini.', 'network');
  }
  if (!res.ok) { let b = null; try { b = await res.json(); } catch { /* */ } throw explain(res.status, b); }
  const data = await res.json();
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name, input: m.inputTokenLimit }))
    .filter(m => /gemini/i.test(m.id) && !/(image|tts|audio|live|embedding|vision|robotics|computer|aqa)/i.test(m.id));
}

function buildBody({ system, contents, temperature, maxOutputTokens }) {
  const body = { contents, safetySettings: SAFETY, generationConfig: {} };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (temperature != null) body.generationConfig.temperature = temperature;
  if (maxOutputTokens) body.generationConfig.maxOutputTokens = maxOutputTokens;
  return body;
}

function textOf(resp) {
  const cand = resp?.candidates?.[0];
  return (cand?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
}

function blockReason(resp) {
  if (resp?.promptFeedback?.blockReason) return resp.promptFeedback.blockReason;
  const f = resp?.candidates?.[0]?.finishReason;
  if (f && ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'].includes(f)) return f;
  return null;
}

function blockedError(reason) {
  if (reason === 'RECITATION') return new GeminiError('Gemini cortó la respuesta porque iba a citar demasiado texto literal. Pídeselo con tus palabras o en un resumen.', 'blocked');
  return new GeminiError('Gemini bloqueó esta respuesta por sus filtros de contenido. Prueba a reformular la pregunta.', 'blocked');
}

// Combina la señal del usuario con un temporizador de inactividad.
function watchdog(userSignal, ms) {
  const ctl = new AbortController();
  let timedOut = false, timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms); };
  const onUser = () => ctl.abort();
  if (userSignal) { if (userSignal.aborted) ctl.abort(); else userSignal.addEventListener('abort', onUser, { once: true }); }
  arm();
  return {
    signal: ctl.signal, arm,
    done() { clearTimeout(timer); userSignal?.removeEventListener('abort', onUser); },
    wrap(e) {
      if (timedOut) return new GeminiError('Gemini tardó demasiado en responder. Inténtalo de nuevo; si se repite, elige otro modelo en Ajustes.', 'timeout');
      return e;
    },
  };
}

export async function generate(opts, timeoutMs = 120000) {
  const { key, model, signal } = opts;
  const w = watchdog(signal, timeoutMs);
  try {
    const res = await post(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, key, buildBody(opts), w.signal);
    const data = await res.json();
    const text = textOf(data);
    if (!text) { const r = blockReason(data); throw r ? blockedError(r) : new GeminiError('Gemini devolvió una respuesta vacía.', 'empty'); }
    return text;
  } catch (e) { throw w.wrap(e); }
  finally { w.done(); }
}

// Respuesta en streaming (SSE). onText recibe el texto acumulado.
// Si no llega nada en `idleMs`, se corta y se avisa con un error 'timeout'.
export async function stream(opts, onText, idleMs = 60000) {
  const { key, model, signal } = opts;
  const w = watchdog(signal, idleMs);
  let full = '', lastReason = null;
  try {
    const res = await post(`${BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, key, buildBody(opts), w.signal);
    w.arm();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      w.arm();
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json || json === '[DONE]') continue;
        let obj; try { obj = JSON.parse(json); } catch { continue; }
        if (obj.error) throw explain(obj.error.code || 500, obj);
        const t = textOf(obj);
        if (t) { full += t; onText(full); }
        lastReason = blockReason(obj) || lastReason;
      }
    }
  } catch (e) {
    const err = w.wrap(e);
    if (err.code === 'timeout' && full) return full + ' …';
    throw err;
  } finally { w.done(); }
  if (!full) throw lastReason ? blockedError(lastReason) : new GeminiError('Gemini devolvió una respuesta vacía.', 'empty');
  if (lastReason) full += '\n\n_(La respuesta se cortó por los filtros de Gemini.)_';
  return full;
}
