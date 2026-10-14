// Giriş Kalite — tek kaydı yazdırılabilir Excel formuna döker. Referans v81
// girisKaliteExcelOlustur + exceljsYukle + excelDosyaIndir (+ excelSatirYuksekligi/SutunHarfi)
// BİREBİR; v2 IncomingInspection modeline uyarlı (karakteristik limitleri explicit
// lowerLimit/upperLimit'ten — referanstaki olcuMetniniAyristir gerekmez).
//
// ExcelJS CDN'den runtime yüklenir (jsdelivr → cdnjs yedek). Dışa aktarım salt-okuma —
// düzenleme yetkisi gerekmez.

import { toast } from '../core/toast.js';
import { t } from '../core/i18n.js';
import { fmtDateTR } from '../core/format.js';

let _exceljsPromise = null;
function exceljsYukle() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (_exceljsPromise) return _exceljsPromise;
  const kaynaklar = [
    'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js',
  ];
  _exceljsPromise = new Promise((resolve, reject) => {
    let i = 0;
    const dene = () => {
      if (i >= kaynaklar.length) { _exceljsPromise = null; reject(new Error('ExcelJS yüklenemedi')); return; }
      const s = document.createElement('script');
      s.src = kaynaklar[i++];
      s.onload = () => window.ExcelJS ? resolve(window.ExcelJS) : dene();
      s.onerror = dene;
      document.head.appendChild(s);
    };
    dene();
  });
  return _exceljsPromise;
}

