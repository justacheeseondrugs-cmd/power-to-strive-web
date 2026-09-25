import { db } from '../db.js';
import { escapeHtml, renderManuscript, toast, bus } from '../utils.js';
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
    '<h2 class="section-title">Write</h2>',
    '<p class="section-hint">Plan your chapter and approve each block before the AI continues. Discarded blocks are NEVER added to the chapter.</p>',
    !hasKey ? '<div class="key-warning">Set up an API key in Settings before writing.</div>' : '',
    '<div id="gen-banner-slot"></div>',
    '<div class="card" id="write-form-card"><h3>New chapter</h3>',
    '<label class="field-label" for="w-title">Title</label><input id="w-title" type="text" placeholder="Chapter 2 — An Hour Early">',
    '<label class="field-label" for="w-instructions">What should happen? (instructions, secrets, and boundaries)</label>',
    '<textarea id="w-instructions" rows="7"></textarea>',
    '<label class="field-label" for="w-scenes">🎬 Scene plan, one scene per line (in order)</label>',
    '<textarea id="w-scenes" rows="5" placeholder="Journey to the capital&#10;Conversations in the square and reactions&#10;Anya enters the scene&#10;Anya reaches Erwin, speaks, and the episode cuts off"></textarea>',
    '<p class="scene-guide">You can choose the next scene before generating each block.</p>',
    '<label class="field-label" for="w-cast">👥 Allowed cast for this chapter (required)</label>',
    '<textarea id="w-cast" rows="3" placeholder="Levi, Joseph, Erwin, Eren, Anya, Hange, Mike, Petra, Jean, Connie, Sasha, Armin, Ymir, Historia, Mikasa, Candy, Zackly"></textarea>',
    '<p class="scene-guide">Character profiles will be sent only for these names. Unnamed extras are allowed if the plot needs them.</p>',
    '<label class="field-label" for="w-forbidden">🚫 Forbidden characters (optional)</label>',
    '<input id="w-forbidden" type="text" placeholder="Kael, Luciana">',
    '<p class="scene-guide">If a forbidden name appears in a block, that block will not be added to the chapter.</p>',
    '<label class="field-label" for="w-ending">Required final scene (recommended)</label>',
    '<textarea id="w-ending" rows="3" placeholder="The girl reaches Erwin and speaks through tears BEFORE the cut."></textarea>',
    '<label class="field-label"><input id="w-reactions" type="checkbox" checked> Reaction room: weave viewers' conversations INTO what happens on screen</label>',
    '<label class="field-label">📚 Reference documents allowed for THIS chapter</label>',
    '<p class="scene-guide">Unchecked documents stay out. A STYLE_ONLY document contributes style notes, never its original text or characters.</p>',
    '<div id="w-reference-list">'+(docsHtml || '<p class="muted">No active reference documents in this story. Upload some in Documents if needed.</p>')+'</div>',
    '<div class="grid-2"><div><label class="field-label" for="w-words">Approximate length</label><select id="w-words"><option value="3000">3,000 words</option><option value="5000" selected>5,000 words</option><option value="7000">7,000 words</option></select></div>',
    '<div><label class="field-label">&nbsp;</label><button class="btn btn-primary" id="w-generate-btn" style="width:100%" '+(!hasKey || active ? 'disabled' : '')+'>✒️ Write first block</button></div></div></div>',
    '<div class="card paper" id="w-paper-card" style="display:none"><div class="paper-title" id="w-paper-title"></div><div class="muted" id="w-paper-meta"></div><hr><div class="paper-readonly manuscript-rendered" id="w-paper-text"></div></div>'
  ].join('');
  // An explicitly chosen brainstorm suggestion is only a draft: the author
  // still reviews it and fills title, cast, scene plan and ending before writing.
  if (plannerDraft?.text && !active) {
    root.querySelector('#w-instructions').value = plannerDraft.text;
    await db.del('settings',plannerDraft.id);
    toast('Planning idea added to the instructions. Review it before writing.');
  }
  document.getElementById('w-generate-btn')?.addEventListener('click',onGenerateClick);
  if(active){ renderBanner(active); showPaper(active); }
}

