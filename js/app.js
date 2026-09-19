import { db } from './db.js';
import { renderWrite } from './ui/write.js?v=20260919-story-continuity-1';
import { renderChapters } from './ui/chapters.js?v=20260919-memory-button-2';
import { renderCharacters } from './ui/characters.js';
import { renderDocuments } from './ui/documents.js';
import { renderMemory } from './ui/memory.js';
import { renderSettings } from './ui/settings.js';
import { bus } from './utils.js';
import { initAppearance } from './ui/appearance.js';

const VIEWS = { write: renderWrite, chapters: renderChapters, characters: renderCharacters, documents: renderDocuments, memory: renderMemory, settings: renderSettings };
async function seedDefaults() {
  const facts = await db.getAll('lockedFacts');
  if (facts.length === 0) {
    await db.put('lockedFacts', { text: 'Levi es mujer en este AU. Usa SIEMPRE pronombres she/her (ella/la) para Levi. Nunca uses he/him/his ni términos masculinos (hombre, esposo, novio, hijo) para referirte a Levi. Esas palabras sí pueden usarse para otros personajes masculinos en la misma frase.', isCore: true });
    await db.put('lockedFacts', { text: 'Hange usa pronombres they/them (elle/su). Nunca uses pronombres binarios (he/she, él/ella) para Hange. Esos pronombres sí pueden referirse a otros personajes cercanos a Hange en la misma frase.', isCore: true });
  }
  const settings = await db.get('settings', 'main');
  if (!settings) await db.put('settings', { id:'main', provider:'gemini', apiKeys:{gemini:'',openai:''}, models:{gemini:'gemini-2.0-flash',openai:'gpt-4o'}, blockWordSize:900 });
}
function switchView(name) { document.querySelectorAll('.view').forEach((v) => v.classList.remove('active')); document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name)); const el = document.getElementById('view-' + name); el.classList.add('active'); localStorage.setItem('pts_last_view', name); VIEWS[name](el); }
function initNav() { document.getElementById('tabbar').addEventListener('click', (e) => { const btn = e.target.closest('.tab-btn'); if (!btn) return; switchView(btn.dataset.view); }); bus.on('navigate', (name) => switchView(name)); }
async function initServiceWorker() { if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('sw.js'); } catch { } } }
async function boot() { await db.openDb(); await seedDefaults(); initNav(); initServiceWorker(); const last = localStorage.getItem('pts_last_view') || 'write'; switchView(VIEWS[last] ? last : 'write'); }
initAppearance();
boot();
