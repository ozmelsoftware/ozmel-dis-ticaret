# Claude Code brief — ETL eşleme düzeltmeleri (30 Eylül yedeği)

Dosya: `tools/etl.php`
Kaynak: `data/qfw_konsol_yedek_2026-09-30.json`

Şema karşılaştırmasında iki sessiz kayıp bulundu, ayrıca silinen kayıtlar v2'ye yansımıyor. İkisi de **bugünkü veritabanında da var**, yani son ETL turu bu verileri zaten kaybetti. Düzeltmeden sonraki ETL mevcut kayıtları upsert ile tamamlar.

Migration yok — gereken sütunlar zaten var.

---

## 1. First Off ölçümleri — `degerler` okunmuyor

**Durum:** `first_off_records` bloğu yalnız eski biçimi okuyor:
`olcumler: {noktaId: {deger, sonuc}}` — 90 kaydın **1'inde** var.

Yeni biçim çok numuneli:
`degerler: {noktaId: [v1, v2, ... vN]}` — 90 kaydın **89'unda** var.

Sonuç: 89 First Off kaydı v2'de ölçümsüz duruyor. Genel karar geliyor ama değerler yok.

**Düzeltme:**
- `degerler` varsa: her nokta için dizideki her değer bir satır, `sequence` = dizideki sıra (0'dan, saatlik bloktaki gibi)
- Değer dönüşümü `incoming_inspections` bloğundaki desenle aynı (satır ~843–851):
  - sayısal → `value`
  - metin (`Uygun` / `Uygun Değil`) → `result`
  - boş / null → ikisi de null (numune sırası korunsun diye satır yine yazılır)
- `degerler` yoksa mevcut `olcumler` yolu aynen kalır (`sequence` 0)
- İkisi birden olan kayıt yok; olursa `degerler` öncelikli

**Ayrıca:** `not` → `note`. 16 kayıtta dolu, içerikleri önemli (müşteri onayları, ölçü sapması notları). `note` sütunu migration 038'den beri var.

**Beklenen:**

| | Adet |
|---|---|
| `degerler`'den ölçüm satırı | 3.162 (hepsinin noktası çözülüyor) |
| — sayısal | 1.473 |
| — metin (Uygun / Uygun Değil) | 1.421 |
| — boş | 268 |
| `olcumler`'den (eski kayıt) | 6 |
| `note` dolu kayıt | 16 |

---

## 2. Giriş Kalite → Satınalma Girişi bağı — liste okunmuyor

**Durum:** ETL tekil `satinalmaGirisId`'yi okuyor — 23 kaydın **1'inde** dolu. Liste alanı `satinalmaGirisIdleri` 22 kayıtta dolu ve hiç okunmuyor. Sonuç: 22 giriş kontrolünün satınalma girişi bağı yok.

**Düzeltme:** Tekil boşsa listenin **ilk** elemanını al. Hem `legacy_purchase_receipt_id` hem `purchase_receipt_id` bundan çözülür.

6 kayıtta birden fazla giriş var (2–4). Şema tek bağ tutuyor, bu yüzden bunlarda yalnız ilki bağlanır. ETL raporuna uyarı olarak yazdır: malzeme + kontrol tarihi + kaç bağ düştü. Çoklu bağ ayrı bir karar, bu brief'in konusu değil.

**Beklenen:** 23/23 kayıtta `purchase_receipt_id` dolu. Listedeki tüm id'ler yedekte çözülüyor.

---

## 3. Silinen kayıtlar — rapor (yazma yok)

Veri girişi cutover'dan sonra da `index.html`'de sürdü, v2 onun aynası olmalı. ETL `legacy_id` ile upsert yapıyor: **Melih'in sildiği kayıtlar v2'de kalıyor.** Daha önce görüldü: 60 kalite ölçümü silinmiş siparişlere bağlıydı.

ETL raporuna, **her tablo için**, salt okuma iki sayı eklensin:

- `legacy_id` dolu ama yedekte bu id yok → "yedekte silinmiş" (ilk 10 id'yi de listele)
- `legacy_id IS NULL` → v2'de doğrudan açılmış

İkinci sayı referans tablolarda (iş merkezi / operasyon — ETL bunları otomatik oluşturuyor) dolu çıkabilir. Onun dışında 0 bekleniyor. 0 değilse dur, raporla.

Silme bu brief'te **yok**. Sayılar görüldükten sonra ayrı karar: `--reconcile` bayrağı, çocuk tabloların sırası ve FK davranışı ile birlikte.

---

## Dokunma

Yedekte, spesifikasyon olan `index.html`'in **kullanmadığı** iki alan var:

- `urunAgaclari.tuketildigiOperasyon` — 162 kaydın 88'inde
- `routes.donusumKodu` — 1 kayıtta

Spesifikasyonda karşılıkları yok, eşlenmeyecek. ETL raporunda "eşlenmeyen alan" olarak listelensin.

---

## Sıra

1. `ozmel_test` yedeği
2. Düzeltme 1 + 2 + rapor 3 → `php -l` → commit
3. Staging dry-run → sayıları yukarıdaki tablolarla karşılaştır → rapor (silinmiş kayıt sayıları dahil)
4. Onaydan sonra `live=1`

**Doğrulama SQL'i** (staging, canlı çalıştırma sonrası):

```sql
SELECT COUNT(*) FROM first_off_measurements;                            -- >= 3168
SELECT COUNT(*) FROM first_off_records WHERE note IS NOT NULL;          -- 16
SELECT COUNT(*) FROM incoming_inspections WHERE purchase_receipt_id IS NOT NULL;  -- 23
```

**Tarayıcı:** Günlük Kalite → First Off → 30.07.2026, 221170 Cutting kaydında 6 nokta × 6 numune görünmeli. İlk nokta: 182.9 / 183.1 / 182.95 / 183 / 183.05 / 183.3.

Prod (`ozmel_db`) ETL'i ayrı karar — bu brief yalnız staging.
