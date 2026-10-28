export const LAST_SUBMISSION_STORAGE_KEY='bill-ai:last-submission-id';
export const LAST_DUPLICATE_SUBMISSION_STORAGE_KEY='bill-ai:last-duplicate-submission-id';
export const DUPLICATE_SUBMISSION_MESSAGE='Duplicate bill detected — this invoice has already been submitted. No duplicate record was created.';

export function statusWarningText(status) {
  return typeof status?.validation_notes==='string'?status.validation_notes:'';
}
export function parseInvoiceNumber(value) {
  if (typeof value==='number') return Number.isFinite(value) ? value : '';
  if (typeof value!=='string') return '';
  const numeric=value.trim().replaceAll(',','');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(numeric)) return '';
  const parsed=Number(numeric);
  return Number.isFinite(parsed) ? parsed : '';
}
export function displayGstPercent(value) {
  const parsed=parseInvoiceNumber(value);
  return typeof parsed==='number'&&parsed>0&&parsed<1 ? parsed*100 : parsed;
}
export function gstRateForStorage(value) {
  const percent=parseInvoiceNumber(value);
  return typeof percent==='number' ? percent/100 : null;
}
export function restoredInvoiceFields(status) {
  return {
    supplier:status.supplier_name,
    invoice_number:status.invoice_number,
    date:status.date,
    gstin:status.gstin,
    payment_mode:status.payment_mode,
    currency:status.currency,
    subtotal:parseInvoiceNumber(status.subtotal),
    discount:parseInvoiceNumber(status.discount),
    tax:parseInvoiceNumber(status.gst_total ?? status.tax),
    round_off:parseInvoiceNumber(status.round_off),
    total:parseInvoiceNumber(status.grand_total ?? status.total)
  };
}
export function restoredInvoiceItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map(item=>({
    description:item.description??'',
    quantity:item.quantity??'',
    unit_price:item.unit_price??'',
    amount:item.amount??'',
    gst_percent:displayGstPercent(item.gst_percent)
  }));
}
export function isSubmissionId(value) {
  return typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value);
}
export function readLastSubmissionId(storage=globalThis.localStorage) {
  try {
    const value=storage?.getItem(LAST_SUBMISSION_STORAGE_KEY);
    return isSubmissionId(value) ? value : null;
  } catch { return null; }
}
export function rememberSubmissionId(submissionId,storage=globalThis.localStorage) {
  if (!isSubmissionId(submissionId)) return false;
  try { storage?.setItem(LAST_SUBMISSION_STORAGE_KEY,submissionId); return true; } catch { return false; }
}
export function rememberDuplicateSubmissionId(submissionId,storage=globalThis.localStorage) {
  if (!isSubmissionId(submissionId)) return false;
  try { storage?.setItem(LAST_DUPLICATE_SUBMISSION_STORAGE_KEY,submissionId); return true; } catch { return false; }
}
export function submissionResultKind(status,submissionId,storage=globalThis.localStorage) {
  try {
    if (status?.duplicate===true) {
      rememberDuplicateSubmissionId(submissionId,storage);
      return 'duplicate';
    }
    if (storage?.getItem(LAST_DUPLICATE_SUBMISSION_STORAGE_KEY)===submissionId) return 'duplicate';
  } catch {}
  return status?.found ? 'found' : 'processing';
}
export async function restoreSubmissionState({storage=globalThis.localStorage,fetchStatus,submissionId:providedSubmissionId}) {
  const submissionId=isSubmissionId(providedSubmissionId)?providedSubmissionId:readLastSubmissionId(storage);
  if (!submissionId) return {kind:'none'};
  try {
    const status=await fetchStatus(submissionId);
    rememberSubmissionId(submissionId,storage);
    return {kind:submissionResultKind(status,submissionId,storage),submissionId,status};
  } catch {
    if (submissionResultKind(null,submissionId,storage)==='duplicate') return {kind:'duplicate',submissionId};
    return {kind:'error',submissionId};
  }
}
// `ids` omitted exports every saved invoice; otherwise only the given history IDs.
export function historyExportBody(ids) {
  return ids===undefined ? {} : {ids:[...new Set(ids)].filter(isSubmissionId)};
}
export function historyCsvFilename(invoices) {
  if (invoices.length!==1) return 'invoices.csv';
  const name=String(invoices[0].invoice_number||invoices[0].supplier||'').replace(/[^A-Za-z0-9._-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,80);
  return name ? `invoice-${name}.csv` : 'invoice.csv';
}
export function historyTotalText(invoice) {
  return typeof invoice.total==='number' ? `${invoice.currency||''}${invoice.currency&&!/^[^A-Za-z]$/.test(invoice.currency)?' ':''}${invoice.total}` : '—';
}
// n8n acknowledges an upload before saving it, and slow runs have taken ~6 minutes, so the dashboard re-checks
// with backoff capped at 30 s: at most 20 requests over 7 minutes.
export const STATUS_POLL_DELAYS_MS=[2000,3000,5000,10000,15000,15000,20000,20000,...Array(11).fill(30000)];
export const STATUS_POLL_MAX_WAIT_MS=STATUS_POLL_DELAYS_MS.reduce((sum,ms)=>sum+ms,0);
export function formatWait(ms) {
  const seconds=Math.round(ms/1000), minutes=Math.floor(seconds/60), rest=seconds%60;
  return minutes ? `${minutes} min${rest?` ${rest} s`:''}` : `${seconds} s`;
}
const MAX_CONSECUTIVE_STATUS_ERRORS=3;
// Re-checks one submission until it is found or duplicate (final), errors repeatedly, times out, or is cancelled.
export async function pollSubmissionStatus({fetchStatus,submissionId,storage=globalThis.localStorage,delays=STATUS_POLL_DELAYS_MS,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),isCancelled=()=>false,onProgress=()=>{}}) {
  let result={kind:'error',submissionId};
  let errors=0, elapsedMs=0;
  for (let attempt=1;attempt<=delays.length+1;attempt++) {
    if (isCancelled()) return {kind:'cancelled',submissionId,attempts:attempt-1};
    result=await restoreSubmissionState({storage,fetchStatus,submissionId});
    if (isCancelled()) return {kind:'cancelled',submissionId,attempts:attempt};
    if (result.kind==='found'||result.kind==='duplicate'||result.kind==='none') return {...result,attempts:attempt};
    errors=result.kind==='error'?errors+1:0;
    if (errors>=MAX_CONSECUTIVE_STATUS_ERRORS) return {...result,attempts:attempt};
    if (attempt>delays.length) break;
    onProgress({attempt,total:delays.length+1,nextDelayMs:delays[attempt-1],elapsedMs,result});
    await sleep(delays[attempt-1]);
    elapsedMs+=delays[attempt-1];
  }
  return {...result,kind:result.kind==='error'?'error':'timeout',attempts:delays.length+1};
}

