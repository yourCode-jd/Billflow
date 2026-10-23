import test from 'node:test';
import assert from 'node:assert/strict';
import {LAST_SUBMISSION_STORAGE_KEY,readLastSubmissionId,rememberSubmissionId,restoreSubmissionState} from './app.js';

const storage=initial=>{const values=new Map(Object.entries(initial||{}));return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)}};

test('restoration skips cleanly when no submission ID is stored',async()=>{
  const result=await restoreSubmissionState({storage:storage(),fetchStatus:async()=>{throw new Error('must not fetch')}});
  assert.deepEqual(result,{kind:'none'});
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
