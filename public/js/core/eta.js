// eta.js — iş emri tahmini bitiş (ETA) hesabı. Referans: v78 workOrderStats (geçerli
// 2. tanım). Öncelik: makine planı (verildiyse) > son 7 üretim ortalaması > yedek hız.
// Genel Bakış (MRP riski) ve İş Emirleri/Satış ekranları paylaşır. Tarih hesabı YEREL (report.js).
//
// opts.plans verilirse (iş emrine bağlı makine planı kayıtları) plan-bazlı ETA denenir:
// planlı adetler tarih sırasıyla kümülatif toplanır, iş emri HEDEFİNE ulaşılan ilk gün
// bitiştir; hiç ulaşılmazsa son planlı gün + planInsufficient=true. Plan yoksa fiili
// ortalamaya, o da yoksa opts.fallbackRate'e (ör. adımın kapasitesi) düşer.
// opts.plans verilmezse davranış ESKİSİYLE AYNI (Genel Bakış etkilenmez).
// Tamamlanmışsa etaDate null (risk yok). production/plans tüm dizidir; workOrderId ile süzülür.

import { startOfDay, addDays, parseISO } from './report.js';

/**
 * @param {{id:any, targetQuantity:number}} workOrder
 * @param {Array<{workOrderId:any, date:string, actualQuantity:number}>} production
 * @param {{today?:Date, fallbackRate?:number, plans?:Array<{workOrderId:any, date:string, targetQuantity:number}>|null}} [opts]
 * @returns {{produced:number, remaining:number, pct:number, avgRate:number|null,
 *            effRate:number|null, daysNeeded:number|null, etaDate:Date|null, complete:boolean,
 *            planBased:boolean, planInsufficient:boolean}}
 */
export function estimateCompletion(workOrder, production, { today = null, fallbackRate = null, plans = null } = {}) {
  const target = Number(workOrder.targetQuantity) || 0;
  const logs = production
    .filter(p => p.workOrderId === workOrder.id)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const produced = logs.reduce((s, p) => s + (Number(p.actualQuantity) || 0), 0);
  const remaining = Math.max(0, target - produced);
  const pct = target > 0 ? Math.min(100, produced / target * 100) : 0;
  const complete = remaining <= 0 && target > 0;

  const recent = logs.slice(-7);
  const avgRate = recent.length
    ? recent.reduce((s, p) => s + (Number(p.actualQuantity) || 0), 0) / recent.length
    : null;
  const effRate = (avgRate && avgRate > 0) ? avgRate : (fallbackRate && fallbackRate > 0 ? fallbackRate : null);

  const base = startOfDay(today || new Date());
  let etaDate = null, daysNeeded = null, planBased = false, planInsufficient = false;
  if (!complete) {
    // Öncelik: makine planı > fiili ortalama > yedek hız.
    const plan = plans ? planCompletion(workOrder, target, plans) : null;
    if (plan) {
      planBased = true;
      etaDate = plan.etaDate;
      planInsufficient = plan.insufficient;
    } else if (effRate) {
      daysNeeded = Math.ceil(remaining / effRate);
      etaDate = addDays(base, daysNeeded);
    }
  }
  return { produced, remaining, pct, avgRate, effRate, daysNeeded, etaDate, complete, planBased, planInsufficient };
}

// Referans planBazliETA: iş emrine bağlı planlı adetleri tarih sırasıyla kümülatif toplar.
// Hedefe ulaşılan ilk gün bitiş; hiç ulaşılmazsa son planlı gün (insufficient=true).
// Eşik HEDEF üzerinden (kalan değil) — referansla birebir. plans/target yoksa null.
function planCompletion(workOrder, target, plans) {
  const recs = plans.filter(p => p.workOrderId === workOrder.id && Number(p.targetQuantity) > 0);
  if (recs.length === 0) return null;
  const byDay = new Map();
  for (const p of recs) byDay.set(p.date, (byDay.get(p.date) || 0) + Number(p.targetQuantity));
  const days = [...byDay.keys()].sort();
  let cum = 0, finishDay = null;
  for (const d of days) {
    cum += byDay.get(d);
    if (finishDay === null && target && cum >= target) finishDay = d;
  }
  const insufficient = target ? cum < target : false;
  return { etaDate: parseISO(finishDay || days[days.length - 1]), insufficient };
}
