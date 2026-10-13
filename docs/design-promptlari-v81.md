# Design prompt'ları — v81 yeni ekranlar

Her ekran için Claude Design'a verilecek prompt. Hedef: ekranlar **referans index'teki
(`docs/referans/2026-10-13.html`) haliyle birebir aynı** olsun. Çıktılar `tasarim/` altına
`.dc.html` olarak gelir, sonra `public/js/modules/` port edilir.

**Tüm prompt'lar için ortak kural (her prompt'un başına ekle):**
> Mevcut ekranlarla (ör. `Uretim-Girisi-v2.dc.html`, `Uretim-Siparisleri-v2.dc.html`) **aynı
> tasarım sistemini** kullan: aynı `_ds` (industry) sistemi, `Kabuk` import'u (sol menü +
> breadcrumb), Barlow / Barlow Condensed başlık, IBM Plex Mono sayısal, `--color-accent*`,
> `--color-neutral*`, `--color-success/warning/danger(+-fill)` tokenları. Masaüstü öncelikli,
> telefon genişliğinde bozulmasın. Tüm metinler Türkçe. Veri örnekleri referanstaki
> rakamlarla aynı olsun.

---

## 1. Kapasite Analizi  (yeni modül · breadcrumb "Üretim Planlama / Kapasite Analizi")

```
Başlık: KAPASİTE ANALİZİ
Alt başlık: Gerçekleşen üretimden makine/ürün/operasyon başına günlük kapasiteyi hesaplar,
tanımlı kapasiteyle karşılaştırır ve öneri verir.

ÜST FİLTRE ÇUBUĞU (tek satır panel, aralara boşluk):
- Sol: üç mod butonu (segment): "Tüm Zamanlar" (varsayılan seçili) · "Aylık" · "Haftalık"
- Orta (sadece Aylık/Haftalık modunda görünür): "Gösterilen değer:" + iki buton
  "Duruşsuz günlük" (seçili) · "Gerçekleşen günlük (duruşlu)"
- Sağ: "Tüm makineler" açılır listesi + "Ürün / operasyon ara" metin kutusu

YÖNTEM PANELİ (açık gri, küçük punto açıklama metni):
"Nasıl hesaplanıyor? 'Günlük' = bir tam gün (Sabah 195 dk + Öğleden Sonra 315 dk = 510 dk net,
mola hariç). Gerçekleşen günlük (duruşlu) = toplam adet ÷ planlı vardiya süresi × tam gün.
Duruşsuz günlük = toplam adet ÷ (planlı süre − duruş) × tam gün. Aynı makinede aynı gün ve
vardiyada birden çok iş emri çalıştıysa süre eşit bölünür. Mesai vardiyası hesaba katılmaz.
Öneri, duruşsuz değer tanımlıdan %10'dan fazla saptığında ve en az 3 üretim günü olan satırlarda çıkar."

ANA TABLO — "Tüm Zamanlar" modunda (sıralanabilir başlıklar):
Kolonlar: Ürün | Operasyon | Makine | Gün (altında "N kayıt") | Toplam Adet |
Tanımlı Günlük | Gerçekleşen Günlük (duruşlu) | Duruşsuz Günlük (kalın) | Duruş % |
Fark | Öneri | (aksiyon)
- Fark hücresi renkli: |%|≤10 yeşil, negatif kırmızı, pozitif mavi/accent; "+12%" biçimi
- Öneri hücresi rozet: "Uygun" (yeşil) / "Düşür → 1.250" (sarı) / "Artır → 2.000" (nötr) /
  "Tanımla → N" (nötr) / "Az veri" (nötr). Süre paylaşımı ≥%30 ise altında kırmızı küçük
  uyarı "⚑ %38 süre paylaşımlı"
- Aksiyon: öneri düşür/artır/tanımla ise "Uygula" butonu
- Örnek satırlar: Testere-01 / Kesim, Torna-03 / Torna, Kaynak-02 / Kaynak…

ANA TABLO — "Aylık" / "Haftalık" modunda (matris):
Kolonlar: Ürün | Operasyon | Makine | Tanımlı | <dönem sütunları>
- Dönem başlığı: aylık "Eylül 2026", haftalık "08.09" (haftanın pazartesisi)
- Her hücre: değer (kalın, renkli: ±%10 yeşil / düşük kırmızı / yüksek mavi) + altında "N gün"

ALT PANEL — "Analize dahil edilmeyen kayıtlar":
Başlık yanında "Hesaba katılan: 142 üretim kaydı, 23 gün"
- Tablo: Tarih | Kayıt | Adet | Açıklama | (aksiyon "Dahil et")
- Altında tarih ekleme: tarih kutusu + "Açıklama (örn. stok girişi)" + "+ Tarihi Hariç Tut"
- Onay kutusu: "Notunda 'iş emri kapamak için' veya 'giriş yapılmıştır' geçen kayıtları da
  hariç tut (N kayıt, M adet)"
- Küçük not: "Ayrıca N boş kaydedilmiş satır ve M mesai kaydı hesaba katılmadı."
```

## 2. Stok  (yeniden tasarım · mevcut `Stok` ekranının yerine · breadcrumb "Satınalma / Stok")