function excelSutunHarfi(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

function excelSatirYuksekligi(metin, genislik, minYukseklik, punto) {
  punto = punto || 10;
  const karSatir = Math.max(4, Math.floor(genislik * 1.05));
  const satir = String(metin == null ? '' : metin).split('\n').reduce((s, p) => s + Math.max(1, Math.ceil(p.length / karSatir)), 0);
  return Math.max(minYukseklik || 18, satir * (punto + 4) + 6);
}

async function excelDosyaIndir(wb, dosyaAdi) {
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = dosyaAdi;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

// Referans girisKaliteExcelOlustur — k normalize edilmiş kayıt, birim string, kapsananOzet string[].
function excelOlustur(ExcelJS, k, birim, kapsananOzet) {
  const kar = k.karakteristikler || [];
  const toplamNumune = Math.max(k.ornekAdedi || 0, ...kar.map(x => (x.degerler || []).length), 1);
  const parcaSayisi = Math.ceil(toplamNumune / 10);
  const slot = Math.ceil(toplamNumune / parcaSayisi);
  const T = 4 + slot;
  const genislikler = [5, 30, 20, ...Array.from({ length: slot }, () => 8.5), 11];
  const toplamGenislik = genislikler.reduce((a, b) => a + b, 0);
  const aralikGenislik = (c1, c2) => genislikler.slice(c1 - 1, c2).reduce((a, b) => a + b, 0);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Özmel Dış Ticaret';
  wb.title = 'Giriş Kalite Kontrol Formu';
  const ws = wb.addWorksheet('Giriş Kalite Kontrol', { views: [{ showGridLines: false }] });
  genislikler.forEach((g, i) => { ws.getColumn(i + 1).width = g; });

  const ince = { style: 'thin', color: { argb: 'FF000000' } };
  const kenar = { top: ince, left: ince, bottom: ince, right: ince };
  const GRI = 'FFD9D9D9', ACIK = 'FFF2F2F2';
  let r = 0;

  const toplamPx = 7 * toplamGenislik + 5 * T;
  const olcekDik = Math.min(1, 0.97 * 717 / toplamPx);
  const dikey = olcekDik >= 0.9;
  const olcek = dikey ? olcekDik : Math.min(1, 0.97 * 1045 / toplamPx);
  const olcekYuzde = Math.max(40, Math.floor(olcek * 100));
  const sayfaYuksekligi = dikey ? 841.9 : 595.3;
  const sayfaKapasitesi = ((sayfaYuksekligi - 1.1 * 72) / (olcekYuzde / 100)) * 0.99;
  let kullanilan = 0;
  const satirToplami = (a, b) => { let tt = 0; for (let i = a; i <= b; i++) tt += ws.getRow(i).height || 15; return tt; };
  const sayfaKontrol = (bas) => {
    const yuk = satirToplami(bas, r);
    if (kullanilan > 0 && kullanilan + yuk > sayfaKapasitesi) { ws.getRow(bas - 1).addPageBreak(); kullanilan = yuk; }
    else kullanilan += yuk;
  };

  const yaz = (satir, c1, c2, deger, o) => {
    o = o || {};
    if (c2 > c1) ws.mergeCells(satir, c1, satir, c2);
    const bas = ws.getCell(satir, c1);
    bas.value = (deger === undefined || deger === null) ? '' : deger;
    for (let c = c1; c <= c2; c++) {
      const hucre = ws.getCell(satir, c);
      if (!o.sinirYok) hucre.border = kenar;
      if (o.fill) hucre.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
    }
    bas.font = { name: 'Arial', size: o.size || 10, bold: !!o.bold, italic: !!o.italic, color: { argb: 'FF000000' } };
    bas.alignment = { horizontal: o.align || 'left', vertical: o.valign || 'middle', wrapText: o.wrap !== false, indent: (o.align || 'left') === 'left' ? 1 : 0 };
    if (o.numFmt) bas.numFmt = o.numFmt;
  };
  const bosSatir = (h) => { r++; ws.getRow(r).height = h; };
  const tarih = (x) => x ? fmtDateTR(x) : '';

  // ---- Başlık ----
  r++; yaz(r, 1, T, 'Özmel Dış Ticaret', { bold: true, size: 11, align: 'center', fill: ACIK }); ws.getRow(r).height = 22;
  r++; yaz(r, 1, T, 'GİRİŞ KALİTE KONTROL FORMU', { bold: true, size: 16, align: 'center' }); ws.getRow(r).height = 30;
  bosSatir(6);

  // ---- Bilgi bloğu (iki sütunlu) ----
  let p = 3, acc = aralikGenislik(1, 3);
  while (p < T - 2 && acc < toplamGenislik / 2) { p++; acc += genislikler[p - 1]; }
  const sagEtiketBitis = p + Math.ceil((T - p) / 2);
  const bilgi = (solE, solD, sagE, sagD) => {
    r++;
    yaz(r, 1, 2, solE, { bold: true, fill: ACIK });
    yaz(r, 3, p, solD, {});
    yaz(r, p + 1, sagEtiketBitis, sagE, { bold: true, fill: ACIK });
    yaz(r, sagEtiketBitis + 1, T, sagD, {});
    ws.getRow(r).height = Math.max(
      excelSatirYuksekligi(solD, aralikGenislik(3, p), 22), excelSatirYuksekligi(sagD, aralikGenislik(sagEtiketBitis + 1, T), 22),
      excelSatirYuksekligi(solE, aralikGenislik(1, 2) * 0.85, 22), excelSatirYuksekligi(sagE, aralikGenislik(p + 1, sagEtiketBitis) * 0.85, 22));
  };
  bilgi('Tedarikçi', k.tedarikci || '', 'Kontrol Tarihi', tarih(k.kontrolTarihi));
  bilgi('Malzeme', k.malzeme || '', 'Malzeme Geliş Tarihi', tarih(k.malzemeGelisTarihi));
  bilgi('Çizim No', k.cizimNo || '', 'İrsaliye No', '');
  bilgi('Gelen Adet', `${k.gelenAdet ?? ''} ${birim}`.trim(), 'Numune Adedi (FR-09)', k.ornekAdedi ?? '');
  bilgi('Gözlem Nedeni', k.gozlemNedeni || '', 'Kontrol Eden', k.kontrolEden || '');
  if (kapsananOzet.length) {
    const metin = kapsananOzet.join('   |   ');
    r++;
    yaz(r, 1, 2, kapsananOzet.length > 1 ? 'Kapsanan Girişler' : 'Kapsanan Giriş', { bold: true, fill: ACIK });
    yaz(r, 3, T, metin, { size: 9 });
    ws.getRow(r).height = Math.max(22, excelSatirYuksekligi(metin, aralikGenislik(3, T), 22, 9));
  }
  r++;
  yaz(r, 1, 2, 'Genel Sonuç', { bold: true, fill: ACIK });
  yaz(r, 3, T, k.genelSonuc === 'Kabul' ? 'KABUL' : k.genelSonuc === 'Red' ? 'RED' : '—', { bold: true, size: 13, align: 'center' });
  ws.getRow(r).height = 24;
  bosSatir(6);
  kullanilan = satirToplami(1, r);

  // ---- Ölçüm tablosu ----
  const olcusel = x => x.tip === 'olcusel';
  const limitler = x => ({ alt: x.altLimit, ust: x.ustLimit });
  const satirDurum = x => {
    const { alt, ust } = limitler(x);
    let fail = 0, dolu = 0; const hatali = [];
    for (let i = 0; i < toplamNumune; i++) {
      const v = (x.degerler || [])[i];
      if (v === undefined || v === null || v === '') continue;
      dolu++;
      let kotu = false;
      if (olcusel(x)) {
        if (alt == null || ust == null || isNaN(alt) || isNaN(ust)) kotu = true;
        else if (!(parseFloat(v) >= alt && parseFloat(v) <= ust)) kotu = true;
      } else if (v === 'Uygun Değil') kotu = true;
      if (kotu) { fail++; hatali[i] = true; }
    }
    return { fail, dolu, hatali };
  };
  const olcuMetni = x => {
    if (!olcusel(x)) return 'Görsel (OK / NOK)';
    if (x.olcu) return x.olcu;
    const { alt, ust } = limitler(x);
    return (alt != null && ust != null) ? `${alt} – ${ust}` : '';
  };

  let sonBirimBas;
  if (kar.length === 0) {
    sonBirimBas = r + 1;
    r++; yaz(r, 1, T, 'Bu kayıt için karakteristik girilmemiş.', { italic: true, align: 'center' }); ws.getRow(r).height = 24;
    bosSatir(8);
  } else {
    for (let c = 0; c < parcaSayisi; c++) {
      const blokBas = r + 1;
      const bas = c * slot, bit = Math.min(toplamNumune, bas + slot);
      r++;
      yaz(r, 1, T, parcaSayisi > 1 ? `Ölçüm Sonuçları — Numune ${bas + 1}–${bit}` : 'Ölçüm Sonuçları', { bold: true, size: 11, fill: GRI });
      ws.getRow(r).height = 20;
      r++;
      yaz(r, 1, 1, 'No', { bold: true, align: 'center', fill: ACIK });
      yaz(r, 2, 2, 'Karakteristik', { bold: true, fill: ACIK });
      yaz(r, 3, 3, 'Ölçü / Tolerans', { bold: true, align: 'center', fill: ACIK });
      for (let s = 0; s < slot; s++) {
        const idx = bas + s;
        yaz(r, 4 + s, 4 + s, idx < bit ? idx + 1 : '', { bold: true, align: 'center', fill: idx < bit ? ACIK : 'FFEDEDED' });
      }
      yaz(r, T, T, 'Kabul / Red', { bold: true, align: 'center', fill: ACIK });
      ws.getRow(r).height = 22;
      kar.forEach(x => {
        r++;
        const d = satirDurum(x);
        yaz(r, 1, 1, x.no ?? '', { align: 'center' });
        yaz(r, 2, 2, x.tanim || '', {});
        yaz(r, 3, 3, olcuMetni(x), { align: 'center', size: 9 });
        const ondalikSay = (n) => (String(n).split('.')[1] || '').length;
        let ondalik = 0;
        if (olcusel(x)) {
          ((x.degerler || []).forEach(v => { if (v !== undefined && v !== null && v !== '' && !isNaN(parseFloat(v))) ondalik = Math.max(ondalik, ondalikSay(parseFloat(v))); }));
          (String(x.olcu || '').match(/\d+[.,]\d+/g) || []).forEach(m => { ondalik = Math.max(ondalik, m.length - m.search(/[.,]/) - 1); });
          ondalik = Math.min(3, ondalik);
        }
        const sayiBicimi = ondalik > 0 ? '0.' + '0'.repeat(ondalik) : '0';
        for (let s = 0; s < slot; s++) {
          const idx = bas + s;
          if (idx >= bit) { yaz(r, 4 + s, 4 + s, '', { fill: 'FFEDEDED' }); continue; }
          const v = (x.degerler || [])[idx];
          const bos = (v === undefined || v === null || v === '');
          let goster = '';
          if (!bos) goster = olcusel(x) ? parseFloat(v) : (v === 'Uygun' ? 'OK' : v === 'Uygun Değil' ? 'NOK' : String(v));
          yaz(r, 4 + s, 4 + s, goster, { align: 'center', bold: !!d.hatali[idx], fill: d.hatali[idx] ? GRI : undefined, numFmt: (olcusel(x) && !bos) ? sayiBicimi : undefined });
        }
        const son = (c === parcaSayisi - 1);
        yaz(r, T, T, !son ? '' : d.dolu === 0 ? '—' : d.fail > 0 ? `Red (${d.fail})` : 'Kabul', { align: 'center', bold: true, fill: (son && d.fail > 0) ? GRI : undefined });
        ws.getRow(r).height = Math.max(excelSatirYuksekligi(x.tanim || '', genislikler[1], 22), excelSatirYuksekligi(olcuMetni(x), genislikler[2], 22, 9));
      });
      bosSatir(8);
      sayfaKontrol(blokBas);
    }
    sonBirimBas = r + 1;
    r++; yaz(r, 1, T, 'Gri dolgulu ve kalın değer: tolerans dışı  ·  OK: uygun  ·  NOK: uygun değil', { italic: true, size: 8, sinirYok: true });
    ws.getRow(r).height = 14;
    bosSatir(6);
  }

  // ---- Açıklama ----
  r++; yaz(r, 1, T, 'Açıklama / İlave Bilgi', { bold: true, fill: ACIK }); ws.getRow(r).height = 18;
  r++; yaz(r, 1, T, k.ilaveBilgi || '', { valign: 'top' });
  ws.getRow(r).height = Math.max(38, excelSatirYuksekligi(k.ilaveBilgi || '', toplamGenislik, 38));
  bosSatir(10);

  // ---- İmza alanları ----
  const b1 = Math.floor(T / 3), b2 = Math.floor(2 * T / 3);
  r++;
  yaz(r, 1, b1, 'Kontrol Eden (Ad Soyad / İmza)', { bold: true, align: 'center', fill: ACIK });
  yaz(r, b1 + 1, b2, 'Kalite Sorumlusu / Onay (İmza)', { bold: true, align: 'center', fill: ACIK });
  yaz(r, b2 + 1, T, 'Tarih', { bold: true, align: 'center', fill: ACIK });
  ws.getRow(r).height = 26;
  r++;
  yaz(r, 1, b1, k.kontrolEden || '', { align: 'center', valign: 'bottom', size: 9 });
  yaz(r, b1 + 1, b2, '', {});
  yaz(r, b2 + 1, T, '', {});
  ws.getRow(r).height = 42;
  sayfaKontrol(sonBirimBas);

  // ---- Yazdırma ayarları ----
  ws.pageSetup = {
    paperSize: 9, orientation: dikey ? 'portrait' : 'landscape',
    fitToPage: false, scale: olcekYuzde, horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.25, footer: 0.3 },
    printArea: `A1:${excelSutunHarfi(T)}${r}`,
  };
  ws.headerFooter.oddFooter = '&L&8Özmel Dış Ticaret — Giriş Kalite Kontrol Formu&C&8Sayfa &P / &N&R&8Yazdırma: &D';
  return wb;
}

/**
 * Tek inspection kaydını Excel'e aktarır.
 * @param {object} inspection v2 incoming-inspection kaydı
 * @param {{ materialLabel:(id)=>string, materialCode:(id)=>string, birim:string, kapsananOzet:string[] }} ctx
 */
export async function exportInspectionExcel(inspection, ctx) {
  const k = {
    tedarikci: inspection.supplier || '',
    malzeme: inspection.materialCodeId != null ? ctx.materialLabel(inspection.materialCodeId) : '',
    cizimNo: inspection.drawingNo || '',
    kontrolTarihi: inspection.inspectionDate || '',
    malzemeGelisTarihi: inspection.arrivalDate || '',
    gelenAdet: inspection.receivedQty,
    ornekAdedi: inspection.sampleQty,
    gozlemNedeni: inspection.reason || '',
    kontrolEden: inspection.inspectorName || '',
    genelSonuc: inspection.overallResult || '',
    ilaveBilgi: '',
    karakteristikler: (inspection.characteristics || []).map(c => ({
      no: c.charNo, tanim: c.name, tip: c.type, olcu: c.specText || '',
      altLimit: c.lowerLimit, ustLimit: c.upperLimit, birim: c.unit,
      degerler: (c.values || []).map(v => (v && v.result != null) ? v.result : (v ? v.value : null)),
    })),
  };
  toast(t('gk.excelPreparing'));
  let ExcelJS;
  try { ExcelJS = await exceljsYukle(); }
  catch (e) { toast(t('gk.excelLibFail'), 'danger'); return; }
  try {
    const wb = excelOlustur(ExcelJS, k, ctx.birim || '', ctx.kapsananOzet || []);
    const kod = (inspection.materialCodeId != null ? ctx.materialCode(inspection.materialCodeId) : '') || 'Kontrol';
    const ad = String(kod).replace(/[^\wşŞıİçÇöÖüÜğĞ]+/g, '_').slice(0, 40);
    const dosyaAdi = `Giris_Kalite_${ad}_${inspection.inspectionDate || ''}.xlsx`;
    await excelDosyaIndir(wb, dosyaAdi);
    toast(t('gk.excelDone'));
  } catch (e) {
    console.error(e);
    toast(t('gk.excelFail', { e: e.message || e }), 'danger');
  }
}
