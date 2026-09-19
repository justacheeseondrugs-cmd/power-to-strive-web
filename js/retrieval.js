// retrieval.js — trocea documentos y recupera sólo los fragmentos relevantes,
// en vez de enviar archivos completos en cada request. La puntuación es un
// solape de términos simple (suficiente para un uso personal, sin backend).

const CHUNK_WORDS = 260;
const MAX_TOTAL_CHUNKS = 14;
const MAX_CHUNKS_PER_DOC_SMART = 3;
const MAX_CHUNKS_PER_DOC_ALWAYS = 6;

const STOPWORDS = new Set('de la que el en y a los se del las un por con no una su para es al lo como más o pero sus le ya o fue este ha sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mi mis tú te ti tu tus ellas nosotras vosotros vosotras os mío mía míos mías tuyo tuya tuyos tuyas suyo suya suyos suyas the of and to in a is that it for on with as was were are be this his her she he him they them their'.split(' '));

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-záéíóúñü0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

export function chunkText(text, documentId, chunkWords = CHUNK_WORDS) {
  const words = (text || '').split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += chunkWords) {
    const slice = words.slice(i, i + chunkWords).join(' ');
    chunks.push({
      id: undefined, // lo asigna la capa db al guardar
      documentId,
      index: chunks.length,
      text: slice,
      wordCount: Math.min(chunkWords, words.length - i),
    });
  }
  if (chunks.length === 0 && text) {
    chunks.push({ documentId, index: 0, text, wordCount: words.length });
  }
  return chunks;
}

function scoreChunk(chunkTokens, queryTokenCounts) {
  if (!chunkTokens.length) return 0;
  let score = 0;
  const seen = new Set();
  for (const t of chunkTokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (queryTokenCounts[t]) score += queryTokenCounts[t];
  }
  return score / Math.sqrt(chunkTokens.length);
}

/**
 * @param context {String} contexto de uso actual: 'chapter_generation' | 'rewrite' | 'memory_summary'
 */
function isAllowedForContext(doc, context) {
  if (doc.active === false) return false;
  const never = (doc.neverUseFor || '').toLowerCase();
  if (context && never && never.split(',').map((s) => s.trim()).some((tag) => tag && context.includes(tag))) {
    return false;
  }
  return true;
}

/**
 * Selecciona los fragmentos más relevantes de todos los documentos activos.
 * documents: [{id, filename, type, active, inclusion, useOnlyFor, neverUseFor, ...}]
 * allChunks: [{id, documentId, index, text, wordCount}]
 * queryText: instrucciones del capítulo + memoria reciente + nombres de personajes en escena
 */
export function getRelevantChunks(documents, allChunks, queryText, { context = 'chapter_generation' } = {}) {
  const queryTokens = tokenize(queryText);
  const queryCounts = {};
  for (const t of queryTokens) queryCounts[t] = (queryCounts[t] || 0) + 1;

  const chunksByDoc = {};
  for (const c of allChunks) (chunksByDoc[c.documentId] ||= []).push(c);

  const selected = [];
  for (const doc of documents) {
    if (!isAllowedForContext(doc, context)) continue;
    const docChunks = (chunksByDoc[doc.id] || []).slice().sort((a, b) => a.index - b.index);
    if (!docChunks.length) continue;

    if (doc.inclusion === 'ALWAYS') {
      const capped = docChunks.slice(0, MAX_CHUNKS_PER_DOC_ALWAYS);
      for (const c of capped) selected.push({ ...c, document: doc, score: 999 });
    } else {
      // SMART: puntuar y quedarnos con los mejores de este documento
      const scored = docChunks.map((c) => ({ ...c, document: doc, score: scoreChunk(tokenize(c.text), queryCounts) }));
      scored.sort((a, b) => b.score - a.score);
      const top = scored.filter((c) => c.score > 0).slice(0, MAX_CHUNKS_PER_DOC_SMART);
      // si nada puntuó (documento corto/consulta pobre en términos), incluir al menos el primero
      if (top.length === 0) top.push(scored[0]);
      selected.push(...top);
    }
  }

  selected.sort((a, b) => (b.document.priority || 0) - (a.document.priority || 0) || b.score - a.score);
  return selected.slice(0, MAX_TOTAL_CHUNKS);
}
