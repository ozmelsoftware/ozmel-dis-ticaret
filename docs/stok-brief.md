# Brief — Stok (yeniden tasarım, v81'e hizalama)

Kaynak: referans `docs/referans/2026-10-13.html` → `viewStok` (yeni 12L) + `viewStokHammaddeSade`,
`viewStokYariMamul`, `tumMalzemeKodlariKategoriye`, `malzemeKategorisi`, `acikSiparislerIcinGerekliKalan`,
`hammaddeStokBilgisiByKod` (değişti). Fark: `docs/staging-v81-fark.md` §3. Design prompt'u:
`docs/design-promptlari-v81.md` §2 (design dosyası sonra gelecek).

**Mevcut `stok.js` tümden yeniden yazılacak.** Eski (sipariş-seçmeli WIP zaman çizgisi) tasarım
v81'de **kaldırıldı** — yeni ekran kategori sekmeli ve sade. Salt-okuma, form yok, **yeni BE ucu yok**
(hepsi `listAll`).

---

## Ekran (3 sekme — WIP YOK)

Üstte sekme çubuğu (sayıyla): **Hammadde (N)** · **Satınalınan Malzemeler (M)** · **Yarı Mamül (K)**.

- **Hammadde / Satınalınan** (aynı tablo — `viewStokHammaddeSade`): Kod | Açıklama | **Mevcut Stok** |
  **Açık Siparişler İçin Gerekli** | **Kalan** | (ok). Birim: malzemenin kendi birimi (kg ya da adet).
  Kalan negatif kırmızı / pozitif yeşil (kalın). "Gerekli" >0 ve detay varsa satır açılır → sipariş
  kırılımı ("SP-… — kalan N kg", sipariş no tıklanınca iş emirlerine gider).
- **Yarı Mamül** (`viewStokYariMamul`): Kod | Üretilen (Kendi Siparişleri) | Diğer Ürünlerin İhtiyacı |
  Kalan. Açıklama metni: "Kendi siparişlerinde üretilmiş ama henüz başka ürüne aktarılmamış miktar".
- Genel boş hal (ürün ağacı yoksa): "Henüz Ürün Ağacı tanımlı değil — önce Ürün Ağaçları'ndan ilişki girin."

---

## Veri & hesap (hepsi mevcut `listAll` — yeni okuma ucu yok)

Yükleme: product-codes, product-trees, operations, purchase-receipts, purchase-requests,
incoming-inspections, orders, work-orders, routes, production (bugünkü `stok.js` ile aynı set).

### 1. Kategori (`malzemeKategorisi` / `tumMalzemeKodlariKategoriye`)
Ürün ağacından türetilir (v2 `type` alanından DEĞİL — bkz. AÇIK KARAR 1):
- Ağaç **yaprağı** + `materialLength` (hammaddeUzunluk) dolu → **Hammadde**
- Ağaç yaprağı + `materialLength` boş → **Satınalınan Malzeme**
- Çocuğu olan (başka ürünün girdisi) → **Yarı Mamül**
Gerekli yardımcılar: `bomYaprakMi` (çocuğu yok mu). v2'de ağaç yürüyüşü `stok.js`'te zaten var.

### 2. Mevcut stok (`hammaddeStokBilgisiByKod`)
= onaylı gelen − tüketilen (malzemenin birimi; kg ya da adet). v2 `stok.js`'te bu mantık VAR:
- onaylı gelen = `incoming_inspections.overallResult='Uygun'` girişler → `purchase_receipts.quantity`
- **DEĞİŞİKLİK (v81):** tüketim artık "Kesim/Cutting" operasyon adı eşleşmesiyle değil, **ürünün
  rotasındaki EN DÜŞÜK sıra numaralı adımın** üretimiyle hesaplanır (TR/EN operasyon adından bağımsız).
  v2'deki `CUT_RE`/`outgoingOperationId` yaklaşımı bununla değiştirilecek. **Hesap değişikliği —
  tüketilen/net sayılar değişebilir; 10-13 verisiyle doğrulanmalı.**

