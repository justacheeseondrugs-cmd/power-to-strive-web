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
    // Los modelos de razonamiento (GPT-5 / o-series) requieren
    // max_completion_tokens, que incluye los tokens internos de razonamiento.
    // No aceptan temperature en el modo de API utilizado aquí.
    const isReasoningModel = /^(?:gpt-5(?:[.-]|$)|o[134](?:[.-]|$))/i.test(model);
    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt || '' },
        { role: 'user', content: userPrompt || '' },
      ],
      [isReasoningModel ? 'max_completion_tokens' : 'max_tokens']: maxOutputTokens,
      ...(isReasoningModel ? {} : { temperature }),
    };

    // Fallback por si el ID del modelo no sigue la convención esperada.
    // Solo se reintenta ante un HTTP 400 que indique un parámetro no compatible.
    // No se vuelve a enviar una generación que haya tenido éxito.
    let res, data;
    for (let attempt = 0; attempt < 3; attempt++) {
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

      try { data = await res.json(); } catch { data = null; }
      const message = String(data?.error?.message || '');
      const parameter = String(data?.error?.param || '');
      if (res.status !== 400 || !/unsupported parameter|unsupported value|not supported|does not support|not available/i.test(message)) break;

      if ((parameter === 'max_tokens' || /['"]max_tokens['"]/i.test(message)) && Object.hasOwn(body, 'max_tokens')) {
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
      } else if ((parameter === 'max_completion_tokens' || /['"]max_completion_tokens['"]/i.test(message)) && Object.hasOwn(body, 'max_completion_tokens')) {
        body.max_tokens = body.max_completion_tokens;
        delete body.max_completion_tokens;
      } else if ((parameter === 'temperature' || /['"]temperature['"]/i.test(message)) && Object.hasOwn(body, 'temperature')) {
        delete body.temperature;
      } else {
        break;
      }
    }

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
