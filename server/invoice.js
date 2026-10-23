export function validateInvoice(inv) {
  const notes=[];
  if(!inv.supplier) notes.push('Supplier is missing.');
  if(!inv.invoice_number) notes.push('Invoice number is missing.');
  if(!inv.date) notes.push('Invoice date is missing or unclear.');
  if(!inv.items.length) notes.push('No item rows were recognized.');
  for (let i=0;i<inv.items.length;i++) {
    const x=inv.items[i];
    if(x.quantity!=null && x.unit_price!=null && x.amount!=null && [x.quantity,x.unit_price,x.amount].every(v=>typeof v==='number'&&Number.isFinite(v))) {
      if(Math.abs(x.quantity*x.unit_price-x.amount)>0.05) notes.push(`Row ${i+1}: quantity × unit price differs from amount (may be discount/tax).`);
    }
  }
  if([inv.subtotal,inv.tax,inv.total].every(v=>typeof v==='number'&&Number.isFinite(v))) {
    if(Math.abs(inv.subtotal+inv.tax-inv.total)>0.05) notes.push('Subtotal + tax does not equal total (may be discount/rounding).');
  }
  return notes;
}
const escapeCell = val => {
  let v=val===null||val===undefined?'':String(val);
  if (/^[\s]*[=+\-@\t\r]/.test(v)) v="'"+v; // spreadsheet formula injection defense
  return '"'+v.replaceAll('"','""')+'"';
};
export function safeCsv(inv) {
  const columns=['supplier','invoice_number','date','currency','description','quantity','unit_price','amount','subtotal','tax','total'];
  const rows=(inv.items.length? inv.items:[{}]).map(item => [inv.supplier,inv.invoice_number,inv.date,inv.currency,item.description,item.quantity,item.unit_price,item.amount,inv.subtotal,inv.tax,inv.total]);
  return [columns,...rows].map(row=>row.map(escapeCell).join(',')).join('\r\n')+'\r\n';
}
