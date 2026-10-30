import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createHistoryStore } from './history.js';
import { safeCsv, safeCsvMany } from './invoice.js';
import { createServer } from './index.js';

const invoiceA={supplier:'EcoMart Supplies',invoice_number:'ECO-2026-0824',date:'2026-08-24',currency:'$',subtotal:180,discount:null,tax:0,total:180,items:[{description:'LED Bulb',quantity:40,unit_price:3.25,amount:130},{description:'=Cable',quantity:2,unit_price:25,amount:50}]};
const invoiceB={supplier:'GreenLeaf',invoice_number:'GL-7',date:'2026-09-01',currency:'INR',subtotal:125,discount:null,tax:0,total:125,items:[{description:'Paper Towels',quantity:10,unit_price:12.5,amount:125}]};
const invoiceC={supplier:'Shree Ganesh',invoice_number:'SG-1',date:'2026-09-02',currency:'INR',subtotal:50,discount:null,tax:0,total:50,items:[{description:'Wood',quantity:1,unit_price:50,amount:50}]};
const idA='123e4567-e89b-42d3-a456-426614174000';
const idB='223e4567-e89b-42d3-a456-426614174000';
const idC='323e4567-e89b-42d3-a456-426614174000';

async function tempFile(t) {
  const dir=await mkdtemp(join(tmpdir(),'billflow-history-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return join(dir,'nested','invoices.json');
}
async function startServer(t,history) {
  const server=createServer({history});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  return `http://127.0.0.1:${server.address().port}`;
}
const postJson=(url,body)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

test('history persists invoices with line items across store instances',async t=>{
  const file=await tempFile(t);
  await createHistoryStore({file}).upsert({submissionId:idA,source:'n8n',invoice:invoiceA});
  await createHistoryStore({file}).upsert({submissionId:idB,source:'n8n',invoice:invoiceB});
  const records=await createHistoryStore({file}).list();
  assert.deepEqual(records.map(record=>record.id).sort(),[idA,idB]);
  assert.deepEqual(records.find(record=>record.id===idA).invoice.items,invoiceA.items);
});
test('history updates one record per submission and keeps the approved version',async()=>{
  const store=createHistoryStore();
  await store.upsert({submissionId:idA,source:'n8n',invoice:invoiceA});
  await store.upsert({submissionId:idA,source:'approved',invoice:{...invoiceA,total:181}});
  await store.upsert({submissionId:idA,source:'n8n',invoice:invoiceA});
  const records=await store.list();
  assert.equal(records.length,1);
  assert.equal(records[0].source,'approved');
  assert.equal(records[0].invoice.total,181);
});
test('approved invoices without a submission ID are matched by supplier and invoice number',async()=>{
  const store=createHistoryStore();
  await store.upsert({source:'approved',invoice:invoiceB});
  await store.upsert({source:'approved',invoice:{...invoiceB,supplier:' greenleaf ',total:126}});
  await store.upsert({source:'approved',invoice:{...invoiceB,invoice_number:''}});
  await store.upsert({source:'approved',invoice:{...invoiceB,invoice_number:''}});
  const records=await store.list();
  assert.equal(records.length,3);
  assert.equal(records.filter(record=>record.invoice.total===126).length,1);
});
test('a corrupt history file is reported and left untouched',async t=>{
  const file=await tempFile(t);
  await createHistoryStore({file}).upsert({submissionId:idB,source:'n8n',invoice:invoiceB});
  await writeFile(file,'{not json');
  const store=createHistoryStore({file});
  await assert.rejects(store.upsert({submissionId:idA,source:'n8n',invoice:invoiceA}));
  assert.equal(await readFile(file,'utf8'),'{not json');
});
test('multi-invoice CSV has one header and every line item, and matches single CSV for one invoice',()=>{
  const csv=safeCsvMany([invoiceA,invoiceB]);
  const lines=csv.trimEnd().split('\r\n');
  assert.equal(lines.length,4);
  assert.match(lines[0],/^"supplier","invoice_number"/);
  assert.match(csv,/"ECO-2026-0824",.*"LED Bulb"/);
  assert.match(csv,/"'=Cable"/);
  assert.match(csv,/"GL-7",.*"Paper Towels","10","12.5","125"/);
  assert.equal(safeCsvMany([invoiceA]),safeCsv(invoiceA));
});
test('history API lists invoices and exports all, selected, or one invoice as CSV',async t=>{
  const store=createHistoryStore();
  for (const [submissionId,invoice] of [[idA,invoiceA],[idB,invoiceB],[idC,invoiceC]]) await store.upsert({submissionId,source:'n8n',invoice});
  const base=await startServer(t,store);
  const list=await (await fetch(`${base}/api/invoices`)).json();
  assert.equal(list.invoices.length,3);
  assert.deepEqual(Object.keys(list.invoices[0]).includes('items'),false);
  assert.equal(list.invoices.find(x=>x.id===idA).item_count,2);
  const csvFor=async body=>{const r=await postJson(`${base}/api/invoices/csv`,body);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/csv/);return (await r.text()).replace(/^﻿/,'')};
  const all=await csvFor({});
  assert.equal(all.trimEnd().split('\r\n').length,5);
  for (const text of ['LED Bulb','=Cable','Paper Towels','Wood']) assert.ok(all.includes(text));
  const selected=await csvFor({ids:[idA,idC]});
  assert.equal(selected.trimEnd().split('\r\n').length,4);
  assert.ok(!selected.includes('Paper Towels'));
  const one=await csvFor({ids:[idB]});
  assert.equal(one,safeCsv(invoiceB));
});
test('history CSV rejects invalid or unknown selections and empty history',async t=>{
  const empty=await startServer(t,createHistoryStore());
  assert.equal((await postJson(`${empty}/api/invoices/csv`,{})).status,404);
  const store=createHistoryStore();
  await store.upsert({submissionId:idA,source:'n8n',invoice:invoiceA});
  const base=await startServer(t,store);
  assert.equal((await postJson(`${base}/api/invoices/csv`,{ids:[]})).status,400);
  assert.equal((await postJson(`${base}/api/invoices/csv`,{ids:['../etc']})).status,400);
  assert.equal((await postJson(`${base}/api/invoices/csv`,{ids:[idA,idB]})).status,404);
  assert.equal((await fetch(`${base}/api/invoices/csv`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://evil.example'},body:'{}'})).status,403);
});
test('saved status responses enter history while duplicates do not',async t=>{
  const originalFetch=globalThis.fetch;
  const originalWebhook=process.env.N8N_WEBHOOK_URL;
  const originalSecret=process.env.BILL_AI_WEBHOOK_SECRET;
  process.env.N8N_WEBHOOK_URL='https://jastpss.app.n8n.cloud/webhook/dashboard-invoice-upload';
  process.env.BILL_AI_WEBHOOK_SECRET='test-only-secret';
  const store=createHistoryStore();
  const base=await startServer(t,store);
  globalThis.fetch=async(url,options)=>{
    if (!String(url).includes('n8n.cloud')) return originalFetch(url,options);
    const submissionId=new URL(url).searchParams.get('submission_id');
    if (submissionId===idB) return new Response(JSON.stringify({found:true,duplicate:true,submission_id:idB,supplier_name:'GreenLeaf',items:[]}));
    return new Response(JSON.stringify({found:true,submission_id:idA,supplier_name:'EcoMart Supplies',invoice_number:'ECO-2026-0824',currency:'$',subtotal:'$180.00',grand_total:'$180.00',items:[{description:'LED Bulb',qty:'40',rate:'$3.25',amount:'$130.00'},{description:'Cable',qty:'2',rate:'25',amount:'50'}]}));
  };
  t.after(()=>{
    globalThis.fetch=originalFetch;
    if(originalWebhook===undefined) delete process.env.N8N_WEBHOOK_URL; else process.env.N8N_WEBHOOK_URL=originalWebhook;
    if(originalSecret===undefined) delete process.env.BILL_AI_WEBHOOK_SECRET; else process.env.BILL_AI_WEBHOOK_SECRET=originalSecret;
  });
  const status=await (await fetch(`${base}/api/submissions/${idA}/status`)).json();
  assert.equal(status.supplier_name,'EcoMart Supplies');
  assert.equal((await fetch(`${base}/api/submissions/${idB}/status`)).status,200);
  const records=await store.list();
  assert.deepEqual(records.map(record=>record.id),[idA]);
  assert.equal(records[0].invoice.supplier,'EcoMart Supplies');
  assert.equal(records[0].invoice.total,180);
  assert.deepEqual(records[0].invoice.items.map(item=>item.amount),[130,50]);
});
test('approving an invoice records it in history even when n8n is not configured',async t=>{
  const originalWebhook=process.env.N8N_WEBHOOK_URL;
  delete process.env.N8N_WEBHOOK_URL;
  t.after(()=>{if(originalWebhook!==undefined) process.env.N8N_WEBHOOK_URL=originalWebhook});
  const store=createHistoryStore();
  const base=await startServer(t,store);
  const r=await postJson(`${base}/api/save`,{invoice:invoiceB,confirmedWarnings:true,submission_id:idB});
  assert.equal(r.status,409);
  assert.equal((await r.json()).history_saved,true);
  const records=await store.list();
  assert.equal(records[0].id,idB);
  assert.equal(records[0].source,'approved');
  assert.equal(records[0].invoice.items.length,1);
});
test('serves the local favicon for both the linked SVG and the default /favicon.ico request',async t=>{
  const base=await startServer(t,createHistoryStore());
  for (const path of ['/favicon.svg','/favicon.ico']) {
    const r=await fetch(base+path);
    assert.equal(r.status,200);
    assert.equal(r.headers.get('content-type'),'image/svg+xml');
    assert.equal(r.headers.get('x-content-type-options'),'nosniff');
    assert.match(await r.text(),/^<svg /);
  }
  assert.equal((await fetch(base+'/favicon.png')).status,404);
});
test('history and review CSV endpoints apply a custom column mapping and reject invalid ones',async t=>{
  const store=createHistoryStore();
  for (const [submissionId,invoice] of [[idA,invoiceA],[idB,invoiceB],[idC,invoiceC]]) await store.upsert({submissionId,source:'n8n',invoice});
  const base=await startServer(t,store);
  const columns=[{key:'invoice_number',label:'Bill'},{key:'description',label:'Item'},{key:'amount',label:'Amount'}];
  const csvFor=async(path,body)=>{const r=await postJson(base+path,body);assert.equal(r.status,200);return (await r.text()).replace(/^\uFEFF/,'').trimEnd().split('\r\n')};
  const all=await csvFor('/api/invoices/csv',{columns});
  assert.equal(all[0],'"Bill","Item","Amount"');
  assert.equal(all.length,1+4);
  const selected=await csvFor('/api/invoices/csv',{ids:[idA,idC],columns});
  assert.deepEqual(selected.slice(1).sort(),['"ECO-2026-0824","\'=Cable","50"','"ECO-2026-0824","LED Bulb","130"','"SG-1","Wood","50"']);
  const one=await csvFor('/api/invoices/csv',{ids:[idB],columns});
  assert.deepEqual(one,['"Bill","Item","Amount"','"GL-7","Paper Towels","125"']);
  const review=await csvFor('/api/csv',{invoice:invoiceA,columns});
  assert.equal(review.length,3);
  const defaultReview=Buffer.from(await (await postJson(base+'/api/csv',{invoice:invoiceA})).arrayBuffer()).toString('utf8');
  assert.equal(defaultReview,'\uFEFF'+safeCsv(invoiceA));
  for (const path of ['/api/csv','/api/invoices/csv']) assert.equal((await postJson(base+path,{invoice:invoiceA,columns:[{key:'nope',label:'x'}]})).status,400);
});
test('status found only through the review row (no invoice line items) does not create an empty history record',async t=>{
  // Shapes match the n8n "Build Submission Status" node: found is true when either sheet matches the submission_id.
  const reviewOnly={found:true,submission_id:idA,state:'saved',supplier_name:'EcoMart Supplies',invoice_number:'ECO-2026-0824',date:'2026-08-24',gstin:'',payment_mode:'',currency:'',subtotal:'',discount:'',gst_total:'',round_off:'',grand_total:'$1,191.62',review_status:'Pending Review',validation_status:'warning',validation_notes:'',calculated_subtotal:'',calculated_gst_exclusive:'',items:[],message:'Invoice data found'};
  const full={...reviewOnly,currency:'$',subtotal:'$1,153.50',gst_total:'$95.80',items:[{description:'LED Bulb',qty:'40',rate:'$3.25',amount:'$130.00',gst_percent:'8.5%'},{description:'Cable',qty:'2',rate:'25',amount:'50',gst_percent:'8.5%'}]};
  const originalFetch=globalThis.fetch;
  const originalWebhook=process.env.N8N_WEBHOOK_URL;
  const originalSecret=process.env.BILL_AI_WEBHOOK_SECRET;
  process.env.N8N_WEBHOOK_URL='https://jastpss.app.n8n.cloud/webhook/dashboard-invoice-upload';
  process.env.BILL_AI_WEBHOOK_SECRET='test-only-secret';
  let n8nResponse=reviewOnly;
  globalThis.fetch=async(url,options)=>String(url).includes('n8n.cloud')?new Response(JSON.stringify(n8nResponse)):originalFetch(url,options);
  t.after(()=>{
    globalThis.fetch=originalFetch;
    if(originalWebhook===undefined) delete process.env.N8N_WEBHOOK_URL; else process.env.N8N_WEBHOOK_URL=originalWebhook;
    if(originalSecret===undefined) delete process.env.BILL_AI_WEBHOOK_SECRET; else process.env.BILL_AI_WEBHOOK_SECRET=originalSecret;
  });
  const store=createHistoryStore();
  const base=await startServer(t,store);
  const partial=await (await fetch(`${base}/api/submissions/${idA}/status`)).json();
  assert.equal(partial.found,true);
  assert.deepEqual(partial.items,[]);
  assert.deepEqual(await store.list(),[]);
  n8nResponse=full;
  await fetch(`${base}/api/submissions/${idA}/status`);
  const records=await store.list();
  assert.equal(records.length,1);
  assert.equal(records[0].id,idA);
  assert.deepEqual(records[0].invoice.items.map(item=>[item.description,item.quantity,item.unit_price,item.amount]),[['LED Bulb',40,3.25,130],['Cable',2,25,50]]);
  assert.equal(records[0].invoice.subtotal,1153.5);
  assert.equal(records[0].invoice.total,1191.62);
});
test('an unreadable history file does not block forwarding an approved invoice to n8n',async t=>{
  const file=await tempFile(t);
  await createHistoryStore({file}).upsert({submissionId:idB,source:'n8n',invoice:invoiceB});
  await writeFile(file,'{corrupt');
  let forwarded=null;
  const n8n=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{forwarded=JSON.parse(body);res.end('{}')})});
  await new Promise(resolve=>n8n.listen(0,'127.0.0.1',resolve));
  const originalWebhook=process.env.N8N_WEBHOOK_URL;
  process.env.N8N_WEBHOOK_URL=`http://127.0.0.1:${n8n.address().port}/webhook/approved`;
  t.after(async()=>{
    await new Promise(resolve=>n8n.close(resolve));
    if(originalWebhook===undefined) delete process.env.N8N_WEBHOOK_URL; else process.env.N8N_WEBHOOK_URL=originalWebhook;
  });
  const base=await startServer(t,createHistoryStore({file}));
  const r=await postJson(`${base}/api/save`,{invoice:invoiceA,confirmedWarnings:true,submission_id:idA});
  assert.equal(r.status,200);
  assert.deepEqual(await r.json(),{history_saved:false,ok:true,message:'Approved invoice sent to n8n.'});
  assert.equal(forwarded.invoice.invoice_number,'ECO-2026-0824');
  assert.equal(forwarded.invoice.items.length,2);
  assert.equal(await readFile(file,'utf8'),'{corrupt');
});
test('GSTIN and payment mode survive status lookup, approval edits and CSV export',async t=>{
  const status={found:true,submission_id:idA,state:'saved',supplier_name:'Horizon Software Solutions',invoice_number:'HS-2026-9905',date:'25 Oct 2026',gstin:'06AABCH345601Z5',payment_mode:'Bank transfer',currency:'₹',subtotal:25000,discount:0,gst_total:4500,round_off:0,grand_total:29500,review_status:'Pending Review',items:[{description:'Software',qty:1,rate:25000,amount:25000,gst_percent:18}]};
  const originalFetch=globalThis.fetch;
  const originalWebhook=process.env.N8N_WEBHOOK_URL;
  const originalSecret=process.env.BILL_AI_WEBHOOK_SECRET;
  process.env.N8N_WEBHOOK_URL='https://jastpss.app.n8n.cloud/webhook/dashboard-invoice-upload';
  process.env.BILL_AI_WEBHOOK_SECRET='test-only-secret';
  globalThis.fetch=async(url,options)=>String(url).includes('n8n.cloud')?new Response(JSON.stringify(status)):originalFetch(url,options);
  t.after(()=>{
    globalThis.fetch=originalFetch;
    if(originalWebhook===undefined) delete process.env.N8N_WEBHOOK_URL; else process.env.N8N_WEBHOOK_URL=originalWebhook;
    if(originalSecret===undefined) delete process.env.BILL_AI_WEBHOOK_SECRET; else process.env.BILL_AI_WEBHOOK_SECRET=originalSecret;
  });
  const store=createHistoryStore();
  const base=await startServer(t,store);
  const restored=await (await fetch(`${base}/api/submissions/${idA}/status`)).json();
  assert.deepEqual([restored.gstin,restored.payment_mode],['06AABCH345601Z5','Bank transfer']);
  let [record]=await store.list();
  assert.deepEqual([record.source,record.invoice.gstin,record.invoice.payment_mode],['n8n','06AABCH345601Z5','Bank transfer']);
  // The reviewer corrects both fields before approving; the approved version keeps the edits.
  const approved={supplier:'Horizon Software Solutions',invoice_number:'HS-2026-9905',date:'25 Oct 2026',gstin:'06AABCH3456O1Z5',payment_mode:'UPI',currency:'₹',subtotal:25000,discount:0,tax:4500,round_off:0,total:29500,items:[{description:'Software',quantity:1,unit_price:25000,amount:25000,gst_percent:0.18}]};
  assert.equal((await (await postJson(`${base}/api/save`,{invoice:approved,confirmedWarnings:true,submission_id:idA})).json()).history_saved,true);
  [record]=await store.list();
  assert.deepEqual([record.source,record.invoice.gstin,record.invoice.payment_mode],['approved','06AABCH3456O1Z5','UPI']);
  const columns=[{key:'invoice_number',label:'Bill'},{key:'gstin',label:'GSTIN'},{key:'payment_mode',label:'Payment'}];
  const csv=async(path,body)=>Buffer.from(await (await postJson(base+path,body)).arrayBuffer()).toString('utf8').replace(/^﻿/,'').trim().split('\r\n');
  assert.deepEqual(await csv('/api/invoices/csv',{ids:[idA],columns}),['"Bill","GSTIN","Payment"','"HS-2026-9905","06AABCH3456O1Z5","UPI"']);
  assert.deepEqual(await csv('/api/csv',{invoice:approved,columns}),['"Bill","GSTIN","Payment"','"HS-2026-9905","06AABCH3456O1Z5","UPI"']);
  // The default CSV format is unchanged.
  assert.equal((await csv('/api/csv',{invoice:approved}))[0],'"supplier","invoice_number","date","currency","description","quantity","unit_price","amount","subtotal","discount","tax","round_off","total"');
});
