import test from 'node:test';
import assert from 'node:assert/strict';
import {CSV_FIELDS,DEFAULT_CSV_COLUMNS} from '../server/invoice.js';
import {EXTRACTION_RETRY_DELAYS_MS,extractionFailureText,followWithExtractionRetries,isTransientExtractionFailure,invoiceFileKey,MAX_UPLOAD_FILES,selectInvoiceFiles,uploadInvoiceBatch,formatWait,pollSubmissionStatus,STATUS_POLL_DELAYS_MS,STATUS_POLL_MAX_WAIT_MS,addCsvPreset,CSV_FIELD_OPTIONS,CSV_PRESETS_STORAGE_KEY,csvColumnsFromMapping,csvMappingFromColumns,defaultCsvMapping,deleteCsvPreset,moveCsvColumn,parseCsv,readCsvPresets,renameCsvPreset,sameCsvColumns,updateCsvPreset,writeCsvPresets,displayGstPercent,historyCsvFilename,historyExportBody,historyTotalText,stateTone,DUPLICATE_SUBMISSION_MESSAGE,gstRateForStorage,LAST_DUPLICATE_SUBMISSION_STORAGE_KEY,LAST_SUBMISSION_STORAGE_KEY,parseInvoiceNumber,readLastSubmissionId,rememberDuplicateSubmissionId,rememberSubmissionId,restoreSubmissionState,restoredInvoiceFields,restoredInvoiceItems,statusWarningText,submissionResultKind} from './app.js';

const storage=initial=>{const values=new Map(Object.entries(initial||{}));return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)}};

