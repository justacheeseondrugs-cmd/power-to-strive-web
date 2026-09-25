import { db } from './db.js';
import { renderWrite } from './ui/write.js?v=20260919-workspaces-v1';
import { renderChapters } from './ui/chapters.js?v=20260919-memory-button-2';
import { renderCharacters } from './ui/characters.js';
import { renderDocuments } from './ui/documents.js';
import { renderMemory } from './ui/memory.js';
import { renderSettings } from './ui/settings.js';
import { renderPlanner } from './ui/planner.js?v=20260925-sos-v2';
import { bus, toast } from './utils.js';
import { getActiveGenerationState } from './generation.js';
import { initAppearance } from './ui/appearance.js';

const VIEWS = { write: renderWrite, planner: renderPlanner, chapters: renderChapters, characters: renderCharacters, documents: renderDocuments, memory: renderMemory, settings: renderSettings };
async function seedDefaults() {
  const facts = await db.getAll('lockedFacts');
  if (facts.length === 0) {
    await db.put('lockedFacts', { text: 'Levi es mujer en este AU. Usa SIEMPRE pronombres she/her (ella/la) para Levi. Nunca uses he/him/his ni términos masculinos (hombre, esposo, novio, hijo) para referirte a Levi. Esas palabras sí pueden usarse para otros personajes masculinos en la misma frase.', isCore: true });
    await db.put('lockedFacts', { text: 'Hange usa pronombres they/them (elle/su). Nunca uses pronombres binarios (he/she, él/ella) para Hange. Esos pronombres sí pueden referirse a otros personajes cercanos a Hange en la misma frase.', isCore: true });
  }
  const settings = await db.get('settings', 'main');
  if (!settings) await db.put('settings', { id:'main', provider:'gemini', apiKeys:{gemini:'',openai:''}, models:{gemini:'gemini-2.0-flash',openai:'gpt-4o'}, blockWordSize:900 });
}

const ORIGINAL = { id:'original', name:'Historia original (mis datos actuales)' };
async function loadWorkspaces() {
  const saved = await db.get('settings','workspaces');
  return [ORIGINAL,...(saved?.items || []).filter((p) => p.id && p.id !== ORIGINAL.id)];
}
async function renderWorkspaces() {
  const select = document.getElementById('workspace-select');
  if (!select) return;
  const list = await loadWorkspaces();
  select.innerHTML = list.map((p) => {
    const option = document.createElement('option');
    option.value = p.id; option.textContent = p.name;
    return option.outerHTML;
  }).join('');
  if (!list.some((p) => p.id === db.getActiveProjectId())) db.setActiveProjectId(ORIGINAL.id);
  select.value = db.getActiveProjectId();
  document.getElementById('workspace-label').textContent = list.find((p) => p.id === select.value)?.name || ORIGINAL.name;
}
async function initWorkspaces() {
  const select = document.getElementById('workspace-select');
  await renderWorkspaces();
  select.addEventListener('change', async () => {
    const old = db.getActiveProjectId();
    const active = await getActiveGenerationState();
    if (active?.status === 'in_progress') {
      select.value = old;
      toast('Termina, detén o descarta primero el bloque que se está generando.', { error:true, ms:6500 });
      return;
    }
    db.setActiveProjectId(select.value);
    await seedDefaults();
    await renderWorkspaces();
    switchView('chapters');
    toast('Historia cambiada. Solo verás los datos de este proyecto.');
  });
  document.getElementById('workspace-create').addEventListener('click', async () => {
    const active = await getActiveGenerationState();
    if (active?.status === 'in_progress') return toast('Detén primero la generación en curso.', {error:true});
    const name = window.prompt('Nombre de la nueva historia (no se copiarán capítulos ni documentos):');
    if (!name?.trim()) return;
    const saved = await db.get('settings','workspaces') || {id:'workspaces',items:[]};
    const project = { id:db.uid(),name:name.trim().slice(0,90) };
    saved.items.push(project);
    await db.put('settings',saved);
    db.setActiveProjectId(project.id);
    await seedDefaults();
    await renderWorkspaces();
    switchView('chapters');
    toast('Historia nueva creada. La original y su memoria siguen intactas.');
  });
}

function switchView(name) { document.querySelectorAll('.view').forEach((v) => v.classList.remove('active')); document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name)); const el = document.getElementById('view-' + name); el.classList.add('active'); localStorage.setItem('pts_last_view', name); VIEWS[name](el); }
function initNav() { document.getElementById('tabbar').addEventListener('click', (e) => { const btn = e.target.closest('.tab-btn'); if (!btn) return; switchView(btn.dataset.view); }); bus.on('navigate', (name) => switchView(name)); }
async function initServiceWorker() { if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('sw.js'); } catch { } } }
async function boot() { await db.openDb(); await seedDefaults(); initNav(); await initWorkspaces(); initServiceWorker(); const last = localStorage.getItem('pts_last_view') || 'write'; switchView(VIEWS[last] ? last : 'write'); }
initAppearance();
boot();
