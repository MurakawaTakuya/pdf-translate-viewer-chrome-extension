import { CITATION_STYLES, CITATION_EXPORTS, createCitationService, citationIdentifier, detectCitationIdentifier } from './citations.js';
import { dismissOnOutsideClick } from './dialog.js';

export function createCitationDialog({ document, getPdf, fileUrl, download, clipboard = globalThis.navigator?.clipboard, service = createCitationService() }) {
  const $ = (s) => document.querySelector(s);
  const dialog = $('#citations');
  dismissOnOutsideClick(dialog);
  let generation = 0, exportGeneration = 0, source = null, exportText = '', exportFormat = null, detected;
  let ready=false,statusOwner='action';
  const text = (selector, value) => { $(selector).textContent = value; };

  function status(message, error = false, owner='action') {
    statusOwner=owner;
    text('#citationStatus', message);
    $('#citationStatus').classList.toggle('error', error);
  }
  async function copy(value) {
    try { await clipboard.writeText(value); status('コピーしました'); }
    catch { status('コピーできませんでした。引用文を選択してコピーしてください', true); }
  }
  function position() {
    const top = document.querySelector('header').getBoundingClientRect().bottom + 8;
    dialog.style.top = `${top}px`;
    dialog.style.maxHeight = `calc(100dvh - ${top + 16}px)`;
  }
  async function load(identifier) {
    const version = ++generation;
    ready=false;
    source = null;
    exportText = '';
    exportFormat = null;
    exportGeneration++;
    $('#citationContent').hidden = true;
    $('#citationExport').hidden = true;
    status('引用情報を取得中…');
    try {
      const result = await service.resolve(identifier);
      if (version !== generation || !dialog.open) return;
      source = result;
      text('#citationPaperTitle', result.title);
      const link = $('#citationSource');
      link.textContent = `${result.version} · DOI: ${result.doi}`;
      link.href = 'https://doi.org/' + result.doi.split('/').map(encodeURIComponent).join('/');
      const scholar = new URL('https://scholar.google.com/scholar');
      scholar.searchParams.set('hl', 'ja');
      scholar.searchParams.set('q', `"${result.title}"`);
      $('#citationScholar').href = scholar.href;
      let failed = 0,settled=0;
      for(const entry of CITATION_STYLES){
        text(`#citation-${entry.id}`,'取得中…');
        const button = $(`#copy-${entry.id}`);
        button.disabled=true;button.onclick=null;
      }
      $('#citationContent').hidden = false;
      $('#citationLookup').hidden = true;
      status('引用形式を取得中…',false,'formats');
      await Promise.all(CITATION_STYLES.map(async entry=>{
        try{
          const value=await service.formatted(result.doi,entry.id);
          if(version!==generation||!dialog.open)return;
          text(`#citation-${entry.id}`,value);
          const button=$(`#copy-${entry.id}`);button.disabled=false;button.onclick=()=>copy(value);
        }catch{
          if(version!==generation||!dialog.open)return;
          failed++;text(`#citation-${entry.id}`,'この形式を取得できませんでした');
        }finally{
          settled++;
          if(version===generation&&dialog.open&&statusOwner==='formats')status(settled<CITATION_STYLES.length?`引用形式を取得中…（${settled}/${CITATION_STYLES.length}）`:
            failed?`${failed}形式を取得できませんでした。識別子を再指定すると再試行できます`:'',false,'formats');
        }
      }));
      if(version===generation&&dialog.open)ready=failed===0;
    } catch (error) {
      if (version !== generation || !dialog.open) return;
      $('#citationLookup').hidden = false;
      status(error.message || '引用情報を取得できませんでした', true);
    }
  }

  for (const format of CITATION_EXPORTS) {
    $(`#export-${format.id}`).onclick = async () => {
      if (!source) return;
      const version = generation, request = ++exportGeneration, doi = source.doi;
      status(`${format.label}形式を取得中…`);
      try {
        const value = await service.exported(doi, format.format);
        if (version !== generation || request !== exportGeneration || !dialog.open) return;
        exportText = value;
        exportFormat = format;
        $('#citationExportText').value = value;
        text('#citationExportLabel', format.label + (format.format === 'ris' ? '（RIS形式）' : ''));
        $('#citationExport').hidden = false;
        status('');
      } catch (error) { if (version === generation && request === exportGeneration && dialog.open) status(error.message, true); }
    };
  }
  $('#citationExportCopy').onclick = () => copy(exportText);
  $('#citationExportSave').onclick = () => {
    if (source && exportFormat && exportText) download(exportText, `citation.${exportFormat.extension}`);
  };
  $('#citationChange').onclick = () => {
    $('#citationLookup').hidden = false;
    $('#citationIdentifier').value = source?.doi || '';
    $('#citationIdentifier').focus();
  };
  $('#citationLookup').onsubmit = (event) => {
    event.preventDefault();
    const id = citationIdentifier($('#citationIdentifier').value);
    if (!id) { status('DOIまたはarXiv IDを入力してください', true); return; }
    return load(id);
  };
  $('#citationClose').onclick = () => dialog.close();
  dialog.onclose = () => { generation++; $('#cite').setAttribute('aria-expanded', 'false'); };

  return {
    async open() {
      if (!getPdf()) return;
      if(dialog.open)return;
      dialog.showModal();
      $('#cite').setAttribute('aria-expanded', 'true');
      position();
      if(ready&&source)return;
      status('論文の識別情報を確認中…');
      const opening = ++generation;
      detected ??= detectCitationIdentifier(fileUrl, getPdf());
      const id = await detected;
      if (!dialog.open || opening !== generation) return;
      if (id) return load(id);
      $('#citationContent').hidden = true;
      $('#citationLookup').hidden = false;
      status('論文を特定できませんでした。DOIまたはarXiv IDを入力してください', true);
    },
    position() { if (dialog.open) position(); },
  };
}
