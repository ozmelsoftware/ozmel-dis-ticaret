# Claude Code brief — Satış Raporları + ortak sipariş raporu

**Kural:** Spesifikasyon `docs/referans/2026-09-30.html`. v2 fonksiyonları oradaki gibi çalışmalı.
İlgili referans fonksiyonları: `viewSatisRaporlari`, `siparisRaporIcerigi`, `orderStats`, `orderSteps`, `workOrderStats`, `planBazliETA`, `capForStep`, `orderStatusBadge`, `productDailyTarget`

**Dikkat:** Referansta `workOrderStats` **iki kez** tanımlı. JS'te sonraki tanım geçerli, yani "Re-defines workOrderStats" yorumlu olan. İlkine bakma.

---

## Teşhis (doğrulandı)

`src/Repository/SalesReportRepository.php` üretimi `orders → work_orders → production` zinciriyle, siparişin **bütün operasyonlarından** topluyor. Her parça ~10 operasyondan geçtiği için sonuç katlanıyor:

| Hesap | 30 Eylül yedeği, satış siparişleri |
|---|---|
| Ekran (tüm operasyonlar) | 653.616 |
| Referans (son operasyon) | 40.700 |

Aylık grafik de üretim tarihine göre değil, siparişin başlangıç tarihine göre gruplanıyor. Ekranın kendisi de referanstaki işi yapmıyor: referansta Satış Raporları, satış siparişlerinin açılır-kapanır listesi ve her satırın içeriği `siparisRaporIcerigi()`.

`satisSiparisleri.js` içindeki `summary()` + Rapor modalı referansa en yakın parça, ama **referanstan dört noktada sapıyor** (aşağıda). Satış Raporları bunu kullanacağı için önce o düzeltilecek.

---

## Adım 1 — Ortak modül, referans kurallarıyla

`satisSiparisleri.js`'teki `summary()`, `statusOf()`, `woLabel()` ve `openReport()` gövdesi `public/js/modules/_orderReport.js`'e taşınır (`_childDetail.js` deseni):

- `orderSummary(order, ctx)` — referans `orderStats`
- `orderStatus(order, summary)` — referans `orderStatusBadge` + "İş Emri Bekliyor"
- `orderReportBody(order, summary, ctx)` — referans `siparisRaporIcerigi`, HTML döner

Taşırken dört sapma düzeltilir:

**1. Son adım:** Referans siparişin **iş emirleri** arasındaki en büyük `sira`yı alıyor. v2 ürünün **rotasındaki** en büyük sequence'i alıyor. Referanstaki gibi yap. Şu anki veride sonuç aynı çıkıyor, ama rotaya adım eklenirse ayrışır.

**2. Tahmini bitiş (ETA):** Referans her son-adım iş emri için şu sırayla hesaplıyor:

1. Kalan 0 → "Tamamlandı"
2. **Makine planı varsa** (`planBazliETA`): o iş emrinin plan günleri tarih sırasıyla, planlı adetler kümülatif toplanır. Toplamın hedefe ulaştığı gün = bitiş. Plan hedefe yetmiyorsa son planlı gün + " (plan yetersiz)".
3. **Plan yoksa:** son 7 üretim kaydının ortalaması günlük hızdır. Hiç üretim yoksa **o adımın makine kapasitesi** kullanılır (`capForStep`: ürün + iş merkezi + operasyon kapasitesi; ürün darboğazı değil). Kalan / hız = gün, bugünden ileri.

Siparişin bitişi, bölünmüş iş emirlerinin en geç bitenidir.

v2'de `core/eta.js` → `estimateCompletion` yalnız 3. adımı yapıyor ve Satış Siparişleri `fallbackRate` geçmiyor. Değişiklik: `estimateCompletion`'a isteğe bağlı bir `plans` seçeneği ekle; verilirse 2. adım önce denenir. Satış Siparişleri ve Satış Raporları `plans` + adım kapasitesini geçer. `plans` vermeyen mevcut çağrılar (Genel Bakış) aynı kalır.

Şu anki veride son operasyonların hiçbirinde makine planı yok, yani 2. adım bugün sonucu değiştirmiyor. Ama kod yolu referanstaki gibi olmalı.

**3. Rozetler** — referans kuralı, bu sırayla:

| Koşul | Rozet |
|---|---|
| İş emri yok | İş Emri Bekliyor (warn) |
| sipariş durumu `Tamamlandı` | Tamamlandı (good) |
| sipariş durumu `İptal` | İptal (neutral) |
| Tahmini bitiş > siparişin istenen teslim tarihi | Gecikme Riski (flag) |
| başlangıç + ⌈hedef / darboğaz kapasitesi⌉ gün > istenen teslim | Kapasite Yetersiz (warn) |
| diğer | Zamanında (good) |

v2'deki "Üretimde" ve hesaplanan "Tamamlandı" kalkar. Referansta Tamamlandı yalnız sipariş durumundan gelir. Bu yüzden 20.000/20.000 biten ama durumu `Aktif` olan sipariş "Zamanında" görünür, bitiş kutusunda "Tamamlandı" yazar. Referans böyle.

