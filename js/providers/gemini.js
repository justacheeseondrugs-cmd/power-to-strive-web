import { AIProvider, isLikelyInvalidProse } from './base.js';

export class GeminiProvider extends AIProvider {
  get name() { return 'gemini'; }

  async generate({ systemPrompt, userPrompt, maxOutputTokens = 2048, temperature = 1.0 }) {
    const apiKey = this.config.apiKey;
    const model = this.config.model || 'gemini-3.8-flash';
    if (!apiKey) {
      return { ok: false, text: null, errorType: 'auth', errorMessage: 'Falta la API key de Gemini en Ajustes.', raw: null };
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt || '' }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt || '' }] }],
      generationConfig: {
        maxOutputTokens,
        temperature,
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      ],
    };

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { ok: false, text: null, errorType: 'network', errorMessage: 'Error de red al contactar Gemini: ' + err.message, raw: err };
    }

    let data;
    try { data = await res.json(); } catch { data = null; }

    if (!res.ok) {
      if (res.status === 429) {
        return { ok: false, text: null, errorType: 'quota', errorMessage: 'Gemini devolvió 429 (cuota/límite de tasa excedido). No reintentes automáticamente; espera y vuelve a intentar.', raw: data };
      }
      if (res.status === 503) {
        return { ok: false, text: null, errorType: 'busy', errorMessage: 'Gemini devolvió HTTP 503: el modelo tiene alta demanda temporal. El borrador está guardado. Espera unos minutos y pulsa Reanudar; también puedes elegir otro modelo Flash disponible en Ajustes.', raw: data };
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, text: null, errorType: 'auth', errorMessage: 'API key de Gemini inválida o sin permisos (HTTP ' + res.status + ').', raw: data };
      }
      return { ok: false, text: null, errorType: 'http', errorMessage: 'Gemini devolvió HTTP ' + res.status + (data?.error?.message ? ': ' + data.error.message : ''), raw: data };
    }

    const candidate = data?.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (finishReason === 'SAFETY' || finishReason === 'RECITATION' || data?.promptFeedback?.blockReason) {
      return { ok: false, text: null, errorType: 'moderation', errorMessage: 'Gemini bloqueó la respuesta (motivo: ' + (finishReason || data?.promptFeedback?.blockReason) + ').', raw: data };
    }

    const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('').trim();
    if (!text || isLikelyInvalidProse(text)) {
      return { ok: false, text: null, errorType: 'empty', errorMessage: 'Gemini devolvió una respuesta vacía o inválida.', raw: data };
    }

    return { ok: true, text, errorType: null, errorMessage: null, raw: data };
  }
}
