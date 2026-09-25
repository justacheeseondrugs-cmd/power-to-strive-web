import { db } from '../db.js';
import { escapeHtml, toast, openModal, closeModal } from '../utils.js';

export async function renderCharacters(root) {
  const characters = (await db.getAll('characters')).sort((a, b) => a.name.localeCompare(b.name));
  root.innerHTML = `
    <h2 class="section-title">Personajes</h2>
    <p class="section-hint">Cada ficha se inyecta en el Canon Guard cuando el personaje está activo. Aquí defines pronombres, personalidad, reglas duras y qué sabe cada uno hasta ahora.</p>
    <div class="btn-row" style="margin-bottom:14px;"><button class="btn btn-primary" id="char-new-btn">+ Nuevo personaje</button></div>
    <div id="char-list"></div>`;
  document.getElementById('char-new-btn').addEventListener('click', () => openCharacterModal(null, root));
  const list = document.getElementById('char-list');
  if (!characters.length) { list.innerHTML = `<div class="empty"><span class="ic">💗</span>Todavía no has añadido personajes.</div>`; return; }
  list.innerHTML = characters.map((c) => `
    <div class="list-item" data-id="${c.id}">
      <div class="title-row"><b>${escapeHtml(c.name)}</b><span class="pill ${c.active !== false ? 'pill-active' : 'pill-inactive'}">${c.active !== false ? 'Activo' : 'Inactivo'}</span></div>
      <div class="muted">${escapeHtml(c.pronouns || 'sin pronombres definidos')}</div>
      ${c.personality ? `<div class="muted" style="margin-top:4px;">${escapeHtml(c.personality)}</div>` : ''}
      <div class="btn-row"><button class="btn btn-ghost btn-sm act-edit">Editar</button><button class="btn btn-ghost btn-sm act-toggle">${c.active !== false ? 'Desactivar' : 'Activar'}</button><button class="btn btn-danger btn-sm act-delete">Eliminar</button></div>
    </div>`).join('');
  list.querySelectorAll('.list-item').forEach((el) => {
    const id = el.dataset.id;
    el.querySelector('.act-edit').addEventListener('click', () => openCharacterModal(id, root));
    el.querySelector('.act-toggle').addEventListener('click', async () => { const c = await db.get('characters', id); c.active = c.active === false ? true : false; await db.put('characters', c); renderCharacters(root); });
    el.querySelector('.act-delete').addEventListener('click', async () => { if (!confirm('¿Eliminar este personaje?')) return; await db.del('characters', id); renderCharacters(root); });
  });
}

async function openCharacterModal(id, root) {
  const c = id ? await db.get('characters', id) : { name: '', pronouns: '', personality: '', speechStyle: '', hardRules: '', currentKnowledge: '', relationships: '', neverDoRules: '', active: true };
  openModal(`
    <h3 style="font-family:'Cormorant Garamond',serif; color:var(--oldrose-700); font-size:22px;">${id ? 'Editar' : 'Nuevo'} personaje</h3>
    <label class="field-label">Nombre</label><input type="text" id="f-name" value="${escapeHtml(c.name)}">
    <label class="field-label">Pronombres</label><input type="text" id="f-pronouns" value="${escapeHtml(c.pronouns)}" placeholder="ej: she/her, they/them, he/him">
    <label class="field-label">Personalidad</label><textarea id="f-personality">${escapeHtml(c.personality)}</textarea>
    <label class="field-label">Estilo de habla</label><textarea id="f-speech">${escapeHtml(c.speechStyle)}</textarea>
    <label class="field-label">Reglas duras (hard rules)</label><textarea id="f-hardrules" placeholder="Cosas que siempre deben cumplirse para este personaje">${escapeHtml(c.hardRules)}</textarea>
    <label class="field-label">Conocimiento actual</label><textarea id="f-knowledge" placeholder="Sólo lo que este personaje sabe hasta el momento actual de la historia">${escapeHtml(c.currentKnowledge)}</textarea>
    <label class="field-label">Relaciones</label><textarea id="f-relationships">${escapeHtml(c.relationships)}</textarea>
    <label class="field-label">Nunca hacer (never-do rules)</label><textarea id="f-neverdo">${escapeHtml(c.neverDoRules)}</textarea>
    <label class="field-label"><input type="checkbox" id="f-active" ${c.active !== false ? 'checked' : ''}> Incluir en el Canon Guard (activo)</label>
    <div class="btn-row"><button class="btn btn-primary" id="f-save-btn">Guardar</button><button class="btn btn-ghost" id="f-cancel-btn">Cancelar</button></div>`);
  document.getElementById('f-cancel-btn').addEventListener('click', closeModal);
  document.getElementById('f-save-btn').addEventListener('click', async () => {
    const name = document.getElementById('f-name').value.trim(); if (!name) return toast('El personaje necesita un nombre.', { error: true });
    const obj = { ...c, id: id || undefined, name, pronouns: document.getElementById('f-pronouns').value.trim(), personality: document.getElementById('f-personality').value.trim(), speechStyle: document.getElementById('f-speech').value.trim(), hardRules: document.getElementById('f-hardrules').value.trim(), currentKnowledge: document.getElementById('f-knowledge').value.trim(), relationships: document.getElementById('f-relationships').value.trim(), neverDoRules: document.getElementById('f-neverdo').value.trim(), active: document.getElementById('f-active').checked };
    await db.put('characters', obj); toast('Personaje guardado.'); closeModal(); renderCharacters(root);
  });
}
