import { db } from '../db.js';
import { escapeHtml, renderManuscript, toast, bus, copyTextToClipboard } from '../utils.js';
import { getActiveGenerationState, startOrResumeGeneration, discardGeneration, approvePendingBlock, rejectPendingBlock, finishReviewedChapter } from '../generation.js?v=20260919-workspaces-v1';
import { generateContinuityMemory } from '../memoryEngine.js?v=20260919-workspaces-v1';

let isRunning = false;
const lines = (t) => String(t || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

export async function renderWrite(root) {
  const [settings, active, documents, plannerDraft] = await Promise.all([
    db.get('settings','main'), getActiveGenerationState(), db.getAll('documents'),
    db.get('settings','planner-draft:' + db.getActiveProjectId())
  ]);
  const hasKey = !!settings?.apiKeys?.[settings.provider];
  const docs = documents.filter((d) => d.active !== false).sort((a,b) => (b.priority || 0)-(a.priority || 0));
  const docsHtml = docs.map((d) => '<label class="doc-choice"><input type="checkbox" class="w-doc" value="'+escapeHtml(d.id)+'" '+(['CANON','CHARACTER','CONTINUITY'].includes(d.type) ? 'checked' : '')+'> '+escapeHtml(d.filename)+' <span class="muted">('+escapeHtml(d.type)+')</span></label>').join('');
  root.innerHTML = [
    '<h2 class="section-title">Escribir</h2>',
    '<p class="section-hint">Planifica el capítulo y aprueba cada bloque antes de que la IA continúe. Los bloques descartados NO pasan al capítulo.</p>',
    !hasKey ? '<div class="key-warning">Configura una API key en Ajustes antes de escribir.</div>' : '',
    '<div id="gen-banner-slot"></div>',
    '<div class="card" id="write-form-card"><h3>Nuevo capítulo</h3>',
    '<label class="field-label" for="w-title">Título</label><input id="w-title" type="text" placeholder="Chapter 2 — An Hour Early">',
    '<label class="field-label" for="w-instructions">¿Qué debe pasar? (instrucciones, secretos y límites)</label>',
    '<textarea id="w-instructions" rows="7"></textarea>',
    '<label class="field-label" for="w-scenes">🎬 Plan de escenas, una por línea (en orden)</label>',
    '<textarea id="w-scenes" rows="5" placeholder="Viaje a la capital&#10;Conversaciones en la plaza y reacciones&#10;Anya aparece en el perro&#10;Anya llega a Erwin, habla y se corta el episodio"></textarea>',
    '<p class="scene-guide">Puedes elegir manualmente la siguiente escena antes de generar cada bloque.</p>',
    '<label class="field-label" for="w-cast">👥 Reparto permitido en este capítulo (obligatorio)</label>',
    '<textarea id="w-cast" rows="3" placeholder="Levi, Joseph, Erwin, Eren, Anya, Hange, Mike, Petra, Jean, Connie, Sasha, Armin, Ymir, Historia, Mikasa, Candy, Zackly"></textarea>',
    '<p class="scene-guide">Se enviarán fichas solo de estos nombres. Los extras sin nombre siguen permitidos si la trama los necesita.</p>',
    '<label class="field-label" for="w-forbidden">🚫 Personajes prohibidos (opcional)</label>',
    '<input id="w-forbidden" type="text" placeholder="Kael, Luciana">',
    '<p class="scene-guide">Si aparece uno de estos nombres en un bloque, no se incorporará al capítulo.</p>',
    '<label class="field-label" for="w-ending">Última escena obligatoria (recomendado)</label>',
    '<textarea id="w-ending" rows="3" placeholder="La niña llega a los brazos de Erwin y habla entre sollozos ANTES del corte."></textarea>',
    '<label class="field-label"><input id="w-reactions" type="checkbox" checked> Sala de reacciones: entrelazar conversaciones de espectadores CON lo que ocurre en pantalla</label>',
    '<label class="field-label">📚 Documentos autorizados para ESTE capítulo</label>',
    '<p class="scene-guide">Los no marcados quedan fuera. Un STYLE_ONLY aporta sus notas de estilo, nunca texto ni personajes originales.</p>',
    '<div id="w-reference-list">'+(docsHtml || '<p class="muted">Sin documentos activos en esta historia. Súbelos en Documentos si los necesitas.</p>')+'</div>',
    '<div class="grid-2"><div><label class="field-label" for="w-words">Extensión orientativa</label><select id="w-words"><option value="3000">3.000 palabras</option><option value="5000" selected>5.000 palabras</option><option value="7000">7.000 palabras</option></select></div>',
    '<div><label class="field-label">&nbsp;</label><button class="btn btn-primary" id="w-generate-btn" style="width:100%" '+(!hasKey || active ? 'disabled' : '')+'>✒️ Escribir primer bloque</button></div></div></div>',
    '<div class="card paper" id="w-paper-card" style="display:none"><div class="paper-title" id="w-paper-title"></div><div class="muted" id="w-paper-meta"></div><div class="btn-row"><button type="button" class="btn btn-ghost btn-sm" id="w-copy-chapter-btn">📋 Copiar capítulo</button></div><hr><div class="paper-readonly manuscript-rendered" id="w-paper-text"></div></div>'
  ].join('');
  // An explicitly chosen brainstorm suggestion is only a draft: the author
  // still reviews it and fills title, cast, scene plan and ending before writing.
  if (plannerDraft?.text && !active) {
    root.querySelector('#w-instructions').value = plannerDraft.text;
    await db.del('settings',plannerDraft.id);
    toast('Idea de planificación lista para revisar en las instrucciones.');
  }
  document.getElementById('w-generate-btn')?.addEventListener('click',onGenerateClick);
  if(active){ renderBanner(active); showPaper(active); }
}

function renderBanner(state) {
  const slot=document.getElementById('gen-banner-slot');
  if(!slot)return;
  if(!state || state.status==='completed'){slot.innerHTML='';return;}
  const labels={
    in_progress:isRunning?'Preparando bloque…':'Interrumpido: pulsa Escribir siguiente bloque',
    awaiting_review:'📝 Bloque pendiente de aprobación',
    paused_review:'⏸ Bloque guardado. Elige qué sigue.',
    review_target_reached:'📖 Extensión alcanzada: revisa si ya está el desenlace.',
    paused_error:'⚠️ Se detuvo por un error',paused_busy:'⏸ Modelo ocupado',
    paused_quota:'⏸ Cuota de API',paused_network:'⏸ Conexión interrumpida',paused_manual:'⏸ Pausado'
  };
  const waiting=state.status==='awaiting_review';
  const showControls=!waiting && (state.status!=='in_progress' || !isRunning);
  const pct=Math.min(100,Math.round((state.wordsSoFar || 0)/Math.max(1,state.targetWords)*100));
  const planOptions=(state.scenePlan || []).map((beat,i)=>'<option value="'+i+'" '+(i===(state.sceneIndex || 0)?'selected':'')+'>'+(i+1)+'. '+escapeHtml(beat)+'</option>').join('');
  slot.innerHTML=[
    '<div class="banner"><div style="flex:1;min-width:200px"><b>'+escapeHtml(state.chapterTitle)+'</b> · '+(labels[state.status] || escapeHtml(state.status)),
    '<div class="progress-track"><div class="progress-fill" style="width:'+pct+'%"></div></div>',
    '<div class="muted">'+state.wordsSoFar+' / '+state.targetWords+' palabras aceptadas · '+state.blocksDone+' bloque(s)</div>',
    state.lastError ? '<p class="muted">'+escapeHtml(state.lastError.message)+'</p>':'','</div></div>',
    waiting ? '<div class="generation-review"><h3>✏️ Lee, corrige y aprueba este bloque</h3><p class="scene-guide">Este texto todavía NO es parte del capítulo. Si algo no te gusta, edítalo o descártalo antes de continuar.</p><textarea id="w-review-text" rows="12">'+escapeHtml(state.pendingText || '')+'</textarea><div class="review-actions"><button type="button" class="btn btn-primary" id="w-approve-btn">✓ Aceptar bloque</button><button type="button" class="btn btn-ghost" id="w-copy-block-btn">📋 Copiar bloque</button><button type="button" class="btn btn-ghost" id="w-reject-btn">Descartar SOLO este bloque</button></div></div>' : '',
    showControls ? '<div class="card"><h3>🎬 Siguiente bloque</h3>'+
       (planOptions ? '<label class="field-label" for="w-current-scene">¿Qué escena debe avanzar ahora?</label><select id="w-current-scene">'+planOptions+'</select>':'')+
       '<label class="field-label" for="w-block-notes">Correcciones para el siguiente bloque</label><textarea id="w-block-notes" rows="3" placeholder="No repetir la plaza. Anya YA llegó: continúa con su encuentro con Erwin."></textarea>'+
       '<div class="btn-row"><button type="button" class="btn btn-primary" id="w-next-btn">✒️ Escribir siguiente bloque</button>'+
       (state.wordsSoFar ? '<button type="button" class="btn btn-ghost" id="w-finish-btn">✓ Finalizar capítulo aquí</button>':'')+
       '<button type="button" class="btn btn-danger" id="w-discard-btn">Cerrar generación</button></div>'+
       '<p class="scene-guide">Finaliza solo cuando el desenlace esté completo. Cerrar generación conserva lo aprobado como borrador.</p></div>':''
  ].join('');
  document.getElementById('w-copy-block-btn')?.addEventListener('click',async()=>{
    const text=document.getElementById('w-review-text')?.value || state.pendingText || '';
    try{await copyTextToClipboard(text);toast('Bloque copiado al portapapeles.');}
    catch(err){toast(err.message || 'No se pudo copiar el bloque.',{error:true});}
  });
  document.getElementById('w-approve-btn')?.addEventListener('click',async(e)=>{
    e.currentTarget.disabled=true;
    try{await approvePendingBlock(state.chapterId,document.getElementById('w-review-text').value);
      toast('Bloque aprobado y guardado.');await renderWrite(document.getElementById('view-write'));
    }catch(err){toast(err.message,{error:true,ms:6500});e.currentTarget.disabled=false;}
  });
  document.getElementById('w-reject-btn')?.addEventListener('click',async()=>{
    if(!confirm('¿Descartar SOLO este bloque? Los anteriores se conservan.'))return;
    await rejectPendingBlock(state.chapterId);
    toast('Bloque descartado. Puedes indicar cómo reescribirlo.');await renderWrite(document.getElementById('view-write'));
  });
  document.getElementById('w-next-btn')?.addEventListener('click',async(e)=>{
    e.currentTarget.disabled=true;
    await runGeneration({
      chapterId:state.chapterId,chapterTitle:state.chapterTitle,instructions:state.instructions,
      targetWords:state.targetWords,requiredEnding:state.requiredEnding,
      sceneIndex:document.getElementById('w-current-scene')?Number(document.getElementById('w-current-scene').value):state.sceneIndex,
      blockNotes:document.getElementById('w-block-notes')?.value.trim() || ''
    });
  });
  document.getElementById('w-finish-btn')?.addEventListener('click',async(e)=>{
    if(!confirm('¿Ya se escribió el desenlace? Se finalizará con los bloques que aceptaste.'))return;
    e.currentTarget.disabled=true;
    try{
      await finishReviewedChapter(state.chapterId);
      await renderWrite(document.getElementById('view-write'));
      toast('Capítulo terminado. Generando memoria de continuidad…');
      const chapter=await db.get('chapters',state.chapterId);
      if(chapter){
        const memory=await generateContinuityMemory(chapter);
        if(memory.ok)toast('Memoria de continuidad guardada.');
        else toast('Capítulo guardado; falló la memoria: '+memory.error,{error:true,ms:8500});
      }
      bus.emit('chapters-changed');
    }catch(err){toast(err.message,{error:true,ms:8500});e.currentTarget.disabled=false;}
  });
  document.getElementById('w-discard-btn')?.addEventListener('click',async()=>{
    if(!confirm('¿Cerrar generación? Se conservará en Capítulos el texto ya aprobado como borrador.'))return;
    await discardGeneration(state.chapterId);
    toast('Generación cerrada. Tu texto aprobado sigue guardado.');await renderWrite(document.getElementById('view-write'));
  });
}

function showPaper(state){
  const card=document.getElementById('w-paper-card');if(!card)return;
  card.style.display='block';
  document.getElementById('w-paper-title').textContent=state.chapterTitle;
  document.getElementById('w-paper-meta').textContent=state.wordsSoFar+' / '+state.targetWords+' palabras aprobadas';
  document.getElementById('w-paper-text').innerHTML=renderManuscript(state.accumulatedText || '(ningún bloque aprobado todavía)');
  const copyBtn=document.getElementById('w-copy-chapter-btn');
  if(copyBtn){
    copyBtn.disabled=!String(state.accumulatedText || '').trim();
    copyBtn.onclick=async()=>{
      const text=String(state.accumulatedText || '').trim();
      if(!text)return toast('Todavía no hay bloques aprobados para copiar.',{error:true});
      try{
        await copyTextToClipboard(state.chapterTitle+'\n\n'+text);
        toast('Capítulo copiado al portapapeles.');
      }catch(err){toast(err.message || 'No se pudo copiar el capítulo.',{error:true});}
    };
  }
}

async function onGenerateClick(){
  const title=document.getElementById('w-title').value.trim();
  const instructions=document.getElementById('w-instructions').value.trim();
  const targetWords=Number(document.getElementById('w-words').value);
  const requiredEnding=document.getElementById('w-ending').value.trim();
  const scenePlan=lines(document.getElementById('w-scenes').value);
  const allowedCast=document.getElementById('w-cast').value.trim();
  const forbiddenCast=document.getElementById('w-forbidden').value.trim();
  const reactionMode=document.getElementById('w-reactions').checked;
  const documentIds=Array.from(document.querySelectorAll('.w-doc:checked')).map((el)=>el.value);
  if(!title || !instructions)return toast('Escribe título e instrucciones.',{error:true});
  if(!allowedCast)return toast('Indica el reparto autorizado del capítulo.',{error:true,ms:6500});
  if(await getActiveGenerationState())return toast('Termina o cierra el capítulo pendiente.',{error:true});
  const chapters=await db.getAll('chapters');
  const chapter={id:db.uid(),title,content:'',wordCount:0,status:'draft',order:chapters.length,versions:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  await db.put('chapters',chapter);
  await runGeneration({chapterId:chapter.id,chapterTitle:title,instructions,targetWords,requiredEnding,scenePlan,allowedCast,forbiddenCast,documentIds,reactionMode});
}

async function runGeneration(options){
  if(isRunning)return toast('Ya hay una generación en curso.',{error:true});
  isRunning=true;
  const root=document.getElementById('view-write');
  root?.querySelector('#w-next-btn')?.setAttribute('disabled','true');
  root?.querySelector('#w-generate-btn')?.setAttribute('disabled','true');
  try{
    const result=await startOrResumeGeneration({...options,onProgress:({state})=>{renderBanner(state);showPaper(state);}});
    if(result.status==='awaiting_review')toast('Bloque listo: léelo y apruébalo antes de continuar.',{ms:6000});
    else if(result.status?.startsWith('paused_'))toast(result.lastError?.message || 'Generación pausada.',{error:true,ms:8000});
  }catch(err){toast('No se pudo generar: '+err.message,{error:true,ms:10000});}
  finally{isRunning=false;await renderWrite(root);}
}
