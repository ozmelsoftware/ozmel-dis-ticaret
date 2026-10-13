# Brief — Kapasite Analizi (yeni modül)

Kaynak: referans `docs/referans/2026-10-13.html` → `viewKapasiteAnalizi` + yardımcıları.
Tasarım: `Kapasite Analizi.html` (Claude Design, index'le birebir).
Fark analizi: `docs/staging-v81-fark.md` §1.

**Yeni ekran. Salt-okunur analiz + tek yazma (Uygula → capacity).**

---

## Ne yapar

Gerçekleşen üretimden (production) makine/ürün/operasyon başına **günlük kapasite** tahmini
çıkarır, tanımlı `capacity` ile karşılaştırır, sapma >%10 ve ≥3 gün veri olan satırlarda
**öneri** verir. "Uygula" önerilen değeri `capacity`'ye yazar.

Menü: **Üretim Planlama** grubunda, Kapasite Yönetimi'nden sonra (`kapasiteanalizi`).

## Veri (hepsi mevcut `listAll` — yeni okuma ucu YOK)

`verimlilik.js` deseni: `Promise.all` ile work-centers, product-codes, work-orders,
production, working-hours. Çalışma saatleri için `core/capacity.js`:
- `netWorkMinutes(wh)` / `shiftWorkMinutes(wh)` → tam gün net dk (Sabah+Öğleden Sonra)
- `downtimeMinutes(start, end, wh)` → mola düşülmüş duruş (her production satırı)
- `resolveCapacity(caps, productId, wcId, opId, netMin)` → tanımlı günlük kapasite
`core/report.js`: `mondayOf` (haftalık dönem), `MONTHS` (aylık etiket), `thresholdClass`.

## Hesap (referansla aynı)

- Her production kaydı → ait olduğu work_order (ürün, operasyon, iş merkezi), vardiya, adet, duruş.
- **Hariç**: hariç-tarih listesi · (opsiyon) notunda "iş emri kapamak için"/"giriş yapılmıştır"
  geçenler · Mesai vardiyası (süresi bilinmiyor) · boş satır (0 adet, duruşsuz).
- Aynı makine+gün+vardiyada birden çok iş emri → vardiya süresi **eşit bölünür** (paylaşım%).
- **Gerçekleşen günlük (duruşlu)** = adet ÷ planlı süre × tam gün.
- **Duruşsuz günlük** = adet ÷ (planlı süre − duruş) × tam gün.
- **Öneri**: duruşsuz 50'ye yuvarlanır; |fark|≤%10 Uygun · <−%10 Düşür · >+%10 Artır ·
  tanımsız Tanımla · <3 gün "Az veri". Paylaşım ≥%30 ise ⚑ uyarı.

## Ekran (tasarımla birebir)

1. Üst filtre: mod (Tüm/Aylık/Haftalık) · değer (Duruşsuz/Gerçekleşen, sadece dönem modunda) ·
   makine seçimi · ürün/operasyon arama.
2. Yöntem paneli (açıklama metni).
3. Tüm Zamanlar: sıralanabilir tablo (Ürün|Operasyon|Makine|Gün|Toplam|Tanımlı|Gerçekleşen|
   Duruşsuz|Duruş%|Fark|Öneri|Uygula). Fark/öneri renkli.
4. Aylık/Haftalık: matris (satır=ürün/op/makine, sütun=dönem, hücre değer+gün, renkli).
5. Alt panel: analize dahil edilmeyen kayıtlar + hariç-tarih yönetimi + not filtresi onayı.

## i18n / stil

Tüm metinler `t()` (TR+EN eşit, `docs/ceviri-sozlugu.md`'ye yeni anahtarlar). Mevcut renk
tokenları ve `.panel/.table/.btn` sınıfları. `text-transform:uppercase` yalnız sabit başlık.

## Kapsam dışı

- Kapasite tanımının kendisi (Kapasite Yönetimi ekranı ayrı).
- Mesai vardiyası süresinin hesaba katılması (veride yok).

## AÇIK KARAR — "hariç tutulan tarihler" kalıcılığı

Referans bunu DB'de tutar (manuel ekle/çıkar + not). v2 seçenekleri → aşağıda sorulacak.

## Doğrulama

`node --check`, TR/EN anahtar dengesi, tarayıcıda aç (TDZ için). Modül `index.html`'e
`['kapasiteanalizi','kapasiteAnalizi.js','viewKapasiteAnalizi']` + `?v=` bump.
