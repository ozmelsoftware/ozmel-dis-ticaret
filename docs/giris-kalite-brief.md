# Brief — Giriş Kalite (v81 hizalama)

Kaynak: referans `docs/referans/2026-10-13.html`. Fark: `docs/staging-v81-fark.md` §5.
**Her şey referansla (index/v81) birebir.** v2 modülü: `public/js/modules/incomingInspections.js`
(DataTable + drawer; kayıt → karakteristik[] → değer[]). DTO `IncomingInspection`.

Üç ayrı parça — farklı büyüklük ve BE ihtiyacı:

---

## A. Excel'e Aktar (SADECE FRONTEND — yeni BE yok)

Tek bir giriş-kalite kaydını yazdırılabilir Excel formuna döker.

- `exceljsYukle` — ExcelJS'i CDN'den tembel yükler (jsdelivr → cdnjs yedek), tek promise.
- `girisKaliteExcelOlustur(ExcelJS, kayit)` (213L) — form üretimi: sayfa ölçeği/sonları, numune
  blokları (10'dan fazla numune birden çok blokta), karakteristik satırları + limit/ölçü
  mantığı (olcusel → alt/üst limit; nitel → OK/NOK). İç yardımcılar: yaz, bosSatir, bilgi,
  satirDurum, limitler, olcuMetni, satirToplami, sayfaKontrol.
- `excelDosyaIndir(wb, dosyaAdi)`, `excelSatirYuksekligi`, `excelSutunHarfi`.
- `girisKaliteTekKayitExcelAktar(id)` — toast + yükle + oluştur + indir.

v2 karşılığı: inspection'da gereken veri VAR (receivedQty, sampleQty, characteristics[] →
nominal/lowerLimit/upperLimit/unit/type + values[]). Düğme: liste satırında "📄 Excel" +
düzenleme formunda "📄 Excel'e Aktar". ExcelJS CDN'den runtime yüklenir (harici script;
mevcut app'te örneği yok — yeni). i18n: `gk.excel*` anahtarları.

## B. Kapsadığı Girişler (BE ŞEMA DEĞİŞİKLİĞİ GEREKİR + frontend)

Referansta bir kalite kaydı **birden çok satınalma girişini (purchase_receipts)** kapsayabilir:
`gk.satinalmaGirisIdleri` (dizi; eski kayıt tekil `satinalmaGirisId`). v2'de inspection **tek**
`purchase_receipt_id`'ye bağlı → çoklu kapsama için depolama yok.

**Gerekli BE değişikliği** (öneri): yeni **join tablo `incoming_inspection_receipts`**
(`inspection_id`, `purchase_receipt_id`, tenant_id + ortak sütunlar, idempotent migration).
`purchase_receipt_id` eski alan geriye-uyum için kalır (tek-kapsama eşlenir). DTO: inspection'a
`purchaseReceiptIds: int[]` eklenir; Repository çocuk tabloyu okur/yazar (machine_plans/kontrol
planı deseni gibi çocuk-tablo yazımı). Controller create/update bu diziyi işler.

Frontend (referans birebir):
- `girisKaliteKapsananGirisIdleri(kayit)` → kapsanan receipt id dizisi (yeni dizi, yoksa tekil).
- Drawer'da kalite kaydına **birden çok giriş seçimi** (checkbox listesi — `girisKaliteGirislerListesiHTML`).
- `girisKaliteGirisToplami(idler)` = seçili girişlerin miktar toplamı.
- **Adet uyarısı** (`girisKaliteAdetUyariMetni`/`Guncelle`): seçili ≥2 girişin toplamı Gelen
  Adet'ten farklıysa kırmızı ⚠ "girişler toplamı N — eşitleyin".
- `girisKaliteKapsananOzet(kayit)` → liste kolonu "Kapsadığı Girişler" (tarih · SP-… · miktar).
- `viewGirisKaliteTab`: yeni "Kapsadığı Girişler" kolonu + Gelen Adet'te toplam-tutarsızlık ⚠.
- `viewGirisKaliteEdit`: Gelen Adet altı uyarı.

## C. Satınalma Girişlerinde tıklanır kalite rozeti (küçük frontend)

`viewSatinalmaGirisleri` (v2: `purchaseReceipts.js`): düz rozet (Uygun/Uygun Değil/Kayıt var)
→ `girisKaliteRozetBaglantili(gk)` ile **tıklanır bağlantıya** (↗, ilgili kalite kaydına gider;
birden çok giriş kapsıyorsa "ortak rapor · N giriş"). `girisKaliteKaydinaGit(id)` navigasyonu.
Bu parça B'ye (kapsama) bağımlı.

---

## Önerilen sıra (her biri ayrı commit)
1. **A — Excel** (BE'siz, en bağımsız, büyük kazanç). Hemen yapılabilir.
2. **B — Kapsama**: migration `046_incoming_inspection_receipts` + DTO/Repo/Controller + drawer
   çoklu seçim + adet uyarısı + liste kolonu.
3. **C — Rozet bağlantısı** (B sonrası).

## Doğrulama & kayıt
`php -l` (B'de BE), `node --check`, TR/EN denge, tarayıcı. Yeni `gk.*` anahtarları +
`ceviri-sozlugu.md`. `?v` bump. Migration ELLE çalıştırılır (B).

> Not: B'deki çoklu kapsama v2'de yeni tablo demek (memory "varsayılan BE yok" — ama referansla
> birebir olması için gerekli). Excel (A) BE gerektirmez.
