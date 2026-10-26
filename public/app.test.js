import test from 'node:test';
import assert from 'node:assert/strict';
import {displayGstPercent,DUPLICATE_SUBMISSION_MESSAGE,gstRateForStorage,LAST_DUPLICATE_SUBMISSION_STORAGE_KEY,LAST_SUBMISSION_STORAGE_KEY,parseInvoiceNumber,readLastSubmissionId,rememberDuplicateSubmissionId,rememberSubmissionId,restoreSubmissionState,restoredInvoiceFields,restoredInvoiceItems,submissionResultKind} from './app.js';

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
  assert.deepEqual(restoredInvoiceFields({supplier_name:'Supplier',invoice_number:'INV-1',date:'2026-10-26',gstin:'',payment_mode:'',currency:'INR',subtotal:'1,11,500.00',gst_total:18570,round_off:0,grand_total:'1,30,070.00'}),{supplier:'Supplier',invoice_number:'INV-1',date:'2026-10-26',gstin:'',payment_mode:'',currency:'INR',subtotal:111500,tax:18570,round_off:0,total:130070});
  assert.equal(parseInvoiceNumber('not a number'),'');
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
