export function normalizeInvoiceNumber(value) {
  if (typeof value==='number') return Number.isFinite(value) ? value : value;
  if (typeof value!=='string'||value.trim()==='') return value;
  const text=value.trim();
  const parenthesized=text.startsWith('(')&&text.endsWith(')');
  const numericText=parenthesized?text.slice(1,-1).trim():text;
  const match=numericText.match(/^([+-]?)\s*([$€£₹¥])?\s*((?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3}|\d+)(?:\.\d+)?)\s*(hrs?)?$/i);
  if (!match||(parenthesized&&match[1])) return value;
  const amount=Number(match[3].replaceAll(',',''));
  if (!Number.isFinite(amount)) return value;
  return (parenthesized||match[1]==='-'?-1:1)*amount;
}

export function calculateInvoiceAmounts(inv) {
  let calculatedSubtotal=0;
  let allAmountsValid=true;
  let allGstRatesValid=true;
  const gstContributions=[];
  for (const item of inv.items) {
    if (typeof item.amount==='number'&&Number.isFinite(item.amount)) calculatedSubtotal+=item.amount;
    else allAmountsValid=false;
    const rate=item.gst_percent;
    if (typeof rate!=='number'||!Number.isFinite(rate)||rate<0||rate>100) allGstRatesValid=false;
    else if (typeof item.amount==='number'&&Number.isFinite(item.amount)) gstContributions.push({amount:item.amount,rate});
  }
  let calculatedGstExclusive=0;
  if (inv.items.length&&allAmountsValid&&allGstRatesValid&&typeof inv.subtotal==='number'&&Number.isFinite(inv.subtotal)&&inv.subtotal!==0) {
    const discount=typeof inv.discount==='number'&&Number.isFinite(inv.discount)?inv.discount:0;
    // Allocate an invoice-wide discount proportionally across line amounts before GST.
    const discountFactor=(calculatedSubtotal+discount)/calculatedSubtotal;
    calculatedGstExclusive=gstContributions.reduce((sum,item)=>sum+item.amount*discountFactor*item.rate/100,0);
  }
  return {calculatedSubtotal,calculatedGstExclusive,allAmountsValid,allGstRatesValid};
}

export function validateInvoice(inv) {
  const notes=[];
  const isMissing=value=>value===null||value===undefined||(typeof value==='string'&&!value.trim());
  const isNumber=value=>typeof value==='number'&&Number.isFinite(value);
  const discount=isMissing(inv.discount)?0:inv.discount;
  const roundOff=isMissing(inv.round_off)?0:inv.round_off;
  const calculated=calculateInvoiceAmounts(inv);
  if(!inv.supplier) notes.push('Supplier is missing.');
  if(!inv.invoice_number) notes.push('Invoice number is missing.');
  if(!inv.date) notes.push('Invoice date is missing or unclear.');
  if(!inv.items.length) notes.push('No item rows were recognized.');
  for (const [field,label] of [['subtotal','Subtotal'],['tax','GST total'],['total','Grand total']]) {
    if(!isMissing(inv[field])&&!isNumber(inv[field])) notes.push(`${label} is invalid.`);
  }
  for (const [field,label] of [['discount','Discount'],['round_off','Round-off']]) {
    if(!isMissing(inv[field])&&!isNumber(inv[field])) notes.push(`${label} is invalid.`);
  }
  for (let i=0;i<inv.items.length;i++) {
    const x=inv.items[i];
    for (const [field,label] of [['quantity','quantity'],['unit_price','rate'],['amount','amount']]) {
      if(!isMissing(x[field])&&!isNumber(x[field])) notes.push(`Item ${i+1} ${label} is invalid.`);
    }
    if(x.quantity!=null && x.unit_price!=null && x.amount!=null && [x.quantity,x.unit_price,x.amount].every(isNumber)) {
      if(Math.abs(x.quantity*x.unit_price-x.amount)>0.05) notes.push(`Row ${i+1}: quantity × unit price differs from amount (may be discount/tax).`);
    }
  }
  if([inv.subtotal,inv.tax,inv.total].every(isNumber)&&isNumber(discount)&&isNumber(roundOff)) {
    if(Math.abs(inv.subtotal+discount+inv.tax+roundOff-inv.total)>0.05) notes.push('Subtotal + discount + tax + round-off does not equal total.');
  }
  if(inv.items.length>0&&calculated.allAmountsValid&&calculated.allGstRatesValid&&isNumber(inv.subtotal)&&inv.subtotal!==0&&isNumber(inv.tax)) {
    if(Math.abs(calculated.calculatedGstExclusive-inv.tax)>0.02) notes.push('GST mismatch: verify tax-inclusive/exclusive pricing');
  }
  return notes;
}
const escapeCell = val => {
  let v=val===null||val===undefined?'':String(val);
  const numeric=typeof val==='number'&&Number.isFinite(val)||typeof val==='string'&&/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(v.trim());
  if (!numeric&&/^[\s]*[=+\-@\t\r]/.test(v)) v="'"+v; // spreadsheet formula injection defense
  return '"'+v.replaceAll('"','""')+'"';
};
// Exportable CSV fields. The first 13, in this order, are the default format.
const CSV_FIELD_VALUES={
  supplier:inv=>inv.supplier,
  invoice_number:inv=>inv.invoice_number,
  date:inv=>inv.date,
  currency:inv=>inv.currency,
  description:(inv,item)=>item.description,
  quantity:(inv,item)=>item.quantity,
  unit_price:(inv,item)=>item.unit_price,
  amount:(inv,item)=>item.amount,
  subtotal:inv=>inv.subtotal,
  discount:inv=>inv.discount,
  tax:inv=>inv.tax,
  round_off:inv=>inv.round_off,
  total:inv=>inv.total,
  line_number:(inv,item,index)=>inv.items.length?index+1:''
};
export const CSV_FIELDS=Object.keys(CSV_FIELD_VALUES);
export const DEFAULT_CSV_COLUMNS=CSV_FIELDS.slice(0,13).map(key=>({key,label:key}));
// Returns validated [{key,label}] columns, the default when omitted, or null when invalid.
export function csvColumns(columns) {
  if (columns===undefined||columns===null) return DEFAULT_CSV_COLUMNS;
  if (!Array.isArray(columns)||!columns.length||columns.length>CSV_FIELDS.length) return null;
  const keys=new Set();
  const valid=[];
  for (const column of columns) {
    if (!column||typeof column!=='object'||!Object.hasOwn(CSV_FIELD_VALUES,column.key)||keys.has(column.key)) return null;
    if (typeof column.label!=='string'||!column.label.trim()||column.label.length>100) return null;
    keys.add(column.key);
    valid.push({key:column.key,label:column.label.trim()});
  }
  return valid;
}
export function safeCsv(inv,columns) {
  return safeCsvMany([inv],columns);
}
// One header row, then one row per line item for every invoice (header-only invoices keep a single row).
// Header labels go through the same escaping as values, so renamed columns cannot inject formulas.
export function safeCsvMany(invoices,columns=DEFAULT_CSV_COLUMNS) {
  const rows=invoices.flatMap(inv=>(inv.items.length? inv.items:[{}]).map((item,index)=>columns.map(column=>CSV_FIELD_VALUES[column.key](inv,item,index))));
  return [columns.map(column=>column.label),...rows].map(row=>row.map(escapeCell).join(',')).join('\r\n')+'\r\n';
}