### 3. Açık siparişler için gerekli (`acikSiparislerIcinGerekliKalan`) — YENİ ÇEKİRDEK HESAP
Açık (`durum≠Tamamlandı`) siparişlerde bu malzemenin kalan ihtiyacı: her sipariş için
`urunHammaddeIhtiyaciHesapla(ürün, hedefMiktar)` → bu malzemeye düşen tam gereklilik; ilk-sıra
adım üretimine göre orantılanıp tüketilen düşülür. Döner: `{toplam, detay:[{orderNo, kalan}]}`.
**Kalan = Mevcut Stok − gerekli.toplam.**

### 4. Yarı Mamül (`viewStokYariMamul`)
Üretilen (son aşama, kendi `durum≠Tamamlandı` siparişleri, `asamaUretilen(order.id, sonSira)`) −
diğer ürünlerin ihtiyacı (`acikSiparislerIcinGerekliKalan`) = kalan.

---

## En büyük parça — BOM verim hesabı (v2'de YOK, port edilecek)

`acikSiparislerIcinGerekliKalan` → `urunHammaddeIhtiyaciHesapla` → `bomYapraklariTopla` +
**`bomDugumHesapla`** zincirine dayanır. `tutarlilik-raporu.md` §C bunları "YOK — en kritik hesap
kaybı" olarak işaretlemiş. **Girdi alanları v2'de VAR** (ProductTree DTO: `partLength`, `cutLoss`,
`materialLength`, `materialWeight`, `unitQuantity`) — sadece hesap fonksiyonları port edilmemiş.

- `bomDugumHesapla(node)` → `{kod, aciklama, parcaAdedi = floor(materialLength/(partLength+cutLoss)),
  hammaddeUzunluk, hammaddeAgirlik}`
- `bomYapraklariTopla(kökId)` → yapraklar + kümülatif birim çarpanı (v2 `multFromRoot` benzeri)
- `urunHammaddeIhtiyaciHesapla(ürün, adet)` → malzeme başına `{gerekliParca, tupSayisi, toplamUzunluk,
  toplamAgirlik}`

**Öneri:** bunlar paylaşılan **`core/bom.js`**'e çıkarılsın — Stok şimdi, **Ürün Ağaçları "Verim"
kolonu** (ayrıca eksik, tutarlilik §C) sonra aynı yerden kullanır. Mevcut `stok.js`'teki ağaç
yürüyüşü (nodeById/rootProductOf/multFromRoot) bu modüle taşınır.

---

## Kapsam dışı
- WIP / sipariş-aşama zaman çizgisi (v81 Stok'tan çıkarıldı; `wipOzetHesapla` başka ekranda).
- Ürün Ağaçları "Verim" kolonu (ayrı iş — ama `core/bom.js` buna da hazır olacak).
- Düşük stok / min-seviye uyarısı: referans yeni tabloda göstermiyor (bugünkü v2'de var; kaldırılabilir).

## AÇIK KARARLAR (uygulamadan önce netleşmeli)
1. **Kategori kaynağı:** Referansla birebir → ağaçtan türet (3 sekme: Hammadde / Satınalınan / Yarı
   Mamül; `materialLength` ayrımı). v2'nin `product-codes.type` (Hammadde/Yarı Mamül/**Ürün**) alanı
   bu 3 kategoriyi karşılamıyor ("Satınalınan Malzeme" yok). → Ağaç-türetme önerilir; onaylansın.
2. **BOM verim hesabı şimdi mi?** "Gerekli" (özellikle kg) bu hesap olmadan çıkmaz. `core/bom.js`'i
   bu turda kuralım mı (önerilen), yoksa "gerekli"yi şimdilik basit (yalnız adet/materialWeight) mi
   yapıp tam hesabı sonraki tura mı bırakalım?
3. **Tüketim değişikliği** (Kesim → ilk-sıra adım) net stok sayılarını değiştirir — onay.

## Doğrulama & kayıt
`node --check`, TR/EN anahtar dengesi, tarayıcıda aç. Yeni `stok.*` anahtarları (sekmeler, kolonlar,
boş haller) + `ceviri-sozlugu.md`. Eski `stok.*` (WIP/aşama) anahtarları kullanılmıyorsa temizlenir.
`?v` bump. Her adım ayrı commit (CLAUDE.md).