// CSV column mapping. Field order and keys must match CSV_FIELDS in server/invoice.js; the first 13 are the default format.
export const CSV_FIELD_OPTIONS=[
  {key:'supplier',name:'Supplier'},{key:'invoice_number',name:'Invoice number'},{key:'date',name:'Date'},{key:'currency',name:'Currency'},
  {key:'description',name:'Item description'},{key:'quantity',name:'Item quantity'},{key:'unit_price',name:'Item unit price'},{key:'amount',name:'Item amount'},
  {key:'subtotal',name:'Subtotal'},{key:'discount',name:'Discount'},{key:'tax',name:'Tax / GST'},{key:'round_off',name:'Round-off'},{key:'total',name:'Total'},
  {key:'line_number',name:'Line number'}
];
export const CSV_PRESETS_STORAGE_KEY='bill-ai:csv-presets';
const DEFAULT_FIELD_COUNT=13;
export function defaultCsvMapping() {
  return CSV_FIELD_OPTIONS.map(({key},i)=>({key,label:key,include:i<DEFAULT_FIELD_COUNT}));
}
// Included columns keep their saved order and names; remaining fields follow, unchecked.
export function csvMappingFromColumns(columns) {
  const included=sanitizeCsvColumns(columns)??[];
  const used=new Set(included.map(column=>column.key));
  return [...included.map(column=>({...column,include:true})),...CSV_FIELD_OPTIONS.filter(({key})=>!used.has(key)).map(({key})=>({key,label:key,include:false}))];
}
export function csvColumnsFromMapping(mapping) {
  return mapping.filter(column=>column.include).map(column=>({key:column.key,label:String(column.label??'').trim().slice(0,100)||column.key}));
}
export function sanitizeCsvColumns(columns) {
  if (!Array.isArray(columns)) return null;
  const known=new Set(CSV_FIELD_OPTIONS.map(({key})=>key));
  const seen=new Set();
  const valid=columns.filter(column=>column&&known.has(column.key)&&!seen.has(column.key)&&seen.add(column.key)).map(column=>({key:column.key,label:typeof column.label==='string'&&column.label.trim()?column.label.trim().slice(0,100):column.key}));
  return valid.length?valid:null;
}
export function sameCsvColumns(a,b) {
  return a.length===b.length&&a.every((column,i)=>column.key===b[i].key&&column.label===b[i].label);
}
export function moveCsvColumn(mapping,index,delta) {
  const target=index+delta;
  if (target<0||target>=mapping.length) return mapping;
  const next=[...mapping];
  [next[index],next[target]]=[next[target],next[index]];
  return next;
}
export function readCsvPresets(storage=globalThis.localStorage) {
  try {
    const parsed=JSON.parse(storage?.getItem(CSV_PRESETS_STORAGE_KEY)||'null');
    const presets=(Array.isArray(parsed?.presets)?parsed.presets:[]).map(preset=>({id:String(preset?.id??''),name:String(preset?.name??'').trim().slice(0,60),columns:sanitizeCsvColumns(preset?.columns)})).filter(preset=>preset.id&&preset.name&&preset.columns);
    const activeId=presets.some(preset=>preset.id===parsed?.activeId)?parsed.activeId:null;
    return {presets,activeId};
  } catch { return {presets:[],activeId:null}; }
}
export function writeCsvPresets(state,storage=globalThis.localStorage) {
  try { storage?.setItem(CSV_PRESETS_STORAGE_KEY,JSON.stringify({version:1,presets:state.presets,activeId:state.activeId})); return true; } catch { return false; }
}
const presetNameError=(state,name,exceptId)=>{
  if (!name) return 'Enter a preset name.';
  if (name.length>60) return 'Preset names can be up to 60 characters.';
  if (state.presets.some(preset=>preset.id!==exceptId&&preset.name.toLowerCase()===name.toLowerCase())) return 'A preset with this name already exists.';
  return '';
};
// Preset operations return {state} on success or {error}; they never mutate the given state.
export function addCsvPreset(state,name,columns,id=`preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`) {
  const trimmed=String(name??'').trim();
  const error=presetNameError(state,trimmed);
  if (error) return {error};
  const valid=sanitizeCsvColumns(columns);
  if (!valid) return {error:'Choose at least one column.'};
  return {state:{presets:[...state.presets,{id,name:trimmed,columns:valid}],activeId:id}};
}
export function updateCsvPreset(state,id,columns) {
  const valid=sanitizeCsvColumns(columns);
  if (!valid) return {error:'Choose at least one column.'};
  if (!state.presets.some(preset=>preset.id===id)) return {error:'Select a saved preset first.'};
  return {state:{...state,presets:state.presets.map(preset=>preset.id===id?{...preset,columns:valid}:preset)}};
}
export function renameCsvPreset(state,id,name) {
  const trimmed=String(name??'').trim();
  if (!state.presets.some(preset=>preset.id===id)) return {error:'Select a saved preset first.'};
  const error=presetNameError(state,trimmed,id);
  if (error) return {error};
  return {state:{...state,presets:state.presets.map(preset=>preset.id===id?{...preset,name:trimmed}:preset)}};
}
export function deleteCsvPreset(state,id) {
  if (!state.presets.some(preset=>preset.id===id)) return {error:'Select a saved preset first.'};
  return {state:{presets:state.presets.filter(preset=>preset.id!==id),activeId:state.activeId===id?null:state.activeId}};
}
// Minimal RFC 4180 parser for previewing the server-generated CSV.
export function parseCsv(text) {
  const rows=[];let row=[],cell='',quoted=false;
  const source=String(text).replace(/^\uFEFF/,'');
  for (let i=0;i<source.length;i++) {
    const ch=source[i];
    if (quoted) { if (ch==='"'&&source[i+1]==='"') {cell+='"';i++} else if (ch==='"') quoted=false; else cell+=ch; }
    else if (ch==='"') quoted=true;
    else if (ch===',') {row.push(cell);cell=''}
    else if (ch==='\n') {row.push(cell);rows.push(row);row=[];cell=''}
    else if (ch!=='\r') cell+=ch;
  }
  if (cell||row.length) {row.push(cell);rows.push(row)}
  return rows;
}