```
Başlık: STOK
Önemli: v78'deki "sipariş seçmeli WIP zaman çizgisi" tasarımını KULLANMA. Yeni tasarım
kategori sekmeli ve sade.

ÜST SEKME ÇUBUĞU (buton grubu, sayıyla):
"Hammadde (N)" (varsayılan seçili) · "Satınalınan Malzemeler (M)" · "Yarı Mamül (K)"

SEKME: Hammadde / Satınalınan Malzemeler (aynı tablo):
Kolonlar: Kod | Açıklama | Mevcut Stok | Açık Siparişler İçin Gerekli | Kalan | (ok)
- Mevcut Stok ve Kalan birimli (kg ya da adet). Kalan: negatifse kırmızı, pozitifse yeşil, kalın
- "Gerekli" >0 ve detay varsa satır tıklanabilir (▶/▼); açılınca alt satırda sipariş kırılımı:
  her açık sipariş için "SP-… — kalan N kg" (sipariş no tıklanınca iş emirlerine gider)
- Boş hal: "Bu kategoride malzeme yok"

SEKME: Yarı Mamül:
Üstte açıklama: "Kendi siparişlerinde üretilmiş ama henüz başka ürüne aktarılmamış miktar —
Ürün Ağacı'nda başka ürünlerin girdisi olan ürünler"
Kolonlar: Kod | Üretilen (Kendi Siparişleri) | Diğer Ürünlerin İhtiyacı | Kalan
- Kalan negatif kırmızı / pozitif yeşil, kalın
- Boş hal: "Yarı mamül olarak işaretli ürün yok"

Genel boş hal (ürün ağacı yoksa): "Henüz Ürün Ağacı tanımlı değil — Stok görmek için önce
Ürün Ağaçları modülünden ürün/hammadde ilişkisi girilmeli."
```

## 3. Satış Raporları — Pano (TV)  (mevcut `Satış Raporları` ekranına yeni görünüm)

```
Mevcut ekranın en üstüne görünüm anahtarı ekle (panel, iki buton):
"Liste" (varsayılan) · "Pano (TV Görünümü)"
"Liste" seçiliyken mevcut açılır-kapanır sipariş listesi aynen kalır.

"Pano (TV Görünümü)" seçiliyken — KOYU TEMA bir pano (büyük ekranda gösterilecek):
- Dış kutu: arka plan #0d1117, köşe yuvarlak 8px, iç boşluk 24px
- Üst satır: solda "Sipariş İlerleyiş Panosu" (açık gri #e6edf3, büyük başlık),
  sağda "⛶ Tam Ekran" butonu (ghost, kenar #30363d)
- İçerik: tamamlanmamış siparişler, teslim tarihine göre sıralı. Her sipariş:
  * 52px yüksek bir çubuk (#21262d zemin, kenar #30363d), içi dolu ilerleme barı:
    genel yüzde kadar genişlik, renk %100 yeşil #3fb950 / >0 mavi #58a6ff / 0 #30363d
  * Barın üstünde (z-index): sol "▶/▼" + sipariş no (mono, kalın, 19px, #e6edf3) +
    (iş emri yoksa turuncu "İş emri bekliyor" #f0883e) + (gecikmişse kırmızı "GECİKMİŞ" #f85149);
    sağda "%87" (mono, kalın, 19px)
  * Satır tıklanınca açılır panel (#161b22, kenar #30363d): müşteri · ürün · adet · teslim;
    altında her operasyon adımı için mini bar (140px etiket | ilerleme barı | sağda yüzde)
- Pano boşsa: ortada "Devam eden sipariş yok." (#8b949e)
```

## 4. Giriş Kalite — delta  (mevcut `incomingInspections` ekranına ekleme)

```
Mevcut Giriş Kalite listesine/formuna şunları ekle:
- LİSTE tablosuna yeni kolon "Kapsadığı Girişler": o kalite kaydının kapsadığı satınalma
  girişleri, her biri "tarih · SP-… (ya da 'siparişsiz') · miktar birim" alt alta; yoksa "—".
  "Gelen Adet" hücresinde, kayıtlı adet kapsanan girişlerin toplamından farklıysa kırmızı
  küçük uyarı "⚠ girişler toplamı N".
- Satır aksiyonlarına "📄 Excel" butonu (ghost).
- DÜZENLEME formunda "Gelen Adet" alanının altına kırmızı uyarı: seçili ≥2 girişin toplamı
  Gelen Adet'ten farklıysa "⚠ Seçili N girişin toplamı M; Gelen Adet farklı. '…Toplamını Gelen
  Adet'e Uygula' ile eşitleyin." Form alt barına "📄 Excel'e Aktar" butonu (sadece kayıtlıyken).
- SATINALMA GİRİŞLERİ ekranındaki kalite rozeti (Uygun/Uygun Değil/Kayıt var) artık tıklanır
  bir bağlantı (yanında ↗); birden çok girişi kapsıyorsa altında "ortak rapor · N giriş".
```

## 5. Satınalma İsteği modalı — delta  (mevcut `purchaseRequests` modalı)

```
"Malzeme / Ürün Kodu" alanını serbest metin/datalist yerine AÇILIR LİSTE yap:
- Kaynak: Kod Tanımları'nda tip='Hammadde' olanlar, koda göre sıralı; her seçenek "KOD — Ad"
- Seçim yapılınca "Malzeme Adı" ve "Birim" alanları o kod tanımından otomatik dolar
  (Malzeme Adı placeholder'ı "Kod seçilince otomatik dolar, gerekirse düzenleyin")
- Alan sırası: önce Kod (select), sonra Malzeme Adı (otomatik dolan input)
```

---

### Design sonrası port sırası (öneri)
1. Kapasite Analizi (en büyük yeni iş; `kapasiteHaricTarihler` migration + repo/DTO gerekir)
2. Stok yeniden yazım (BE'siz, mevcut listAll'larla)
3. Satış Pano (BE'siz; `satis-raporlari-brief.md` ile birlikte)
4. Giriş Kalite Excel + kapsama · 5. Satınalma modal (küçük)

Her biri ayrı brief + ayrı commit (CLAUDE.md: brief'siz büyük iş yok, her iş ayrı commit).
