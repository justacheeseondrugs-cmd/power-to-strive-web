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
  return all.filter((g) => ['in_progress','awaiting_review','review_target_reached'].includes(g.status) || g.status?.startsWith('paused_'))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
}

export async function startOrResumeGeneration({ chapterId, chapterTitle, instructions, targetWords, requiredEnding = '', scenePlan = [], sceneIndex, allowedCast = '', forbiddenCast = '', documentIds = [], reactionMode = true, blockNotes = '', onProgress, shouldStop }) {
  let state = await db.get('generationState', chapterId);
  if (!state) {
    state = {
      id: chapterId,
      chapterId,
      chapterTitle,
      instructions,
      targetWords,
      requiredEnding,
      scenePlan,
      sceneIndex: 0,
      allowedCast,
      forbiddenCast,
      documentIds,
      reactionMode,
      blockNotes,
      pendingText: '',
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
    if (state.status === 'awaiting_review') return state;
    state.status = 'in_progress';
    state.instructions = instructions || state.instructions;
    if (Number.isInteger(sceneIndex)) state.sceneIndex = sceneIndex;
    state.blockNotes = blockNotes || '';
    await db.put('generationState', state);
  }

  return runGenerationLoop(state, onProgress, shouldStop);
}

export async function runGenerationLoop(state, onProgress, shouldStop) {
  const settings = (await db.get('settings', 'main')) || {};
  const blockWords = settings.blockWordSize || DEFAULT_BLOCK_WORDS;
  const provider = getProvider(settings);

  const [lockedFacts, allCharacters, allMemoryEntries, canonNotes, allDocuments, allChunks] = await Promise.all([
    db.getAll('lockedFacts'),
    db.getAll('characters'),
    db.getAll('memoryEntries'),
    db.getAll('canonNotes'),
    db.getAll('documents'),
    db.getAll('docChunks'),
  ]);

  // A single API call produces one PENDING block. Never auto-append it:
  // the author must approve or edit each block before a follow-up API request.
  {
    const remaining = Math.max(1,state.targetWords - state.wordsSoFar);
    const thisBlockTarget = Math.min(blockWords, Math.max(remaining, Math.round(blockWords * .65)));
    const isFirstBlock = state.blocksDone === 0;
    const isLastStretch = remaining <= blockWords;

    const permittedNames = (state.allowedCast || '').split(/[,;\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const characters = allCharacters.filter((c) => permittedNames.includes(c.name.trim().toLowerCase()) && c.active !== false);
    const memoryEntries = allMemoryEntries.sort((a,b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .filter((m) => m.chapterId !== state.chapterId);
    const documents = allDocuments.filter((d) =>
      Array.isArray(state.documentIds) ? state.documentIds.includes(d.id) : true);
    const queryText = [state.instructions, state.allowedCast, memoryEntries.slice(-2).map((m) => m.events).join(' ')].join(' ');
    const safeDocuments = documents.filter((d) => d.type !== 'STYLE_ONLY');
    const retrievedChunks = getRelevantChunks(safeDocuments, allChunks, queryText, { context: 'chapter_generation' });
    // STYLE_ONLY source prose may contain foreign plot/character names. Never
    // send that source text into a scene-generation request.
    for (const doc of documents.filter((d) => d.type === 'STYLE_ONLY' && d.active !== false)) {
      retrievedChunks.push({ documentId:doc.id, document:doc,
        text:'Style notes supplied by author: '+(doc.useOnlyFor || 'novel-like rhythm and narration')+
        '. Do not import any plot, character, relationship, dialogue or event from this file.' });
    }

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
      state.reactionMode ? 'REACTION ROOM: write TWO living scenes unfolding together, not a separated episode followed by a roster of comments. Interleave timely viewers reactions at scene beats and within onscreen action. Let viewers respond to EACH OTHER across several turns, interrupt, argue, joke or go silent; not every viewer needs to speak. Every reaction changes a conversation or action. Do not use formulaic introduction phrases like Meanwhile in the reaction room, or literary-critic commentary about symbolism.' : 'Write only the narrative requested by the author.',
      'References contain background, not a new scene plan. Do not introduce unrelated characters, places or plotlines just because a reference mentions them. The author instructions and chapter-so-far control the current episode.',
      'Word count is a flexible target, not a reason to end before the author-requested final event. Pace the setup to leave time for the entire climax and cliffhanger.',
      'ALLOWED NAMED CAST FOR THIS CHAPTER: '+(state.allowedCast || '(none; ask the author for a cast)')+'. Do not introduce ANY other named person from a reference or another AU. Unnamed extras may appear only when the chapter instruction requires them.',
      state.forbiddenCast ? 'EXPLICITLY FORBIDDEN PEOPLE/CHARACTERS: '+state.forbiddenCast+'. These names must never appear in the NEW prose.' : '',
      Array.isArray(state.scenePlan) && state.scenePlan.length ? 'ORDERED STORY PLAN (each beat happens once):\n'+state.scenePlan.map((beat,i) => (i+1)+'. '+beat).join('\n')+'\nFOCUS FOR THIS BLOCK: scene '+(Math.min(state.scenePlan.length-1,Math.max(0,state.sceneIndex || 0))+1)+': '+state.scenePlan[Math.min(state.scenePlan.length-1,Math.max(0,state.sceneIndex || 0))]+'. Progress from here toward the later scenes, never jump backward.' : '',
      state.blockNotes ? 'AUTHOR CORRECTION FOR THIS BLOCK (obey exactly, never repeat an earlier bad draft): '+state.blockNotes : '',
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

    // Rechazar de forma verificable nombres que el autor haya prohibido.
    const forbidden = (state.forbiddenCast || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
    const escaped = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const leaks = forbidden.filter((name) => new RegExp('\\b'+escaped(name)+'\\b','i').test(result.text));
    if (leaks.length) {
      state.status = 'paused_error';
      state.lastError = {type:'cast',message:'The block included forbidden characters: '+leaks.join(', ')+'. It was not added to the chapter; revise your instructions and try again.',at:new Date().toISOString()};
      state.updatedAt = new Date().toISOString();
      await db.put('generationState',state);
      onProgress?.({phase:'error',state});
      return state;
    }

    // Guardar el bloque candidato por separado, para leer y EDITAR antes de
    // que se incorpore a la historia. Solo entonces podrá continuar el modelo.
    state.pendingText = result.text.trim();
    state.status = 'awaiting_review';
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    await db.put('generationState',state);
    onProgress?.({ phase:'block_ready',state });
    return state;
  }

  return state;
}

export async function approvePendingBlock(chapterId, editedText) {
  const state = await db.get('generationState',chapterId);
  if (!state || state.status !== 'awaiting_review') throw new Error('There is no block awaiting approval.');
  const content = String(editedText || '').trim();
  if (wordCount(content) < 15) throw new Error('This block is too short. Review it before saving.');
  state.accumulatedText += (state.accumulatedText ? '\n\n' : '') + content;
  state.wordsSoFar = wordCount(state.accumulatedText);
  state.blocksDone += 1;
  state.pendingText = '';
  state.status = state.wordsSoFar >= state.targetWords ? 'review_target_reached' : 'paused_review';
  state.updatedAt = new Date().toISOString();
  await db.put('generationState',state);
  const chapter = await db.get('chapters',chapterId);
  if (chapter) {
    chapter.content = state.accumulatedText;
    chapter.wordCount = state.wordsSoFar;
    chapter.updatedAt = state.updatedAt;
    await db.put('chapters',chapter);
  }
  return state;
}

export async function rejectPendingBlock(chapterId) {
  const state = await db.get('generationState',chapterId);
  if (!state || state.status !== 'awaiting_review') return null;
  state.pendingText = '';
  state.status = 'paused_review';
  state.updatedAt = new Date().toISOString();
  await db.put('generationState',state);
  return state;
}

export async function finishReviewedChapter(chapterId) {
  const state = await db.get('generationState',chapterId);
  if (!state || !state.wordsSoFar || state.pendingText) throw new Error('Primero aprueba el bloque pendiente.');
  state.status = 'completed';
  state.updatedAt = new Date().toISOString();
  await db.put('generationState',state);
  const chapter = await db.get('chapters',chapterId);
  if (chapter) { chapter.status='finished'; chapter.updatedAt=state.updatedAt; await db.put('chapters',chapter); }
  return state;
}

export async function discardGeneration(chapterId) {
  await db.del('generationState', chapterId);
}