test('restoration skips cleanly when no submission ID is stored',async()=>{
  const result=await restoreSubmissionState({storage:storage(),fetchStatus:async()=>{throw new Error('must not fetch')}});
  assert.deepEqual(result,{kind:'none'});
});
test('keeps the stored submission in processing when status reports found false',async()=>{
  const submissionId='123e4567-e89b-42d3-a456-426614174000';
  const result=await restoreSubmissionState({storage:storage({[LAST_SUBMISSION_STORAGE_KEY]:submissionId}),fetchStatus:async()=>({found:false,state:'processing'})});
  assert.deepEqual(result,{kind:'processing',submissionId,status:{found:false,state:'processing'}});
});
test('restores a confirmed duplicate without treating it as processing',async()=>{
  const submissionId='123e4567-e89b-42d3-a456-426614174000';
  const browserStorage=storage({[LAST_SUBMISSION_STORAGE_KEY]:submissionId});
  const result=await restoreSubmissionState({storage:browserStorage,fetchStatus:async()=>({found:false,duplicate:true,state:'duplicate'})});
  assert.equal(result.kind,'duplicate');
  assert.equal(browserStorage.getItem(LAST_DUPLICATE_SUBMISSION_STORAGE_KEY),submissionId);
});
test('retains a confirmed duplicate result for refresh when status has no record',async()=>{
  const submissionId='123e4567-e89b-42d3-a456-426614174000';
  const browserStorage=storage({[LAST_SUBMISSION_STORAGE_KEY]:submissionId});
  rememberDuplicateSubmissionId(submissionId,browserStorage);
  const result=await restoreSubmissionState({storage:browserStorage,fetchStatus:async()=>({found:false,state:'processing'})});
  assert.equal(result.kind,'duplicate');
});
test('does not restore old invoice details for a confirmed duplicate on refresh',async()=>{
  const duplicateId='sub-1792746870954-svpovbjnuh';
  const originalId='sub-1792746870954-original';
  const browserStorage=storage({[LAST_SUBMISSION_STORAGE_KEY]:duplicateId});
  rememberDuplicateSubmissionId(duplicateId,browserStorage);
  const result=await restoreSubmissionState({storage:browserStorage,fetchStatus:async()=>({
    found:true,
    submission_id:duplicateId,
    supplier_name:'Previously saved invoice',
    items:[{description:'Old line item'}]
  })});
  assert.equal(result.kind,'duplicate');
  assert.equal(result.status.supplier_name,'Previously saved invoice');
  assert.match(DUPLICATE_SUBMISSION_MESSAGE,/No duplicate record was created/);
  const recovered=await restoreSubmissionState({storage:browserStorage,submissionId:originalId,fetchStatus:async()=>({
    found:true,
    submission_id:originalId,
    supplier_name:'Original invoice',
    items:[{description:'Original line item'}]
  })});
  assert.equal(recovered.kind,'found');
  assert.equal(recovered.status.supplier_name,'Original invoice');
});
test('keeps normal found and processing status outcomes unchanged',()=>{
  const submissionId='123e4567-e89b-42d3-a456-426614174000';
  const browserStorage=storage();
  assert.equal(submissionResultKind({found:true},submissionId,browserStorage),'found');
  assert.equal(submissionResultKind({found:false},submissionId,browserStorage),'processing');
});
test('does not infer duplicate from an existing invoice without an explicit duplicate flag',async()=>{
  const submissionId='sub-1792746870954-svpovbjnuh';
  const result=await restoreSubmissionState({storage:storage({[LAST_SUBMISSION_STORAGE_KEY]:submissionId}),fetchStatus:async()=>({
    found:true,
    submission_id:submissionId,
    supplier_name:'Previously saved invoice',
    items:[{description:'Existing line item'}]
  })});
  assert.equal(result.kind,'found');
  assert.equal(result.status.supplier_name,'Previously saved invoice');
});
test('uses a manually entered ID instead of a different stored ID',async()=>{
  const storedId='123e4567-e89b-42d3-a456-426614174000';
  const providedId='sub-1792746870954-svpovbjnuh';
  const browserStorage=storage({[LAST_SUBMISSION_STORAGE_KEY]:storedId});
  let requestedId;
  const result=await restoreSubmissionState({storage:browserStorage,submissionId:providedId,fetchStatus:async id=>{
    requestedId=id;
    return {found:true};
  }});
  assert.equal(requestedId,providedId);
  assert.equal(result.kind,'found');
  assert.equal(browserStorage.getItem(LAST_SUBMISSION_STORAGE_KEY),providedId);
});
test('recovers with a supplied submission ID when browser storage is empty',async()=>{
  const browserStorage=storage();
  let requestedId;
  const result=await restoreSubmissionState({storage:browserStorage,submissionId:'sub-1792746870954-svpovbjnuh',fetchStatus:async id=>{
    requestedId=id;
    return {found:true,items:[{description:'Paper',gst_percent:0.18}]};
  }});
  assert.equal(requestedId,'sub-1792746870954-svpovbjnuh');
  assert.equal(result.kind,'found');
  assert.equal(browserStorage.getItem(LAST_SUBMISSION_STORAGE_KEY),'sub-1792746870954-svpovbjnuh');
});
test('stores only a valid non-secret submission ID for refresh restoration',()=>{
  const value='123e4567-e89b-42d3-a456-426614174000';
  const browserStorage=storage();
  assert.equal(rememberSubmissionId(undefined,browserStorage),false);
  assert.equal(rememberSubmissionId(value,browserStorage),true);
  assert.equal(browserStorage.getItem(LAST_SUBMISSION_STORAGE_KEY),value);
  assert.equal(readLastSubmissionId(browserStorage),value);
  assert.equal(rememberSubmissionId('not valid!',browserStorage),false);
});
test('restoration reports a failed status request without discarding the submission ID',async()=>{
  const browserStorage=storage({[LAST_SUBMISSION_STORAGE_KEY]:'123e4567-e89b-42d3-a456-426614174000'});
  const result=await restoreSubmissionState({storage:browserStorage,fetchStatus:async()=>{throw new Error('offline')}});
  assert.deepEqual(result,{kind:'error',submissionId:'123e4567-e89b-42d3-a456-426614174000'});
  assert.equal(readLastSubmissionId(browserStorage),'123e4567-e89b-42d3-a456-426614174000');
});
test('restoration returns source-of-truth saved status',async()=>{
  const submissionId='123e4567-e89b-42d3-a456-426614174000';
  const result=await restoreSubmissionState({storage:storage({[LAST_SUBMISSION_STORAGE_KEY]:submissionId}),fetchStatus:async()=>({found:true,state:'saved',review_status:'Needs Review'})});
  assert.equal(result.kind,'found');
  assert.equal(result.status.review_status,'Needs Review');
});
test('restores formatted invoice totals as numeric form values',()=>{
  assert.deepEqual(restoredInvoiceFields({supplier_name:'Supplier',invoice_number:'INV-1',date:'2026-10-26',gstin:'',payment_mode:'',currency:'INR',subtotal:'1,11,500.00',discount:0,gst_total:18570,round_off:0,grand_total:'1,30,070.00'}),{supplier:'Supplier',invoice_number:'INV-1',date:'2026-10-26',gstin:'',payment_mode:'',currency:'INR',subtotal:111500,discount:0,tax:18570,round_off:0,total:130070});
  assert.equal(parseInvoiceNumber('not a number'),'');
});
test('restores EcoMart discount, currency, all five line items, and genuine warnings',()=>{
  const restored=restoredInvoiceFields({supplier_name:'EcoMart Supplies',invoice_number:'ECO-2026-0824',date:'Oct 28, 2026',gstin:'',payment_mode:'',currency:'$',subtotal:1153.5,discount:-57.68,gst_total:95.8,round_off:'',grand_total:1191.62});
  assert.equal(restored.currency,'$');
  assert.equal(restored.discount,-57.68);
  assert.equal(restored.round_off,'');
  const items=restoredInvoiceItems([
    {description:'Coffee',quantity:20,unit_price:18.5,amount:370,gst_percent:8.5},
    {description:'Notebook',quantity:50,unit_price:4.25,amount:212.5,gst_percent:8.5},
    {description:'Toothbrush',quantity:30,unit_price:6.75,amount:202.5,gst_percent:8.5},
    {description:'Bottle',quantity:15,unit_price:15.9,amount:238.5,gst_percent:8.5},
    {description:'LED Bulb',quantity:40,unit_price:3.25,amount:130,gst_percent:8.5}
  ]);
  assert.equal(items.length,5);
  assert.ok(items.every(item=>item.gst_percent===8.5));
  assert.equal(statusWarningText({validation_notes:'GST mismatch: verify tax-inclusive/exclusive pricing'}),'GST mismatch: verify tax-inclusive/exclusive pricing');
  assert.equal(statusWarningText({validation_notes:''}),'');
});
test('converts fractional GST rates for display and back to the stored fraction',()=>{
  assert.equal(displayGstPercent(0.18),18);
  assert.equal(displayGstPercent(0.12),12);
  assert.equal(gstRateForStorage(18),0.18);
  assert.equal(gstRateForStorage(12),0.12);
});
test('restores GST percentage values into the line-item GST input mapping',()=>{
  assert.deepEqual(restoredInvoiceItems([{description:'Paper',quantity:2,unit_price:50,amount:100,gst_percent:0.18},{description:'Ink',gst_percent:0.12}]),[
    {description:'Paper',quantity:2,unit_price:50,amount:100,gst_percent:18},
    {description:'Ink',quantity:'',unit_price:'',amount:'',gst_percent:12}
  ]);
});
test('builds history CSV export requests for all, selected, and one invoice',()=>{
  const id='123e4567-e89b-42d3-a456-426614174000';
  assert.deepEqual(historyExportBody(),{});
  assert.deepEqual(historyExportBody([id,id,'../bad']),{ids:[id]});
  assert.equal(historyCsvFilename([{invoice_number:'ECO/2026 0824'}]),'invoice-ECO_2026_0824.csv');
  assert.equal(historyCsvFilename([{invoice_number:'',supplier:''}]),'invoice.csv');
  assert.equal(historyCsvFilename([{},{}]),'invoices.csv');
  assert.equal(historyTotalText({currency:'$',total:1191.62}),'$1191.62');
  assert.equal(historyTotalText({currency:'INR',total:125}),'INR 125');
  assert.equal(historyTotalText({currency:'INR',total:''}),'—');
});
test('maps review status labels to visual tones',()=>{
  assert.equal(stateTone('Not processed'),'neutral');
  assert.equal(stateTone('Loading…'),'progress');
  assert.equal(stateTone('Processing'),'progress');
  assert.equal(stateTone('Duplicate'),'warning');
  assert.equal(stateTone('Status unavailable'),'danger');
  assert.equal(stateTone('saved · Approved · valid'),'success');
  assert.equal(stateTone('saved · Needs Review · warning'),'warning');
  assert.equal(stateTone('Sent to n8n'),'success');
});
test('CSV field options match the server and default to the existing format',()=>{
  assert.deepEqual(CSV_FIELD_OPTIONS.map(option=>option.key),CSV_FIELDS);
  assert.deepEqual(csvColumnsFromMapping(defaultCsvMapping()),DEFAULT_CSV_COLUMNS);
});
test('maps, reorders and renames CSV columns',()=>{
  let mapping=defaultCsvMapping();
  mapping=moveCsvColumn(mapping,4,-4);
  assert.equal(mapping[0].key,'description');
  assert.equal(moveCsvColumn(mapping,0,-1),mapping);
  mapping=mapping.map(column=>column.key==='description'?{...column,label:'  Item  '}:column.key==='date'?{...column,include:false}:column.key==='currency'?{...column,label:'   '}:column);
  const columns=csvColumnsFromMapping(mapping);
  assert.equal(columns[0].label,'Item');
  assert.equal(columns.find(column=>column.key==='currency').label,'currency');
  assert.equal(columns.some(column=>column.key==='date'),false);
  const restored=csvMappingFromColumns(columns);
  assert.deepEqual(csvColumnsFromMapping(restored),columns);
  assert.deepEqual(restored.filter(column=>!column.include).map(column=>column.key).sort(),['date','line_number']);
  assert.equal(sameCsvColumns(columns,csvColumnsFromMapping(restored)),true);
  assert.equal(sameCsvColumns(columns,DEFAULT_CSV_COLUMNS),false);
});
test('saves, reuses, renames and deletes CSV presets in browser storage',()=>{
  const browserStorage=storage();
  assert.deepEqual(readCsvPresets(browserStorage),{presets:[],activeId:null});
  const columns=[{key:'invoice_number',label:'Bill'},{key:'total',label:'Total'}];
  let result=addCsvPreset({presets:[],activeId:null},'  Tally  ',columns,'p1');
  assert.equal(result.state.activeId,'p1');
  assert.equal(result.state.presets[0].name,'Tally');
  assert.equal(addCsvPreset(result.state,'tally',columns).error,'A preset with this name already exists.');
  assert.equal(addCsvPreset(result.state,' ',columns).error,'Enter a preset name.');
  assert.equal(addCsvPreset(result.state,'Empty',[]).error,'Choose at least one column.');
  result=addCsvPreset(result.state,'Zoho',[{key:'supplier',label:'Vendor'}],'p2');
  assert.ok(writeCsvPresets(result.state,browserStorage));
  const reloaded=readCsvPresets(browserStorage);
  assert.deepEqual(reloaded,result.state);
  assert.equal(renameCsvPreset(reloaded,'p2','Tally').error,'A preset with this name already exists.');
  let next=renameCsvPreset(reloaded,'p2','Zoho Books').state;
  assert.equal(next.presets[1].name,'Zoho Books');
  next=updateCsvPreset(next,'p2',[{key:'supplier',label:'Vendor name'},{key:'amount',label:'Amt'}]).state;
  assert.equal(next.presets[1].columns.length,2);
  next=deleteCsvPreset(next,'p2').state;
  assert.deepEqual(next.presets.map(preset=>preset.id),['p1']);
  assert.equal(next.activeId,null);
  assert.equal(deleteCsvPreset(next,'missing').error,'Select a saved preset first.');
});
test('ignores corrupt or tampered CSV preset storage',()=>{
  assert.deepEqual(readCsvPresets(storage({[CSV_PRESETS_STORAGE_KEY]:'{oops'})),{presets:[],activeId:null});
  const tampered=readCsvPresets(storage({[CSV_PRESETS_STORAGE_KEY]:JSON.stringify({activeId:'gone',presets:[{id:'a',name:'Bad',columns:[{key:'secret',label:'x'}]},{id:'b',name:'Ok',columns:[{key:'total',label:'T'},{key:'total',label:'dup'},{key:'nope'}]}]})}));
  assert.deepEqual(tampered,{presets:[{id:'b',name:'Ok',columns:[{key:'total',label:'T'}]}],activeId:null});
  assert.deepEqual(readCsvPresets({getItem(){throw new Error('blocked')}}),{presets:[],activeId:null});
  assert.equal(writeCsvPresets({presets:[],activeId:null},{setItem(){throw new Error('full')}}),false);
});
test('parses server CSV for the preview, including quotes, commas and the BOM',()=>{
  assert.deepEqual(parseCsv('﻿"A","B ""x"""\r\n"1,2","\'=Cable"\r\n'),[['A','B "x"'],['1,2',"'=Cable"]]);
});
const pollId='123e4567-e89b-42d3-a456-426614174000';
const scripted=responses=>{let calls=0;return {fetchStatus:async id=>{assert.equal(id,pollId);const next=responses[Math.min(calls++,responses.length-1)];if(next instanceof Error)throw next;return next},calls:()=>calls}};
const fakeSleep=()=>{const waits=[];return {sleep:async ms=>{waits.push(ms)},waits}};
test('upload follow-up re-checks until the invoice is found, with backoff',async()=>{
  const found={found:true,submission_id:pollId,items:[{description:'LED'}]};
  const n8n=scripted([{found:false},{found:false},{found:false},found]);
  const clock=fakeSleep();const progress=[];
  const result=await pollSubmissionStatus({fetchStatus:n8n.fetchStatus,submissionId:pollId,storage:storage(),sleep:clock.sleep,onProgress:p=>progress.push(p.attempt)});
  assert.equal(result.kind,'found');
  assert.equal(result.status,found);
  assert.equal(result.attempts,4);
  assert.equal(n8n.calls(),4);
  assert.deepEqual(clock.waits,STATUS_POLL_DELAYS_MS.slice(0,3));
  assert.deepEqual(progress,[1,2,3]);
});
test('upload follow-up stops at a duplicate and remembers it for refresh',async()=>{
  const browserStorage=storage();
  const n8n=scripted([{found:false},{found:true,duplicate:true,submission_id:pollId}]);
  const result=await pollSubmissionStatus({fetchStatus:n8n.fetchStatus,submissionId:pollId,storage:browserStorage,sleep:fakeSleep().sleep});
  assert.equal(result.kind,'duplicate');
  assert.equal(n8n.calls(),2);
  assert.equal(browserStorage.getItem(LAST_DUPLICATE_SUBMISSION_STORAGE_KEY),pollId);
});
test('upload follow-up treats a saved submission without line items as final',async()=>{
  const n8n=scripted([{found:true,submission_id:pollId,items:[]}]);
  const result=await pollSubmissionStatus({fetchStatus:n8n.fetchStatus,submissionId:pollId,storage:storage(),sleep:fakeSleep().sleep});
  assert.equal(result.kind,'found');
  assert.equal(n8n.calls(),1);
});
test('upload follow-up times out after a bounded number of requests and keeps the submission ID',async()=>{
  const browserStorage=storage();
  const n8n=scripted([{found:false}]);
  const clock=fakeSleep();
  const result=await pollSubmissionStatus({fetchStatus:n8n.fetchStatus,submissionId:pollId,storage:browserStorage,sleep:clock.sleep});
  assert.equal(result.kind,'timeout');
  assert.equal(n8n.calls(),STATUS_POLL_DELAYS_MS.length+1);
  assert.equal(n8n.calls(),20);
  assert.equal(clock.waits.reduce((a,b)=>a+b,0),7*60000);
  assert.equal(STATUS_POLL_MAX_WAIT_MS,7*60000);
  assert.equal(readLastSubmissionId(browserStorage),pollId);
});
test('upload follow-up waits long enough for a slow n8n run (~6 minutes) with conservative backoff',async()=>{
  // Fake n8n that finishes 6 minutes after upload, as seen in a live run.
  let now=0;const found={found:true,submission_id:pollId,items:[{description:'LED'}]};
  let calls=0;const fetchStatus=async()=>{calls++;return now>=6*60000?found:{found:false,state:'processing'}};
  const progress=[];
  const result=await pollSubmissionStatus({fetchStatus,submissionId:pollId,storage:storage(),sleep:async ms=>{now+=ms},onProgress:p=>progress.push(p)});
  assert.equal(result.kind,'found');
  assert.ok(now>=6*60000&&now<=6*60000+30000,'found within one interval of completion');
  assert.ok(calls<=18,`${calls} requests`);
  assert.ok(STATUS_POLL_DELAYS_MS.every((ms,i)=>ms<=30000&&(i===0||ms>=STATUS_POLL_DELAYS_MS[i-1])),'non-decreasing, capped at 30 s');
  assert.deepEqual(progress.slice(0,3).map(p=>p.elapsedMs),[0,2000,5000]);
  assert.equal(progress.at(-1).total,20);
});
test('formats waits for progress and timeout messages',()=>{
  assert.equal(formatWait(2000),'2 s');
  assert.equal(formatWait(90000),'1 min 30 s');
  assert.equal(formatWait(STATUS_POLL_MAX_WAIT_MS),'7 min');
});
test('upload follow-up retries a transient status error but stops after repeated errors',async()=>{
  const recovered=scripted([new Error('502'),{found:false},new Error('502'),{found:true,submission_id:pollId,items:[{}]}]);
  assert.equal((await pollSubmissionStatus({fetchStatus:recovered.fetchStatus,submissionId:pollId,storage:storage(),sleep:fakeSleep().sleep})).kind,'found');
  const failing=scripted([new Error('502')]);
  const result=await pollSubmissionStatus({fetchStatus:failing.fetchStatus,submissionId:pollId,storage:storage(),sleep:fakeSleep().sleep});
  assert.equal(result.kind,'error');
  assert.equal(failing.calls(),3);
});
test('upload follow-up stops without further requests once cancelled',async()=>{
  const n8n=scripted([{found:false}]);
  let cancelled=false;
  const result=await pollSubmissionStatus({fetchStatus:n8n.fetchStatus,submissionId:pollId,storage:storage(),sleep:async()=>{cancelled=true},isCancelled:()=>cancelled});
  assert.equal(result.kind,'cancelled');
  assert.equal(n8n.calls(),1);
});
test('upload follow-up cancelled late in a long wait makes no further requests',async()=>{
  const n8n=scripted([{found:false}]);
  let waited=0;
  const result=await pollSubmissionStatus({fetchStatus:n8n.fetchStatus,submissionId:pollId,storage:storage(),sleep:async ms=>{waited+=ms},isCancelled:()=>waited>=5*60000});
  assert.equal(result.kind,'cancelled');
  const callsAtCancel=n8n.calls();
  assert.ok(callsAtCancel>10&&callsAtCancel<20);
  assert.equal(result.attempts,callsAtCancel);
});

