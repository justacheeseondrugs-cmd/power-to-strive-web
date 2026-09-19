import { db } from '../db.js';
import { escapeHtml, toast, wordCount } from '../utils.js';
import { getActiveGenerationState, startOrResumeGeneration, discardGeneration } from '../generation.js';
import { generateContinuityMemory } from '../memoryEngine.js';
import { bus } from '../utils.js';

let stopRequested = false;
let isRunning = false;

export async function renderWrite(root) {
  const settings = await db.get('settings', 'main');
  const activeGen = await getActiveGenerationState();
  const hasKey = !!(settings?.apiKeys?.[settings.provider]);
  root.innerHTML = `
    <h2 class="section-title">Escribir</h2>
    <p class="section-hint">Indica qué debe pasar en la escena y deja que la IA escriba el capítulo por bloques, respetando el Canon Guard.</p>
    ${!hasKey ? `<div class="key-warning">No has configurado una API key todavía. Ve a <b>Ajustes</b> para añadir tu clave de ${settings?.provider === 'openai' ? 'OpenAI' : 'Gemini'}.</div>` : ''}
    <div id="gen-banner-slot"></div>
    <div class="card" id="write-form-card"><h3>Nuevo capítulo</h3><label class="field-label">Título del capítulo</label><input type="text" id="w-title" placeholder="Ej: Capítulo 7 — La sala de vigilancia" /><label class="field-label">¿Qué debe pasar? (instrucciones para este capítulo)</label><textarea id="w-instructions" placeholder="Ej: El grupo termina de ver el episodio 4. Levi se queda callada tras ver morir a Petra. Hange intenta distraer al grupo. Erwin observa a Levi de lejos, preocupado..."></textarea><div class="grid-2"><div><label class="field-label">Extensión objetivo</label><select id="w-words"><option value="3000">3000 palabras</option><option value="5000" selected>5000 palabras</option><option value="7000">7000 palabras</option></select></div><div><label class="field-label">&nbsp;</label><button class="btn btn-primary" id="w-generate-btn" style="width:100%" ${!hasKey ? 'disabled' : ''}>✒️ Escribir capítulo</button></div></div></div>
    <div class="card paper" id="w-paper-card" style="display:none;"><div class="paper-title" id="w-paper-title">—</div><div class="muted" id="w-paper-meta"></div><hr><div class="paper-readonly" id="w-paper-text"></div></div>`;
  document.getElementById('w-generate-btn')?.addEventListener('click', onGenerateClick);
  if (activeGen) { renderBanner(activeGen); if (activeGen.status !== 'completed') showPaper(activeGen); }
}
function renderBanner(state) {
  const slot = document.getElementById('gen-banner-slot'); if (!slot) return; if (!state || state.status === 'completed') { slot.innerHTML = ''; return; }
  const pct = Math.min(100, Math.round((state.wordsSoFar / state.targetWords) * 100));
  const statusLabel = { in_progress: isRunning ? 'Generando…' : '⏸ Interrumpido: puedes reanudar el borrador', paused_quota:'⏸ Pausado: límite de cuota (429) de la API alcanzado', paused_network:'⏸ Pausado: error de red', paused_busy:'⏸ Pausado: Gemini con alta demanda (503). Tu texto está guardado.', paused_error:'⏸ Pausado: revisa el error antes de reanudar', paused_manual:'⏸ Pausado manualmente' }[state.status] || state.status;
  const isError = state.status.startsWith('paused');
  slot.innerHTML = `<div class="banner ${isError ? 'error' : ''}"><div style="flex:1; min-width:200px;"><b>${escapeHtml(state.chapterTitle)}</b> · ${statusLabel}<div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div><div class="muted">${state.wordsSoFar} / ${state.targetWords} palabras · bloque ${state.blocksDone}</div>${state.lastError ? `<div class="muted">${escapeHtml(state.lastError.message)}</div>` : ''}</div><div class="btn-row" style="margin-top:0;">${state.status === 'in_progress' && isRunning ? `<button class="btn btn-ghost btn-sm" id="gen-stop-btn">Detener</button>` : `<button class="btn btn-primary btn-sm" id="gen-resume-btn">Reanudar borrador</button><button class="btn btn-danger btn-sm" id="gen-discard-btn">Descartar</button>`}</div></div>`;
  document.getElementById('gen-stop-btn')?.addEventListener('click', () => { stopRequested = true; toast('Se detendrá al terminar el bloque actual…'); });
  document.getElementById('gen-resume-btn')?.addEventListener('click', () => resumeGeneration(state));
  document.getElementById('gen-discard-btn')?.addEventListener('click', async () => { if (!confirm('¿Descartar este borrador de generación? El texto ya escrito permanecerá en el capítulo, pero no podrás continuar generando este bloque en curso.')) return; await discardGeneration(state.chapterId); renderBanner(null); });
}
function showPaper(state) { const card = document.getElementById('w-paper-card'); if (!card) return; card.style.display = 'block'; document.getElementById('w-paper-title').textContent = state.chapterTitle; document.getElementById('w-paper-meta').textContent = `${state.wordsSoFar} / ${state.targetWords} palabras`; document.getElementById('w-paper-text').textContent = state.accumulatedText || '(aún sin texto)'; }
async function onGenerateClick() {
  const title = document.getElementById('w-title').value.trim(); const instructions = document.getElementById('w-instructions').value.trim(); const targetWords = parseInt(document.getElementById('w-words').value, 10);
  if (!title) return toast('Ponle un título al capítulo.', { error: true }); if (!instructions) return toast('Escribe qué debe pasar en el capítulo.', { error: true });
  const previous = await getActiveGenerationState();
  if (previous) return toast('Ya tienes un borrador pendiente: pulsa Reanudar borrador o descártalo antes de crear otro capítulo.', { error: true, ms: 6000 });
  const chapters = await db.getAll('chapters'); const chapter = { id: db.uid(), title, content:'', wordCount:0, status:'draft', order:chapters.length, versions:[], createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() }; await db.put('chapters', chapter);
  await runGeneration({ chapterId: chapter.id, chapterTitle: title, instructions, targetWords });
}
async function resumeGeneration(state) { await runGeneration({ chapterId: state.chapterId, chapterTitle: state.chapterTitle, instructions: state.instructions, targetWords: state.targetWords }); }
async function runGeneration({ chapterId, chapterTitle, instructions, targetWords }) {
  if (isRunning) return toast('Ya hay una generación en curso.', { error: true }); isRunning = true; stopRequested = false; document.getElementById('w-generate-btn')?.setAttribute('disabled','true');
  const finalState = await startOrResumeGeneration({ chapterId, chapterTitle, instructions, targetWords, shouldStop: () => stopRequested, onProgress: ({ phase, state }) => { renderBanner(state); showPaper(state); } });
  isRunning = false; document.getElementById('w-generate-btn')?.removeAttribute('disabled');
  if (finalState.status === 'completed') { toast('¡Capítulo terminado! Generando memoria de continuidad…'); const chapter = await db.get('chapters', chapterId); if (chapter) { chapter.status = 'finished'; await db.put('chapters', chapter); const memResult = await generateContinuityMemory(chapter); if (memResult.ok) toast('Memoria de continuidad guardada.'); else toast('El capítulo se guardó, pero la memoria de continuidad falló: ' + memResult.error, { error: true, ms: 6000 }); } bus.emit('chapters-changed'); }
  else if (finalState.status.startsWith('paused')) toast('Generación en pausa. Puedes reanudarla cuando quieras — nada se ha perdido.', { ms: 5000 });
}
