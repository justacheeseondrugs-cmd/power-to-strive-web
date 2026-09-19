import { AIProvider, isLikelyInvalidProse } from './base.js';

export class OpenAIProvider extends AIProvider {
  get name() { return 'openai'; }

  async generate({ systemPrompt, userPrompt, maxOutputTokens = 2048, temperature = 1.0 }) {
    const apiKey = this.config.apiKey;
    const model = this.config.model || 'gpt-4o';
    if (!apiKey) {
      return { ok: false, text: null, errorType: 'auth', errorMessage: 'Falta la API key de OpenAI en Ajustes.', raw: null };
    }
    const url = 'https://api.openai.com/v1/chat/completions';
    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt || '' },
        { role: 'user', content: userPrompt || '' },
      ],
      max_tokens: maxOutputTokens,
      temperature,
    };

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { ok: false, text: null, errorType: 'network', errorMessage: 'Error de red al contactar OpenAI: ' + err.message, raw: err };
    }

    let data;
    try { data = await res.json(); } catch { data = null; }

    if (!res.ok) {
      if (res.status === 429) {
        return { ok: false, text: null, errorType: 'quota', errorMessage: 'OpenAI devolvió 429 (cuota/límite de tasa excedido). No reintentes automáticamente; espera y vuelve a intentar.', raw: data };
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, text: null, errorType: 'auth', errorMessage: 'API key de OpenAI inválida o sin permisos (HTTP ' + res.status + ').', raw: data };
      }
      return { ok: false, text: null, errorType: 'http', errorMessage: 'OpenAI devolvió HTTP ' + res.status + (data?.error?.message ? ': ' + data.error.message : ''), raw: data };
    }

    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'content_filter') {
      return { ok: false, text: null, errorType: 'moderation', errorMessage: 'OpenAI bloqueó la respuesta por el filtro de contenido.', raw: data };
    }

    const text = (choice?.message?.content || '').trim();
    if (!text || isLikelyInvalidProse(text)) {
      return { ok: false, text: null, errorType: 'empty', errorMessage: 'OpenAI devolvió una respuesta vacía o inválida.', raw: data };
    }

    return { ok: true, text, errorType: null, errorMessage: null, raw: data };
  }
}
