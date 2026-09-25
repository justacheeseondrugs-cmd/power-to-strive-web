import { db } from '../db.js';
import { escapeHtml, toast, openModal, closeModal } from '../utils.js';

export async function renderCharacters(root) {
  const characters = (await db.getAll('characters')).sort((a, b) => a.name.localeCompare(b.name));
  root.innerHTML = `
    <h2 class="section-title">Characters</h2>
    <p class="section-hint">Active character profiles are included in Canon Guard. Define pronouns, personality, hard rules, and what each character knows so far.</p>
    <div class="btn-row" style="margin-bottom:14px;"><button class="btn btn-primary" id="char-new-btn">+ New character</button></div>
    <div id="char-list"></div>`;
  document.getElementById('char-new-btn').addEventListener('click', () => openCharacterModal(null, root));
  const list = document.getElementById('char-list');
  if (!characters.length) { list.innerHTML = `<div class="empty"><span class="ic">💗</span>You have not added any characters yet.</div>`; return; }
  list.innerHTML = characters.map((c) => `
    <div class="list-item" data-id="${c.id}">
      <div class="title-row"><b>${escapeHtml(c.name)}</b><span class="pill ${c.active !== false ? 'pill-active' : 'pill-inactive'}">${c.active !== false ? 'Active' : 'Inactive'}</span></div>
      <div class="muted">${escapeHtml(c.pronouns || 'pronouns not specified')}</div>
      ${c.personality ? `<div class="muted" style="margin-top:4px;">${escapeHtml(c.personality)}</div>` : ''}
      <div class="btn-row"><button class="btn btn-ghost btn-sm act-edit">Edit</button><button class="btn btn-ghost btn-sm act-toggle">${c.active !== false ? 'Deactivate' : 'Activate'}</button><button class="btn btn-danger btn-sm act-delete">Delete</button></div>
    </div>`).join('');
  list.querySelectorAll('.list-item').forEach((el) => {
    const id = el.dataset.id;
    el.querySelector('.act-edit').addEventListener('click', () => openCharacterModal(id, root));
    el.querySelector('.act-toggle').addEventListener('click', async () => { const c = await db.get('characters', id); c.active = c.active === false ? true : false; await db.put('characters', c); renderCharacters(root); });
    el.querySelector('.act-delete').addEventListener('click', async () => { if (!confirm('Delete this character?')) return; await db.del('characters', id); renderCharacters(root); });
  });
}

async function openCharacterModal(id, root) {
  const c = id ? await db.get('characters', id) : { name: '', pronouns: '', personality: '', speechStyle: '', hardRules: '', currentKnowledge: '', relationships: '', neverDoRules: '', active: true };
  openModal(`
    <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700); font-size:22px;">${id ? 'Edit' : 'New'} character</h3>
    <label class="field-label">Name</label><input type="text" id="f-name" value="${escapeHtml(c.name)}">
    <label class="field-label">Pronouns</label><input type="text" id="f-pronouns" value="${escapeHtml(c.pronouns)}" placeholder="e.g. she/her, they/them, he/him">
    <label class="field-label">Personality</label><textarea id="f-personality">${escapeHtml(c.personality)}</textarea>
    <label class="field-label">Speech style</label><textarea id="f-speech">${escapeHtml(c.speechStyle)}</textarea>
    <label class="field-label">Hard rules</label><textarea id="f-hardrules" placeholder="Things that must always remain true for this character">${escapeHtml(c.hardRules)}</textarea>
    <label class="field-label">Current knowledge</label><textarea id="f-knowledge" placeholder="Only what this character knows at the current point in the story">${escapeHtml(c.currentKnowledge)}</textarea>
    <label class="field-label">Relationships</label><textarea id="f-relationships">${escapeHtml(c.relationships)}</textarea>
    <label class="field-label">Never-do rules</label><textarea id="f-neverdo">${escapeHtml(c.neverDoRules)}</textarea>
    <label class="field-label"><input type="checkbox" id="f-active" ${c.active !== false ? 'checked' : ''}> Include in Canon Guard (active)</label>
    <div class="btn-row"><button class="btn btn-primary" id="f-save-btn">Save</button><button class="btn btn-ghost" id="f-cancel-btn">Cancel</button></div>`);
  document.getElementById('f-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('f-save-btn').addEventListener('click', async () => {
    const name = document.getElementById('f-name').value.trim(); if (!name) return toast('This character needs a name.', { error: true });
    const obj = { ...c, id: id || undefined, name, pronouns: document.getElementById('f-pronouns').value.trim(), personality: document.getElementById('f-personality').value.trim(), speechStyle: document.getElementById('f-speech').value.trim(), hardRules: document.getElementById('f-hardrules').value.trim(), currentKnowledge: document.getElementById('f-knowledge').value.trim(), relationships: document.getElementById('f-relationships').value.trim(), neverDoRules: document.getElementById('f-neverdo').value.trim(), active: document.getElementById('f-active').checked };
    await db.put('characters', obj); toast('Character saved.'); closeModal(); renderCharacters(root);
  });
}
