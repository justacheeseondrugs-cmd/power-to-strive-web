import { db } from '../db.js';
import { escapeHtml, renderManuscript, toast, fmtDate, debounce, wordCount, openModal, closeModal, bus } from '../utils.js';
import { rewriteChapter, generateContinuityMemory } from '../memoryEngine.js';

function safeFilename(value, fallback = 'chapter') {
  const cleaned = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 100);
  return cleaned || fallback;
}

function downloadMarkdown(filename, markdown) {
  const blob = new Blob([String(markdown || '')], { type:'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.md') ? filename : filename + '.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function chapterAsMarkdown(chapter) {
  const title = String(chapter?.title || 'Untitled chapter').trim();
  const body = String(chapter?.content || '').trim();
  return '# ' + title + '\n\n' + body + '\n';
}

async function downloadChapterMarkdown(id) {
  const chapter = await db.get('chapters',id);
  if (!chapter) return toast('Chapter not found.',{error:true});
  downloadMarkdown(safeFilename(chapter.title,'chapter') + '.md', chapterAsMarkdown(chapter));
  toast('Chapter downloaded as .md · 0 AI tokens.');
}

async function downloadAllChaptersMarkdown(chapters) {
  if (!chapters.length) return toast('There are no chapters to download.',{error:true});
  const workspace = document.getElementById('workspace-label')?.textContent?.trim() || 'Inky Paws';
  const body = [
    '# ' + workspace,
    '',
    chapters.map((chapter) => chapterAsMarkdown(chapter).trim()).join('\n\n---\n\n'),
    ''
  ].join('\n');
  downloadMarkdown(safeFilename(workspace,'inky-paws') + ' - chapters.md', body);
  toast('All chapters downloaded in one .md file · 0 AI tokens.',{ms:6000});
}


bus.on('chapters-changed', () => {
  const root = document.getElementById('view-chapters');
  if (root && root.classList.contains('active')) renderChapters(root);
});

export async function renderChapters(root) {
  const chapters = (await db.getAll('chapters')).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  root.innerHTML = `
    <h2 class="section-title">Chapters</h2>
    <p class="section-hint">Your chapter library. Markdown files are created locally without any API calls or tokens.</p>
    <div class="btn-row chapter-export-row">
      <button class="btn btn-ghost" id="chapters-download-all">⬇️ Download all as .md</button>
    </div>
    <div id="chapters-list"></div>`;
  document.getElementById('chapters-download-all')?.addEventListener('click', () => downloadAllChaptersMarkdown(chapters));
  const list = document.getElementById('chapters-list');
  if (!chapters.length) { list.innerHTML = `<div class="empty"><span class="ic">📖</span>No chapters yet. Go to Write to create your first one.</div>`; return; }
  list.innerHTML = chapters.map((c) => `
    <div class="list-item" data-id="${c.id}">
      <div class="title-row"><b>${escapeHtml(c.title)}</b><span class="muted">${c.wordCount || 0} words</span></div>
      <div class="chip-row">
        <span class="pill ${c.status === 'finished' ? 'pill-active' : 'pill-inactive'}">${c.status === 'finished' ? 'Finished' : 'Draft'}</span>
        ${c.versions?.length ? `<span class="pill pill-reference">${c.versions.length} previous version(s)</span>` : ''}
        <span class="muted">${fmtDate(c.updatedAt)}</span>
      </div>
      <div class="btn-row">
        <button class="btn btn-ghost btn-sm act-open">Open / edit</button>
        <button class="btn btn-ghost btn-sm act-download">⬇️ .md</button>
        <button class="btn btn-ghost btn-sm act-rewrite">Rewrite</button>
        <button class="btn btn-ghost btn-sm act-memory">🧠 Create / update memory</button>
        <button class="btn btn-ghost btn-sm act-duplicate">Duplicate</button>
        <button class="btn btn-danger btn-sm act-delete">Delete</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('.list-item').forEach((el) => {
    const id = el.dataset.id;
    el.querySelector('.act-open').addEventListener('click', () => openChapterEditor(id));
    el.querySelector('.act-download').addEventListener('click', () => downloadChapterMarkdown(id));
    el.querySelector('.act-rewrite').addEventListener('click', () => openRewriteModal(id));
    el.querySelector('.act-memory').addEventListener('click', () => createChapterMemory(id, el));
    el.querySelector('.act-duplicate').addEventListener('click', () => duplicateChapter(id));
    el.querySelector('.act-delete').addEventListener('click', () => deleteChapter(id, root));
  });
}

async function createChapterMemory(id, card) {
  const chapter = await db.get('chapters', id);
  if (!chapter?.content?.trim()) return toast('This chapter has no text to summarize.', { error:true });
  const gen = await db.get('generationState', id);
  if (gen && gen.status !== 'completed' && gen.status !== 'discarded') {
    if (!confirm('This chapter has an unfinished generation draft. Create provisional continuity memory from the text saved so far?')) return;
  }
  const button = card.querySelector('.act-memory');
  if (button) { button.disabled = true; button.textContent = '🧠 Generating memory…'; }
  try {
    const result = await generateContinuityMemory(chapter);
    if (result.ok) toast('Continuity memory saved. Review it in Memory → Continuity.', { ms:6000 });
    else toast('Memory was not saved: ' + result.error, { error:true, ms:10000 });
  } catch (e) {
    toast('Could not save memory: ' + e.message, { error:true, ms:10000 });
  } finally {
    if (button) { button.disabled = false; button.textContent = '🧠 Create / update memory'; }
  }
}

async function openChapterEditor(id) {
  const chapter = await db.get('chapters', id); if (!chapter) return;
  const autosave = debounce(async (content) => {
    const fresh = await db.get('chapters', id); fresh.content = content; fresh.wordCount = wordCount(content); fresh.updatedAt = new Date().toISOString(); await db.put('chapters', fresh);
    const badge = document.getElementById('editor-save-badge'); if (badge) badge.textContent = 'Saved ✓ ' + new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    bus.emit('chapters-changed');
  }, 700);
  openModal(`
    <div class="paper" style="padding:20px;">
      <div class="card-row"><input type="text" id="editor-title" value="${escapeHtml(chapter.title)}" style="font-family:'Cormorant Garamond',serif; font-size:20px; border:none; background:transparent; padding:0;"><span class="muted" id="editor-save-badge">Saved ✓</span></div>
      <hr><div class="paper-readonly manuscript-rendered" id="editor-reading">${renderManuscript(chapter.content)}</div><textarea class="paper-text" id="editor-content" rows="18" style="display:none;">${escapeHtml(chapter.content)}</textarea>
    </div>
    <div class="btn-row"><button class="btn btn-primary" id="editor-mode-toggle">✏️ Edit text</button><button class="btn btn-ghost" id="editor-close-btn">Close</button><span class="muted" style="align-self:center;" id="editor-wc">${wordCount(chapter.content)} words</span></div>`);
  document.getElementById('editor-content').addEventListener('input', (e) => { document.getElementById('editor-wc').textContent = wordCount(e.target.value) + ' words'; document.getElementById('editor-save-badge').textContent = 'Saving…'; autosave(e.target.value); });
  // La edición conserva Markdown como texto original; lectura lo presenta con formato.
  document.getElementById('editor-mode-toggle').addEventListener('click', (e) => {
    const source = document.getElementById('editor-content');
    const preview = document.getElementById('editor-reading');
    const toEdit = source.style.display === 'none';
    source.style.display = toEdit ? 'block' : 'none';
    preview.style.display = toEdit ? 'none' : 'block';
    if (!toEdit) preview.innerHTML = renderManuscript(source.value);
    e.currentTarget.textContent = toEdit ? '📖 Reading view' : '✏️ Edit text';
    if (toEdit) source.focus();
  });
  document.getElementById('editor-title').addEventListener('change', async (e) => { const fresh = await db.get('chapters', id); fresh.title = e.target.value.trim() || fresh.title; await db.put('chapters', fresh); bus.emit('chapters-changed'); });
  document.getElementById('editor-close-btn').addEventListener('click', closeModal);
}

async function openRewriteModal(id) {
  const chapter = await db.get('chapters', id);
  openModal(`
    <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700);">Rewrite «${escapeHtml(chapter.title)}»</h3>
    <p class="muted">The current version will be kept in version history.</p>
    <label class="field-label">Rewrite instructions</label>
    <textarea id="rewrite-instructions" placeholder="Example: Extend the Levi–Erwin scene, add more of Levi's thoughts, and keep the rest unchanged."></textarea>
    <div class="btn-row"><button class="btn btn-primary" id="rewrite-go-btn">Rewrite with AI</button><button class="btn btn-ghost" id="rewrite-cancel-btn">Cancel</button></div>
    <div id="rewrite-status" class="muted" style="margin-top:8px;"></div>`);
  document.getElementById('rewrite-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('rewrite-go-btn').addEventListener('click', async () => {
    const instructions = document.getElementById('rewrite-instructions').value.trim(); if (!instructions) return toast('Describe what you want to change.', { error: true });
    const btn = document.getElementById('rewrite-go-btn'); btn.disabled = true; document.getElementById('rewrite-status').textContent = 'Rewriting…';
    const result = await rewriteChapter(chapter, instructions); btn.disabled = false;
    if (!result.ok) { document.getElementById('rewrite-status').textContent = '⚠️ ' + result.error; toast('No changes were saved because the response was invalid.', { error: true }); return; }
    const fresh = await db.get('chapters', id); fresh.versions = fresh.versions || []; fresh.versions.push({ content: fresh.content, note: instructions, timestamp: new Date().toISOString() }); fresh.content = result.text; fresh.wordCount = wordCount(result.text); fresh.updatedAt = new Date().toISOString(); await db.put('chapters', fresh);
    toast('Chapter rewritten. The previous version was saved.'); closeModal(); bus.emit('chapters-changed');
  });
}

async function duplicateChapter(id) {
  const chapter = await db.get('chapters', id); const copy = { ...chapter, id: db.uid(), title: chapter.title + ' (copy)', versions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; await db.put('chapters', copy); toast('Chapter duplicated.'); bus.emit('chapters-changed');
}

async function deleteChapter(id, root) {
  if (!confirm('Permanently delete this chapter and its continuity memory? Export a backup first if you want to keep them.')) return;
  await db.del('chapters', id);
  await db.del('generationState', id).catch(() => {});
  const memories = await db.getByIndex('memoryEntries', 'by_chapter', id);
  for (const memory of memories) await db.del('memoryEntries', memory.id);
  toast('Chapter and its memory were deleted.');
  renderChapters(root);
}
