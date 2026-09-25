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
  // La memoria DEBE resumir el manuscrito real, no historias de referencia.
  // No enviar documentos STYLE_ONLY ni otros textos al extractor: así no se
  // introducen personajes o sucesos ajenos en una continuidad aprobada.
  const retrievedChunks = [];
  const systemPrompt = assembleSystemPrompt({
    lockedFacts,
    chapterInstructions: 'Analyze the author's entire chapter and extract an accurate, structured continuity summary. Do not invent anything that is not supported by the chapter.',
    characters, memoryEntries: [], canonNotes, recentChapterExcerpt: '', retrievedChunks,
    extraGuidance: `Reply EXCLUSIVELY with a valid JSON object (no Markdown and no text outside the JSON) using exactly these keys: EVENTS, RELATIONSHIP_CHANGES, NEW_FACTS, WHO_KNOWS_WHAT, PHYSICAL_STATE, CURRENT_LOCATION_TIME, OPEN_THREADS. Write each value in English as a brief string (1–4 sentences). If a category does not apply in this chapter, use an empty string.`,
  });
  const userPrompt = `CHAPTER TO ANALYZE ("${chapter.title}"):\n\n${chapter.content}`;
  // En modelos de razonamiento, max_completion_tokens incluye también los
  // tokens de razonamiento; 900 puede agotarse antes de devolver el JSON.
  const reasoningModel = /^(?:gpt-5(?:[.-]|$)|o[134](?:[.-]|$))/i.test(provider.config?.model || '');
  const result = await provider.generate({ systemPrompt, userPrompt, maxOutputTokens: reasoningModel ? 4800 : 1200, temperature: 0.3 });
  if (!result.ok || isLikelyInvalidProse(result.text)) return { ok: false, error: result.errorMessage || 'Could not generate continuity memory.' };
  const fields = parseMemoryResponse(result.text);
  if (!Object.values(fields).some((value) => String(value || '').trim())) {
    return { ok: false, error: 'The AI did not return a usable continuity summary. No empty memory was saved.' };
  }
  // Rehacer una memoria sustituye la anterior del MISMO capítulo, sin duplicarla.
  const previous = await db.getByIndex('memoryEntries', 'by_chapter', chapter.id);
  const entry = {
    id: previous[0]?.id || db.uid(),
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    projectId: chapter.projectId || 'original',
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
  const retrievedChunks = getRelevantChunks(documents.filter((d) => d.type !== 'STYLE_ONLY'), allChunks, queryText, { context: 'rewrite' });
  const systemPrompt = assembleSystemPrompt({
    lockedFacts,
    chapterInstructions: `You will REWRITE an existing chapter following the author's instructions. Rewrite instructions: ${rewriteInstructions}`,
    characters, memoryEntries, canonNotes, recentChapterExcerpt: '', retrievedChunks,
    extraGuidance: 'Return the entire rewritten chapter as prose, preserving the original narrative language and without meta-commentary or explanations outside the story.',
  });
  const userPrompt = `ORIGINAL CHAPTER:\n\n${chapter.content}\n\n---\n\nRewrite this chapter following the instructions above. Preserve everything the author did not ask to change.`;
  const result = await provider.generate({ systemPrompt, userPrompt, maxOutputTokens: 4000, temperature: 1.0 });
  if (!result.ok || isLikelyInvalidProse(result.text)) return { ok: false, error: result.errorMessage || 'The rewrite did not return valid prose. No changes were saved.' };
  return { ok: true, text: result.text.trim() };
}
