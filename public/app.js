export const LAST_SUBMISSION_STORAGE_KEY='bill-ai:last-submission-id';

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
export async function restoreSubmissionState({storage=globalThis.localStorage,fetchStatus}) {
  const submissionId=readLastSubmissionId(storage);
  if (!submissionId) return {kind:'none'};
  try {
    const status=await fetchStatus(submissionId);
    return status?.found ? {kind:'found',submissionId,status} : {kind:'processing',submissionId,status};
  } catch { return {kind:'error',submissionId}; }
}

function init() {
  const $=id=>document.getElementById(id);
  let file=null, rows=[];
  const fields=['supplier','invoice_number','date','currency','subtotal','tax','total'];
  const msg=(id,text)=>{$(id).textContent=text};
  const setEmpty=text=>{$('review').hidden=true;$('empty').hidden=false;$('empty').textContent=text};
  const getInvoice=()=>{const invoice={};for(const k of fields) invoice[k]=['subtotal','tax','total'].includes(k)?num($(k).value):$(k).value.trim();invoice.items=rows.map(r=>({description:r.description,quantity:num(r.quantity),unit_price:num(r.unit_price),amount:num(r.amount)}));return invoice};
  const num=v=>v===''||v===null||v===undefined?null:Number(v);
  const setFile=f=>{if(!f)return;if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(f.type)){msg('message','Please choose JPG, PNG, WebP or PDF.');return}if(f.size>10*1024*1024){msg('message','The file must be smaller than 10 MB.');return}file=f;$('filename').textContent=f.name;$('extract').disabled=false;msg('message','')};
  $('file').addEventListener('change',e=>setFile(e.target.files[0]));
  const drop=document.querySelector('.drop');
  drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('drag')});
  drop.addEventListener('dragleave',()=>drop.classList.remove('drag'));
  drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('drag');setFile(e.dataTransfer.files[0])});
  const renderRows=()=>{const body=$('rows');body.replaceChildren();rows.forEach((item,i)=>{const tr=document.createElement('tr');for(const k of ['description','quantity','unit_price','amount']){const td=document.createElement('td');const input=document.createElement('input');input.setAttribute('aria-label',`Row ${i+1} ${k}`);input.value=item[k]??'';input.type=k==='description'?'text':'number';if(input.type==='number')input.step='any';input.addEventListener('input',()=>{rows[i][k]=input.value;$('approved').checked=false;sync()});td.append(input);tr.append(td)}const td=document.createElement('td');const b=document.createElement('button');b.className='remove';b.textContent='×';b.setAttribute('aria-label',`Remove row ${i+1}`);b.onclick=()=>{rows.splice(i,1);$('approved').checked=false;renderRows();sync()};td.append(b);tr.append(td);body.append(tr)})};
  const sync=()=>{const checked=$('approved').checked;$('csv').disabled=!checked;$('save').disabled=!checked};
  const fetchSubmissionStatus=async submissionId=>{const response=await fetch(`/api/submissions/${encodeURIComponent(submissionId)}/status`);let data={};try{data=await response.json()}catch{}if(!response.ok)throw Error((data.error||'Could not restore submission status.')+(data.code?` [${data.code}]`:''));return data};
  const renderStatus=status=>{
    if (!status.found) {$('state').textContent='Processing';setEmpty('This submission is still processing. Check again shortly.');return;}
    const label=[status.state,status.review_status].filter(Boolean).join(' · ') || 'Saved';
    $('state').textContent=label;
    const reference=[status.supplier_name,status.invoice_number].filter(Boolean).join(' · ');
    setEmpty(`${reference ? `${reference} was saved. ` : 'Submission was saved. '}Invoice details are not available in the status response.`);
  };
  const restoreLastSubmission=async()=>{
    const storedId=readLastSubmissionId();
    if (!storedId) return;
    $('state').textContent='Loading…';
    setEmpty('Restoring the last submitted invoice…');
    const result=await restoreSubmissionState({fetchStatus:fetchSubmissionStatus});
    if (result.kind==='found'||result.kind==='processing') return renderStatus(result.status);
    if (result.kind==='error') {$('state').textContent='Status unavailable';setEmpty('Could not restore the last submission. Check your connection and refresh.');}
  };
  $('approved').onchange=sync;
  for(const k of fields)$(k).addEventListener('input',()=>{$('approved').checked=false;sync()});
  $('add').onclick=()=>{rows.push({description:'',quantity:null,unit_price:null,amount:null});$('approved').checked=false;renderRows();sync()};
  $('extract').onclick=async()=>{if(!file)return;$('extract').disabled=true;msg('message','Sending invoice for processing…');try{const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file)});const response=await fetch('/api/extract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base64,mimeType:file.type,fileName:file.name})});const data=await response.json();if(!response.ok)throw Error((data.error||'Upload failed.')+(data.code?` [${data.code}]`:''));if(!rememberSubmissionId(data.submission_id))throw Error('Upload was accepted, but its submission ID was invalid.');$('state').textContent='Processing';setEmpty('Checking the submitted invoice status…');msg('message',data.message||'Accepted for processing — not yet saved.');await restoreLastSubmission()}catch(e){msg('message',e.message||'Upload failed.')}finally{$('extract').disabled=false}};
  $('csv').onclick=async()=>{try{const r=await fetch('/api/csv',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({invoice:getInvoice()})});if(!r.ok)throw Error('Could not generate CSV.');const blob=await r.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='invoice.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);msg('save-message','CSV downloaded. Review it before importing into accounting software.')}catch(e){msg('save-message',e.message)}};
  $('save').onclick=async()=>{msg('save-message','Sending to n8n…');try{const r=await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({invoice:getInvoice(),confirmedWarnings:true})});const data=await r.json();if(!r.ok)throw Error(data.error);msg('save-message',data.message);$('state').textContent='Sent to n8n'}catch(e){msg('save-message',e.message)}};
  void restoreLastSubmission();
}

if (typeof document!=='undefined') init();
