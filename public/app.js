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

function init() {
  const $=id=>document.getElementById(id);
  let file=null, rows=[];
  const fields=['supplier','invoice_number','date','currency','subtotal','discount','tax','round_off','total'];
  const msg=(id,text)=>{$(id).textContent=text};
  const setEmpty=text=>{$('review').hidden=true;$('empty').hidden=false;$('empty').textContent=text};
  const getInvoice=()=>{const invoice={};for(const k of fields) invoice[k]=['subtotal','discount','tax','round_off','total'].includes(k)?num($(k).value):$(k).value.trim();invoice.items=rows.map(r=>({description:r.description,quantity:num(r.quantity),unit_price:num(r.unit_price),amount:num(r.amount),gst_percent:gstRateForStorage(r.gst_percent)}));return invoice};
  const num=v=>v===''||v===null||v===undefined?null:Number(v);
  const setFile=f=>{if(!f)return;if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(f.type)){msg('message','Please choose JPG, PNG, WebP or PDF.');return}if(f.size>10*1024*1024){msg('message','The file must be smaller than 10 MB.');return}file=f;$('filename').textContent=f.name;$('extract').disabled=false;msg('message','')};
  $('file').addEventListener('change',e=>setFile(e.target.files[0]));
  const drop=document.querySelector('.drop');
  drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('drag')});
  drop.addEventListener('dragleave',()=>drop.classList.remove('drag'));
  drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('drag');setFile(e.dataTransfer.files[0])});
  const renderRows=()=>{const body=$('rows');body.replaceChildren();rows.forEach((item,i)=>{const tr=document.createElement('tr');for(const k of ['description','quantity','unit_price','amount','gst_percent']){const td=document.createElement('td');const input=document.createElement('input');input.setAttribute('aria-label',`Row ${i+1} ${k}`);input.value=item[k]??'';input.type=k==='description'?'text':'number';if(input.type==='number')input.step='any';input.addEventListener('input',()=>{rows[i][k]=input.value;$('approved').checked=false;sync()});td.append(input);tr.append(td)}const td=document.createElement('td');const b=document.createElement('button');b.className='remove';b.textContent='×';b.setAttribute('aria-label',`Remove row ${i+1}`);b.onclick=()=>{rows.splice(i,1);$('approved').checked=false;renderRows();sync()};td.append(b);tr.append(td);body.append(tr)})};
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
  $('recover').onclick=async()=>{
    const submissionId=$('recovery-id').value.trim();
    if(!isSubmissionId(submissionId)) {msg('recovery-message','Enter a valid submission ID.');return;}
    $('recover').disabled=true;
    msg('recovery-message','Looking up the saved invoice…');
    await restoreLastSubmission(submissionId);
    $('recover').disabled=false;
  };
  $('approved').onchange=sync;
  for(const k of fields)$(k).addEventListener('input',()=>{$('approved').checked=false;sync()});
  $('add').onclick=()=>{rows.push({description:'',quantity:null,unit_price:null,amount:null});$('approved').checked=false;renderRows();sync()};
  $('extract').onclick=async()=>{if(!file)return;$('extract').disabled=true;$('duplicate-warning').hidden=true;msg('message','Sending invoice for processing…');try{const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file)});const response=await fetch('/api/extract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base64,mimeType:file.type,fileName:file.name})});const data=await response.json();if(!response.ok)throw Error((data.error||'Upload failed.')+(data.code?` [${data.code}]`:''));if(!rememberSubmissionId(data.submission_id))throw Error('Upload was accepted, but its submission ID was invalid.');if(data.duplicate===true){rememberDuplicateSubmissionId(data.submission_id);showDuplicate();msg('message',data.message||DUPLICATE_SUBMISSION_MESSAGE);return;}$('state').textContent='Processing';setEmpty('Checking the submitted invoice status…');msg('message',data.message||'Accepted for processing — not yet saved.');await restoreLastSubmission()}catch(e){msg('message',e.message||'Upload failed.')}finally{$('extract').disabled=false}};
  $('csv').onclick=async()=>{try{const r=await fetch('/api/csv',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({invoice:getInvoice()})});if(!r.ok)throw Error('Could not generate CSV.');const blob=await r.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='invoice.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);msg('save-message','CSV downloaded. Review it before importing into accounting software.')}catch(e){msg('save-message',e.message)}};
  $('save').onclick=async()=>{msg('save-message','Sending to n8n…');try{const r=await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({invoice:getInvoice(),confirmedWarnings:true})});const data=await r.json();if(!r.ok)throw Error(data.error);msg('save-message',data.message);$('state').textContent='Sent to n8n'}catch(e){msg('save-message',e.message)}};
  void restoreLastSubmission();
}

if (typeof document!=='undefined') init();
