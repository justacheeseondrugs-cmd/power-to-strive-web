// base.js — contrato que debe cumplir cualquier proveedor de IA.
// Un proveedor SOLO sabe hablar con una API externa. No sabe nada de
// capítulos, canon guard, ni personajes: recibe texto, devuelve texto.
//
// generate({ systemPrompt, userPrompt, maxOutputTokens, temperature })
// debe resolver SIEMRE (nunca lanzar), con esta forma:
// {
//   ok: boolean,
//   text: string|null,
//   errorType: null | 'quota' | 'network' | 'http' | 'moderation' | 'empty' | 'auth',
//   errorMessage: string|null,
//   raw: <respuesta cruda, para depuración>
// }

export class AIProvider {
  constructor(config) {
    this.config = config || {};
  }
  get name() { return 'base'; }
  async generate(_opts) {
    return { ok: false, text: null, errorType: 'http', errorMessage: 'Proveedor no implementado', raw: null };
  }
}

export function isLikelyInvalidProse(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length < 20) return true;
  // Frases típicas de rechazo/moderación devueltas como "texto" en vez de error HTTP.
  const flags = [
    /^lo siento,? (pero )?no puedo/i,
    /^i('m| am) sorry,? (but )?i can('t|not)/i,
    /^as an ai language model/i,
    /content policy/i,
    /no puedo generar (este|ese) contenido/i,
  ];
  return flags.some((rx) => rx.test(trimmed));
}