// Visual tone for the review status pill, derived from its existing label text.
export function stateTone(text) {
  const label=String(text||'').toLowerCase();
  if (/duplicate/.test(label)) return 'warning';
  if (/unavailable|error|fail|reject/.test(label)) return 'danger';
  if (/needs|review|warning|mismatch/.test(label)&&!/approved/.test(label)) return 'warning';
  if (/processing|loading|pending/.test(label)) return 'progress';
  if (/saved|sent|approved|valid|complete|found/.test(label)) return 'success';
  return 'neutral';
}
const ITEM_LABELS={description:'Description',quantity:'Quantity',unit_price:'Unit price',amount:'Amount',gst_percent:'GST %'};

function init() {
  const $=id=>document.getElementById(id);
  let file=null, rows=[], currentSubmissionId=null, history=[];
  let csvPresets=readCsvPresets();
  let csvMapping=csvPresets.activeId?csvMappingFromColumns(csvPresets.presets.find(preset=>preset.id===csvPresets.activeId).columns):defaultCsvMapping();
  const fields=['supplier','invoice_number','date','currency','subtotal','discount','tax','round_off','total'];
  const msg=(id,text)=>{$(id).textContent=text};
  const toneState=()=>{$('state').dataset.tone=stateTone($('state').textContent)};
  new MutationObserver(toneState).observe($('state'),{childList:true,characterData:true,subtree:true});
  toneState();
  const setEmpty=text=>{$('review').hidden=true;$('empty').hidden=false;$('empty').textContent=text};
  const getInvoice=()=>{const invoice={};for(const k of fields) invoice[k]=['subtotal','discount','tax','round_off','total'].includes(k)?num($(k).value):$(k).value.trim();invoice.items=rows.map(r=>({description:r.description,quantity:num(r.quantity),unit_price:num(r.unit_price),amount:num(r.amount),gst_percent:gstRateForStorage(r.gst_percent)}));return invoice};
  const num=v=>v===''||v===null||v===undefined?null:Number(v);
  const setFile=f=>{if(!f)return;if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(f.type)){msg('message','Please choose JPG, PNG, WebP or PDF.');return}if(f.size>10*1024*1024){msg('message','The file must be smaller than 10 MB.');return}file=f;$('filename').textContent=f.name;$('extract').disabled=false;msg('message','')};
  $('file').addEventListener('change',e=>setFile(e.target.files[0]));
  const drop=document.querySelector('.drop');
  drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('drag')});
  drop.addEventListener('dragleave',()=>drop.classList.remove('drag'));
  drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('drag');setFile(e.dataTransfer.files[0])});
  const renderRows=()=>{const body=$('rows');body.replaceChildren();rows.forEach((item,i)=>{const tr=document.createElement('tr');for(const k of ['description','quantity','unit_price','amount','gst_percent']){const td=document.createElement('td');td.dataset.label=ITEM_LABELS[k];const input=document.createElement('input');input.setAttribute('aria-label',`Row ${i+1} ${k}`);input.value=item[k]??'';input.type=k==='description'?'text':'number';if(input.type==='number'){input.step='any';input.inputMode='decimal'}input.addEventListener('input',()=>{rows[i][k]=input.value;$('approved').checked=false;sync()});td.append(input);tr.append(td)}const td=document.createElement('td');const b=document.createElement('button');b.className='remove';b.textContent='×';b.setAttribute('aria-label',`Remove row ${i+1}`);b.onclick=()=>{rows.splice(i,1);$('approved').checked=false;renderRows();sync()};td.append(b);tr.append(td);body.append(tr)})};
  const sync=()=>{const checked=$('approved').checked;$('csv').disabled=!checked;$('save').disabled=!checked};
  const fetchSubmissionStatus=async submissionId=>{const response=await fetch(`/api/submissions/${encodeURIComponent(submissionId)}/status`);let data={};try{data=await response.json()}catch{}if(!response.ok)throw Error((data.error||'Could not restore submission status.')+(data.code?` [${data.code}]`:''));return data};
  const showDuplicate=()=>{
    $('state').textContent='Duplicate';
    $('review').hidden=true;
    $('empty').hidden=true;
    $('duplicate-warning').hidden=false;
    $('recovery').hidden=false;
    $('recovery-id').value='';
    msg('recovery-message','Enter the original saved submission ID to restore its invoice details.');
  };
  const renderStatus=status=>{
    if (status.duplicate===true) {
      showDuplicate();
      return;
    }
    $('duplicate-warning').hidden=true;
    if (!status.found) {$('state').textContent='Processing';setEmpty('This submission is still processing. Check again shortly.');return;}
    const label=[status.state,status.review_status,status.validation_status].filter(Boolean).join(' · ') || 'Saved';
    $('state').textContent=label;
    if (!Array.isArray(status.items)||!status.items.length) {
      setEmpty('Submission was saved, but invoice details are not available in the status response.');
      return;
    }
    currentSubmissionId=isSubmissionId(status.submission_id)?status.submission_id:null;
    void loadHistory();
    const restored=restoredInvoiceFields(status);
    for (const [key,value] of Object.entries(restored)) if (value!==''&&value!==null&&value!==undefined) $(key).value=value;
    rows=restoredInvoiceItems(status.items);
    renderRows();
    $('approved').checked=false;
    sync();
    $('review').hidden=false;
    $('empty').hidden=true;
    $('duplicate-warning').hidden=true;
    const notes=statusWarningText(status);
    $('warnings').textContent=notes;
    $('warnings').hidden=!notes;
  };
  const restoreLastSubmission=async(providedSubmissionId)=>{
    const submissionId=isSubmissionId(providedSubmissionId)?providedSubmissionId:readLastSubmissionId();
    if (!submissionId) {
      $('recovery').hidden=false;
      msg('recovery-message','Enter a submission ID to restore an invoice.');
      return;
    }
    $('recovery').hidden=true;
    $('state').textContent='Loading…';
    setEmpty('Restoring the last submitted invoice…');
    const result=await restoreSubmissionState({fetchStatus:fetchSubmissionStatus,submissionId});
    if (result.kind==='duplicate') {
      showDuplicate();
      return;
    }
    if (result.kind==='found'||result.kind==='processing') {
      renderStatus(result.status);
      if (result.kind==='processing') {
        $('recovery').hidden=false;
        $('recovery-id').value=submissionId;
        msg('recovery-message','No saved invoice was found for this submission ID yet. If it was marked duplicate, enter the original saved submission ID to restore that invoice.');
      }
      return;
    }
    if (result.kind==='error') {
      $('state').textContent='Status unavailable';
      setEmpty('Could not restore the last submission. Check your connection and try again.');
      $('recovery').hidden=false;
      $('recovery-id').value=submissionId;
      msg('recovery-message','Status lookup failed. Retry this ID or enter another saved submission ID.');
    }
  };
  // Follow an accepted upload until n8n reports a final result. A newer accepted upload or a valid manual restore cancels it.
  let pollToken=0;
  const followUpload=async submissionId=>{
    const token=++pollToken;
    const current=()=>token===pollToken;
    // Recovery stays available while waiting; restoring another ID cancels this follow-up.
    $('recovery').hidden=false;
    $('recovery-id').value=submissionId;
    msg('recovery-message','Checking this submission automatically. To open a different saved invoice, enter its submission ID.');
    $('state').textContent='Processing';
    setEmpty('Waiting for the invoice to be processed…');
    const result=await pollSubmissionStatus({fetchStatus:fetchSubmissionStatus,submissionId,isCancelled:()=>!current(),onProgress:({attempt,total,nextDelayMs,elapsedMs})=>{
      $('state').textContent='Processing';
      setEmpty(`Processing the invoice… ${elapsedMs?`${formatWait(elapsedMs)} so far; `:''}checking again in ${formatWait(nextDelayMs)} (check ${attempt} of ${total}). Some invoices take up to ${formatWait(STATUS_POLL_MAX_WAIT_MS)}.`);
    }});
    if (!current()||result.kind==='cancelled') return;
    if (result.kind==='duplicate') {showDuplicate();msg('message',DUPLICATE_SUBMISSION_MESSAGE);return;}
    if (result.kind==='found') {$('recovery').hidden=true;renderStatus(result.status);msg('message','Invoice processed.');return;}
    $('recovery').hidden=false;
    $('recovery-id').value=submissionId;
    if (result.kind==='timeout') {
      $('state').textContent='Still processing';
      setEmpty(`Not finished after ${formatWait(STATUS_POLL_MAX_WAIT_MS)} of automatic checks. n8n may still be processing it; nothing was lost and the submission ID is kept.`);
      msg('recovery-message','Automatic checks stopped. Use Restore invoice in a few minutes to check this submission again.');
      return;
    }
    $('state').textContent='Status unavailable';
    setEmpty('Could not check the submitted invoice. Check your connection and try again.');
    msg('recovery-message','Status lookup failed. Retry this ID or enter another saved submission ID.');
  };
  $('recover').onclick=async()=>{
    const submissionId=$('recovery-id').value.trim();
    if(!isSubmissionId(submissionId)) {msg('recovery-message','Enter a valid submission ID.');return;}
    // Cancel an automatic follow-up only once a valid restore replaces it.
    pollToken++;
    $('recover').disabled=true;
    msg('recovery-message','Looking up the saved invoice…');
    await restoreLastSubmission(submissionId);
    $('recover').disabled=false;
  };
  $('approved').onchange=sync;
  for(const k of fields)$(k).addEventListener('input',()=>{$('approved').checked=false;sync()});
  $('add').onclick=()=>{rows.push({description:'',quantity:null,unit_price:null,amount:null});$('approved').checked=false;renderRows();sync()};
  $('extract').onclick=async()=>{if(!file)return;$('extract').disabled=true;$('duplicate-warning').hidden=true;msg('message','Sending invoice for processing…');try{const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file)});const response=await fetch('/api/extract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base64,mimeType:file.type,fileName:file.name})});const data=await response.json();if(!response.ok)throw Error((data.error||'Upload failed.')+(data.code?` [${data.code}]`:''));if(!rememberSubmissionId(data.submission_id))throw Error('Upload was accepted, but its submission ID was invalid.');pollToken++;if(data.duplicate===true){rememberDuplicateSubmissionId(data.submission_id);showDuplicate();msg('message',data.message||DUPLICATE_SUBMISSION_MESSAGE);return;}msg('message',data.message||'Accepted for processing — not yet saved.');void followUpload(data.submission_id)}catch(e){msg('message',e.message||'Upload failed.')}finally{$('extract').disabled=false}};
  $('csv').onclick=async()=>{try{const r=await fetch('/api/csv',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({invoice:getInvoice(),columns:csvColumnsFromMapping(csvMapping)})});if(!r.ok)throw Error('Could not generate CSV.');const blob=await r.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='invoice.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);msg('save-message','CSV downloaded. Review it before importing into accounting software.')}catch(e){msg('save-message',e.message)}};
  $('save').onclick=async()=>{msg('save-message','Sending to n8n…');try{const r=await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({invoice:getInvoice(),confirmedWarnings:true,submission_id:currentSubmissionId})});const data=await r.json();if(data.history_saved)void loadHistory();if(!r.ok)throw Error(data.error+(data.history_saved?' The approved invoice was saved to invoice history.':''));msg('save-message',data.message+(data.history_saved===false?' It could not be saved to invoice history.':''));$('state').textContent='Sent to n8n'}catch(e){msg('save-message',e.message)}};
  const selectedHistoryIds=()=>[...$('history-rows').querySelectorAll('input[type=checkbox]:checked')].map(box=>box.value);
  const syncHistory=()=>{const selected=selectedHistoryIds();$('history-selected').disabled=!selected.length;$('history-all').disabled=!history.length;$('history-select-all').checked=history.length>0&&selected.length===history.length};
  const downloadHistory=async ids=>{
    msg('history-message','Preparing CSV…');
    try {
      const r=await fetch('/api/invoices/csv',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...historyExportBody(ids),columns:csvColumnsFromMapping(csvMapping)})});
      if(!r.ok){let data={};try{data=await r.json()}catch{}throw Error(data.error||'Could not generate CSV.')}
      const blob=await r.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=historyCsvFilename(ids===undefined?history:history.filter(x=>ids.includes(x.id)));a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      const count=ids===undefined?history.length:ids.length;
      msg('history-message',`CSV downloaded for ${count} invoice${count===1?'':'s'}, including all line items.`);
    } catch(e) {msg('history-message',e.message)}
  };
  const renderHistory=()=>{
    const body=$('history-rows');body.replaceChildren();
    for (const invoice of history) {
      const tr=document.createElement('tr');
      const pick=document.createElement('td');const box=document.createElement('input');box.type='checkbox';box.value=invoice.id;box.setAttribute('aria-label',`Select invoice ${invoice.invoice_number||invoice.supplier||invoice.id}`);box.onchange=syncHistory;const hit=document.createElement('label');hit.className='pick';hit.append(box);pick.append(hit);tr.append(pick);
      for (const [label,text] of [['Supplier',invoice.supplier||'—'],['Invoice number',invoice.invoice_number||'—'],['Date',invoice.date||'—'],['Total',historyTotalText(invoice)],['Items',String(invoice.item_count)]]) {const td=document.createElement('td');td.dataset.label=label;td.textContent=text;tr.append(td)}
      const status=document.createElement('td');status.dataset.label='Status';const badge=document.createElement('span');badge.className='history-badge';badge.dataset.source=invoice.source;badge.textContent=invoice.source==='approved'?'Approved':'Saved by n8n';status.append(badge);tr.append(status);
      const action=document.createElement('td');const b=document.createElement('button');b.className='secondary history-one';b.type='button';b.textContent='CSV ↓';b.setAttribute('aria-label',`Download CSV for invoice ${invoice.invoice_number||invoice.supplier||invoice.id}`);b.onclick=()=>downloadHistory([invoice.id]);action.append(b);tr.append(action);
      body.append(tr);
    }
    $('history-table').hidden=!history.length;
    $('history-empty').hidden=history.length>0;
    syncHistory();
  };
  async function loadHistory() {
    try {
      const r=await fetch('/api/invoices');const data=await r.json();
      if(!r.ok)throw Error(data.error||'Could not load invoice history.');
      history=Array.isArray(data.invoices)?data.invoices:[];renderHistory();schedulePreview();
    } catch(e) {msg('history-message',e.message||'Could not load invoice history.')}
  }
  $('history-select-all').onchange=()=>{for(const box of $('history-rows').querySelectorAll('input[type=checkbox]'))box.checked=$('history-select-all').checked;syncHistory();schedulePreview()};
  $('history-rows').addEventListener('change',()=>schedulePreview());
  const activePreset=()=>csvPresets.presets.find(preset=>preset.id===csvPresets.activeId)??null;
  const savedColumns=()=>activePreset()?.columns??csvColumnsFromMapping(defaultCsvMapping());
  const syncCsvFormat=()=>{
    const preset=activePreset();
    $('csv-format-name').textContent=preset?preset.name:'Default';
    $('csv-format-dirty').hidden=sameCsvColumns(csvColumnsFromMapping(csvMapping),savedColumns());
    $('csv-preset-save').disabled=!preset;
    $('csv-preset-rename').disabled=!preset;
    $('csv-preset-delete').disabled=!preset;
  };
  const renderPresets=()=>{
    const select=$('csv-preset');select.replaceChildren();
    const option=(value,text)=>{const o=document.createElement('option');o.value=value;o.textContent=text;return o};
    select.append(option('','Default format'));
    for (const preset of csvPresets.presets) select.append(option(preset.id,preset.name));
    select.value=csvPresets.activeId??'';
    $('csv-preset-name').value=activePreset()?.name??'';
    syncCsvFormat();
  };
  const commitPresets=(result,message)=>{
    if (result.error) {msg('csv-preset-message',result.error);return false}
    csvPresets=result.state;
    msg('csv-preset-message',writeCsvPresets(csvPresets)?message:'Preset changed for this page only: browser storage is unavailable.');
    renderPresets();
    return true;
  };
  const changeMapping=next=>{csvMapping=next;renderCsvColumns();syncCsvFormat();schedulePreview()};
  const renderCsvColumns=()=>{
    const list=$('csv-columns');list.replaceChildren();
    const included=csvMapping.filter(column=>column.include).length;
    csvMapping.forEach((column,i)=>{
      const name=CSV_FIELD_OPTIONS.find(option=>option.key===column.key).name;
      const li=document.createElement('li');li.className='csv-column';li.dataset.include=String(column.include);
      const pick=document.createElement('label');pick.className='pick';const box=document.createElement('input');box.type='checkbox';box.checked=column.include;box.setAttribute('aria-label',`Include ${name}`);
      box.onchange=()=>{if(!box.checked&&included===1){box.checked=true;msg('csv-preset-message','Keep at least one column.');return}changeMapping(csvMapping.map((c,j)=>j===i?{...c,include:box.checked}:c))};
      pick.append(box);
      const field=document.createElement('span');field.className='csv-column-field';field.textContent=name;
      const label=document.createElement('input');label.value=column.label;label.maxLength=100;label.disabled=!column.include;label.setAttribute('aria-label',`Column name for ${name}`);label.placeholder=column.key;
      label.addEventListener('input',()=>{csvMapping=csvMapping.map((c,j)=>j===i?{...c,label:label.value}:c);syncCsvFormat();schedulePreview()});
      const move=document.createElement('div');move.className='csv-column-move';
      for (const [delta,text,title] of [[-1,'↑','Move up'],[1,'↓','Move down']]) {const b=document.createElement('button');b.type='button';b.className='secondary icon-button';b.textContent=text;b.setAttribute('aria-label',`${title}: ${name}`);b.disabled=i+delta<0||i+delta>=csvMapping.length;b.onclick=()=>{changeMapping(moveCsvColumn(csvMapping,i,delta));list.children[i+delta]?.querySelector(`button[aria-label^="${title}"]`)?.focus()};move.append(b)}
      li.append(pick,field,label,move);list.append(li);
    });
  };
  let previewTimer=null, previewToken=0;
  const schedulePreview=()=>{clearTimeout(previewTimer);if($('csv-format').open)previewTimer=setTimeout(()=>void renderPreview(),200)};
  const renderPreview=async()=>{
    const token=++previewToken;
    const columns=csvColumnsFromMapping(csvMapping);
    const selected=selectedHistoryIds();
    const ids=(selected.length?selected:history.map(invoice=>invoice.id)).slice(0,3);
    let request,source;
    if (ids.length) {request=['/api/invoices/csv',{ids,columns}];source=selected.length?'selected invoices':'saved invoices'}
    else if (!$('review').hidden) {request=['/api/csv',{invoice:getInvoice(),columns}];source='the invoice under review'}
    else {request=['/api/csv',{invoice:{supplier:'Sample Supplier',invoice_number:'INV-001',date:'2026-01-31',currency:'INR',subtotal:150,tax:27,total:177,items:[{description:'Sample item',quantity:2,unit_price:50,amount:100},{description:'Second item',quantity:1,unit_price:50,amount:50}]},columns}];source='a sample invoice'}
    try {
      const r=await fetch(request[0],{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request[1])});
      if(!r.ok)throw Error();
      const parsed=parseCsv(await r.text());
      if (token!==previewToken) return;
      const table=$('csv-preview');table.replaceChildren();
      const [header,...body]=parsed;
      const thead=document.createElement('thead');const htr=document.createElement('tr');for(const text of header){const th=document.createElement('th');th.scope='col';th.textContent=text;htr.append(th)}thead.append(htr);
      const tbody=document.createElement('tbody');for(const cells of body.slice(0,5)){const tr=document.createElement('tr');for(const text of cells){const td=document.createElement('td');td.textContent=text;tr.append(td)}tbody.append(tr)}
      table.append(thead,tbody);
      $('csv-preview-note').textContent=`${Math.min(body.length,5)} of ${body.length} row${body.length===1?'':'s'} from ${source}`;
    } catch { if (token===previewToken) $('csv-preview-note').textContent='Preview unavailable.'; }
  };
  $('csv-format').addEventListener('toggle',()=>schedulePreview());
  $('csv-preset').onchange=()=>{
    const id=$('csv-preset').value||null;
    csvPresets={...csvPresets,activeId:id};writeCsvPresets(csvPresets);
    csvMapping=id?csvMappingFromColumns(activePreset().columns):defaultCsvMapping();
    msg('csv-preset-message',id?`Using preset “${activePreset().name}”.`:'Using the default format.');
    renderPresets();renderCsvColumns();schedulePreview();
  };
  $('csv-preset-save').onclick=()=>{if(commitPresets(updateCsvPreset(csvPresets,csvPresets.activeId,csvColumnsFromMapping(csvMapping)),'Preset saved.'))changeMapping(csvMappingFromColumns(activePreset().columns))};
  $('csv-preset-save-as').onclick=()=>{if(commitPresets(addCsvPreset(csvPresets,$('csv-preset-name').value,csvColumnsFromMapping(csvMapping)),'Preset saved.'))changeMapping(csvMappingFromColumns(activePreset().columns))};
  $('csv-preset-rename').onclick=()=>commitPresets(renameCsvPreset(csvPresets,csvPresets.activeId,$('csv-preset-name').value),'Preset renamed.');
  $('csv-preset-delete').onclick=()=>{
    const preset=activePreset();
    if(!preset||!confirm(`Delete the preset “${preset.name}”? This cannot be undone.`))return;
    if(commitPresets(deleteCsvPreset(csvPresets,preset.id),`Deleted “${preset.name}”. Using the default format.`))changeMapping(defaultCsvMapping());
  };
  $('csv-reset').onclick=()=>{changeMapping(defaultCsvMapping());msg('csv-preset-message','Columns reset to the default format. Save to keep this in the selected preset.')};
  renderPresets();renderCsvColumns();
  $('history-selected').onclick=()=>{const ids=selectedHistoryIds();if(ids.length)void downloadHistory(ids)};
  $('history-all').onclick=()=>downloadHistory();
  $('history-refresh').onclick=()=>{msg('history-message','');void loadHistory()};
  void loadHistory();
  void restoreLastSubmission();
}

if (typeof document!=='undefined') init();
