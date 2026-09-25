// index.js — fábrica de proveedores. Este es el ÚNICO archivo que el resto
// de la app debe tocar para "saber" qué proveedor está activo. Añadir un
// proveedor nuevo (p.ej. Claude, Mistral, un backend propio) sólo requiere
// crear un archivo hermano con la misma interfaz (ver base.js) y registrarlo
// aquí — el resto de la aplicación (generación de capítulos, memoria, etc.)
// no necesita cambiar ni una línea.

import { GeminiProvider } from './gemini.js';
import { OpenAIProvider } from './openai.js?v=20260919-memoryfix-1';
import { OpenRouterFreeProvider } from './openrouter.js';

const REGISTRY = {
  gemini: { label: 'Google Gemini', build: (cfg) => new GeminiProvider(cfg) },
  openai: { label: 'OpenAI (GPT)', build: (cfg) => new OpenAIProvider(cfg) },
  openrouter: { label: 'OpenRouter · free models', build: (cfg) => new OpenRouterFreeProvider(cfg) },
};

export function listProviders() {
  return Object.entries(REGISTRY).map(([id, v]) => ({ id, label: v.label }));
}

export function getProvider(settings) {
  const id = settings?.provider || 'gemini';
  const entry = REGISTRY[id] || REGISTRY.gemini;
  const apiKey = settings?.apiKeys?.[id] || '';
  const model = settings?.models?.[id] || '';
  return entry.build({ apiKey, model });
}