const invoiceFile=(name,{type='image/png',size=1000,lastModified=1}={})=>({name,type,size,lastModified});
test('multiple selection keeps each supported file once, in order, and explains the rest',()=>{
  const a=invoiceFile('a.png'),b=invoiceFile('b.pdf',{type:'application/pdf'});
  const {files,rejected}=selectInvoiceFiles([a,invoiceFile('notes.txt',{type:'text/plain'}),b,{...a},invoiceFile('big.jpg',{type:'image/jpeg',size:10*1024*1024+1})]);
  assert.deepEqual(files,[a,b]);
  assert.deepEqual(rejected,[
    {name:'notes.txt',reason:'Please choose JPG, PNG, WebP or PDF.'},
    {name:'a.png',reason:'Selected more than once; it is sent only once.'},
    {name:'big.jpg',reason:'The file must be smaller than 10 MB.'}
  ]);
  // Same name but a different file is not a duplicate.
  assert.equal(selectInvoiceFiles([a,invoiceFile('a.png',{size:2000})]).files.length,2);
  const many=Array.from({length:MAX_UPLOAD_FILES+2},(_,i)=>invoiceFile(`f${i}.png`));
  const capped=selectInvoiceFiles(many);
  assert.equal(capped.files.length,MAX_UPLOAD_FILES);
  assert.deepEqual(capped.rejected.map(r=>r.name),[`f${MAX_UPLOAD_FILES}.png`,`f${MAX_UPLOAD_FILES+1}.png`]);
});
test('a single selected file behaves as before',()=>{
  const a=invoiceFile('a.png');
  assert.deepEqual(selectInvoiceFiles([a]),{files:[a],rejected:[]});
  assert.deepEqual(selectInvoiceFiles([invoiceFile('a.gif',{type:'image/gif'})]).files,[]);
});
test('batch upload processes each file independently and continues after a failure',async()=>{
  const files=[invoiceFile('one.png'),invoiceFile('two.png'),invoiceFile('three.png'),invoiceFile('four.png')];
  const uploaded=[];const seen=[];
  const upload=async file=>{
    uploaded.push(file.name);
    if (file.name==='two.png') throw Error('The invoice-processing service is temporarily unavailable. [N8N_WEBHOOK_UNAVAILABLE]');
    if (file.name==='three.png') return {submission_id:`id-${file.name}`,duplicate:true,message:'Duplicate bill detected'};
    return {submission_id:`id-${file.name}`,message:'Accepted for processing — not yet saved.'};
  };
  const results=await uploadInvoiceBatch({files,upload,onResult:(result,index)=>seen.push([index,result.file.name,result.status])});
  assert.deepEqual(uploaded,['one.png','two.png','three.png','four.png']);
  assert.deepEqual(results.map(r=>[r.file.name,r.status,r.submissionId??r.error]),[
    ['one.png','accepted','id-one.png'],
    ['two.png','failed','The invoice-processing service is temporarily unavailable. [N8N_WEBHOOK_UNAVAILABLE]'],
    ['three.png','duplicate','id-three.png'],
    ['four.png','accepted','id-four.png']
  ]);
  assert.deepEqual(seen,[[0,'one.png','accepted'],[1,'two.png','failed'],[2,'three.png','duplicate'],[3,'four.png','accepted']]);
});
test('batch upload does not resend accepted files on a second click but retries failed ones',async()=>{
  const files=[invoiceFile('one.png'),invoiceFile('two.png')];
  const sent=new Set();let failTwo=true;const calls=[];
  const upload=async file=>{calls.push(file.name);if(file.name==='two.png'&&failTwo)throw Error('Upload failed.');return {submission_id:`id-${file.name}`}};
  await uploadInvoiceBatch({files,upload,sent});
  failTwo=false;
  const second=await uploadInvoiceBatch({files,upload,sent});
  assert.deepEqual(calls,['one.png','two.png','two.png']);
  assert.deepEqual(second.map(r=>r.status),['skipped','accepted']);
  assert.deepEqual([...sent],files.map(invoiceFileKey));
});

