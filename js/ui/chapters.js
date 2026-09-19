import { db } from '../db.js';
import { escapeHtml, renderManuscript, toast, fmtDate, debounce, wordCount, openModal, closeModal, bus } from '../utils.js';
import { rewriteChapter, generateContinuityMemory } from '../memoryEngine.js';

bus.on('chapters-changed', () => {
  const root = document.getElementById('view-chapters');
  if (root && root.classList.contains('active')) renderChapters(root);
});

export async function renderChapters(root) {
  const chapters = (await db.getAll('chapters')).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  root.innerHTML = `
    <h2 class="section-title">Capítulos</h2>
    <p class="section-hint">Biblioteca de todos tus capítulos. Ábrelos para leer/editar, reescribirlos con instrucciones o duplicarlos.</p>
    <div id="chapters-list"></div>`;
  const list = document.getElementById('chapters-list');
  if (!chapters.length) { list.innerHTML = `<div class="empty"><span class="ic">📖</span>Todavía no tienes capítulos. Ve a «Escribir» para crear el primero.</div>`; return; }
  list.innerHTML = chapters.map((c) => `
    <div class="list-item" data-id="${c.id}">
      <div class="title-row"><b>${escapeHtml(c.title)}</b><span class="muted">${c.wordCount || 0} palabras</span></div>
      <div class="chip-row">
        <span class="pill ${c.status === 'finished' ? 'pill-active' : 'pill-inactive'}">${c.status === 'finished' ? 'Terminado' : 'Borrador'}</span>
        ${c.versions?.length ? `<span class="pill pill-reference">${c.versions.length} versión(es) anterior(es)</span>` : ''}
        <span class="muted">${fmtDate(c.updatedAt)}</span>
      </div>
      <div class="btn-row">
        <button class="btn btn-ghost btn-sm act-open">Abrir/editar</button>
        <button class="btn btn-ghost btn-sm act-rewrite">Reescribir</button>
        <button class="btn btn-ghost btn-sm act-memory">🧠 Crear/actualizar memoria</button>
        <button class="btn btn-ghost btn-sm act-duplicate">Duplicar</button>
        <button class="btn btn-danger btn-sm act-delete">Eliminar</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('.list-item').forEach((el) => {
    const id = el.dataset.id;
    el.querySelector('.act-open').addEventListener('click', () => openChapterEditor(id));
    el.querySelector('.act-rewrite').addEventListener('click', () => openRewriteModal(id));
    el.querySelector('.act-memory').addEventListener('click', () => createChapterMemory(id, el));
    el.querySelector('.act-duplicate').addEventListener('click', () => duplicateChapter(id));
    el.querySelector('.act-delete').addEventListener('click', () => deleteChapter(id, root));
  });
}

async function createChapterMemory(id, card) {
  const chapter = await db.get('chapters', id);
  if (!chapter?.content?.trim()) return toast('Este capítulo no tiene texto para resumir.', { error:true });
  const gen = await db.get('generationState', id);
  if (gen && gen.status !== 'completed' && gen.status !== 'discarded') {
    if (!confirm('Este capítulo tiene un borrador de generación sin terminar. ¿Crear una memoria provisional con lo escrito hasta ahora?')) return;
  }
  const button = card.querySelector('.act-memory');
  if (button) { button.disabled = true; button.textContent = '🧠 Preparando memoria…'; }
  try {
    const result = await generateContinuityMemory(chapter);
    if (result.ok) toast('Memoria de continuidad guardada. Revísala en Memoria → Continuidad.', { ms:6000 });
    else toast('No se guardó memoria: ' + result.error, { error:true, ms:10000 });
  } catch (e) {
    toast('No se pudo guardar la memoria: ' + e.message, { error:true, ms:10000 });
  } finally {
    if (button) { button.disabled = false; button.textContent = '🧠 Crear/actualizar memoria'; }
  }
}

async function openChapterEditor(id) {
  const chapter = await db.get('chapters', id); if (!chapter) return;
  const autosave = debounce(async (content) => {
    const fresh = await db.get('chapters', id); fresh.content = content; fresh.wordCount = wordCount(content); fresh.updatedAt = new Date().toISOString(); await db.put('chapters', fresh);
    const badge = document.getElementById('editor-save-badge'); if (badge) badge.textContent = 'Guardado ✓ ' + new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    bus.emit('chapters-changed');
  }, 700);
  openModal(`
    <div class="paper" style="padding:20px;">
      <div class="card-row"><input type="text" id="editor-title" value="${escapeHtml(chapter.title)}" style="font-family:'Cormorant Garamond',serif; font-size:20px; border:none; background:transparent; padding:0;"><span class="muted" id="editor-save-badge">Guardado ✓</span></div>
      <hr><div class="paper-readonly manuscript-rendered" id="editor-reading">${renderManuscript(chapter.content)}</div><textarea class="paper-text" id="editor-content" rows="18" style="display:none;">${escapeHtml(chapter.content)}</textarea>
    </div>
    <div class="btn-row"><button class="btn btn-primary" id="editor-mode-toggle">✏️ Editar texto</button><button class="btn btn-ghost" id="editor-close-btn">Cerrar</button><span class="muted" style="align-self:center;" id="editor-wc">${wordCount(chapter.content)} palabras</span></div>`);
  document.getElementById('editor-content').addEventListener('input', (e) => { document.getElementById('editor-wc').textContent = wordCount(e.target.value) + ' palabras'; document.getElementById('editor-save-badge').textContent = 'Guardando…'; autosave(e.target.value); });
  // La edición conserva Markdown como texto original; lectura lo presenta con formato.
  document.getElementById('editor-mode-toggle').addEventListener('click', (e) => {
    const source = document.getElementById('editor-content');
    const preview = document.getElementById('editor-reading');
    const toEdit = source.style.display === 'none';
    source.style.display = toEdit ? 'block' : 'none';
    preview.style.display = toEdit ? 'none' : 'block';
    if (!toEdit) preview.innerHTML = renderManuscript(source.value);
    e.currentTarget.textContent = toEdit ? '📖 Vista de lectura' : '✏️ Editar texto';
    if (toEdit) source.focus();
  });
  document.getElementById('editor-title').addEventListener('change', async (e) => { const fresh = await db.get('chapters', id); fresh.title = e.target.value.trim() || fresh.title; await db.put('chapters', fresh); bus.emit('chapters-changed'); });
  document.getElementById('editor-close-btn').addEventListener('click', closeModal);
}

async function openRewriteModal(id) {
  const chapter = await db.get('chapters', id);
  openModal(`
    <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700);">Reescribir «${escapeHtml(chapter.title)}»</h3>
    <p class="muted">La versión actual se conservará en el historial de versiones.</p>
    <label class="field-label">Instrucciones de reescritura</label>
    <textarea id="rewrite-instructions" placeholder="Ej: Alarga la escena entre Levi y Erwin, añade más interioridad de Levi, mantén el resto igual."></textarea>
    <div class="btn-row"><button class="btn btn-primary" id="rewrite-go-btn">Reescribir con IA</button><button class="btn btn-ghost" id="rewrite-cancel-btn">Cancelar</button></div>
    <div id="rewrite-status" class="muted" style="margin-top:8px;"></div>`);
  document.getElementById('rewrite-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('rewrite-go-btn').addEventListener('click', async () => {
    const instructions = document.getElementById('rewrite-instructions').value.trim(); if (!instructions) return toast('Escribe qué quieres cambiar.', { error: true });
    const btn = document.getElementById('rewrite-go-btn'); btn.disabled = true; document.getElementById('rewrite-status').textContent = 'Reescribiendo…';
    const result = await rewriteChapter(chapter, instructions); btn.disabled = false;
    if (!result.ok) { document.getElementById('rewrite-status').textContent = '⚠️ ' + result.error; toast('No se guardó ningún cambio: la respuesta no fue válida.', { error: true }); return; }
    const fresh = await db.get('chapters', id); fresh.versions = fresh.versions || []; fresh.versions.push({ content: fresh.content, note: instructions, timestamp: new Date().toISOString() }); fresh.content = result.text; fresh.wordCount = wordCount(result.text); fresh.updatedAt = new Date().toISOString(); await db.put('chapters', fresh);
    toast('Capítulo reescrito. La versión anterior quedó guardada.'); closeModal(); bus.emit('chapters-changed');
  });
}

async function duplicateChapter(id) {
  const chapter = await db.get('chapters', id); const copy = { ...chapter, id: db.uid(), title: chapter.title + ' (copia)', versions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; await db.put('chapters', copy); toast('Capítulo duplicado.'); bus.emit('chapters-changed');
}

async function deleteChapter(id, root) {
  if (!confirm('¿Eliminar definitivamente este capítulo y su memoria de continuidad? Antes, exporta un backup si quieres conservarlo.')) return;
  await db.del('chapters', id);
  await db.del('generationState', id).catch(() => {});
  const memories = await db.getByIndex('memoryEntries', 'by_chapter', id);
  for (const memory of memories) await db.del('memoryEntries', memory.id);
  toast('Capítulo y su memoria eliminados.');
  renderChapters(root);
}
