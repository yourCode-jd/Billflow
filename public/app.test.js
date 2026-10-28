import test from 'node:test';
import assert from 'node:assert/strict';
import {CSV_FIELDS,DEFAULT_CSV_COLUMNS} from '../server/invoice.js';
import {pollSubmissionStatus,STATUS_POLL_DELAYS_MS,addCsvPreset,CSV_FIELD_OPTIONS,CSV_PRESETS_STORAGE_KEY,csvColumnsFromMapping,csvMappingFromColumns,defaultCsvMapping,deleteCsvPreset,moveCsvColumn,parseCsv,readCsvPresets,renameCsvPreset,sameCsvColumns,updateCsvPreset,writeCsvPresets,displayGstPercent,historyCsvFilename,historyExportBody,historyTotalText,stateTone,DUPLICATE_SUBMISSION_MESSAGE,gstRateForStorage,LAST_DUPLICATE_SUBMISSION_STORAGE_KEY,LAST_SUBMISSION_STORAGE_KEY,parseInvoiceNumber,readLastSubmissionId,rememberDuplicateSubmissionId,rememberSubmissionId,restoreSubmissionState,restoredInvoiceFields,restoredInvoiceItems,statusWarningText,submissionResultKind} from './app.js';

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
  assert.ok(n8n.calls()<=12);
  assert.ok(clock.waits.reduce((a,b)=>a+b,0)<=120000);
  assert.equal(readLastSubmissionId(browserStorage),pollId);
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
