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

export async function getActiveGenerationState() {
  const all = await db.getAll('generationState');
  return all.find((g) => g.status === 'in_progress' || g.status === 'paused_quota' || g.status === 'paused_network') || null;
}

export async function startOrResumeGeneration({ chapterId, chapterTitle, instructions, targetWords, onProgress, shouldStop }) {
  let state = await db.get('generationState', chapterId);
  if (!state) {
    state = {
      id: chapterId,
      chapterId,
      chapterTitle,
      instructions,
      targetWords,
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

    const recentExcerpt = state.accumulatedText ? state.accumulatedText.slice(-1400) : '';

    const systemPrompt = assembleSystemPrompt({
      lockedFacts,
      chapterInstructions: state.instructions,
      characters,
      memoryEntries,
      canonNotes,
      recentChapterExcerpt: recentExcerpt,
      retrievedChunks,
      extraGuidance: isFirstBlock
        ? `Este es el INICIO del capítulo "${state.chapterTitle}". Objetivo total del capítulo: ~${state.targetWords} palabras, generado en bloques. Escribe ahora el primer bloque de aproximadamente ${thisBlockTarget} palabras. No concluyas el capítulo todavía si quedan más palabras por escribir.`
        : `Continúa el capítulo EXACTAMENTE donde quedó el fragmento anterior (mostrado arriba), sin repetir texto ni resumir lo ya escrito. Escribe el siguiente bloque de aproximadamente ${thisBlockTarget} palabras.` +
          (isLastStretch ? ' Este es el ÚLTIMO bloque: dale un cierre de escena satisfactorio dentro de esta extensión.' : ' Aún no cierres el capítulo: quedan más bloques después de este.'),
    });

    const userPrompt = isFirstBlock
      ? `Escribe el primer bloque del capítulo siguiendo las instrucciones y el canon indicados en el sistema.`
      : `Continúa la narración desde donde terminó el fragmento anterior. No repitas lo ya narrado.`;

    onProgress?.({ phase: 'requesting', state });

    const result = await provider.generate({
      systemPrompt,
      userPrompt,
      maxOutputTokens: Math.round(thisBlockTarget * 2.4) + 200,
      temperature: 1.0,
    });

    if (!result.ok) {
      state.lastError = { type: result.errorType, message: result.errorMessage, at: new Date().toISOString() };
      if (result.errorType === 'quota') {
        state.status = 'paused_quota';
      } else if (result.errorType === 'network') {
        state.status = 'paused_network';
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
