import { AIProvider, isLikelyInvalidProse } from './base.js';

// Free router only: do not switch silently to a paid OpenRouter model.
export const isFreeModel = (model) => model === 'openrouter/free' || /^[a-z0-9._-]+\/[a-z0-9._:-]+:free$/i.test(model);

export class OpenRouterFreeProvider extends AIProvider {
  get name() { return 'openrouter'; }
  async generate({ systemPrompt, userPrompt, maxOutputTokens = 2048, temperature = 1 }) {
    const key = String(this.config.apiKey || '').trim();
    const model = String(this.config.model || 'openrouter/free').trim();
    if (!key) return { ok:false, text:null, errorType:'auth', errorMessage:'OpenRouter API key is missing. Add it in Settings. A Gemini API key will not work here.', raw:null };
    if (!isFreeModel(model)) return { ok:false, text:null, errorType:'http', errorMessage:'This provider only allows openrouter/free or model IDs ending in :free to prevent charges.', raw:null };
    let response;
    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${key}`, 'X-Title':'Inky Paws' },
        body:JSON.stringify({
          model,
          messages:[{role:'system',content:systemPrompt || ''},{role:'user',content:userPrompt || ''}],
          max_tokens:maxOutputTokens,
          temperature,
          stream:false,
        }),
      });
    } catch(e) { return {ok:false,text:null,errorType:'network',errorMessage:'Connection error with OpenRouter: '+e.message,raw:null}; }
    let data;
    try {data=await response.json();} catch {data=null;}
    const info = String(data?.error?.message || '').slice(0,250);
    if (!response.ok) {
      const status = response.status;
      let errorType = status === 429 || status === 402 ? 'quota' : [502,503,504].includes(status) ? 'busy' : [401,403].includes(status) ? 'auth' : 'http';
      let help = status===402 ? 'This request requires credits. Paid models will not be used.' : status===429 ? 'Free-tier limit or high demand. Wait before resuming.' : [502,503,504].includes(status) ? 'Temporarily busy. Wait before resuming.' : '';
      return {ok:false,text:null,errorType,errorMessage:`OpenRouter HTTP ${status}. ${help} ${info} Your draft is still saved.`,raw:data};
    }
    const content=data?.choices?.[0]?.message?.content;
    const prose=(typeof content==='string' ? content : Array.isArray(content) ? content.map(x=>typeof x==='string'?x:x?.text||'').join('') : '').trim();
    if (!prose || isLikelyInvalidProse(prose)) {
      const finishReason = String(data?.choices?.[0]?.finish_reason || 'unknown').slice(0,60);
      const chosenModel = String(data?.model || model).slice(0,120);
      const reasoningTokens = Number(data?.usage?.completion_tokens_details?.reasoning_tokens || 0);
      const help = !prose && (finishReason === 'length' || reasoningTokens > 0)
        ? 'The model used its tokens before generating visible text. '
        : !prose ? 'The model returned a response with no visible text. ' : 'The response was not valid prose. ';
      return {
        ok:false, text:null, errorType:'empty',
        errorMessage:help + 'Model: ' + chosenModel + '; reason: ' + finishReason + '. In Settings, switch the OpenRouter model to arcee-ai/trinity-large-preview:free and resume your draft. Nothing has been deleted.',
        raw:null,
      };
    }
    return {ok:true,text:prose,errorType:null,errorMessage:null,raw:null};
  }
}