Gecikme Riski: son-adım iş emirlerinden herhangi birinin tahmini bitişi siparişin istenen teslim tarihinden sonraysa. "Kapasite Yetersiz" satırındaki darboğaz kapasitesi `productDailyTarget` (ürünün darboğazı) — ETA'daki adım kapasitesiyle karıştırma.

**4. Sipariş durumu sözlüğü:** Referansta sipariş durumu `Aktif / Tamamlandı / İptal`. v2'de `Order::STATUSES` 9 değerli (Hammadde Bekleniyor, Üretimde, … Sevk Edildi) ve ETL `Aktif` yazıyor, oysa `Aktif` o listede yok. Bu adımda **değiştirme**: rozet `Tamamlandı` / `İptal` değerlerine bakar, ikisi de listede var. Sözlük farkı uyum denetiminde ele alınacak.

**Satış Siparişleri'ndeki filtreler** (v2 fazlası, kalabilir) yeni rozetlere eşlenir: Tümü / İş Emri Bekliyor / Gecikme Riski / Tamamlandı.

**Doğrulama:** Satış Siparişleri'nde rozetler değişecek, bu beklenen. Rapor modalında üretilen/hedef/kalan değişmemeli. Tahmini bitiş, üretimi başlamamış iş emirlerinde boştan tarihe dönebilir (yedek hız eklendi). Ayrı commit.

---

## Adım 2 — Satış Raporları ekranı

`salesReports.js` yeniden yazılır. Menü kaydı (`index.html` ~137) aynı kalır.

**Veri:** Satış Siparişleri ile aynı `listAll` çağrıları, `source === 'satis'` filtresi.

**Liste** (referans `viewSatisRaporlari`):
- Sıralama: `startDate`, yeniden eskiye
- Arama: ürün, müşteri, satış sipariş no, takip no
- Her sipariş `core/collapsible.js` → `collapsiblePanel` ile. Katlama durumu localStorage'da, bileşen hallediyor.
  - `key`: `sr.order.{id}`
  - `title`: takip no
  - `metaHTML`: müşteri · ürün kodu · `{miktar} adet` · `teslim {tarih}` — bileşen esc'lemiyor, değerleri `esc()` ile üret
  - `rightHTML`: `orderStatus()` rozeti
  - `body`: `orderReportBody()` — yalnız açıkken üretilir
  - `defaultCollapsed: true`
- Boş hal: "Henüz satış siparişi yok" — "Satış Siparişleri modülünden sipariş girildiğinde burada listelenecek."

Metinler `t()` ile, yeni anahtarlar `docs/ceviri-sozlugu.md`'ye. Mümkün olduğunca `ss.*` anahtarları kullanılsın.

**Kaldırılanlar:** tarih filtresi, müşteri filtresi, aylık grafik, ürün/müşteri kırılımı.

---

## Adım 3 — Artıkları temizle (ayrı commit)

Adım 2 bunları kullanılmaz hale getiriyor:
- `src/Controller/SalesReportController.php`
- `src/Repository/SalesReportRepository.php`
- `public/api/index.php` ~85: `'sales-reports' => ...`
- `i18n.js`'teki kullanılmayan `sr.*` anahtarları + `docs/ceviri-sozlugu.md` karşılıkları
- `app.css` `.rep-*` sınıfları — başka dosya kullanmıyorsa

Silmeden önce `grep` ile teyit et, raporda listele.

---

## Kapsam dışı

- `Order::STATUSES` sözlüğü (uyum denetimi)
- Genel Bakış'ın ETA'sı (`plans` vermeden çağırmaya devam eder) — uyum denetiminde ele alınacak

---

## Doğrulama

`node --check` + `php -l`, sonra tarayıcı. 30 Eylül yedeğiyle ETL sonrası:

| Takip No | Ürün | Üretilen / Hedef | Kalan | Tahmini Bitiş |
|---|---|---|---|---|
| SP-2026-50500 | 221175 | 20.000 / 20.000 | 0 | Tamamlandı |
| SP-2026-50502 | 221121 | 20.000 / 20.000 | 0 | Tamamlandı |
| SP-2026-50482 | 226181 | 600 / 600 | 0 | Tamamlandı |
| SP-2026-50501 | 221122 | 0 / 20.000 | 20.000 | tarih (son adım makinesinin kapasitesinden) |
| SP-2026-50741 | 221124 | 0 / 4.000 | 4.000 | tarih |

**Asıl test SP-2026-50741 / 221124:** önceki operasyonlarda 16.000 adet kayıt var, "Üretilen" 0 göstermeli.

- 34 siparişin 10'u "İş Emri Bekliyor"
- Hiçbir sipariş "Tamamlandı" rozeti almamalı — hepsinin durumu `Aktif`
- Aynı değerler Satış Siparişleri → Rapor modalında da çıkmalı

---

## Sıra

Adım 1 → commit → rapor → Adım 2 → commit → Adım 3 → commit → rapor
