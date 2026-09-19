import { db } from './db.js';
import { getProvider } from './providers/index.js';
import { assembleSystemPrompt } from './canonGuard.js';
import { getRelevantChunks } from './retrieval.js';
import { isLikelyInvalidProse } from './providers/base.js';

const MEMORY_FIELDS = [
  ['EVENTS', 'events'],
  ['RELATIONSHIP_CHANGES', 'relationshipChanges'],
  ['NEW_FACTS', 'newFacts'],
  ['WHO_KNOWS_WHAT', 'whoKnowsWhat'],
  ['PHYSICAL_STATE', 'physicalState'],
  ['CURRENT_LOCATION_TIME', 'currentLocationTime'],
  ['OPEN_THREADS', 'openThreads'],
];

function parseMemoryResponse(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const obj = JSON.parse(jsonMatch[0]);
      const out = {};
      for (const [key, field] of MEMORY_FIELDS) out[field] = obj[key] || obj[field] || '';
      return out;
    }
  } catch { }
  const out = {};
  for (const [key, field] of MEMORY_FIELDS) {
    const rx = new RegExp(key.replace(/_/g, '[ _]?') + '\\s*[:\\-]\\s*(.+?)(?=\\n[A-Z_ ]+\\s*[:\\-]|$)', 'is');
    const m = text.match(rx);
    out[field] = m ? m[1].trim() : '';
  }
  return out;
}

export async function generateContinuityMemory(chapter) {
  const settings = (await db.get('settings', 'main')) || {};
  const provider = getProvider(settings);
  const [lockedFacts, characters, canonNotes, documents, allChunks] = await Promise.all([
    db.getAll('lockedFacts'), db.getAll('characters'), db.getAll('canonNotes'), db.getAll('documents'), db.getAll('docChunks'),
  ]);
  const retrievedChunks = getRelevantChunks(documents, allChunks, chapter.content, { context: 'memory_summary' });
  const systemPrompt = assembleSystemPrompt({
    lockedFacts,
    chapterInstructions: 'Analiza el capítulo completo proporcionado por el usuario y extrae, con precisión y sin inventar nada que no esté implícito en el texto, un resumen de continuidad estructurado.',
    characters, memoryEntries: [], canonNotes, recentChapterExcerpt: '', retrievedChunks,
    extraGuidance: `Responde EXCLUSIVAMENTE con un objeto JSON válido (sin markdown, sin texto fuera del JSON) con estas claves exactas: EVENTS, RELATIONSHIP_CHANGES, NEW_FACTS, WHO_KNOWS_WHAT, PHYSICAL_STATE, CURRENT_LOCATION_TIME, OPEN_THREADS. Cada valor es un string breve (1-4 frases). Si una categoría no aplica en este capítulo, usa un string vacío.`,
  });
  const userPrompt = `CAPÍTULO A ANALIZAR ("${chapter.title}"):\n\n${chapter.content}`;
  // En modelos de razonamiento, max_completion_tokens incluye también los
  // tokens de razonamiento; 900 puede agotarse antes de devolver el JSON.
  const reasoningModel = /^(?:gpt-5(?:[.-]|$)|o[134](?:[.-]|$))/i.test(provider.config?.model || '');
  const result = await provider.generate({ systemPrompt, userPrompt, maxOutputTokens: reasoningModel ? 4800 : 1200, temperature: 0.3 });
  if (!result.ok || isLikelyInvalidProse(result.text)) return { ok: false, error: result.errorMessage || 'No se pudo generar la memoria de continuidad.' };
  const fields = parseMemoryResponse(result.text);
  if (!Object.values(fields).some((value) => String(value || '').trim())) {
    return { ok: false, error: 'La IA no devolvió un resumen de continuidad reconocible. No se ha guardado una memoria vacía.' };
  }
  // Rehacer una memoria sustituye la anterior del MISMO capítulo, sin duplicarla.
  const previous = await db.getByIndex('memoryEntries', 'by_chapter', chapter.id);
  const entry = {
    id: previous[0]?.id || db.uid(),
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    ...fields,
    createdAt: new Date().toISOString(),
  };
  const saved = await db.put('memoryEntries', entry);
  for (const duplicate of previous.slice(1)) await db.del('memoryEntries', duplicate.id);
  return { ok: true, entry: saved };
}

export async function rewriteChapter(chapter, rewriteInstructions) {
  const settings = (await db.get('settings', 'main')) || {};
  const provider = getProvider(settings);
  const [lockedFacts, characters, memoryEntries, canonNotes, documents, allChunks] = await Promise.all([
    db.getAll('lockedFacts'), db.getAll('characters'), db.getAll('memoryEntries'), db.getAll('canonNotes'), db.getAll('documents'), db.getAll('docChunks'),
  ]);
  const queryText = rewriteInstructions + ' ' + chapter.title;
  const retrievedChunks = getRelevantChunks(documents, allChunks, queryText, { context: 'rewrite' });
  const systemPrompt = assembleSystemPrompt({
    lockedFacts,
    chapterInstructions: `Vas a REESCRIBIR un capítulo existente según instrucciones del autor. Instrucciones de reescritura: ${rewriteInstructions}`,
    characters, memoryEntries, canonNotes, recentChapterExcerpt: '', retrievedChunks,
    extraGuidance: 'Devuelve el capítulo reescrito completo, en prosa, sin comentarios meta ni explicaciones fuera del propio texto narrativo.',
  });
  const userPrompt = `CAPÍTULO ORIGINAL:\n\n${chapter.content}\n\n---\n\nReescribe este capítulo aplicando las instrucciones indicadas, conservando lo que no se pidió cambiar.`;
  const result = await provider.generate({ systemPrompt, userPrompt, maxOutputTokens: 4000, temperature: 1.0 });
  if (!result.ok || isLikelyInvalidProse(result.text)) return { ok: false, error: result.errorMessage || 'La reescritura no devolvió prosa válida; no se guardó ningún cambio.' };
  return { ok: true, text: result.text.trim() };
}
