// Document-level exclusions shared by local and Gemini translation. Text stays
// available for reading, selection and Gemini reference context.
export const isReferenceHeading = text => /^(?:(?:\d+(?:\.\d+)*|[A-Z])[.)]?\s+)?(?:references|bibliography|参考文献|引用文献)\s*[:：]?\s*$/i.test(text.trim());
const startsSection = block => {
  if(!['heading','title'].includes(block.kind))return false;
  const text=block.text.trim();
  if(/^(?:appendi(?:x|ces)\b|supplement(?:ary|al)?(?:\s+material)?\b)/i.test(text))return true;
  const prefix=text.match(/^(?:[A-Z](?:\.\d+)*[.]?|\d+(?:\.\d+)*[.)]?)\s+/);
  if(!prefix)return false;
  // Bold bibliography entries can start with an author's initial too. A
  // multi-sentence author/title entry is not a new appendix section.
  const rest=text.slice(prefix[0].length).replace(/\b[A-Z](?:\.\d+)+[.]?/g,'');
  return !/(?:\b[A-Z]\.\s+[A-Z]|\.\s+[A-Z])/.test(rest);
};

export function excludeReferences(blocks, continued = false) {
  let active = continued;
  for (const block of blocks) {
    if (['heading','title'].includes(block.kind)&&!block.translationSkip&&isReferenceHeading(block.text)) active = true;
    else if (active && !block.translationSkip && startsSection(block)) active = false;
    if (active) { block.translate = false; block.translationSkip = 'references'; }
  }
  return active;
}

export function loadTranslationBlocks(row, rows, extract) {
  if (row.blocks) return Promise.resolve(row.blocks);
  if (row.blocksP) return row.blocksP;
  // A jump to a bibliography continuation still needs the preceding section
  // state. This reads text only; it does not render or translate those pages.
  row.blocksP = (async () => {
    const index = rows.indexOf(row), previous = index > 0 ? rows[index - 1] : null;
    if (previous) await loadTranslationBlocks(previous, rows, extract);
    const blocks = await extract(row);
    row.referencesOpen = excludeReferences(blocks, previous?.referencesOpen || false);
    row.blocks = blocks;
    return blocks;
  })().catch(error => { row.blocksP = null; throw error; });
  return row.blocksP;
}
