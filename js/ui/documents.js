import { db } from '../db.js';
import { escapeHtml, toast, wordCount } from '../utils.js';
import { chunkText } from '../retrieval.js';

const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
let pdfjsReady = null;
function loadPdfJs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = PDFJS_CDN;
    script.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; resolve(window.pdfjsLib); };
    script.onerror = reject; document.head.appendChild(script);
  });
  return pdfjsReady;
}
async function extractPdfText(file) {
  const pdfjsLib = await loadPdfJs(); const buf = await file.arrayBuffer(); const doc = await pdfjsLib.getDocument({ data: buf }).promise; let text = '';
  for (let i = 1; i <= doc.numPages; i++) { const page = await doc.getPage(i); const content = await page.getTextContent(); text += content.items.map((it) => it.str).join(' ') + '\n\n'; }
  return text;
}
async function readFileText(file) {
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) { try { return await extractPdfText(file); } catch (e) { toast('No se pudo leer el PDF "' + file.name + '": ' + e.message, { error: true }); return null; } }
  return await file.text();
}
export async function renderDocuments(root) {
  const documents = (await db.getAll('documents')).sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const chunksAll = await db.getAll('docChunks');
  root.innerHTML = `<h2 class="section-title">Documentos de referencia</h2><p class="section-hint">Sube TXT, MD o PDF. Configura para qué sirve cada uno: la IA sólo recibirá fragmentos relevantes, nunca el archivo completo.</p><div class="card"><input type="file" id="doc-upload-input" multiple accept=".txt,.md,.pdf,text/plain,application/pdf"><div class="btn-row"><button class="btn btn-primary" id="doc-upload-btn">+ Subir documentos</button></div></div><div id="doc-list"></div>`;
  document.getElementById('doc-upload-btn').addEventListener('click', () => document.getElementById('doc-upload-input').click());
  document.getElementById('doc-upload-input').addEventListener('change', async (e) => { const files = Array.from(e.target.files || []); for (const file of files) { toast('Procesando ' + file.name + '…'); const text = await readFileText(file); if (!text) continue; const doc = { id: db.uid(), filename: file.name, type: 'REFERENCE', priority: 50, useOnlyFor: '', neverUseFor: '', active: true, inclusion: 'SMART', wordCount: wordCount(text), createdAt: new Date().toISOString() }; await db.put('documents', doc); const chunks = chunkText(text, doc.id); for (const ch of chunks) await db.put('docChunks', ch); } toast('Documentos añadidos.'); renderDocuments(root); });
  const list = document.getElementById('doc-list'); if (!documents.length) { list.innerHTML = `<div class="empty"><span class="ic">📚</span>Aún no has subido documentos de referencia.</div>`; return; }
  const pillClass = { CANON: 'pill-canon', CHARACTER: 'pill-character', CONTINUITY: 'pill-continuity', STYLE_ONLY: 'pill-style', REFERENCE: 'pill-reference' };
  list.innerHTML = documents.map((d) => { const nChunks = chunksAll.filter((c) => c.documentId === d.id).length; return `<div class="card" data-id="${d.id}"><div class="card-row"><b>${escapeHtml(d.filename)}</b><span class="muted">${d.wordCount} palabras · ${nChunks} fragmentos</span></div><div class="chip-row"><span class="pill ${pillClass[d.type] || 'pill-reference'}">${d.type}</span><span class="pill ${d.active !== false ? 'pill-active' : 'pill-inactive'}">${d.active !== false ? 'Activo' : 'Ignorado'}</span><span class="pill pill-reference">${d.inclusion}</span></div><label class="field-label">Rol / tipo</label><select class="f-type"><option value="CANON" ${d.type === 'CANON' ? 'selected' : ''}>CANON</option><option value="CHARACTER" ${d.type === 'CHARACTER' ? 'selected' : ''}>CHARACTER</option><option value="CONTINUITY" ${d.type === 'CONTINUITY' ? 'selected' : ''}>CONTINUITY</option><option value="STYLE_ONLY" ${d.type === 'STYLE_ONLY' ? 'selected' : ''}>STYLE_ONLY</option><option value="REFERENCE" ${d.type === 'REFERENCE' ? 'selected' : ''}>REFERENCE</option></select><div class="grid-2"><div><label class="field-label">Prioridad (0-100)</label><input type="number" class="f-priority" value="${d.priority ?? 50}" min="0" max="100"></div><div><label class="field-label">Inclusión</label><select class="f-inclusion"><option value="SMART" ${d.inclusion === 'SMART' ? 'selected' : ''}>SMART (sólo fragmentos relevantes)</option><option value="ALWAYS" ${d.inclusion === 'ALWAYS' ? 'selected' : ''}>ALWAYS (incluir siempre, con tope)</option></select></div></div><label class="field-label">Usar sólo para (etiquetas separadas por coma)</label><input type="text" class="f-useonly" value="${escapeHtml(d.useOnlyFor || '')}" placeholder="ej: estilo, ambientación"><label class="field-label">Nunca usar para (etiquetas separadas por coma)</label><input type="text" class="f-neveruse" value="${escapeHtml(d.neverUseFor || '')}" placeholder="ej: memory_summary"><label class="field-label"><input type="checkbox" class="f-active" ${d.active !== false ? 'checked' : ''}> Documento activo</label><div class="btn-row"><button class="btn btn-primary btn-sm act-save">Guardar alcance</button><button class="btn btn-danger btn-sm act-delete">Eliminar</button></div></div>`; }).join('');
  list.querySelectorAll('.card[data-id]').forEach((el) => { const id = el.dataset.id; el.querySelector('.act-save').addEventListener('click', async () => { const d = await db.get('documents', id); d.type = el.querySelector('.f-type').value; d.priority = parseInt(el.querySelector('.f-priority').value, 10) || 0; d.inclusion = el.querySelector('.f-inclusion').value; d.useOnlyFor = el.querySelector('.f-useonly').value.trim(); d.neverUseFor = el.querySelector('.f-neveruse').value.trim(); d.active = el.querySelector('.f-active').checked; await db.put('documents', d); toast('Alcance guardado para "' + d.filename + '".'); renderDocuments(root); }); el.querySelector('.act-delete').addEventListener('click', async () => { if (!confirm('¿Eliminar este documento y sus fragmentos?')) return; await db.del('documents', id); const chunks = await db.getByIndex('docChunks', 'by_document', id); for (const c of chunks) await db.del('docChunks', c.id); renderDocuments(root); }); });
}