function renderBanner(state) {
  const slot=document.getElementById('gen-banner-slot');
  if(!slot)return;
  if(!state || state.status==='completed'){slot.innerHTML='';return;}
  const labels={
    in_progress:isRunning?'Preparing block…':'Interrupted: press Write next block',
    awaiting_review:'📝 Block awaiting your approval',
    paused_review:'⏸ Block saved. Choose what happens next.',
    review_target_reached:'📖 Target length reached: check whether the ending is complete.',
    paused_error:'⚠️ Stopped due to an error',paused_busy:'⏸ Model busy',
    paused_quota:'⏸ API quota reached',paused_network:'⏸ Connection interrupted',paused_manual:'⏸ Paused'
  };
  const waiting=state.status==='awaiting_review';
  const showControls=!waiting && (state.status!=='in_progress' || !isRunning);
  const pct=Math.min(100,Math.round((state.wordsSoFar || 0)/Math.max(1,state.targetWords)*100));
  const planOptions=(state.scenePlan || []).map((beat,i)=>'<option value="'+i+'" '+(i===(state.sceneIndex || 0)?'selected':'')+'>'+(i+1)+'. '+escapeHtml(beat)+'</option>').join('');
  slot.innerHTML=[
    '<div class="banner"><div style="flex:1;min-width:200px"><b>'+escapeHtml(state.chapterTitle)+'</b> · '+(labels[state.status] || escapeHtml(state.status)),
    '<div class="progress-track"><div class="progress-fill" style="width:'+pct+'%"></div></div>',
    '<div class="muted">'+state.wordsSoFar+' / '+state.targetWords+' accepted words · '+state.blocksDone+' block(s)</div>',
    state.lastError ? '<p class="muted">'+escapeHtml(state.lastError.message)+'</p>':'','</div></div>',
    waiting ? '<div class="generation-review"><h3>✏️ Read, edit, and approve this block</h3><p class="scene-guide">This text is NOT part of the chapter yet. If something is wrong, edit or discard it before continuing.</p><textarea id="w-review-text" rows="12">'+escapeHtml(state.pendingText || '')+'</textarea><div class="review-actions"><button type="button" class="btn btn-primary" id="w-approve-btn">✓ Approve block</button><button type="button" class="btn btn-ghost" id="w-reject-btn">Discard ONLY this block</button></div></div>' : '',
    showControls ? '<div class="card"><h3>🎬 Next block</h3>'+
       (planOptions ? '<label class="field-label" for="w-current-scene">Which scene should happen next?</label><select id="w-current-scene">'+planOptions+'</select>':'')+
       '<label class="field-label" for="w-block-notes">Notes and corrections for the next block</label><textarea id="w-block-notes" rows="3" placeholder="Do not repeat the town square. Anya has ALREADY arrived; continue her meeting with Erwin."></textarea>'+
       '<div class="btn-row"><button type="button" class="btn btn-primary" id="w-next-btn">✒️ Write next block</button>'+
       (state.wordsSoFar ? '<button type="button" class="btn btn-ghost" id="w-finish-btn">✓ Finish chapter here</button>':'')+
       '<button type="button" class="btn btn-danger" id="w-discard-btn">Close generation</button></div>'+
       '<p class="scene-guide">Finish only when the ending is complete. Closing generation keeps all approved text as a draft.</p></div>':''
  ].join('');
  document.getElementById('w-approve-btn')?.addEventListener('click',async(e)=>{
    e.currentTarget.disabled=true;
    try{await approvePendingBlock(state.chapterId,document.getElementById('w-review-text').value);
      toast('Block approved and saved.');await renderWrite(document.getElementById('view-write'));
    }catch(err){toast(err.message,{error:true,ms:6500});e.currentTarget.disabled=false;}
  });
  document.getElementById('w-reject-btn')?.addEventListener('click',async()=>{
    if(!confirm('Discard ONLY this block? Previously approved blocks will be kept.'))return;
    await rejectPendingBlock(state.chapterId);
    toast('Block discarded. You can describe how it should be rewritten.');await renderWrite(document.getElementById('view-write'));
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
    if(!confirm('Is the ending complete? The chapter will be finished using only your approved blocks.'))return;
    e.currentTarget.disabled=true;
    try{
      await finishReviewedChapter(state.chapterId);
      await renderWrite(document.getElementById('view-write'));
      toast('Chapter finished. Generating continuity memory…');
      const chapter=await db.get('chapters',state.chapterId);
      if(chapter){
        const memory=await generateContinuityMemory(chapter);
        if(memory.ok)toast('Continuity memory saved.');
        else toast('Chapter saved, but continuity memory failed: '+memory.error,{error:true,ms:8500});
      }
      bus.emit('chapters-changed');
    }catch(err){toast(err.message,{error:true,ms:8500});e.currentTarget.disabled=false;}
  });
  document.getElementById('w-discard-btn')?.addEventListener('click',async()=>{
    if(!confirm('Close generation? Approved text will remain in Chapters as a draft.'))return;
    await discardGeneration(state.chapterId);
    toast('Generation closed. Your approved text is still saved.');await renderWrite(document.getElementById('view-write'));
  });
}

function showPaper(state){
  const card=document.getElementById('w-paper-card');if(!card)return;
  card.style.display='block';
  document.getElementById('w-paper-title').textContent=state.chapterTitle;
  document.getElementById('w-paper-meta').textContent=state.wordsSoFar+' / '+state.targetWords+' approved words';
  document.getElementById('w-paper-text').innerHTML=renderManuscript(state.accumulatedText || '(no blocks approved yet)');
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
  if(!title || !instructions)return toast('Enter a title and instructions.',{error:true});
  if(!allowedCast)return toast('Enter the allowed cast for this chapter.',{error:true,ms:6500});
  if(await getActiveGenerationState())return toast('Finish or close the chapter currently in progress.',{error:true});
  const chapters=await db.getAll('chapters');
  const chapter={id:db.uid(),title,content:'',wordCount:0,status:'draft',order:chapters.length,versions:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  await db.put('chapters',chapter);
  await runGeneration({chapterId:chapter.id,chapterTitle:title,instructions,targetWords,requiredEnding,scenePlan,allowedCast,forbiddenCast,documentIds,reactionMode});
}

async function runGeneration(options){
  if(isRunning)return toast('A generation is already in progress.',{error:true});
  isRunning=true;
  const root=document.getElementById('view-write');
  root?.querySelector('#w-next-btn')?.setAttribute('disabled','true');
  root?.querySelector('#w-generate-btn')?.setAttribute('disabled','true');
  try{
    const result=await startOrResumeGeneration({...options,onProgress:({state})=>{renderBanner(state);showPaper(state);}});
    if(result.status==='awaiting_review')toast('Block ready: read and approve it before continuing.',{ms:6000});
    else if(result.status?.startsWith('paused_'))toast(result.lastError?.message || 'Generation paused.',{error:true,ms:8000});
  }catch(err){toast('Generation failed: '+err.message,{error:true,ms:10000});}
  finally{isRunning=false;await renderWrite(root);}
}
