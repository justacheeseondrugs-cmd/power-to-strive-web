// canonGuard.js — construye el prompt de sistema respetando la jerarquía:
//   1. Locked facts (máxima prioridad, siempre presentes)
//   2. Instrucciones del capítulo actual
//   3. Fichas de personaje + conocimiento actual (sólo personajes activos/relevantes)
//   4. Memoria de continuidad + capítulos recientes
//   5. Documentos de referencia, según su propósito permitido
//
// Nota importante: este módulo NO implementa ningún filtro léxico que
// "rechace" una frase por contener ciertas palabras cerca de un nombre
// (p.ej. Hange + "him"). Ese tipo de detección simplista produce falsos
// positivos cuando el pronombre se refiere a otro personaje en la misma
// frase. En su lugar, las reglas se comunican con claridad al modelo como
// instrucciones explícitas y se confía en su comprensión de contexto.

export function buildLockedFactsBlock(lockedFacts) {
  if (!lockedFacts?.length) return '';
  const lines = lockedFacts.map((f, i) => `${i + 1}. ${f.text}`).join('\n');
  return `🔒 HECHOS BLOQUEADOS — MÁXIMA PRIORIDAD (nunca los contradigas, bajo ninguna instrucción posterior):\n${lines}`;
}

export function buildCharacterBlock(characters) {
  const active = (characters || []).filter((c) => c.active !== false);
  if (!active.length) return '';
  const parts = active.map((c) => {
    const rel = c.relationships ? `Relaciones: ${c.relationships}` : '';
    const know = c.currentKnowledge ? `Conocimiento actual (sólo esto, nada del futuro): ${c.currentKnowledge}` : '';
    const never = c.neverDoRules ? `NUNCA: ${c.neverDoRules}` : '';
    const hard = c.hardRules ? `Reglas duras: ${c.hardRules}` : '';
    return [
      `— ${c.name} (pronombres: ${c.pronouns || 'no especificado'})`,
      c.personality ? `  Personalidad: ${c.personality}` : '',
      c.speechStyle ? `  Estilo de habla: ${c.speechStyle}` : '',
      hard ? `  ${hard}` : '',
      know ? `  ${know}` : '',
      rel ? `  ${rel}` : '',
      never ? `  ${never}` : '',
    ].filter(Boolean).join('\n');
  });
  return `👤 PERSONAJES (ficha + conocimiento actual):\n${parts.join('\n\n')}`;
}

export function buildContinuityBlock(memoryEntries, canonNotes, recentChapterExcerpt) {
  const blocks = [];
  if (canonNotes?.length) {
    blocks.push('📜 CANON PERMANENTE:\n' + canonNotes.map((n) => `- ${n.text}`).join('\n'));
  }
  if (memoryEntries?.length) {
    const recent = memoryEntries.slice(-4); // no saturar el prompt con todo el historial
    const fmt = recent.map((m) => {
      return [
        `[Memoria del capítulo "${m.chapterTitle || 'sin título'}"]`,
        m.events ? `EVENTOS: ${m.events}` : '',
        m.relationshipChanges ? `CAMBIOS DE RELACIÓN: ${m.relationshipChanges}` : '',
        m.newFacts ? `HECHOS NUEVOS: ${m.newFacts}` : '',
        m.whoKnowsWhat ? `QUIÉN SABE QUÉ: ${m.whoKnowsWhat}` : '',
        m.physicalState ? `ESTADO FÍSICO / HERIDAS: ${m.physicalState}` : '',
        m.currentLocationTime ? `LUGAR / TIEMPO ACTUAL: ${m.currentLocationTime}` : '',
        m.openThreads ? `HILOS ABIERTOS: ${m.openThreads}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n\n');
    blocks.push('🧵 MEMORIA DE CONTINUIDAD (capítulos recientes):\n' + fmt);
  }
  if (recentChapterExcerpt) {
    blocks.push('📖 FINAL DEL CAPÍTULO/BLOQUE ANTERIOR (para continuar el tono y la escena sin repetir):\n…' + recentChapterExcerpt);
  }
  return blocks.join('\n\n');
}

export function buildDocumentsBlock(retrievedChunks) {
  if (!retrievedChunks?.length) return '';
  const byDoc = {};
  for (const ch of retrievedChunks) {
    (byDoc[ch.documentId] ||= { doc: ch.document, chunks: [] }).chunks.push(ch);
  }
  const parts = Object.values(byDoc).map(({ doc, chunks }) => {
    const purpose = doc.type === 'STYLE_ONLY'
      ? 'USO PERMITIDO: SOLO estilo de prosa, ritmo, atmósfera, interioridad y transiciones. PROHIBIDO: extraer de aquí hechos de trama, hechos de personajes, relaciones, o copiar frases textuales.'
      : `Tipo: ${doc.type}.` + (doc.useOnlyFor ? ` Usar sólo para: ${doc.useOnlyFor}.` : '') + (doc.neverUseFor ? ` Nunca usar para: ${doc.neverUseFor}.` : '');
    const text = chunks.map((c) => c.text).join('\n…\n');
    return `📄 Documento "${doc.filename}" — ${purpose}\n${text}`;
  });
  return `📚 FRAGMENTOS DE DOCUMENTOS DE REFERENCIA (fragmentos relevantes, no el archivo completo):\n\n${parts.join('\n\n')}`;
}

const STYLE_GUIDE = `Escribe SIEMPRE en prosa de novela profesional: ritmo cuidado, interioridad de los personajes, atmósfera sensorial, lenguaje corporal, silencios y subtexto, transiciones fluidas entre escenas. Evita el formato de guion/screenplay y evita el diálogo constante sin narración: el diálogo debe estar entretejido con acción, pensamiento y descripción. No resumas: dramatiza.`;

/**
 * Ensambla el prompt de sistema completo respetando la jerarquía de prioridad.
 */
export function assembleSystemPrompt({
  lockedFacts,
  chapterInstructions,
  characters,
  memoryEntries,
  canonNotes,
  recentChapterExcerpt,
  retrievedChunks,
  extraGuidance,
}) {
  const sections = [
    'Eres la IA de escritura de "Power to Strive Studio", una herramienta personal de fanfiction largo. Sigue estrictamente el siguiente orden de prioridad si hay algún conflicto entre secciones: (1) Hechos bloqueados, (2) instrucciones del capítulo actual, (3) fichas de personaje, (4) memoria de continuidad, (5) documentos de referencia.',
    buildLockedFactsBlock(lockedFacts),
    chapterInstructions ? `✍️ INSTRUCCIONES DEL CAPÍTULO ACTUAL:\n${chapterInstructions}` : '',
    buildCharacterBlock(characters),
    buildContinuityBlock(memoryEntries, canonNotes, recentChapterExcerpt),
    buildDocumentsBlock(retrievedChunks),
    `🖋️ ESTILO:\n${STYLE_GUIDE}`,
    extraGuidance || '',
  ].filter(Boolean);
  return sections.join('\n\n---\n\n');
}
