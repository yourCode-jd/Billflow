import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { normalizeInvoiceNumber, validateInvoice, safeCsv, safeCsvMany, csvColumns } from './invoice.js';
import { createHistoryStore, historySummary } from './history.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function applyLocalEnvironment(text, environment=process.env) {
  const parsed={};
  for (const line of text.split(/\r?\n/)) {
    const match=line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value=match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value=value.slice(1,-1);
    parsed[match[1]]=value;
  }
  for (const [name,value] of Object.entries(parsed)) {
    if (environment[name] === undefined || environment[name] === '') environment[name]=value;
  }
  // Migration support: existing local setups used this server-only n8n secret name.
  if (!environment.BILL_AI_WEBHOOK_SECRET && parsed.N8N_SHARED_SECRET) environment.BILL_AI_WEBHOOK_SECRET=parsed.N8N_SHARED_SECRET;
}
async function loadLocalEnvironment() {
  const envPath=resolve(root, '.env');
  try {
    const envText = await readFile(envPath, 'utf8');
    applyLocalEnvironment(envText);
  } catch {}
}
const MAX_BYTES = 10 * 1024 * 1024;
const N8N_INVOICE_WEBHOOK_HOST = 'jastpss.app.n8n.cloud';
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
function normalizeGstPercent(value) {
  const percent=typeof value==='string'?value.trim().replace(/%\s*$/,''):value;
  return normalizeInvoiceNumber(percent);
}
const securityHeaders = {
  'Cache-Control':'no-store',
  'X-Content-Type-Options':'nosniff',
  'X-Frame-Options':'DENY',
  'Referrer-Policy':'no-referrer',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; connect-src 'self'"
};
function reply(res, code, obj) { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8',...securityHeaders}); res.end(JSON.stringify(obj)); }
export function hasJsonContentType(req) {
  const contentType = req.headers['content-type'] || '';
  return contentType.toLowerCase().startsWith('application/json');
}
function requireJson(req) {
  if (!hasJsonContentType(req)) {
    const err = new Error('Content-Type must be application/json.'); err.status = 415; throw err;
  }
}
export function isSameOrigin(req) {
  // Requests from this app include Origin. Permit requests without one for local CLI testing.
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}`;
}
function requireSameOrigin(req) {
  if (!isSameOrigin(req)) {
    const err = new Error('Cross-origin requests are not allowed.'); err.status = 403; throw err;
  }
}
async function readJson(req) {
  let size = 0, chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 14 * 1024 * 1024) { const err = new Error('Request too large'); err.status = 413; throw err; } chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { const err = new Error('Invalid JSON'); err.status = 400; throw err; }
}
export function isExpectedFile(mimeType, bytes) {
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if (mimeType === 'image/webp') return bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WEBP'));
  if (mimeType === 'application/pdf') return bytes.length >= 5 && bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
  return false;
}
export function normalize(result) {
  const inv = result && typeof result === 'object' ? result : {};
  // Accept a common model synonym as a fallback, while the prompt requires `items`.
  const sourceItems = Array.isArray(inv.items) ? inv.items : Array.isArray(inv.line_items) ? inv.line_items : [];
  const normalized={
    supplier: String(inv.supplier ?? ''), invoice_number: String(inv.invoice_number ?? ''),
    date: String(inv.date ?? ''), currency: String(inv.currency ?? ''),
    subtotal: normalizeInvoiceNumber(inv.subtotal ?? null),
    discount: normalizeInvoiceNumber(inv.discount ?? null),
    tax: normalizeInvoiceNumber(inv.tax ?? inv.gst_total ?? null),
    total: normalizeInvoiceNumber(inv.total ?? inv.grand_total ?? null),
    items: sourceItems.slice(0,100).map(x => ({
      description:String(x.description ?? ''),
      quantity:normalizeInvoiceNumber(x.quantity ?? x.qty ?? null),
      unit_price:normalizeInvoiceNumber(x.unit_price ?? x.rate ?? null),
      amount:normalizeInvoiceNumber(x.amount ?? null),
      ...(x.gst_percent!==undefined?{gst_percent:normalizeGstPercent(x.gst_percent)}:{})
    }))
  };
  for (const key of ['gst_total','round_off','grand_total','calculated_subtotal','calculated_gst_exclusive']) {
    if (inv[key]!==undefined) normalized[key]=normalizeInvoiceNumber(inv[key]);
  }
  return normalized;
}
export function classifyGeminiFailure(httpStatus, raw, model) {
  let provider = {};
  try { provider = JSON.parse(raw)?.error || {}; } catch {}
  const metadata = {
    code: 'GEMINI_REQUEST_FAILED',
    provider_status: typeof provider.status === 'string' ? provider.status : 'UNKNOWN'
  };
  if (httpStatus === 404 || provider.status === 'NOT_FOUND') {
    return {...metadata, code:'GEMINI_MODEL_UNAVAILABLE', error:`Gemini model "${model}" is unavailable to this API key. Choose a currently available multimodal model.`};
  }
  if (httpStatus === 401) {
    return {...metadata, code:'GEMINI_AUTH_FAILED', error:'Gemini rejected the API key. Check that the key is valid and enabled.'};
  }
  if (httpStatus === 403) {
    return {...metadata, code:'GEMINI_ACCESS_DENIED', error:'This Gemini API key or project is not permitted to use the requested model.'};
  }
  if (httpStatus === 429) {
    return {...metadata, code:'GEMINI_QUOTA_EXCEEDED', error:'Gemini quota or rate limit was exceeded. Wait and retry, or review the project quota and billing tier.'};
  }
  if (httpStatus >= 500) {
    return {...metadata, code:'GEMINI_SERVICE_UNAVAILABLE', error:'Gemini is temporarily unavailable. Retry shortly.'};
  }
  return {...metadata, code:'GEMINI_REQUEST_REJECTED', error:'Gemini rejected this extraction request. Check the file and model configuration.'};
}
const transientGeminiStatuses = new Set([408,500,502,503,504]);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export async function requestGemini({endpoint,apiKey,payload,fetchImpl=fetch,maxAttempts=2,retryDelayMs=300,sleep=wait}) {
  for (let attempt=1; attempt<=maxAttempts; attempt++) {
    try {
      const response=await fetchImpl(endpoint,{method:'POST',signal:AbortSignal.timeout(45000),headers:{'Content-Type':'application/json','x-goog-api-key':apiKey},body:JSON.stringify(payload)});
      if (!transientGeminiStatuses.has(response.status) || attempt===maxAttempts) return response;
      try { await response.body?.cancel(); } catch {}
    } catch (error) {
      // Do not retry a timeout: the upstream request may still be processing and a retry would add delay/cost.
      if (attempt===maxAttempts || error?.name==='AbortError' || error?.name==='TimeoutError') throw error;
    }
    await sleep(retryDelayMs*attempt);
  }
}
function logGeminiFailure(metadata) {
  // Deliberately exclude request bodies, provider messages, headers, and credentials.
  console.warn('Gemini extraction failed', metadata);
}
function safeFilename(value) {
  const filename=String(value ?? 'invoice').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,120);
  return filename || 'invoice';
}
export function getN8nInvoiceWebhookUrl(environment=process.env) {
  const configured = environment.N8N_WEBHOOK_URL;
  if (typeof configured !== 'string' || !configured.trim()) {
    return {ok:false,code:'N8N_WEBHOOK_URL_MISSING',error:'Invoice processing is not configured on this server.'};
  }
  let url;
  try { url = new URL(configured); } catch {
    return {ok:false,code:'N8N_WEBHOOK_URL_INVALID',error:'Invoice processing is not configured on this server.'};
  }
  if (url.protocol !== 'https:' || url.hostname !== N8N_INVOICE_WEBHOOK_HOST || url.port || url.username || url.password || !url.pathname.startsWith('/webhook/') || url.search || url.hash) {
    return {ok:false,code:'N8N_WEBHOOK_URL_INVALID',error:'Invoice processing is not configured on this server.'};
  }
  return {ok:true,url:url.toString()};
}
export function getN8nSubmissionStatusWebhookUrl(environment=process.env) {
  const invoiceWebhook=getN8nInvoiceWebhookUrl(environment);
  if (!invoiceWebhook.ok) return invoiceWebhook;
  const statusUrl=new URL('/webhook/dashboard-submission-status',invoiceWebhook.url);
  return {ok:true,url:statusUrl.toString()};
}
export function isSubmissionId(value) {
  return typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value);
}
export async function submitInvoiceToN8n({bytes,mimeType,fileName,submissionId,secret,endpoint,fetchImpl=fetch}) {
  const form=new FormData();
  form.set('Invoice',new Blob([bytes],{type:mimeType}),safeFilename(fileName));
  form.set('submission_id',submissionId);
  return fetchImpl(endpoint,{method:'POST',headers:{'x-bill-ai-secret':secret},body:form,signal:AbortSignal.timeout(15000)});
}
export async function requestSubmissionStatus({submissionId,secret,endpoint,fetchImpl=fetch}) {
  const statusUrl=new URL(endpoint);
  statusUrl.searchParams.set('submission_id',submissionId);
  return fetchImpl(statusUrl,{method:'GET',headers:{'x-bill-ai-secret':secret},signal:AbortSignal.timeout(15000)});
}
export function isDuplicateSubmissionResult(payload) {
  return Boolean(payload&&typeof payload==='object'&&payload.duplicate===true);
}
export function normalizeN8nUploadResult(payload,submissionId) {
  if (payload?.submission_id!==undefined&&payload.submission_id!==submissionId) throw new Error('Mismatched upload response');
  const duplicate=isDuplicateSubmissionResult(payload);
  const result={
    accepted:true,
    submission_id:submissionId,
    processing_status:duplicate?'duplicate':'accepted_for_processing',
    message:duplicate?'Duplicate bill detected — this invoice has already been submitted. No duplicate record was created.':'Accepted for processing — not yet saved.'
  };
  if (typeof payload?.duplicate==='boolean') result.duplicate=duplicate;
  return result;
}
function statusField(value,limit=200) {
  return typeof value==='string' ? value.slice(0,limit) : '';
}
function invoiceValue(value,limit=200) {
  const normalized=normalizeInvoiceNumber(value);
  return typeof normalized==='string'?normalized.slice(0,limit):normalized??'';
}
function normalizeStatusItems(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0,100).filter(item=>item&&typeof item==='object').map(item=>({
    description:statusField(item.description),
    quantity:invoiceValue(item.quantity ?? item.qty),
    unit_price:invoiceValue(item.unit_price ?? item.rate),
    amount:invoiceValue(item.amount),
    gst_percent:normalizeGstPercent(item.gst_percent)
  }));
}
function clearNormalizedNumericWarnings(notes,{subtotal,gstTotal,grandTotal,items}) {
  const validNumber=value=>typeof value==='number'&&Number.isFinite(value);
  return notes.split(/;\s*|(?<=\.)\s+|\r?\n/).filter(note=>{
    const text=note.trim();
    if (/^gst total is missing\.?$/i.test(text)&&validNumber(gstTotal)) return false;
    if (/^subtotal is invalid\.?$/i.test(text)&&validNumber(subtotal)) return false;
    if (/^gst total is invalid\.?$/i.test(text)&&validNumber(gstTotal)) return false;
    if (/^grand total is invalid\.?$/i.test(text)&&validNumber(grandTotal)) return false;
    const itemWarning=text.match(/^item\s+(\d+)\s+(rate|amount)\s+is invalid\.?$/i);
    if (itemWarning) {
      const item=items[Number(itemWarning[1])-1];
      const value=itemWarning[2].toLowerCase()==='rate'?item?.unit_price:item?.amount;
      if (validNumber(value)) return false;
    }
    return true;
  }).join('; ').trim();
}
export function normalizeSubmissionStatus(payload,submissionId) {
  if (!payload || typeof payload!=='object' || typeof payload.found!=='boolean') throw new Error('Invalid status response');
  if (payload.submission_id && payload.submission_id!==submissionId) throw new Error('Mismatched status response');
  const gstTotal=invoiceValue(payload.gst_total ?? payload.tax);
  const validationNotes=statusField(payload.validation_notes,1000);
  const subtotal=invoiceValue(payload.subtotal);
  const grandTotal=invoiceValue(payload.grand_total ?? payload.total);
  const items=normalizeStatusItems(payload.items);
  const normalized={
    found:payload.found,
    submission_id:submissionId,
    state:statusField(payload.state,80),
    supplier_name:statusField(payload.supplier_name),
    invoice_number:statusField(payload.invoice_number),
    date:statusField(payload.date,80),
    gstin:statusField(payload.gstin,80),
    payment_mode:statusField(payload.payment_mode,80),
    currency:statusField(payload.currency,12),
    subtotal,
    discount:invoiceValue(payload.discount),
    tax:invoiceValue(payload.tax ?? payload.gst_total),
    total:invoiceValue(payload.total ?? payload.grand_total),
    gst_total:gstTotal,
    round_off:invoiceValue(payload.round_off),
    grand_total:grandTotal,
    calculated_subtotal:invoiceValue(payload.calculated_subtotal),
    calculated_gst_exclusive:invoiceValue(payload.calculated_gst_exclusive),
    items,
    validation_status:statusField(payload.validation_status,80),
    validation_notes:clearNormalizedNumericWarnings(validationNotes,{subtotal,gstTotal,grandTotal,items}),
    review_status:statusField(payload.review_status,80),
    message:statusField(payload.message)
  };
  if (typeof payload.duplicate==='boolean') normalized.duplicate=isDuplicateSubmissionResult(payload);
  return normalized;
}
export function classifyN8nFailure(status) {
  if (status===401 || status===403) return {code:'N8N_WEBHOOK_AUTH_FAILED',error:'The invoice-processing service rejected the server credential.'};
  if (status===429) return {code:'N8N_WEBHOOK_RATE_LIMITED',error:'The invoice-processing service is busy. Retry later.'};
  if (status>=500) return {code:'N8N_WEBHOOK_UNAVAILABLE',error:'The invoice-processing service is temporarily unavailable. Retry later.'};
  return {code:'N8N_WEBHOOK_REJECTED',error:'The invoice-processing service rejected this upload.'};
}
async function extract(req,res) {
  requireJson(req); requireSameOrigin(req);
  const data = await readJson(req);
  if (!['image/jpeg','image/png','image/webp','application/pdf'].includes(data.mimeType)) return reply(res,400,{error:'Use JPG, PNG, WebP or PDF.'});
  if (typeof data.base64 !== 'string' || data.base64.length > Math.ceil(MAX_BYTES*4/3)+8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64)) return reply(res,400,{error:'Invalid image or file too large (10 MB max).'});
  const decoded = Buffer.from(data.base64, 'base64');
  if (!decoded.length || decoded.length > MAX_BYTES) return reply(res,400,{error:'Invalid or oversized file.'});
  if (!isExpectedFile(data.mimeType, decoded)) return reply(res,400,{error:'The file content does not match its declared type.'});
  if (!process.env.BILL_AI_WEBHOOK_SECRET) return reply(res,503,{code:'N8N_WEBHOOK_SECRET_MISSING',error:'Invoice processing is not configured on this server.'});
  const webhook = getN8nInvoiceWebhookUrl();
  if (!webhook.ok) return reply(res,503,{code:webhook.code,error:webhook.error});
  const submissionId=randomUUID();
  let response;
  try {
    response=await submitInvoiceToN8n({bytes:decoded,mimeType:data.mimeType,fileName:data.fileName,submissionId,secret:process.env.BILL_AI_WEBHOOK_SECRET,endpoint:webhook.url});
  } catch(e) {
    // No retry: n8n may have accepted the upload even if this request timed out.
    const failure=e.name==='AbortError'||e.name==='TimeoutError'?{code:'N8N_WEBHOOK_TIMEOUT',error:'Could not confirm processing acceptance. Do not resubmit immediately; check the processing system first.'}:{code:'N8N_WEBHOOK_NETWORK_ERROR',error:'Unable to reach the invoice-processing service. No upload confirmation was received.'};
    return reply(res,502,failure);
  }
  if (!response.ok) {
    const failure=classifyN8nFailure(response.status);
    return reply(res,502,failure);
  }
  let n8nResult;
  try { n8nResult=await response.json(); } catch { try { await response.body?.cancel(); } catch {} }
  return reply(res,202,normalizeN8nUploadResult(n8nResult,submissionId));
}
function statusFailure(status) {
  if (status===401 || status===403) return {code:'N8N_STATUS_AUTH_FAILED',error:'The submission-status service rejected the server credential.'};
  if (status===429) return {code:'N8N_STATUS_RATE_LIMITED',error:'The submission-status service is busy. Retry shortly.'};
  if (status>=500) return {code:'N8N_STATUS_UNAVAILABLE',error:'The submission-status service is temporarily unavailable.'};
  return {code:'N8N_STATUS_REJECTED',error:'The submission-status service rejected this request.'};
}
async function recordStatusInHistory(history,status) {
  // n8n reports found:true when only the Invoice Reviews row matches the submission_id (Invoices rows without it).
  // That response has no line items or amounts, so it is not invoice data and must not create an empty history record.
  if (!status.found||status.duplicate===true||!status.items.length) return;
  try { await history.upsert({submissionId:status.submission_id,source:'n8n',invoice:normalize({...status,supplier:status.supplier_name})}); }
  catch { console.warn('Could not record invoice history', {submission_id:status.submission_id}); }
}
async function submissionStatus(req,res,submissionId,history) {
  requireSameOrigin(req);
  if (!isSubmissionId(submissionId)) return reply(res,400,{code:'INVALID_SUBMISSION_ID',error:'Invalid submission ID.'});
  if (!process.env.BILL_AI_WEBHOOK_SECRET) return reply(res,503,{code:'N8N_WEBHOOK_SECRET_MISSING',error:'Invoice processing is not configured on this server.'});
  const webhook=getN8nSubmissionStatusWebhookUrl();
  if (!webhook.ok) return reply(res,503,{code:webhook.code,error:webhook.error});
  let response;
  try {
    response=await requestSubmissionStatus({submissionId,secret:process.env.BILL_AI_WEBHOOK_SECRET,endpoint:webhook.url});
  } catch(e) {
    const failure=e.name==='AbortError'||e.name==='TimeoutError'?{code:'N8N_STATUS_TIMEOUT',error:'Could not confirm the saved submission status. Retry shortly.'}:{code:'N8N_STATUS_NETWORK_ERROR',error:'Unable to reach the submission-status service.'};
    return reply(res,502,failure);
  }
  if (!response.ok) return reply(res,502,statusFailure(response.status));
  let payload;
  try { payload=JSON.parse(await response.text()); } catch { return reply(res,502,{code:'N8N_STATUS_INVALID_RESPONSE',error:'The submission-status service returned an invalid response.'}); }
  let status;
  try { status=normalizeSubmissionStatus(payload,submissionId); } catch { return reply(res,502,{code:'N8N_STATUS_INVALID_RESPONSE',error:'The submission-status service returned an invalid response.'}); }
  await recordStatusInHistory(history,status);
  return reply(res,200,status);
}
async function save(req,res,history) {
  requireJson(req); requireSameOrigin(req);
  const input=await readJson(req);
  const invoice=normalize(input.invoice);
  const warnings=validateInvoice(invoice);
  if (warnings.length && input.confirmedWarnings !== true) return reply(res,422,{error:'Review validation warnings and confirm before saving.',warnings});
  if (!invoice.invoice_number && !invoice.supplier) return reply(res,422,{error:'Supplier or invoice number is required.'});
  // Record the approved version before forwarding, so history persists even when n8n is unavailable.
  await history.upsert({submissionId:isSubmissionId(input.submission_id)?input.submission_id:null,source:'approved',invoice});
  const url=process.env.N8N_WEBHOOK_URL;
  if (!url) return reply(res,409,{history_saved:true,error:'n8n webhook not configured. You can download the CSV now or set N8N_WEBHOOK_URL.'});
  let parsed;
  try { parsed=new URL(url); } catch { return reply(res,500,{history_saved:true,error:'Invalid n8n webhook URL.'}); }
  // Local-only default avoids sending client bills to arbitrary external destinations accidentally.
  if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || !['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)) return reply(res,403,{history_saved:true,error:'Remote webhook blocked in demo. Use a local HTTP(S) n8n URL.'});
  try {
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(process.env.N8N_SHARED_SECRET?{'x-bill-agent-secret':process.env.N8N_SHARED_SECRET}:{})},body:JSON.stringify({invoice,approved_at:new Date().toISOString(),warnings_acknowledged:warnings.length>0}),signal:AbortSignal.timeout(15000)});
    if (!r.ok) return reply(res,502,{history_saved:true,error:`n8n returned ${r.status}; check whether webhook is active and sheet is connected.`});
    return reply(res,200,{history_saved:true,ok:true,message:'Approved invoice sent to n8n.'});
  } catch { return reply(res,502,{history_saved:true,error:'Cannot reach n8n. Check its webhook URL and whether n8n is running.'}); }
}
async function listHistory(req,res,history) {
  requireSameOrigin(req);
  return reply(res,200,{invoices:(await history.list()).map(historySummary)});
}
async function historyCsv(req,res,history) {
  requireJson(req); requireSameOrigin(req);
  const data=await readJson(req);
  const columns=csvColumns(data.columns);
  if (!columns) return reply(res,400,{error:'Invalid CSV column mapping.'});
  let records;
  if (data.ids===undefined) records=[...await history.list()].reverse();
  else {
    if (!Array.isArray(data.ids)||!data.ids.length||data.ids.length>1000||!data.ids.every(isSubmissionId)) return reply(res,400,{error:'Select one or more saved invoices.'});
    records=await history.get([...new Set(data.ids)]);
    if (records.includes(null)) return reply(res,404,{error:'One or more selected invoices are no longer in history.'});
  }
  if (!records.length) return reply(res,404,{error:'No saved invoices to export.'});
  const csv=safeCsvMany(records.map(record=>record.invoice),columns);
  res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="invoices.csv"',...securityHeaders}); return res.end('\uFEFF'+csv);
}
export function createServer({history=createHistoryStore()}={}) {
  return http.createServer(async(req,res)=>{
  try {
    const requestUrl=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    const statusMatch=requestUrl.pathname.match(/^\/api\/submissions\/([^/]+)\/status$/);
    if(req.method==='GET' && statusMatch) return await submissionStatus(req,res,decodeURIComponent(statusMatch[1]),history);
    if(req.method==='GET' && requestUrl.pathname==='/api/invoices') return await listHistory(req,res,history);
    if(req.method==='POST' && req.url==='/api/invoices/csv') return await historyCsv(req,res,history);
    if(req.method==='POST' && req.url==='/api/extract') return await extract(req,res);
    if(req.method==='POST' && req.url==='/api/save') return await save(req,res,history);
    if(req.method==='POST' && req.url==='/api/csv') {
      requireJson(req); requireSameOrigin(req);
      const data=await readJson(req); const columns=csvColumns(data.columns);
      if (!columns) return reply(res,400,{error:'Invalid CSV column mapping.'});
      const csv=safeCsv(normalize(data.invoice),columns);
      res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="invoice.csv"',...securityHeaders}); return res.end('\uFEFF'+csv);
    }
    if(req.method!=='GET') return reply(res,405,{error:'Method not allowed'});
    // Browsers request /favicon.ico by default; serve the same local SVG icon.
    const page = req.url==='/' ? '/index.html' : req.url==='/favicon.ico' ? '/favicon.svg' : req.url;
    if (!['/index.html','/app.js','/style.css','/recovery.css','/favicon.svg'].includes(page)) return reply(res,404,{error:'Not found'});
    const buffer=await readFile(resolve(root,'public',page.slice(1)));
    res.writeHead(200,{'Content-Type':mime[extname(page)],...securityHeaders}); res.end(buffer);
  } catch (e) { reply(res,e.status||500,{error:e.status?e.message:'Unexpected server error.'}); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await loadLocalEnvironment();
  const PORT = Number(process.env.PORT || 3000);
  const historyFile=resolve(root, process.env.BILL_AI_HISTORY_FILE || 'data/invoices.json');
  createServer({history:createHistoryStore({file:historyFile})}).listen(PORT,'127.0.0.1',()=>console.log(`Bill Agent demo: http://localhost:${PORT}`));
}
