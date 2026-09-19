// generation.js — motor de generación de capítulos por bloques.
//
// Diseño para poder recuperarse tras cerrar la web, detener la generación o
// un error: el estado de generación (generationState) se guarda en
// IndexedDB DESPUÉS de cada bloque exitoso, nunca antes. Si el bloque en
// curso se pierde (la pestaña se cierra a mitad de una llamada a la API),
// al reanudar se retoma pidiendo el siguiente bloque a partir del último
// texto ya guardado — es decir, la recuperación es exacta a nivel de bloque,
// no a mitad de frase, porque no usamos streaming (streaming complicaría
// mucho la recuperación fiable sin un backend propio).

import { db } from './db.js';
import { getProvider } from './providers/index.js';
import { assembleSystemPrompt } from './canonGuard.js';
import { getRelevantChunks } from './retrieval.js';
import { wordCount } from './utils.js';

const DEFAULT_BLOCK_WORDS = 900;
const STORY_CONTEXT_CHAR_CAP = 55000; // Hasta aproximadamente 7k palabras.


export async function getActiveGenerationState() {
  const all = await db.getAll('generationState');
  return all.filter((g) => g.status === 'in_progress' || g.status?.startsWith('paused_'))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
}

export async function startOrResumeGeneration({ chapterId, chapterTitle, instructions, targetWords, requiredEnding = '', onProgress, shouldStop }) {
  let state = await db.get('generationState', chapterId);
  if (!state) {
    state = {
      id: chapterId,
      chapterId,
      chapterTitle,
      instructions,
      targetWords,
      requiredEnding,
      accumulatedText: '',
      wordsSoFar: 0,
      blocksDone: 0,
      status: 'in_progress',
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await db.put('generationState', state);
  } else {
    state.status = 'in_progress';
    state.instructions = instructions || state.instructions;
    await db.put('generationState', state);
  }

  return runGenerationLoop(state, onProgress, shouldStop);
}

export async function runGenerationLoop(state, onProgress, shouldStop) {
  const settings = (await db.get('settings', 'main')) || {};
  const blockWords = settings.blockWordSize || DEFAULT_BLOCK_WORDS;
  const provider = getProvider(settings);

  const [lockedFacts, characters, memoryEntries, canonNotes, documents, allChunks] = await Promise.all([
    db.getAll('lockedFacts'),
    db.getAll('characters'),
    db.getAll('memoryEntries'),
    db.getAll('canonNotes'),
    db.getAll('documents'),
    db.getAll('docChunks'),
  ]);

  while (state.wordsSoFar < state.targetWords) {
    if (shouldStop && shouldStop()) {
      state.status = 'paused_manual';
      state.updatedAt = new Date().toISOString();
      await db.put('generationState', state);
      onProgress?.({ phase: 'stopped', state });
      return state;
    }
    const remaining = state.targetWords - state.wordsSoFar;
    const thisBlockTarget = Math.min(blockWords, remaining);
    const isFirstBlock = state.blocksDone === 0;
    const isLastStretch = remaining <= blockWords;

    const queryText = [state.instructions, memoryEntries.slice(-2).map((m) => m.events).join(' ')].join(' ');
    const retrievedChunks = getRelevantChunks(documents, allChunks, queryText, { context: 'chapter_generation' });

    // No cortar el texto anterior a 1.400 caracteres: cada llamada debe ver
    // lo escrito en este mismo capítulo para no reiniciar escenas ya narradas.
    const chapterSoFar = state.accumulatedText.slice(-STORY_CONTEXT_CHAR_CAP);
    const progress = state.wordsSoFar / Math.max(state.targetWords, 1);
    const narrativePosition = isFirstBlock
      ? 'FIRST BLOCK: establish the initial scene; do not rush to the climax.'
      : isLastStretch || progress >= .82
        ? 'FINAL STRETCH: stop expanding the setup. Move directly toward the author-requested final scene and execute it fully. Close immediately after the specified cliffhanger.'
        : progress >= .60
          ? 'LATE MIDDLE: complete the ongoing conversation and make tangible progress toward the closing scene. No new subplot, character introductions or recaps.'
          : 'MIDDLE: continue from the precise last action and develop the NEXT unique event. Never replay a previous arrival, conversation or scream.';

    const extraGuidance = [
      'This request is ONE continuous chapter, NOT a fresh chapter per API call. All events in CHAPTER_SO_FAR have ALREADY HAPPENED. Return ONLY the next new prose, never a repeat or rephrasing.',
      'In reaction-room fiction, weave the watchers into the events throughout: allow spontaneous dialogue and interaction, not separate rounds of symbolic commentary.',
      'References contain background, not a new scene plan. Do not introduce unrelated characters, places or plotlines just because a reference mentions them. The author instructions and chapter-so-far control the current episode.',
      'Word count is a flexible target, not a reason to end before the author-requested final event. Pace the setup to leave time for the entire climax and cliffhanger.',
      narrativePosition,
      state.requiredEnding ? 'MANDATORY FINAL SCENE / LAST IMAGE: ' + state.requiredEnding + ' Complete the entire event before ending; do not stop at the first distant hint of it.' : '',
      isFirstBlock ? 'Write the FIRST approximately ' + thisBlockTarget + ' words of "' + state.chapterTitle + '". Do not end the chapter in this block.' : 'Write ONLY the NEXT approximately ' + thisBlockTarget + ' words from the last sentence. ' + (isLastStretch ? 'This is the final scene, not another setup.' : 'Keep moving toward the specified ending.'),
    ].filter(Boolean).join('\n\n');

    const systemPrompt = assembleSystemPrompt({
      lockedFacts,
      chapterInstructions: state.instructions,
      characters,
      memoryEntries,
      canonNotes,
      recentChapterExcerpt: '',
      retrievedChunks,
      extraGuidance,
    });

    const userPrompt = isFirstBlock
      ? 'BEGIN CHAPTER. Follow the author scene order and write ONLY the opening block as English novel prose.'
      : [
          'EXACT CHAPTER ALREADY WRITTEN. Do not rewrite, summarize, reproduce or restart any part:',
          '<CHAPTER_SO_FAR>',
          chapterSoFar,
          '</CHAPTER_SO_FAR>',
          'The chapter currently has ' + state.wordsSoFar + ' of approximately ' + state.targetWords + ' words. Begin the NEXT paragraph after the final sentence above, with no heading and no recap.',
          state.requiredEnding ? 'The author-required event to reach before ending is: ' + state.requiredEnding : '',
          narrativePosition,
          'Return ONLY new prose continuing from the final line of CHAPTER_SO_FAR.',
        ].filter(Boolean).join('\n\n');

    onProgress?.({ phase: 'requesting', state });

    const result = await provider.generate({
      systemPrompt,
      userPrompt,
      maxOutputTokens: Math.round(thisBlockTarget * 3.6) + 700,
      temperature: 1.0,
    });

    if (!result.ok) {
      state.lastError = { type: result.errorType, message: result.errorMessage, at: new Date().toISOString() };
      if (result.errorType === 'quota') {
        state.status = 'paused_quota';
      } else if (result.errorType === 'network') {
        state.status = 'paused_network';
      } else if (result.errorType === 'busy') {
        state.status = 'paused_busy';
      } else {
        state.status = 'paused_error';
      }
      state.updatedAt = new Date().toISOString();
      await db.put('generationState', state);
      onProgress?.({ phase: 'error', state, error: result });
      return state;
    }

    // Nunca se guarda nada que no sea prosa válida (ya filtrado por el proveedor).
    const separator = state.accumulatedText ? '\n\n' : '';
    state.accumulatedText += separator + result.text.trim();
    state.wordsSoFar = wordCount(state.accumulatedText);
    state.blocksDone += 1;
    state.status = 'in_progress';
    state.lastError = null;
    state.updatedAt = new Date().toISOString();

    // Checkpoint: se guarda INMEDIATAMENTE tras un bloque válido.
    await db.put('generationState', state);

    // Reflejar también en el capítulo en vivo, para que "Escribir" y "Capítulos" siempre coincidan.
    const chapter = await db.get('chapters', state.chapterId);
    if (chapter) {
      chapter.content = state.accumulatedText;
      chapter.wordCount = state.wordsSoFar;
      chapter.updatedAt = new Date().toISOString();
      await db.put('chapters', chapter);
    }

    onProgress?.({ phase: 'block_done', state });
  }

  state.status = 'completed';
  state.updatedAt = new Date().toISOString();
  await db.put('generationState', state);
  onProgress?.({ phase: 'completed', state });
  return state;
}

export async function discardGeneration(chapterId) {
  await db.del('generationState', chapterId);
}
