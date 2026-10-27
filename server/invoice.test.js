import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {calculateInvoiceAmounts,normalizeInvoiceNumber,validateInvoice,safeCsv} from './invoice.js';
import {applyLocalEnvironment,classifyGeminiFailure,classifyN8nFailure,createServer,getN8nInvoiceWebhookUrl,getN8nSubmissionStatusWebhookUrl,hasJsonContentType,isDuplicateSubmissionResult,isExpectedFile,isSameOrigin,isSubmissionId,normalize,normalizeN8nUploadResult,normalizeSubmissionStatus,requestGemini,requestSubmissionStatus,submitInvoiceToN8n} from './index.js';
test('warns when arithmetic mismatches',()=>{assert.ok(validateInvoice({supplier:'X',invoice_number:'1',date:'2026-10-21',subtotal:100,tax:5,total:200,items:[{description:'A',quantity:2,unit_price:20,amount:30}]}).length>=2)});
test('rejects non-empty invalid numeric fields but preserves missing values',()=>{
  const invalid=validateInvoice({supplier:'X',invoice_number:'1',date:'2026-10-21',subtotal:'five hundred',tax:'$41x',total:null,items:[{description:'A',quantity:'many',unit_price:'unknown',amount:125}]});
  assert.ok(invalid.includes('Subtotal is invalid.'));
  assert.ok(invalid.includes('GST total is invalid.'));
  assert.ok(invalid.includes('Item 1 quantity is invalid.'));
  assert.ok(invalid.includes('Item 1 rate is invalid.'));
  assert.ok(!invalid.includes('Grand total is invalid.'));
  assert.ok(!invalid.includes('Item 1 amount is invalid.'));
});
test('normalizes supported formatted invoice numeric values without extracting arbitrary text',()=>{
  assert.equal(normalizeInvoiceNumber('$8,250.00'),8250);
  assert.equal(normalizeInvoiceNumber('$120.00'),120);
  assert.equal(normalizeInvoiceNumber('35 hrs'),35);
  assert.equal(normalizeInvoiceNumber('1'),1);
  assert.equal(normalizeInvoiceNumber('1,234.50'),1234.5);
  assert.equal(normalizeInvoiceNumber('1,11,500.00'),111500);
  assert.equal(normalizeInvoiceNumber('-$603.50'),-603.5);
  assert.equal(normalizeInvoiceNumber('($603.50)'),-603.5);
  assert.equal(normalizeInvoiceNumber('35 hours of labor'),'35 hours of labor');
  assert.equal(normalizeInvoiceNumber(''), '');
  assert.equal(normalizeInvoiceNumber(null),null);
});
test('normalizes real invoice numeric fields before existing validation and CSV serialization',()=>{
  const invoice=normalize({
    supplier:'Example supplier',
    invoice_number:'INV-123',
    date:'2026-10-27',
    subtotal:'$12,070.00',
    gst_total:'$945.99',
    round_off:'0',
    grand_total:'$12,412.49',
    calculated_subtotal:'$12,070.00',
    calculated_gst_exclusive:'$945.99',
    items:[
      {description:'Item one',qty:'1'},
      {description:'Labor',qty:'35 hrs',rate:'$120.00',amount:'$4,200.00'}
    ]
  });
  assert.equal(invoice.subtotal,12070);
  assert.equal(invoice.tax,945.99);
  assert.equal(invoice.gst_total,945.99);
  assert.equal(invoice.round_off,0);
  assert.equal(invoice.total,12412.49);
  assert.equal(invoice.grand_total,12412.49);
  assert.equal(invoice.calculated_subtotal,12070);
  assert.equal(invoice.calculated_gst_exclusive,945.99);
  assert.deepEqual(invoice.items.map(({quantity,unit_price,amount})=>({quantity,unit_price,amount})),[
    {quantity:1,unit_price:null,amount:null},
    {quantity:35,unit_price:120,amount:4200}
  ]);
  assert.ok(validateInvoice(invoice).some(note=>note==='Subtotal + discount + tax + round-off does not equal total.'));
  const csv=safeCsv(invoice);
  assert.match(csv,/"12070"/);
  assert.match(csv,/"945.99"/);
  assert.match(csv,/"12412.49"/);
});
test('normalizes the EcoMart invoice amounts, discount, currency symbol, and five items',()=>{
  const invoice=normalize({
    supplier:'EcoMart Supplies',
    invoice_number:'ECO-2026-0824',
    date:'Oct 28, 2026',
    currency:'$',
    subtotal:'$1,153.50',
    discount:'-$57.68',
    gst_total:'$95.80',
    tax:'$95.80',
    round_off:'',
    grand_total:'$1,191.62',
    total:'$1,191.62',
    items:[
      {description:'Organic Coffee Beans (1kg)',qty:'20',rate:'$18.50',amount:'$370.00',gst_percent:'8.5%'},
      {description:'Recycled Notebook (A5)',qty:'50',rate:'$4.25',amount:'$212.50',gst_percent:'8.5%'},
      {description:'Bamboo Toothbrush (Pack of 4)',qty:'30',rate:'$6.75',amount:'$202.50',gst_percent:'8.5%'},
      {description:'Stainless Steel Water Bottle (750ml)',qty:'15',rate:'$15.90',amount:'$238.50',gst_percent:'8.5%'},
      {description:'LED Bulb (9W)',qty:'40',rate:'$3.25',amount:'$130.00',gst_percent:'8.5%'}
    ]
  });
  assert.equal(invoice.currency,'$');
  assert.equal(invoice.subtotal,1153.5);
  assert.equal(invoice.discount,-57.68);
  assert.equal(invoice.tax,95.8);
  assert.equal(invoice.total,1191.62);
  assert.deepEqual(invoice.items.map(({quantity,unit_price,amount,gst_percent})=>({quantity,unit_price,amount,gst_percent})),[
    {quantity:20,unit_price:18.5,amount:370,gst_percent:8.5},
    {quantity:50,unit_price:4.25,amount:212.5,gst_percent:8.5},
    {quantity:30,unit_price:6.75,amount:202.5,gst_percent:8.5},
    {quantity:15,unit_price:15.9,amount:238.5,gst_percent:8.5},
    {quantity:40,unit_price:3.25,amount:130,gst_percent:8.5}
  ]);
  const warnings=validateInvoice(invoice);
  const calculated=calculateInvoiceAmounts(invoice);
  assert.equal(calculated.calculatedSubtotal,1153.5);
  assert.ok(Math.abs(calculated.calculatedGstExclusive-93.1447)<0.001);
  assert.equal(calculated.allAmountsValid,true);
  assert.equal(calculated.allGstRatesValid,true);
  assert.ok(!warnings.some(note=>/invalid|Subtotal \+ tax|does not equal total/i.test(note)));
  assert.ok(warnings.includes('GST mismatch: verify tax-inclusive/exclusive pricing'));
  const csv=safeCsv(invoice);
  for (const value of ['"$"','"1153.5"','"-57.68"','"95.8"','"1191.62"','"18.5"','"370"','"3.25"','"130"']) {
    assert.ok(csv.includes(value),`CSV should include normalized value ${value}`);
  }
  assert.equal((csv.match(/EcoMart Supplies/g)||[]).length,5);
});
test('does not invent optional EcoMart fields or a default currency',()=>{
  const invoice=normalize({
    supplier:'EcoMart Supplies',
    invoice_number:'ECO-2026-0824',
    gstin:'',
    payment_mode:'',
    round_off:'',
    items:[{description:'LED Bulb',qty:'40',rate:'$3.25',amount:'$130.00'}]
  });
  assert.equal(invoice.currency,'');
  assert.equal(invoice.discount,null);
  assert.equal(invoice.round_off,'');
  assert.equal(invoice.items[0].gst_percent,undefined);
  assert.equal(invoice.items.length,1);
});
test('CSV escapes formula-like content',()=>{const csv=safeCsv({supplier:'=CMD()',invoice_number:'1',date:'',currency:'INR',items:[{description:'+evil',quantity:1,unit_price:10,amount:10}],subtotal:10,tax:0,total:10});assert.match(csv,/"'=CMD\(\)"/);assert.match(csv,/"'\+evil"/)});
test('recognizes the declared upload file signatures',()=>{
  assert.ok(isExpectedFile('image/png',Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])));
  assert.ok(isExpectedFile('application/pdf',Buffer.from('%PDF-1.7')));
  assert.equal(isExpectedFile('image/jpeg',Buffer.from('not an image')),false);
});
test('requires same-origin JSON API requests',()=>{
  assert.ok(hasJsonContentType({headers:{'content-type':'application/json; charset=utf-8'}}));
  assert.equal(hasJsonContentType({headers:{'content-type':'text/plain'}}),false);
  assert.ok(isSameOrigin({headers:{host:'127.0.0.1:3000',origin:'http://127.0.0.1:3000'}}));
  assert.equal(isSameOrigin({headers:{host:'127.0.0.1:3000',origin:'https://example.invalid'}}),false);
});
test('preserves line items when Gemini uses its common alternative key',()=>{
  const invoice=normalize({line_items:[{description:'Paper',quantity:2,unit_price:25,amount:50}]});
  assert.deepEqual(invoice.items,[{description:'Paper',quantity:2,unit_price:25,amount:50}]);
});
test('classifies model access and quota failures without returning provider body',()=>{
  assert.equal(classifyGeminiFailure(404,'{"error":{"status":"NOT_FOUND","message":"internal"}}','old-model').code,'GEMINI_MODEL_UNAVAILABLE');
  assert.equal(classifyGeminiFailure(403,'{}','model').code,'GEMINI_ACCESS_DENIED');
  assert.equal(classifyGeminiFailure(429,'{}','model').code,'GEMINI_QUOTA_EXCEEDED');
});
test('retries one transient Gemini service failure with a mock transport',async()=>{
  let calls=0;
  const response=await requestGemini({endpoint:'https://mock.invalid/generate',apiKey:'',payload:{},retryDelayMs:0,sleep:async()=>{},fetchImpl:async()=>{
    calls++;
    return calls===1 ? new Response('',{status:503}) : new Response('{"candidates":[]}',{status:200});
  }});
  assert.equal(calls,2);
  assert.equal(response.status,200);
});
test('does not retry a quota response from a mock transport',async()=>{
  let calls=0;
  const response=await requestGemini({endpoint:'https://mock.invalid/generate',apiKey:'',payload:{},retryDelayMs:0,sleep:async()=>{},fetchImpl:async()=>{
    calls++;
    return new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}',{status:429});
  }});
  assert.equal(calls,1);
  assert.equal(response.status,429);
});
test('forwards the validated upload to n8n as multipart Invoice and submission ID without exposing the secret',async()=>{
  let request;
  const response=await submitInvoiceToN8n({bytes:Buffer.from('%PDF-1.7'),mimeType:'application/pdf',fileName:'April invoice.pdf',submissionId:'123e4567-e89b-42d3-a456-426614174000',secret:'mock-secret',endpoint:'https://mock.invalid/invoice',fetchImpl:async(url,options)=>{
    request={url,options};
    return new Response('',{status:202});
  }});
  assert.equal(response.status,202);
  assert.equal(request.url,'https://mock.invalid/invoice');
  assert.equal(request.options.headers['x-bill-ai-secret'],'mock-secret');
  const upload=request.options.body.get('Invoice');
  assert.equal(upload.name,'April_invoice.pdf');
  assert.equal(upload.type,'application/pdf');
  assert.equal(Buffer.from(await upload.arrayBuffer()).toString(),'%PDF-1.7');
  assert.equal(request.options.body.get('submission_id'),'123e4567-e89b-42d3-a456-426614174000');
});
test('does not retry an uncertain n8n network request',async()=>{
  let calls=0;
  await assert.rejects(()=>submitInvoiceToN8n({bytes:Buffer.from('%PDF-1.7'),mimeType:'application/pdf',fileName:'invoice.pdf',submissionId:'123e4567-e89b-42d3-a456-426614174000',secret:'mock-secret',endpoint:'https://mock.invalid/invoice',fetchImpl:async()=>{
    calls++;
    throw new TypeError('network unavailable');
  }}));
  assert.equal(calls,1);
});
test('classifies n8n authentication and availability failures safely',()=>{
  assert.equal(classifyN8nFailure(401).code,'N8N_WEBHOOK_AUTH_FAILED');
  assert.equal(classifyN8nFailure(503).code,'N8N_WEBHOOK_UNAVAILABLE');
});
test('accepts only explicit duplicate results from n8n',()=>{
  assert.equal(isDuplicateSubmissionResult({duplicate:true}),true);
  assert.equal(isDuplicateSubmissionResult({duplicate:false}),false);
  assert.equal(isDuplicateSubmissionResult({message:'Duplicate bill'}),false);
});
test('maps explicit duplicate and normal upload responses for the dashboard',()=>{
  const submissionId='123e4567-e89b-42d3-a456-426614174000';
  assert.deepEqual(normalizeN8nUploadResult({duplicate:true},submissionId),{accepted:true,submission_id:submissionId,duplicate:true,processing_status:'duplicate',message:'Duplicate bill detected — this invoice has already been submitted. No duplicate record was created.'});
  assert.deepEqual(normalizeN8nUploadResult({submission_id:submissionId,duplicate:true},submissionId),{accepted:true,submission_id:submissionId,duplicate:true,processing_status:'duplicate',message:'Duplicate bill detected — this invoice has already been submitted. No duplicate record was created.'});
  assert.deepEqual(normalizeN8nUploadResult({accepted:true,duplicate:false},submissionId),{accepted:true,submission_id:submissionId,duplicate:false,processing_status:'accepted_for_processing',message:'Accepted for processing — not yet saved.'});
  assert.deepEqual(normalizeN8nUploadResult({accepted:true},submissionId),{accepted:true,submission_id:submissionId,processing_status:'accepted_for_processing',message:'Accepted for processing — not yet saved.'});
  assert.throws(()=>normalizeN8nUploadResult({submission_id:'original-submission',duplicate:true},submissionId),/Mismatched upload response/);
});
test('requires a configured HTTPS n8n invoice webhook on the expected host',()=>{
  assert.equal(getN8nInvoiceWebhookUrl({}).code,'N8N_WEBHOOK_URL_MISSING');
  const valid=getN8nInvoiceWebhookUrl({N8N_WEBHOOK_URL:'https://jastpss.app.n8n.cloud/webhook/dashboard-invoice-upload'});
  assert.equal(valid.ok,true);
  assert.equal(valid.url,'https://jastpss.app.n8n.cloud/webhook/dashboard-invoice-upload');
  assert.equal(getN8nInvoiceWebhookUrl({N8N_WEBHOOK_URL:'http://jastpss.app.n8n.cloud/webhook/dashboard-invoice-upload'}).code,'N8N_WEBHOOK_URL_INVALID');
  assert.equal(getN8nInvoiceWebhookUrl({N8N_WEBHOOK_URL:'https://example.invalid/webhook/dashboard-invoice-upload'}).code,'N8N_WEBHOOK_URL_INVALID');
});
test('builds the protected status webhook URL from the configured invoice webhook',()=>{
  const configuration={N8N_WEBHOOK_URL:'https://jastpss.app.n8n.cloud/webhook/dashboard-invoice-upload'};
  assert.equal(getN8nSubmissionStatusWebhookUrl(configuration).url,'https://jastpss.app.n8n.cloud/webhook/dashboard-submission-status');
  assert.equal(isSubmissionId('123e4567-e89b-42d3-a456-426614174000'),true);
  assert.equal(isSubmissionId('bad id'),false);
});
test('requests and normalizes a submission status without exposing the server credential',async()=>{
  let request;
  await requestSubmissionStatus({submissionId:'123e4567-e89b-42d3-a456-426614174000',secret:'mock-secret',endpoint:'https://mock.invalid/webhook/dashboard-submission-status',fetchImpl:async(url,options)=>{
    request={url,options}; return new Response('{"found":true}',{status:200});
  }});
  assert.equal(request.url.searchParams.get('submission_id'),'123e4567-e89b-42d3-a456-426614174000');
  assert.equal(request.options.method,'GET');
  assert.equal(request.options.headers['x-bill-ai-secret'],'mock-secret');
  const normalStatus=normalizeSubmissionStatus({found:true,submission_id:'123e4567-e89b-42d3-a456-426614174000',state:'saved',review_status:'Needs Review'},'123e4567-e89b-42d3-a456-426614174000');
  assert.equal(normalStatus.found,true);
  assert.equal(Object.hasOwn(normalStatus,'duplicate'),false);
  assert.equal(normalizeSubmissionStatus({found:false,state:'processing'},'123e4567-e89b-42d3-a456-426614174000').found,false);
});
test('passes an explicit duplicate result from status through the safe response shape',()=>{
  assert.equal(normalizeSubmissionStatus({found:false,duplicate:true,state:'duplicate'},'123e4567-e89b-42d3-a456-426614174000').duplicate,true);
});
test('keeps absent optional status fields empty instead of inventing values',()=>{
  const status=normalizeSubmissionStatus({found:true,items:[{description:'LED Bulb'}]},'123e4567-e89b-42d3-a456-426614174000');
  assert.equal(status.currency,'');
  assert.equal(status.discount,'');
  assert.equal(status.payment_mode,'');
  assert.equal(status.round_off,'');
  assert.equal(status.gstin,'');
});
test('status API returns normalized EcoMart values and only genuine warnings',async t=>{
  const originalFetch=globalThis.fetch;
  const originalWebhook=process.env.N8N_WEBHOOK_URL;
  const originalSecret=process.env.BILL_AI_WEBHOOK_SECRET;
  process.env.N8N_WEBHOOK_URL='https://jastpss.app.n8n.cloud/webhook/dashboard-invoice-upload';
  process.env.BILL_AI_WEBHOOK_SECRET='test-only-secret';
  globalThis.fetch=async(url,options)=>{
    assert.equal(new URL(url).pathname,'/webhook/dashboard-submission-status');
    assert.equal(options.headers['x-bill-ai-secret'],'test-only-secret');
    return new Response(JSON.stringify({
      found:true,
      submission_id:'123e4567-e89b-42d3-a456-426614174000',
      currency:'$',
      subtotal:'$1,153.50',
      discount:'-$57.68',
      gst_total:'$95.80',
      round_off:'',
      grand_total:'$1,191.62',
      validation_notes:'Subtotal is invalid; GST total is invalid; Grand total is invalid; Item 1 rate is invalid; Item 1 amount is invalid; GST mismatch: verify tax-inclusive/exclusive pricing',
      items:[{description:'LED Bulb',qty:'40',rate:'$3.25',amount:'$130.00',gst_percent:'8.5%'}]
    }),{status:200});
  };
  const server=createServer();
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    globalThis.fetch=originalFetch;
    if(originalWebhook===undefined) delete process.env.N8N_WEBHOOK_URL;
    else process.env.N8N_WEBHOOK_URL=originalWebhook;
    if(originalSecret===undefined) delete process.env.BILL_AI_WEBHOOK_SECRET;
    else process.env.BILL_AI_WEBHOOK_SECRET=originalSecret;
  });
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  const {port}=server.address();
  const responseText=await new Promise((resolve,reject)=>{
    http.get({host:'127.0.0.1',port,path:'/api/submissions/123e4567-e89b-42d3-a456-426614174000/status'},response=>{
      let text='';
      response.setEncoding('utf8');
      response.on('data',chunk=>text+=chunk);
      response.on('end',()=>resolve(text));
    }).on('error',reject);
  });
  const response=JSON.parse(responseText);
  assert.equal(response.currency,'$');
  assert.equal(response.subtotal,1153.5);
  assert.equal(response.discount,-57.68);
  assert.equal(response.grand_total,1191.62);
  assert.equal(response.items[0].gst_percent,8.5);
  assert.equal(response.validation_notes,'GST mismatch: verify tax-inclusive/exclusive pricing');
  assert.equal(JSON.stringify(response).includes('test-only-secret'),false);
});
test('clears only stale invalid-number notes when the restored fields normalize to numbers',()=>{
  const status=normalizeSubmissionStatus({
    found:true,
    subtotal:'$513.00',
    gst_total:'$41.34',
    grand_total:'$528.69',
    items:[
      {description:'Paper',qty:'10',rate:'$12.50',amount:'$125.00'},
      {description:'Bags',qty:'20',rate:'$8.75',amount:'$175.00'}
    ],
    validation_notes:'Subtotal is invalid; GST total is invalid; Grand total is invalid; Item 1 rate is invalid; Item 1 amount is invalid; Item 2 rate is invalid; Item 2 amount is invalid; Invoice date is missing.'
  },'123e4567-e89b-42d3-a456-426614174000');
  assert.equal(status.subtotal,513);
  assert.equal(status.gst_total,41.34);
  assert.equal(status.grand_total,528.69);
  assert.equal(status.items[0].unit_price,12.5);
  assert.equal(status.items[1].amount,175);
  assert.equal(status.validation_notes,'Invoice date is missing.');
});
test('normalizes EcoMart status values and clears only its stale numeric warnings',()=>{
  const status=normalizeSubmissionStatus({
    found:true,
    supplier_name:'EcoMart Supplies',
    invoice_number:'ECO-2026-0824',
    date:'Oct 28, 2026',
    currency:'$',
    subtotal:'$1,153.50',
    discount:'-$57.68',
    gst_total:'$95.80',
    round_off:'',
    grand_total:'$1,191.62',
    validation_status:'Flagged',
    validation_notes:'Subtotal is invalid; GST total is invalid; Grand total is invalid; Item 1 rate is invalid; Item 1 amount is invalid; Item 2 rate is invalid; Item 2 amount is invalid; Item 3 rate is invalid; Item 3 amount is invalid; Item 4 rate is invalid; Item 4 amount is invalid; Item 5 rate is invalid; Item 5 amount is invalid; GST mismatch: verify tax-inclusive/exclusive pricing',
    items:[
      {description:'Organic Coffee Beans',qty:'20',rate:'$18.50',amount:'$370.00',gst_percent:'8.5%'},
      {description:'Recycled Notebook',qty:'50',rate:'$4.25',amount:'$212.50',gst_percent:'8.5%'},
      {description:'Bamboo Toothbrush',qty:'30',rate:'$6.75',amount:'$202.50',gst_percent:'8.5%'},
      {description:'Water Bottle',qty:'15',rate:'$15.90',amount:'$238.50',gst_percent:'8.5%'},
      {description:'LED Bulb',qty:'40',rate:'$3.25',amount:'$130.00',gst_percent:'8.5%'}
    ]
  },'123e4567-e89b-42d3-a456-426614174000');
  assert.equal(status.currency,'$');
  assert.equal(status.subtotal,1153.5);
  assert.equal(status.discount,-57.68);
  assert.equal(status.grand_total,1191.62);
  assert.equal(status.items.length,5);
  assert.ok(status.items.every(item=>typeof item.unit_price==='number'&&typeof item.amount==='number'));
  assert.equal(status.validation_notes,'GST mismatch: verify tax-inclusive/exclusive pricing');
});
test('clears stale numeric warnings from a status response with native number values',()=>{
  const status=normalizeSubmissionStatus({
    found:true,
    subtotal:1791,
    gst_total:143.82,
    grand_total:1845.27,
    items:[
      {description:'Chair',quantity:5,unit_price:189,amount:945,gst_percent:''},
      {description:'Mouse',quantity:10,unit_price:24.5,amount:245,gst_percent:''},
      {description:'Stand',quantity:8,unit_price:32,amount:256,gst_percent:''},
      {description:'Lamp',quantity:12,unit_price:28.75,amount:345,gst_percent:''}
    ],
    validation_notes:'Subtotal is invalid; GST total is invalid; Grand total is invalid; Item 1 rate is invalid; Item 1 amount is invalid; Item 2 rate is invalid; Item 2 amount is invalid; Item 3 rate is invalid; Item 3 amount is invalid; Item 4 rate is invalid; Item 4 amount is invalid'
  },'123e4567-e89b-42d3-a456-426614174000');
  assert.equal(typeof status.subtotal,'number');
  assert.equal(typeof status.gst_total,'number');
  assert.equal(typeof status.grand_total,'number');
  assert.ok(status.items.every(item=>typeof item.unit_price==='number'&&typeof item.amount==='number'));
  assert.equal(status.validation_notes,'');
});
test('retains invalid-number notes when values do not normalize to valid numbers',()=>{
  const status=normalizeSubmissionStatus({
    found:true,
    subtotal:'about five hundred',
    items:[{description:'Paper',rate:'unknown',amount:'$125.00'}],
    validation_notes:'Subtotal is invalid; Item 1 rate is invalid; Item 1 amount is invalid.'
  },'123e4567-e89b-42d3-a456-426614174000');
  assert.equal(status.validation_notes,'Subtotal is invalid; Item 1 rate is invalid');
});
test('normalizes GreenLeaf status values consistently for validation and CSV export',()=>{
  const status=normalizeSubmissionStatus({
    found:true,
    supplier_name:'GreenLeaf SUPPLY CO.',
    invoice_number:'GLS-2026-0457',
    date:'Oct 24, 2026',
    currency:'',
    subtotal:'513',
    gst_total:'41.34',
    grand_total:'528.69',
    validation_notes:'Subtotal is invalid; GST total is invalid; Grand total is invalid; Item 1 rate is invalid; Item 1 amount is invalid; Item 2 rate is invalid; Item 2 amount is invalid; Item 3 rate is invalid; Item 3 amount is invalid; Item 4 rate is invalid; Item 4 amount is invalid',
    items:[
      {description:'Eco-Friendly Paper Towels',qty:'10',rate:'12.5',amount:'125'},
      {description:'Biodegradable Trash Bags',qty:'20',rate:'8.75',amount:'175'},
      {description:'Recycled Cleaning Spray',qty:'15',rate:'6.2',amount:'93'},
      {description:'Reusable Shopping Bags',qty:'25',rate:'4.8',amount:'120'}
    ]
  },'sub-greenleaf-2026-0457');
  const invoice=normalize({
    supplier:status.supplier_name,
    invoice_number:status.invoice_number,
    date:status.date,
    currency:status.currency,
    subtotal:status.subtotal,
    gst_total:status.gst_total,
    tax:status.gst_total,
    grand_total:status.grand_total,
    total:status.grand_total,
    items:status.items
  });
  assert.equal(typeof status.subtotal,'number');
  assert.equal(typeof status.gst_total,'number');
  assert.equal(typeof status.grand_total,'number');
  assert.ok(status.items.every(item=>typeof item.unit_price==='number'&&typeof item.amount==='number'));
  assert.equal(status.currency,'');
  assert.equal(status.validation_notes,'');
  assert.deepEqual(validateInvoice(invoice),['Subtotal + discount + tax + round-off does not equal total.']);
  const csv=safeCsv(invoice);
  for (const value of ['"513"','"41.34"','"528.69"','"12.5"','"8.75"','"6.2"','"4.8"','"125"','"175"','"93"','"120"']) {
    assert.ok(csv.includes(value),`CSV should include numeric value ${value}`);
  }
  assert.match(csv,/,"Eco-Friendly Paper Towels","10","12\.5","125",/);
});
test('passes formatted invoice totals and fractional GST rates through status normalization',()=>{
  const status=normalizeSubmissionStatus({found:true,supplier_name:'Supplier',invoice_number:'INV-1',date:'2026-10-26',gstin:'GSTIN-1',payment_mode:'',subtotal:'1,11,500.00',gst_total:18570,round_off:'0',grand_total:'1,30,070.00',calculated_subtotal:'1,11,500.00',calculated_gst_exclusive:18570,review_status:'Needs Review',validation_status:'Valid',validation_notes:'GST total is missing. Check totals.',items:[{description:'Paper',qty:2,rate:50,amount:100,gst_percent:0.18},{description:'Ink',qty:1,rate:20,amount:20,gst_percent:0.12}],secret:'must not be returned'},'123e4567-e89b-42d3-a456-426614174000');
  assert.deepEqual(status,{found:true,submission_id:'123e4567-e89b-42d3-a456-426614174000',state:'',supplier_name:'Supplier',invoice_number:'INV-1',date:'2026-10-26',gstin:'GSTIN-1',payment_mode:'',currency:'',subtotal:111500,discount:'',tax:18570,total:130070,gst_total:18570,round_off:0,grand_total:130070,calculated_subtotal:111500,calculated_gst_exclusive:18570,items:[{description:'Paper',quantity:2,unit_price:50,amount:100,gst_percent:0.18},{description:'Ink',quantity:1,unit_price:20,amount:20,gst_percent:0.12}],validation_status:'Valid',validation_notes:'Check totals.',review_status:'Needs Review',message:''});
});
test('keeps GST percentage fields through invoice normalization for saving',()=>{
  const invoice=normalize({items:[{description:'Paper',quantity:1,unit_price:50,amount:50,gst_percent:0.18}]});
  assert.equal(invoice.items[0].gst_percent,0.18);
});
test('loads the dedicated webhook secret and supports the existing server-side name',()=>{
  const dedicated={};
  applyLocalEnvironment('BILL_AI_WEBHOOK_SECRET=example-value\n',dedicated);
  assert.equal(dedicated.BILL_AI_WEBHOOK_SECRET,'example-value');
  const legacy={};
  applyLocalEnvironment('N8N_SHARED_SECRET=example-value\n',legacy);
  assert.equal(legacy.BILL_AI_WEBHOOK_SECRET,'example-value');
});
