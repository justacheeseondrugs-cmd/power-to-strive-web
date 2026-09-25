// appearance.js — standalone local display preferences. Never touches chapters, API keys or IndexedDB.
const KEY = 'pts_appearance_v1';
const DEFAULTS = Object.freeze({ theme:'light', paper:'cream', font:'cormorant', fontSize:19, lineHeight:1.75, pageWidth:760 });
const FONTS = {
  cormorant: "'Cormorant Garamond', Georgia, serif",
  georgia: "Georgia, 'Times New Roman', serif",
  lora: "'Lora', Georgia, serif",
  baskerville: "'Libre Baskerville', Georgia, serif",
  garamond: "'EB Garamond', Georgia, serif"
};
const THEMES = ['light','dark','system'];
const PAPERS = ['cream','sepia','dark'];
const clamp = (n,min,max) => Math.max(min,Math.min(max,n));
let systemListenerAttached = false;

function preferences() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { /* private mode / old malformed preference */ }
  return {
    theme: THEMES.includes(stored.theme) ? stored.theme : DEFAULTS.theme,
    paper: PAPERS.includes(stored.paper) ? stored.paper : DEFAULTS.paper,
    font: Object.hasOwn(FONTS,stored.font) ? stored.font : DEFAULTS.font,
    fontSize: clamp(Number(stored.fontSize) || DEFAULTS.fontSize,15,25),
    lineHeight: clamp(Number(stored.lineHeight) || DEFAULTS.lineHeight,1.4,2.1),
    pageWidth: clamp(Number(stored.pageWidth) || DEFAULTS.pageWidth,600,900),
  };
}

export function applyAppearance() {
  const p = preferences();
  const isDark = p.theme === 'dark' || (p.theme === 'system' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const body = document.body;
  body.dataset.theme = isDark ? 'dark' : 'light';
  body.dataset.paper = p.paper;
  body.style.setProperty('--reader-font', FONTS[p.font]);
  body.style.setProperty('--reader-size', p.fontSize+'px');
  body.style.setProperty('--reader-leading',String(p.lineHeight));
  body.style.setProperty('--reader-width',p.pageWidth+'px');
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content',isDark?'#412d3e':'#b56576');
}

export function initAppearance() {
  applyAppearance();
  if (systemListenerAttached || !window.matchMedia) return;
  systemListenerAttached = true;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener?.('change', () => { if (preferences().theme === 'system') applyAppearance(); });
}

function savePreferences(next) {
  const p = { ...preferences(), ...next };
  try { localStorage.setItem(KEY,JSON.stringify(p)); } catch { /* appearance still applies in this session */ }
  // Apply the selected option even if persistence is unavailable.
  if (next.theme) {
    const isDark = p.theme === 'dark' || (p.theme === 'system' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    document.body.dataset.theme = isDark ? 'dark' : 'light';
  }
  document.body.dataset.paper = p.paper;
  document.body.style.setProperty('--reader-font',FONTS[p.font]);
  document.body.style.setProperty('--reader-size',p.fontSize+'px');
  document.body.style.setProperty('--reader-leading',String(p.lineHeight));
  document.body.style.setProperty('--reader-width',p.pageWidth+'px');
  applyAppearance();
}

export function renderAppearanceSettings() {
  return '<div class="card" id="appearance-card">' +
    '<h3>🌸 Appearance & Reading</h3>' +
    '<p class="muted">Make your writing space your own. Display preferences are saved in this browser and never change your chapters.</p>' +
    '<div class="grid-2">' +
      '<div><label class="field-label" for="a-theme">App theme</label><select id="a-theme"><option value="light">Light · pastel pink</option><option value="dark">Dark · plum and mauve</option><option value="system">Follow device settings</option></select></div>' +
      '<div><label class="field-label" for="a-paper">Page color</label><select id="a-paper"><option value="cream">Cream paper</option><option value="sepia">Soft sepia</option><option value="dark">Dark paper</option></select></div>' +
      '<div><label class="field-label" for="a-font">Chapter font</label><select id="a-font"><option value="cormorant">Cormorant Garamond · original</option><option value="georgia">Georgia</option><option value="lora">Lora</option><option value="baskerville">Libre Baskerville</option><option value="garamond">EB Garamond</option></select></div>' +
      '<div><label class="field-label" for="a-size">Font size <output id="a-size-val"></output></label><input id="a-size" type="range" min="15" max="25" step="1"></div>' +
      '<div><label class="field-label" for="a-line">Line spacing <output id="a-line-val"></output></label><input id="a-line" type="range" min="1.4" max="2.1" step=".05"></div>' +
      '<div><label class="field-label" for="a-width">Page width <output id="a-width-val"></output></label><input id="a-width" type="range" min="600" max="900" step="20"></div>' +
    '</div>' +
    '<div class="paper appearance-preview"><p>Stories live in the little details, too: a pink door, a pen on the desk, and a kitten watching over every page.</p><p><em>This is how your next chapter will look.</em></p></div>' +
    '<div class="btn-row"><button type="button" class="btn btn-ghost btn-sm" id="a-reset">Restore default appearance</button></div>' +
    '</div>';
}

export function bindAppearanceSettings() {
  const root = document.getElementById('appearance-card');
  if (!root) return;
  const fields = {
    theme:root.querySelector('#a-theme'),paper:root.querySelector('#a-paper'),font:root.querySelector('#a-font'),
    fontSize:root.querySelector('#a-size'),lineHeight:root.querySelector('#a-line'),pageWidth:root.querySelector('#a-width')
  };
  const sync = () => {
    const p = preferences();
    for (const [name,element] of Object.entries(fields)) element.value = p[name];
    root.querySelector('#a-size-val').textContent = p.fontSize+' px';
    root.querySelector('#a-line-val').textContent = Number(p.lineHeight).toFixed(2);
    root.querySelector('#a-width-val').textContent = p.pageWidth+' px';
  };
  for (const [name,element] of Object.entries(fields)) {
    element.addEventListener(name === 'theme' || name === 'paper' || name === 'font'?'change':'input', () => {
      const value = ['fontSize','lineHeight','pageWidth'].includes(name) ? Number(element.value) : element.value;
      savePreferences({ [name]: value });
      sync();
    });
  }
  root.querySelector('#a-reset').addEventListener('click',() => { savePreferences(DEFAULTS); sync(); });
  sync();
}