const failedStatus=message=>({found:false,submission_id:pollId,state:'failed',review_status:'Extraction Failed',items:[],message});
test('an extraction failure recorded by n8n is final instead of "processing"',async()=>{
  assert.equal(submissionResultKind(failedStatus('Gemini extraction failed: 503'),pollId,storage()),'failed');
  assert.equal(submissionResultKind({found:false,state:'processing'},pollId,storage()),'processing');
  const n8n=scripted([failedStatus('Gemini extraction failed: The service is currently unavailable. [503]')]);
  const result=await pollSubmissionStatus({fetchStatus:n8n.fetchStatus,submissionId:pollId,storage:storage(),sleep:fakeSleep().sleep});
  assert.equal(result.kind,'failed');
  assert.equal(n8n.calls(),1);
});
test('classifies transient Gemini and connection errors',()=>{
  for (const message of ['Gemini extraction failed: The service is currently unavailable. [503 Service Unavailable]','The model is overloaded. Please try again later.','Gemini extraction failed: [429 Too Many Requests] Resource has been exhausted','read ECONNRESET','connect ETIMEDOUT 142.250.0.1:443','socket hang up','Request timed out'])
    assert.equal(isTransientExtractionFailure(message),true,message);
  for (const message of ['Gemini extraction failed: [400 Bad Request] Unsupported MIME type','API key not valid. Please pass a valid API key.','',undefined])
    assert.equal(isTransientExtractionFailure(message),false,String(message));
});
const sequence=(...steps)=>{let i=0;return async()=>{const step=steps[Math.min(i++,steps.length-1)];if(step instanceof Error)throw step;return step}};
test('a transient extraction failure is sent again after a backoff, with a new submission ID',async()=>{
  const followed=[];const waits=[];const retries=[];
  const follow=async id=>{followed.push(id);return id==='retry-1'?{kind:'found',submissionId:id,status:{found:true,items:[{}]}}:{kind:'failed',submissionId:id,status:failedStatus('Gemini extraction failed: [503] overloaded')}};
  let uploads=0;
  const result=await followWithExtractionRetries({submissionId:'first',follow,reupload:async()=>{uploads++;return {submission_id:'retry-1'}},sleep:async ms=>{waits.push(ms)},onRetry:r=>retries.push([r.retry,r.total,r.submissionId])});
  assert.equal(result.kind,'found');
  assert.equal(result.submissionId,'retry-1');
  assert.equal(result.retries,1);
  assert.deepEqual(followed,['first','retry-1']);
  assert.equal(uploads,1);
  assert.deepEqual(waits,[EXTRACTION_RETRY_DELAYS_MS[0]]);
  assert.deepEqual(retries,[[1,2,'first']]);
});
test('extraction retries are bounded and report the failure',async()=>{
  let uploads=0;const waits=[];
  const result=await followWithExtractionRetries({submissionId:'first',follow:async id=>({kind:'failed',submissionId:id,status:failedStatus('Gemini extraction failed: The service is currently unavailable.')}),reupload:async()=>({submission_id:`retry-${++uploads}`}),sleep:async ms=>{waits.push(ms)}});
  assert.equal(result.kind,'failed');
  assert.equal(result.retries,2);
  assert.equal(uploads,2);
  assert.deepEqual(waits,EXTRACTION_RETRY_DELAYS_MS);
  assert.equal(EXTRACTION_RETRY_DELAYS_MS.reduce((a,b)=>a+b,0),150000);
  assert.match(extractionFailureText(result),/Extraction failed after 2 automatic retries; nothing was saved to Google Sheets\.$/);
});
test('a permanent extraction failure is not retried automatically',async()=>{
  let uploads=0;
  const result=await followWithExtractionRetries({submissionId:'first',follow:async id=>({kind:'failed',submissionId:id,status:failedStatus('Gemini extraction failed: [400 Bad Request] Unsupported MIME type')}),reupload:async()=>{uploads++;return {submission_id:'x'}},sleep:async()=>{}});
  assert.equal(result.kind,'failed');
  assert.equal(result.transient,false);
  assert.equal(uploads,0);
});
test('extraction retry stops when cancelled, when re-sending fails, or when the re-sent file is a duplicate',async()=>{
  const failing=async id=>({kind:'failed',submissionId:id,status:failedStatus('503 unavailable')});
  let uploads=0;let cancelled=false;
  const cancelledResult=await followWithExtractionRetries({submissionId:'first',follow:failing,reupload:async()=>{uploads++;return {submission_id:'x'}},sleep:async()=>{cancelled=true},isCancelled:()=>cancelled});
  assert.equal(cancelledResult.kind,'cancelled');
  assert.equal(uploads,0);
  const uploadFailed=await followWithExtractionRetries({submissionId:'first',follow:failing,reupload:sequence(Error('The invoice-processing service is temporarily unavailable. Retry later.')),sleep:async()=>{}});
  assert.equal(uploadFailed.kind,'upload-failed');
  assert.match(uploadFailed.error,/temporarily unavailable/);
  const duplicate=await followWithExtractionRetries({submissionId:'first',follow:failing,reupload:sequence({submission_id:'dup-id',duplicate:true}),sleep:async()=>{}});
  assert.equal(duplicate.kind,'duplicate');
  assert.equal(duplicate.submissionId,'dup-id');
  assert.equal(duplicate.uploadDuplicate,true);
  // Other outcomes pass through without any retry.
  const found=await followWithExtractionRetries({submissionId:'first',follow:async id=>({kind:'timeout',submissionId:id}),reupload:async()=>assert.fail('no re-upload'),sleep:async()=>assert.fail('no wait')});
  assert.equal(found.kind,'timeout');
});
