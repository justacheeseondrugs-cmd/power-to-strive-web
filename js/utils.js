// utils.js — helpers compartidos por toda la UI.

export function wordCount(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Vista de lectura segura: convierte énfasis Markdown en formato tipográfico
// sin interpretar HTML que pueda aparecer dentro del manuscrito.
// La versión original con asteriscos se conserva intacta para seguir editándola.
export function renderManuscript(text) {
  const safe = escapeHtml(String(text ?? '').replace(/\r\n?/g, '\n'));
  const formatted = safe
    .replace(/\*\*\*([^\n*]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^\n*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^\n*]+?)\*/g, '<em>$1</em>');
  return formatted.split(/\n[\t ]*\n+/).map((paragraph) =>
    '<p>' + paragraph.replace(/\n/g, '<br>') + '</p>'
  ).join('');
}

export function toast(message, { error = false, ms = 3600 } = {}) {
  let wrap = document.getElementById('toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' toast-error' : '');
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

// ---- modal genérico (sheet) ----
export function openModal(innerHtml) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.id = 'active-modal';
  backdrop.innerHTML = `<div class="modal-sheet">${innerHtml}</div>`;
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
  document.body.appendChild(backdrop);
  return backdrop;
}

export function closeModal() {
  document.getElementById('active-modal')?.remove();
}

export function debounce(fn, wait = 600) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

// ---- bus de eventos minimalista ----
const listeners = {};
export const bus = {
  on(evt, cb) { (listeners[evt] ||= []).push(cb); },
  emit(evt, payload) { (listeners[evt] || []).forEach((cb) => cb(payload)); },
};
