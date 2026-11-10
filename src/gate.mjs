// Gate v3: deterministic pre-checks. Durable reservation and payout live in pipeline_v3.mjs.
import fs from 'node:fs';

export const normNo=s=>String(s??'').normalize('NFKC').replace(/[\p{Cf}\p{Z}\s]/gu,'').toUpperCase();
const isConfusable=s=>s!==''&&!/^[A-Z0-9-]+$/.test(s);

export function gate(inv,ctx,seen=new Set()){
  const r=[]; const v=ctx.vendors.find(v=>v.name===inv.vendor);
  const invoiceNorm=normNo(inv.invoice_no??inv.id),poNorm=normNo(inv.po);
  if(!/^\d{1,7}\.\d{2}$/.test(String(inv.amount))||!(+inv.amount>0)) r.push('AMOUNT_FORMAT');
  if(!v) r.push('VENDOR_UNKNOWN');
  else{if(inv.pay_to!==v.paypal) r.push('PAYEE_MISMATCH');if(+inv.amount>v.max) r.push('OVER_CAP');}
  const po=ctx.purchase_orders?.find(p=>normNo(p.po)===poNorm&&p.vendor===inv.vendor);
  if(ctx.purchase_orders){if(!po) r.push('NO_PO');else if(po.amount!==inv.amount) r.push('AMOUNT_NE_PO');}
  if(poNorm&&((ctx.paid_pos??[]).map(normNo).includes(poNorm)||seen.has('PO|'+poNorm))) r.push('PO_ALREADY_BILLED');
  const key=inv.vendor+'|'+invoiceNorm;
  if((ctx.paid_invoice_numbers??[]).map(normNo).includes(invoiceNorm)||seen.has(key)||inv.dup_of) r.push('DUPLICATE');
  if(inv.invoice_no!==undefined&&invoiceNorm!==String(inv.invoice_no).toUpperCase()) r.push('HIDDEN_CHARS');
  if(inv.po&&poNorm!==String(inv.po).toUpperCase()) r.push('HIDDEN_CHARS');
  if(isConfusable(invoiceNorm)||isConfusable(poNorm)) r.push('CONFUSABLE');
  seen.add(key);
  if(/ignore previous|system:|assistant|AI 비서|asistente|note to ai|update .*(email|address)|actualizar/i.test(inv.notes)) r.push('INJECTION_SUSPECT');
  if(!r.length&&poNorm) seen.add('PO|'+poNorm);
  return {verdict:r.length?'BLOCK':'PASS',reasons:r};
}
