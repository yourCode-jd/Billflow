import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

// Local invoice history. `file` null keeps records in memory only (used by tests and createServer defaults).
export function createHistoryStore({file=null,now=()=>new Date().toISOString()}={}) {
  let records=null;
  let queue=Promise.resolve();
  const load=async()=>{
    if (records) return records;
    if (!file) return records=[];
    let text;
    try { text=await readFile(file,'utf8'); } catch(e) { if (e.code==='ENOENT') return records=[]; throw e; }
    // A corrupt file is reported rather than replaced, so existing history is never silently lost.
    const parsed=JSON.parse(text);
    if (!Array.isArray(parsed?.invoices)) throw new Error('Invalid invoice history file');
    return records=parsed.invoices;
  };
  const persist=async()=>{
    if (!file) return;
    await mkdir(dirname(file),{recursive:true});
    const temporary=`${file}.${process.pid}.tmp`;
    await writeFile(temporary,JSON.stringify({version:1,invoices:records},null,2));
    await rename(temporary,file);
  };
  const serialized=task=>{const run=queue.then(task);queue=run.catch(()=>{});return run};
  return {
    list:()=>serialized(async()=>[...await load()].sort((a,b)=>b.updated_at.localeCompare(a.updated_at))),
    get:ids=>serialized(async()=>{const all=await load();return ids.map(id=>all.find(record=>record.id===id)??null)}),
    // source 'approved' is a human-reviewed version and is never replaced by a later n8n status read.
    upsert:({submissionId=null,source,invoice})=>serialized(async()=>{
      const all=await load();
      const key=submissionId?null:manualKey(invoice);
      const existing=all.find(record=>submissionId?record.submission_id===submissionId:!record.submission_id&&key&&manualKey(record.invoice)===key);
      const timestamp=now();
      if (existing) {
        if (existing.source==='approved'&&source!=='approved') return existing;
        const previous={...existing};
        Object.assign(existing,{source,invoice,updated_at:timestamp});
        try { await persist(); } catch(e) { Object.assign(existing,previous); throw e; }
        return existing;
      }
      const record={id:submissionId||randomUUID(),submission_id:submissionId,source,saved_at:timestamp,updated_at:timestamp,invoice};
      all.push(record);
      try { await persist(); } catch(e) { all.pop(); throw e; }
      return record;
    })
  };
}
function manualKey(invoice) {
  const supplier=String(invoice?.supplier??'').trim().toLowerCase();
  const number=String(invoice?.invoice_number??'').trim().toLowerCase();
  return supplier&&number?`${supplier}|${number}`:null;
}
export function historySummary(record) {
  const inv=record.invoice;
  return {id:record.id,submission_id:record.submission_id,source:record.source,saved_at:record.saved_at,updated_at:record.updated_at,supplier:inv.supplier,invoice_number:inv.invoice_number,date:inv.date,currency:inv.currency,total:inv.total,item_count:inv.items.length};
}
