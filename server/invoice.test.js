import test from 'node:test';
import assert from 'node:assert/strict';
import {validateInvoice,safeCsv} from './invoice.js';
import {applyLocalEnvironment,classifyGeminiFailure,classifyN8nFailure,getN8nInvoiceWebhookUrl,getN8nSubmissionStatusWebhookUrl,hasJsonContentType,isExpectedFile,isSameOrigin,isSubmissionId,normalize,normalizeSubmissionStatus,requestGemini,requestSubmissionStatus,submitInvoiceToN8n} from './index.js';
test('warns when arithmetic mismatches',()=>{assert.ok(validateInvoice({supplier:'X',invoice_number:'1',date:'2026-10-21',subtotal:100,tax:5,total:200,items:[{description:'A',quantity:2,unit_price:20,amount:30}]}).length>=2)});
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
  assert.deepEqual(normalizeSubmissionStatus({found:true,submission_id:'123e4567-e89b-42d3-a456-426614174000',state:'saved',review_status:'Needs Review'},'123e4567-e89b-42d3-a456-426614174000'),{found:true,submission_id:'123e4567-e89b-42d3-a456-426614174000',state:'saved',supplier_name:'',invoice_number:'',validation_status:'',review_status:'Needs Review',message:''});
});
test('loads the dedicated webhook secret and supports the existing server-side name',()=>{
  const dedicated={};
  applyLocalEnvironment('BILL_AI_WEBHOOK_SECRET=example-value\n',dedicated);
  assert.equal(dedicated.BILL_AI_WEBHOOK_SECRET,'example-value');
  const legacy={};
  applyLocalEnvironment('N8N_SHARED_SECRET=example-value\n',legacy);
  assert.equal(legacy.BILL_AI_WEBHOOK_SECRET,'example-value');
});
