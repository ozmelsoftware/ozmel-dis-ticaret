<?php
declare(strict_types=1);

/**
 * etl.php — Melih'in KRC yedek JSON'unu v2 tablolarina aktarir.
 *
 * Kullanim (CLI):
 *   php etl.php --file=../data/qfw_konsol_yedek_2026-08-23.json [--dry-run]
 * SSH yoksa tarayicidan: tools/etl_web.php (gecici, anahtar korumali sarmalayici).
 *
 * --dry-run : hicbir sey KALICI yazilmaz. Tum is tek bir transaction icinde yapilir
 *             ve sonunda GERI ALINIR; rapor "ne olurdu"yu gosterir.
 *
 * Kimlik esleme: v1 id'leri string (msa62js08dce9); v2 auto-increment. Her kayit
 * eski id'sini legacy_id sutununa yazar. Bellekte [koleksiyon][eski_id] => yeni_id
 * haritasi tutulur; FK'ler bundan cozulur. Metin->FK (isMerkezi/operasyon/malzeme
 * adlari) ad/kod uzerinden cozulur; referans tablolarda yoksa otomatik olusturulur.
 * product_codes'ta kod bulunamazsa kayit ATLANIR (urun kodu uydurulamaz).
 *
 * Yazma yalnizca Repository katmanindan yapilir (tenant_id + sutun whitelist otomatik).
 * Her koleksiyon kendi Db::transaction()'inda; biri patlarsa oncekiler korunur ve
 * nerede duruldugu raporlanir.
 */

use App\Core\Context;
use App\Core\Db;

// --- autoload (public/api/index.php ile ayni desen) --------------------------
spl_autoload_register(static function (string $class): void {
    if (!str_starts_with($class, 'App\\')) {
        return;
    }
    $path = dirname(__DIR__) . '/src/' . str_replace('\\', '/', substr($class, 4)) . '.php';
    if (is_file($path)) {
        require $path;
    }
});

// --- girdi: CLI (getopt) ya da web sarmalayici -------------------------------
// CLI'da --file / --dry-run. Web'de (tools/etl_web.php — gecici sarmalayici) bu iki
// deger $ETL_FILE / $ETL_DRYRUN olarak onceden set edilir. Web SAPI'de STDERR
// tanimli olmadigindan hata mesajlari echo ile verilir.
$isCli = (PHP_SAPI === 'cli');
if ($isCli) {
    $opts   = getopt('', ['file:', 'dry-run', 'reconcile']);
    $file   = $opts['file'] ?? null;
    $dryRun = array_key_exists('dry-run', $opts);
    $reconcile = array_key_exists('reconcile', $opts);
} else {
    $file   = $ETL_FILE ?? null;
    $dryRun = $ETL_DRYRUN ?? true; // web'de varsayilan dry-run
    $reconcile = !empty($ETL_RECONCILE); // web'de varsayilan kapali (&reconcile=1 ile acilir)
}

$stderr = static function (string $msg) use ($isCli): void {
    if ($isCli && defined('STDERR')) {
        fwrite(STDERR, $msg . "\n");
    } else {
        echo $msg . "\n";
    }
};

if ($file === null) {
    $stderr('Kullanim: php etl.php --file=yedek.json [--dry-run]');
    exit(1);
}
if (!is_file($file)) {
    $stderr("Dosya bulunamadi: $file");
    exit(1);
}

$raw = json_decode((string) file_get_contents($file), true);
if (!is_array($raw) || !isset($raw['data']) || !is_array($raw['data'])) {
    $stderr('Gecersiz yedek: beklenen {data:{...}} yapisi yok');
    exit(1);
}
$D = $raw['data'];

// --- baglam + repolar --------------------------------------------------------
// ETL sistem kullanicisi: tenant 1, userId 0. created_by/updated_by = 0.
$ctx = new Context(tenantId: 1, userId: 0, role: 'editor', displayName: 'ETL');

$repo = [
    'product_codes'   => new App\Repository\ProductCodeRepository($ctx),
    'work_centers'    => new App\Repository\WorkCenterRepository($ctx),
    'operations'      => new App\Repository\OperationRepository($ctx),
    'task_people'     => new App\Repository\TaskPersonRepository($ctx),
    'terms'           => new App\Repository\TermRepository($ctx),
    'working_hours'   => new App\Repository\WorkingHoursRepository($ctx),
    'operators'       => new App\Repository\OperatorRepository($ctx),
    'product_trees'   => new App\Repository\ProductTreeRepository($ctx),
    'routes'          => new App\Repository\RouteRepository($ctx),
    'capacities'      => new App\Repository\CapacityRepository($ctx),
    // Denetim Soruları modülü kaldırıldı (müşteri kararı, Eylül 2026).
    // Geri istenirse bu satır, aşağıdaki audits bloğu ve migration 043 geri alınır.
    // 'audits'          => new App\Repository\AuditRepository($ctx),
    'tasks'           => new App\Repository\TaskRepository($ctx),
    'orders'          => new App\Repository\OrderRepository($ctx),
    'work_orders'     => new App\Repository\WorkOrderRepository($ctx),
    'production'      => new App\Repository\ProductionRepository($ctx),
    'machine_plans'   => new App\Repository\MachinePlanRepository($ctx),
    'first_off_points'  => new App\Repository\FirstOffPointRepository($ctx),
    'first_off_records' => new App\Repository\FirstOffRecordRepository($ctx),
    'hourly_points'   => new App\Repository\HourlyPointRepository($ctx),
    'hourly_records'  => new App\Repository\HourlyRecordRepository($ctx),
    'purchase_requests' => new App\Repository\PurchaseRequestRepository($ctx),
    'purchase_receipts' => new App\Repository\PurchaseReceiptRepository($ctx),
    'incoming_inspections' => new App\Repository\IncomingInspectionRepository($ctx),
    'control_plans'        => new App\Repository\ControlPlanRepository($ctx),
    'quality_measurements' => new App\Repository\QualityMeasurementRepository($ctx),
    'sites'                => new App\Repository\SiteRepository($ctx),
    'downtime_reasons'     => new App\Repository\DowntimeReasonRepository($ctx),
];

// --- deger yardimcilari ------------------------------------------------------
$str = static function (mixed $v): ?string {
    if ($v === null) return null;
    $s = trim((string) $v);
    return $s === '' ? null : $s;
};
$num = static function (mixed $v): ?float {
    if ($v === null || (is_string($v) && trim($v) === '')) return null;
    return is_numeric($v) ? (float) $v : null;
};
$int = static function (mixed $v): ?int {
    if ($v === null || (is_string($v) && trim($v) === '')) return null;
    return is_numeric($v) ? (int) $v : null;
};
$bool = static fn(mixed $v): int => $v ? 1 : 0;
// Tarih normalize: YYYY-MM-DD aynen, YYYY-MM-DDT... -> ilk 10, '-'/bos/null -> null.
// Baska bir bicim -> null + $dateIssues'a uyari (koleksiyon, id, deger). revision_date
// alanlari iki yeni bicimde geliyordu ('-' ve ISO T) ve DB'de DATE sutunu patliyordu.
$dateIssues = [];
$date = static function (mixed $v, string $col = '', string $id = '') use (&$dateIssues): ?string {
    if ($v === null) return null;
    $s = trim((string) $v);
    if ($s === '' || $s === '-') return null;
    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $s)) return $s;          // YYYY-MM-DD
    if (preg_match('/^\d{4}-\d{2}-\d{2}T/', $s)) return substr($s, 0, 10); // ISO -> gun
    $dateIssues[] = ['col' => $col, 'id' => $id, 'value' => $s];     // beklenmeyen bicim
    return null;
};

// --- kimlik + referans haritalari --------------------------------------------
$idMap = [];                 // idMap[koleksiyon][eski_id] = yeni_id
$ref   = ['product' => [], 'wc' => [], 'op' => [], 'person' => []];

// --- rapor -------------------------------------------------------------------
$report = [];
$order  = [];                // koleksiyon isleme sirasi (raporda korunur)
$rec = static function (string $col) use (&$report, &$order): array {
    if (!isset($report[$col])) {
        $report[$col] = ['read' => 0, 'created' => 0, 'updated' => 0, 'skipped' => 0, 'autorefs' => 0, 'reasons' => []];
        $order[] = $col;
    }
    return [];
};
$materialIssues = [];        // Melih'e: malzeme kod yerine aciklama tasiyan istekler
$multiReceiptIssues = [];    // Giris kalite: birden fazla satinalma girisi olan kayitlar (yalniz ilki baglanir)
$stoppedAt      = null;      // koleksiyon patlarsa

// Kayit atlama sinyali (beklenen: eksik FK). Koleksiyon transaction'ini BOZMAZ.
final class EtlSkip extends \RuntimeException {}

// --- referans cozumleyiciler (ad/kod -> id, yoksa otomatik olustur) ----------
$resolveProduct = static function (?string $code) use (&$ref): int {
    if ($code === null || $code === '') {
        throw new EtlSkip('urun/malzeme kodu bos');
    }
    if (!isset($ref['product'][$code])) {
        throw new EtlSkip("urun kodu bulunamadi: $code");
    }
    return $ref['product'][$code];
};
$resolveWorkCenter = static function (?string $name) use (&$ref, $repo, &$report): ?int {
    if ($name === null || $name === '') return null;
    if (isset($ref['wc'][$name])) return $ref['wc'][$name];
    $r = $repo['work_centers']->etlEnsureByName('name', $name, ['is_active' => 1]);
    $ref['wc'][$name] = $r['id'];
    if ($r['created']) $report['work_centers']['autorefs']++;
    return $r['id'];
};
$resolveOperation = static function (?string $name) use (&$ref, $repo, &$report): ?int {
    if ($name === null || $name === '') return null;
    if (isset($ref['op'][$name])) return $ref['op'][$name];
    $r = $repo['operations']->etlEnsureByName('name', $name);
    $ref['op'][$name] = $r['id'];
    if ($r['created']) $report['operations']['autorefs']++;
    return $r['id'];
};
$resolvePerson = static function (?string $name) use (&$ref, $repo, &$report): ?int {
    if ($name === null || $name === '') return null;
    if (isset($ref['person'][$name])) return $ref['person'][$name];
    $r = $repo['task_people']->etlEnsureByName('name', $name);
    $ref['person'][$name] = $r['id'];
    if ($r['created']) $report['task_people']['autorefs']++;
    return $r['id'];
};

/**
 * Bir koleksiyonu tek transaction icinde isler. $handler($record) her kayit icin
 * cagirilir ve ['created'|'updated'] doner; EtlSkip firlatirsa kayit atlanir (sebep
 * raporlanir), transaction bozulmaz. Beklenmedik hata transaction'i geri alir ve
 * disari firlar (isleme durur).
 */
$runCollection = static function (string $col, array $records, callable $handler)
        use (&$report, &$stoppedAt, $rec): bool {
    if ($stoppedAt !== null) {
        return false; // onceki koleksiyon patladi — isleme durdu, digerlerine dokunma
    }
    $rec($col);
    $report[$col]['read'] = count($records);
    try {
        Db::transaction(function () use ($records, $handler, $col, &$report): void {
            foreach ($records as $r) {
                try {
                    $action = $handler($r);
                    if ($action === 'created') $report[$col]['created']++;
                    elseif ($action === 'updated') $report[$col]['updated']++;
                } catch (EtlSkip $s) {
                    $report[$col]['skipped']++;
                    $report[$col]['reasons'][] = $s->getMessage();
                } catch (\PDOException $e) {
                    // Butunluk catismasi (SQLSTATE 23000): ayni dogal anahtar (or. gercek
                    // veride tekrar eden order_no/wo_no) ya da NOT NULL/FK. Statement geri
                    // alinir ama transaction devam eder (InnoDB) — kaydi atla, raporla.
                    // Diger DB hatalari gercek arizadir: koleksiyonu abort etmek icin firlat.
                    if ((string) $e->getCode() === '23000') {
                        $report[$col]['skipped']++;
                        $report[$col]['reasons'][] = 'butunluk catismasi (dogal anahtar/NOT NULL/FK): '
                            . preg_replace('/\s+/', ' ', $e->getMessage());
                    } else {
                        throw $e;
                    }
                }
            }
        });
        return true;
    } catch (\Throwable $e) {
        $stoppedAt = ['collection' => $col, 'error' => $e->getMessage()];
        return false;
    }
};

// dry-run: her seyi tek dis transaction'a al, sonunda geri al. Ic Db::transaction
// cagrilari (reentrant) buna katilir; hicbir sey commit edilmez.
if ($dryRun) {
    Db::pdo()->beginTransaction();
}

// Koleksiyonlar bagimliliga gore sirayla islenir; her adim onceki idMap/ref'lere dayanir.

// =========================================================================
// GRUP 1 — referans / bagimsiz tablolar
// Referans tablolar (work_centers/operations/task_people) product_codes'tan ONCE:
// product_codes.cikanOperasyon operasyon adina FK verir; operasyonlar once yuklenmezse
// otomatik olusturulur ve sonra operasyon koleksiyonu ayni adi eklerken UNIQUE(name)
// catisir. Bu yuzden referanslar basta.
// =========================================================================

// --- work_centers (isMerkezleri) ---
$runCollection('work_centers', $D['isMerkezleri'] ?? [], function (array $r)
        use ($repo, &$idMap, &$ref, $str): string {
    $name = $str($r['ad'] ?? null);
    if ($name === null) throw new EtlSkip('is merkezi adi bos');
    $res = $repo['work_centers']->etlUpsert($str($r['id'] ?? null), ['name' => $name, 'is_active' => 1]);
    $idMap['work_centers'][$r['id']] = $res['id'];
    $ref['wc'][$name] = $res['id'];
    return $res['action'];
});

// --- operations (operasyonlarListesi) ---
$runCollection('operations', $D['operasyonlarListesi'] ?? [], function (array $r)
        use ($repo, &$idMap, &$ref, $str): string {
    $name = $str($r['ad'] ?? null);
    if ($name === null) throw new EtlSkip('operasyon adi bos');
    $res = $repo['operations']->etlUpsert($str($r['id'] ?? null), ['name' => $name]);
    $idMap['operations'][$r['id']] = $res['id'];
    $ref['op'][$name] = $res['id'];
    return $res['action'];
});

// --- task_people (gorevKisiler) ---
$runCollection('task_people', $D['gorevKisiler'] ?? [], function (array $r)
        use ($repo, &$idMap, &$ref, $str): string {
    $name = $str($r['isim'] ?? null);
    if ($name === null) throw new EtlSkip('kisi ismi bos');
    $res = $repo['task_people']->etlUpsert($str($r['id'] ?? null), [
        'name'  => $name,
        'email' => $str($r['eposta'] ?? null),
        'phone' => $str($r['telefon'] ?? null),
    ]);
    $idMap['task_people'][$r['id']] = $res['id'];
    $ref['person'][$name] = $res['id'];
    return $res['action'];
});

// --- product_codes (kodTanimlari) — referanslardan sonra (cikanOperasyon FK'si icin) ---
$runCollection('product_codes', $D['kodTanimlari'] ?? [], function (array $r)
        use ($repo, &$idMap, &$ref, $str, $num, $date, $resolveOperation): string {
    $cols = [
        'code'            => $str($r['kod'] ?? null) ?? '',
        'name'            => $str($r['ad'] ?? null) ?? '',
        'type'            => $str($r['tip'] ?? null) ?? 'Ürün',
        'unit'            => $str($r['birim'] ?? null),
        'status'          => $str($r['durum'] ?? null),
        'category'        => $str($r['kategori'] ?? null),
        'drawing_no'      => $str($r['cizimNo'] ?? null),
        'revision'        => $str($r['revizyon'] ?? null),
        'revision_date'   => $date($r['revizyonTarihi'] ?? null, 'product_codes', (string) ($r['id'] ?? '')),
        'note'            => $str($r['not'] ?? null),
        'suppliers'       => $str($r['tedarikciler'] ?? null),
        'customer'        => $str($r['musteri'] ?? null),
        'parent_product_code' => $str($r['anaUrun'] ?? null),
        'outer_diameter'  => $num($r['disCap'] ?? null),
        'inner_diameter'  => $num($r['icCap'] ?? null),
        'material_length' => $num($r['hammaddeUzunluk'] ?? null),
        'material_weight' => $num($r['hammaddeAgirlik'] ?? null),
        'min_stock_level' => $num($r['minStokSeviyesi'] ?? null),
        'supply_days'     => $num($r['tedarikSuresi'] ?? null),
        'box_quantity'    => $num($r['koliAdedi'] ?? null),
    ];
    if ($cols['code'] === '') {
        throw new EtlSkip('urun kodu bos, atlandi');
    }
    // cikanOperasyon: ad -> operation id (varsa; operasyonlar zaten yuklendi)
    $opName = $str($r['cikanOperasyon'] ?? null);
    if ($opName !== null) {
        $cols['outgoing_operation_id'] = $resolveOperation($opName);
    }
    $res = $repo['product_codes']->etlUpsert($str($r['id'] ?? null), $cols);
    $idMap['product_codes'][$r['id']] = $res['id'];
    $ref['product'][$cols['code']] = $res['id'];
    return $res['action'];
});

// --- terms (terimCevirileri + gizliTerimler) ---
$hiddenSet = [];
foreach (($D['gizliTerimler'] ?? []) as $h) {
    $t = is_string($h) ? trim($h) : '';
    if ($t !== '') $hiddenSet[$t] = true;
}
$runCollection('terms', $D['terimCevirileri'] ?? [], function (array $r)
        use ($repo, $str, $hiddenSet): string {
    $orig = $str($r['orijinal'] ?? null);
    if ($orig === null) throw new EtlSkip('orijinal terim bos');
    $res = $repo['terms']->etlUpsert($str($r['id'] ?? null), [
        'original'    => $orig,
        'translation' => $str($r['ceviri'] ?? null),
        'is_hidden'   => isset($hiddenSet[$orig]) ? 1 : 0,
    ]);
    return $res['action'];
});
// gizliTerimler'de olup terimCevirileri'nde OLMAYAN terimler: legacy'siz, ada gore olustur.
$transOriginals = [];
foreach (($D['terimCevirileri'] ?? []) as $t) {
    $o = $str($t['orijinal'] ?? null);
    if ($o !== null) $transOriginals[$o] = true;
}
$runCollection('terms_hidden_only', array_values(array_filter(
        array_keys($hiddenSet), static fn($o) => !isset($transOriginals[$o]))),
    function (string $orig) use ($repo): string {
        $r = $repo['terms']->etlEnsureByName('original', $orig, ['is_hidden' => 1]);
        return $r['created'] ? 'created' : 'updated';
    });

// --- working_hours (calismaSaatleri) — tekil konfig, legacy'siz upsert yok ---
if ($stoppedAt === null) {
$rec('working_hours');
$whList = $D['calismaSaatleri'] ?? [];
$report['working_hours']['read'] = count($whList);
if ($whList !== []) {
    $w = $whList[0];
    $whCols = [
        'morning_start'         => $str($w['sabahBaslangic'] ?? null),
        'morning_break_start'   => $str($w['sabahMolaBaslangic'] ?? null),
        'morning_break_end'     => $str($w['sabahMolaBitis'] ?? null),
        'morning_end'           => $str($w['sabahBitis'] ?? null),
        'afternoon_start'       => $str($w['ogledenSonraBaslangic'] ?? null),
        'afternoon_break_start' => $str($w['ogledenSonraMolaBaslangic'] ?? null),
        'afternoon_break_end'   => $str($w['ogledenSonraMolaBitis'] ?? null),
        'afternoon_end'         => $str($w['ogledenSonraBitis'] ?? null),
    ];
    try {
        Db::transaction(function () use ($repo, $whCols, &$report): void {
            if ($repo['working_hours']->findForTenant() !== null) {
                $repo['working_hours']->updateForTenant($whCols, null);
                $report['working_hours']['updated']++;
            } else {
                $repo['working_hours']->create($whCols); // migration tohumlamamissa
                $report['working_hours']['created']++;
            }
        });
    } catch (\Throwable $e) {
        $stoppedAt = ['collection' => 'working_hours', 'error' => $e->getMessage()];
    }
}
} // if stoppedAt === null (working_hours)

// =========================================================================
// GRUP 2 — operators(+skills), product_trees, routes(+variants), capacities, tasks
// =========================================================================

if ($stoppedAt === null)
$runCollection('operators', $D['operatorler'] ?? [], function (array $r)
        use ($repo, &$idMap, &$report, $str, $bool, $resolveOperation): string {
    $badge = $str($r['sicilNo'] ?? null);
    if ($badge === null) {
        // Tum operatorlerde sicilNo bos; badge_no NOT NULL UNIQUE oldugundan legacy id
        // yer tutucu olarak yazilir (benzersiz, izlenebilir). Melih sonradan doldurur.
        $badge = (string) ($r['id'] ?? '');
        $report['operators']['reasons'][] = "sicil no bos -> legacy id ile dolduruldu ({$r['id']})";
    }
    $res = $repo['operators']->etlUpsert($str($r['id'] ?? null), [
        'full_name' => $str($r['adSoyad'] ?? null) ?? '',
        'badge_no'  => $badge,
        'is_active' => $bool(($r['durum'] ?? '') === 'Aktif'),
    ]);
    $idMap['operators'][$r['id']] = $res['id'];

    // yetkinOperasyonlar: operasyon ADLARI -> id
    $skillIds = [];
    foreach (($r['yetkinOperasyonlar'] ?? []) as $opName) {
        $id = $resolveOperation($str($opName));
        if ($id !== null && !in_array($id, $skillIds, true)) $skillIds[] = $id;
    }
    $repo['operators']->updateWithSkills($res['id'], [], $skillIds, null);
    return $res['action'];
});

// --- product_trees (urunAgaclari) — iki pass (oz-referans parent_id) ---
if ($stoppedAt === null) {
    $treeRecords = $D['urunAgaclari'] ?? [];
    // Pass 1: parent'siz upsert + kimlik haritasi
    $ok = $runCollection('product_trees', $treeRecords, function (array $r)
            use ($repo, &$idMap, &$ref, $str, $num, $date, $resolveProduct): string {
        $code = $str($r['kod'] ?? null);
        $productId = $resolveProduct($code); // yoksa EtlSkip
        $cols = [
            'product_code_id'     => $productId,
            'description'         => $str($r['aciklama'] ?? null),
            'revision'            => $str($r['revNo'] ?? null),
            'revision_date'       => $date($r['revTarihi'] ?? null, 'product_trees', (string) ($r['id'] ?? '')),
            'unit_quantity'       => $num($r['birimMiktar'] ?? null),
            'outer_diameter'      => $num($r['disCap'] ?? null),
            'inner_diameter'      => $num($r['icCap'] ?? null),
            'material_length'     => $num($r['hammaddeUzunluk'] ?? null),
            'material_weight'     => $num($r['hammaddeAgirlik'] ?? null),
            'part_length'         => $num($r['parcaBoyu'] ?? null),
            'cut_loss'            => $num($r['kesimKaybi'] ?? null),
            'supplier_cut_length' => $num($r['tedarikciKesimUzunlugu'] ?? null),
        ];
        // malzemeKodu (varsa) -> hammadde kodu FK; bulunamazsa null (zorunlu degil)
        $mk = $str($r['malzemeKodu'] ?? null);
        if ($mk !== null) $cols['material_code_id'] = $ref['product'][$mk] ?? null;

        $res = $repo['product_trees']->etlUpsert($str($r['id'] ?? null), $cols);
        $idMap['product_trees'][$r['id']] = $res['id'];
        return $res['action'];
    });
    // Pass 2: parent_id'yi map'ten coz (yalnizca parent'i olanlar)
    if ($ok) {
        try {
            Db::transaction(function () use ($treeRecords, $repo, &$idMap): void {
                foreach ($treeRecords as $r) {
                    $pid = $r['parentId'] ?? null;
                    if ($pid !== null && isset($idMap['product_trees'][$r['id']], $idMap['product_trees'][$pid])) {
                        $repo['product_trees']->etlUpsert((string) $r['id'], [
                            'parent_id' => $idMap['product_trees'][$pid],
                        ]);
                    }
                }
            });
        } catch (\Throwable $e) {
            $stoppedAt = ['collection' => 'product_trees(parent)', 'error' => $e->getMessage()];
        }
    }
}

// --- routes (+ varyantSecenekleri) ---
if ($stoppedAt === null)
$runCollection('routes', $D['routes'] ?? [], function (array $r)
        use ($repo, &$idMap, $str, $num, $bool, $resolveProduct, $resolveWorkCenter, $resolveOperation): string {
    $cols = [
        'product_code_id' => $resolveProduct($str($r['urun'] ?? null)),
        'operation_id'    => $resolveOperation($str($r['operasyon'] ?? null)),
        'work_center_id'  => $resolveWorkCenter($str($r['isMerkezi'] ?? null)),
        // sira ondalikli (alt operasyon 1.1/1.2) — routes.sequence DECIMAL; $int TRUNCATE ederdi.
        'sequence'        => $num($r['sira'] ?? null) ?? 0,
        'is_active'       => $bool($r['aktif'] ?? false),
        'variant_label'   => $str($r['varyantEtiketi'] ?? null),
    ];
    if ($cols['operation_id'] === null || $cols['work_center_id'] === null) {
        throw new EtlSkip('rota: operasyon ya da is merkezi bos');
    }
    $res = $repo['routes']->etlUpsert($str($r['id'] ?? null), $cols);
    $idMap['routes'][$r['id']] = $res['id'];

    $variants = [];
    foreach (($r['varyantSecenekleri'] ?? []) as $v) {
        $s = $str($v);
        if ($s !== null && !in_array($s, $variants, true)) $variants[] = $s;
    }
    $repo['routes']->updateWithVariants($res['id'], [], $variants, null);
    return $res['action'];
});

// --- capacities (capacity) ---
if ($stoppedAt === null)
$runCollection('capacities', $D['capacity'] ?? [], function (array $r)
        use ($repo, &$idMap, $str, $num, $resolveProduct, $resolveWorkCenter, $resolveOperation): string {
    $wc = $resolveWorkCenter($str($r['isMerkezi'] ?? null));
    if ($wc === null) throw new EtlSkip('kapasite: is merkezi bos');
    $res = $repo['capacities']->etlUpsert($str($r['id'] ?? null), [
        'product_code_id'    => $resolveProduct($str($r['urun'] ?? null)),
        'work_center_id'     => $wc,
        // operasyon opsiyonel: bos -> NULL (eski kayit); dolu -> operations id (gerekirse olusur).
        'operation_id'       => $resolveOperation($str($r['operasyon'] ?? null)),
        'capacity_per_shift' => $num($r['kapasite'] ?? null) ?? 0,
        // v1 alan adi dakikaPerAdet (dakika DEGIL) — onceki eslemede yanlisti, minutes hep NULL kaliyordu.
        'minutes'            => $num($r['dakikaPerAdet'] ?? null),
    ]);
    $idMap['capacities'][$r['id']] = $res['id'];
    return $res['action'];
});

// --- audits ---
// Denetim Soruları modülü kaldırıldı (müşteri kararı, Eylül 2026).
// Geri istenirse bu blok, yukarıdaki $repo['audits'] kaydı ve migration 043 geri alınır.
// (561 kayıt yedek dosyalarında duruyor.)
// if ($stoppedAt === null)
// $runCollection('audits', $D['audits'] ?? [], function (array $r)
//         use ($repo, $str, $num): string {
//     $res = $repo['audits']->etlUpsert($str($r['id'] ?? null), [
//         'form'     => $str($r['form'] ?? null) ?? 'TQS',
//         'section'  => $str($r['section'] ?? null) ?? '',
//         'question' => $str($r['question'] ?? null) ?? '',
//         'score'    => $num($r['score'] ?? null),
//         'evidence' => $str($r['evidence'] ?? null),
//     ]);
//     return $res['action'];
// });

// --- tasks (gorevler) ---
if ($stoppedAt === null)
$runCollection('tasks', $D['gorevler'] ?? [], function (array $r)
        use ($repo, $str, $int, $num, $resolvePerson): string {
    $res = $repo['tasks']->etlUpsert($str($r['id'] ?? null), [
        'sequence'              => $int($r['sira'] ?? null),
        'description'           => $str($r['gorevTanimi'] ?? null) ?? '',
        'department'            => $str($r['departman'] ?? null),
        'primary_assignee_id'   => $resolvePerson($str($r['anaSorumlu'] ?? null)),
        'secondary_assignee_id' => $resolvePerson($str($r['yardimci'] ?? null)),
        'priority'              => $str($r['oncelik'] ?? null),
        'due_date'              => $str($r['termin'] ?? null),
        'status'                => $str($r['durum'] ?? null),
        'completion_ratio'      => $num($r['tamamlanmaYuzdesi'] ?? null),
        'notes'                 => $str($r['notlar'] ?? null),
    ]);
    return $res['action'];
});

// =========================================================================
// GRUP 3 — orders -> work_orders -> production -> machine_plans
// =========================================================================

if ($stoppedAt === null)
$runCollection('orders', $D['orders'] ?? [], function (array $r)
        use ($repo, &$idMap, $str, $num, $resolveProduct): string {
    $res = $repo['orders']->etlUpsert($str($r['id'] ?? null), [
        'order_no'                => $str($r['orderNo'] ?? null) ?? '',
        'source'                  => $str($r['kaynak'] ?? null) ?? 'satis',
        'status'                  => $str($r['durum'] ?? null) ?? '',
        'customer'                => $str($r['musteri'] ?? null),
        'sales_order_no'          => $str($r['satisSiparisNo'] ?? null),
        'product_code_id'         => $resolveProduct($str($r['urun'] ?? null)),
        'target_quantity'         => $num($r['hedefMiktar'] ?? null) ?? 0,
        'start_date'              => $str($r['baslangicTarihi'] ?? null),
        'requested_delivery_date' => $str($r['istenenTeslimTarihi'] ?? null),
        'note'                    => $str($r['not'] ?? null),
    ]);
    $idMap['orders'][$r['id']] = $res['id'];
    return $res['action'];
});

if ($stoppedAt === null)
$runCollection('work_orders', $D['workorders'] ?? [], function (array $r)
        use ($repo, &$idMap, $str, $int, $num, $resolveProduct, $resolveOperation, $resolveWorkCenter): string {
    $orderId = $idMap['orders'][$r['orderId'] ?? ''] ?? null;
    if ($orderId === null) throw new EtlSkip("is emri: siparis bulunamadi ({$r['orderId']})");
    $res = $repo['work_orders']->etlUpsert($str($r['id'] ?? null), [
        'wo_no'           => $str($r['woNo'] ?? null) ?? '',
        'order_id'        => $orderId,
        'product_code_id' => $resolveProduct($str($r['urun'] ?? null)),
        'operation_id'    => $resolveOperation($str($r['operasyon'] ?? null)),
        'work_center_id'  => $resolveWorkCenter($str($r['isMerkezi'] ?? null)),
        'sequence'        => $int($r['sira'] ?? null),
        'target_quantity' => $num($r['hedefMiktar'] ?? null) ?? 0,
        'status'          => $str($r['durum'] ?? null) ?? '',
        'split_label'     => $str($r['splitEtiket'] ?? null),
    ]);
    $idMap['work_orders'][$r['id']] = $res['id'];
    return $res['action'];
});

// --- Durus nedenleri: ONCE migration 035 TOHUM kayitlarini temizle (yalniz o adlar +
// legacy_id NULL; FK'li olan korunur), sonra gercek listeyi legacy_id ile upsert et.
// production'dan ONCE gelir ki durusNedeni ADI id'ye cozulebilsin.
$downtimeSeedNames = ['Malzeme bekleme', 'Kalıp değişimi', 'Mekanik arıza', 'Ölçü ayarı', 'Vardiya devri'];
$downtimeSeedCleanup = ['deleted' => 0, 'kept' => 0];
if ($stoppedAt === null) {
    $downtimeSeedCleanup = $repo['downtime_reasons']->etlDeleteSeeds($downtimeSeedNames);
}

if ($stoppedAt === null)
$runCollection('downtime_reasons', $D['durusNedenleri'] ?? [], function (array $r)
        use ($repo, $str): string {
    // v1 ad alani: 'ad' / 'neden' / 'isim' / 'name' varyantlari denenir.
    $name = $str($r['ad'] ?? $r['neden'] ?? $r['isim'] ?? $r['name'] ?? null);
    if ($name === null) throw new EtlSkip('durus nedeni adi bos');
    $active = array_key_exists('aktif', $r) ? ($r['aktif'] ? 1 : 0) : 1;
    $res = $repo['downtime_reasons']->etlUpsert($str($r['id'] ?? null), ['name' => $name, 'is_active' => $active]);
    return $res['action'];
});

// production.durusNedeni AD olarak gelir → downtime_reasons.name uzerinden id'ye cozulur.
$reasonByName = $repo['downtime_reasons']->etlMapBy('name');
$reasonIssues = [];   // cozulemeyen durus nedeni adlari (ad => adet)
$resolveReason = static function (?string $name) use ($reasonByName, &$reasonIssues): ?int {
    if ($name === null || $name === '') return null;
    if (isset($reasonByName[$name])) return $reasonByName[$name];
    $reasonIssues[$name] = ($reasonIssues[$name] ?? 0) + 1;   // eslesmezse NULL + raporla
    return null;
};

if ($stoppedAt === null)
$runCollection('production', $D['production'] ?? [], function (array $r)
        use ($repo, &$idMap, $str, $num, $resolveReason): string {
    $woId = $idMap['work_orders'][$r['workOrderId'] ?? ''] ?? null;
    if ($woId === null) throw new EtlSkip("uretim: is emri bulunamadi ({$r['workOrderId']})");
    $res = $repo['production']->etlUpsert($str($r['id'] ?? null), [
        'work_order_id'     => $woId,
        'date'              => $str($r['tarih'] ?? null),
        'shift'             => $str($r['vardiya'] ?? null) ?? 'Sabah',
        'target_quantity'   => $num($r['hedefAdet'] ?? null),
        'actual_quantity'   => $num($r['gercekAdet'] ?? null) ?? 0,
        'scrap_quantity'    => $num($r['fireAdet'] ?? null) ?? 0,
        'operator_id'       => $idMap['operators'][$r['operator'] ?? ''] ?? null,
        'downtime_start'    => $str($r['durusBaslangic'] ?? null),
        'downtime_end'      => $str($r['durusBitis'] ?? null),
        'downtime_reason_id' => $resolveReason($str($r['durusNedeni'] ?? null)),
        'note'              => $str($r['not'] ?? null),
    ]);
    return $res['action'];
});

if ($stoppedAt === null)
$runCollection('machine_plans', $D['makinePlani'] ?? [], function (array $r)
        use ($repo, &$idMap, $str, $num, $resolveProduct, $resolveWorkCenter): string {
    $wc = $resolveWorkCenter($str($r['isMerkezi'] ?? null));
    if ($wc === null) throw new EtlSkip('makine plani: is merkezi bos');
    $res = $repo['machine_plans']->etlUpsert($str($r['id'] ?? null), [
        'date'            => $str($r['tarih'] ?? null),
        'work_center_id'  => $wc,
        'product_code_id' => $resolveProduct($str($r['urun'] ?? null)),
        'work_order_id'   => $idMap['work_orders'][$r['workOrderId'] ?? ''] ?? null,
        'target_quantity' => $num($r['hedefMiktar'] ?? null),
        'note'            => $str($r['not'] ?? null),
    ]);
    return $res['action'];
});

// =========================================================================
// GRUP 4 — first_off_points -> first_off_records
// =========================================================================

if ($stoppedAt === null)
$runCollection('first_off_points', $D['firstOffNoktalari'] ?? [], function (array $r)
        use ($repo, &$idMap, $str, $int, $num, $resolveProduct, $resolveOperation): string {
    $res = $repo['first_off_points']->etlUpsert($str($r['id'] ?? null), [
        'product_code_id' => $resolveProduct($str($r['urun'] ?? null)),
        'operation_id'    => $resolveOperation($str($r['operasyon'] ?? null)) ?? throw new EtlSkip('nokta: operasyon bos'),
        'point_no'        => $int($r['no'] ?? null) ?? 0,
        'characteristic'  => $str($r['karakteristik'] ?? null) ?? '',
        'type'            => $str($r['tip'] ?? null) ?? 'olcusel',
        'nominal'         => $num($r['nominal'] ?? null),
        'lower_limit'     => $num($r['altLimit'] ?? null),
        'upper_limit'     => $num($r['ustLimit'] ?? null),
        'unit'            => $str($r['birim'] ?? null),
    ]);
    $idMap['first_off_points'][$r['id']] = $res['id'];
    return $res['action'];
});

if ($stoppedAt === null)
$runCollection('first_off_records', $D['firstOffKayitlari'] ?? [], function (array $r)
        use ($repo, &$idMap, $str, $int, $num, $resolveProduct, $resolveOperation): string {
    $res = $repo['first_off_records']->etlUpsert($str($r['id'] ?? null), [
        'product_code_id' => $resolveProduct($str($r['urun'] ?? null)),
        'operation_id'    => $resolveOperation($str($r['operasyon'] ?? null)) ?? throw new EtlSkip('kayit: operasyon bos'),
        'date'            => $str($r['tarih'] ?? null),
        'shift'           => $str($r['vardiya'] ?? null) ?? '',
        'operator_name'   => $str($r['operator'] ?? null),
        'wo_no'           => $str($r['isEmriNo'] ?? null),
        'sample_count'    => $int($r['numuneAdedi'] ?? null),
        'check_time'      => $str($r['kontrolSaati'] ?? null),
        'overall_result'  => $str($r['genelKarar'] ?? null),
        'note'            => $str($r['not'] ?? null), // kaynak alan: 'not'
    ]);
    $recordId = $res['id'];

    // Olcum satirlari: iki bicim var.
    //   YENI (cok numuneli): degerler: {noktaLegacyId: [v1, v2, ... vN]} — her deger bir
    //     satir, sequence dizideki sira (0'dan). Deger donusumu incoming_inspections ile
    //     ayni: sayisal -> value, metin (Uygun/Uygun Degil) -> result, bos/null -> ikisi
    //     de null (numune sirasi korunsun diye satir yine yazilir).
    //   ESKI (tek numune): olcumler: {noktaLegacyId: {deger, sonuc}} — sequence 0.
    // degerler varsa oncelikli; ikisi birden olan kayit yok.
    $measurements = [];
    if (isset($r['degerler']) && is_array($r['degerler']) && $r['degerler'] !== []) {
        foreach ($r['degerler'] as $ptLegacy => $vals) {
            $pointId = $idMap['first_off_points'][$ptLegacy] ?? null;
            if ($pointId === null || !is_array($vals)) continue; // nokta yoksa atla
            $seq = 0;
            foreach ($vals as $v) {
                if ($v === null || (is_string($v) && trim($v) === '')) {
                    $measurements[] = ['point_id' => $pointId, 'sequence' => $seq++, 'value' => null, 'result' => null];
                } elseif (is_numeric($v)) {
                    $measurements[] = ['point_id' => $pointId, 'sequence' => $seq++, 'value' => (float) $v, 'result' => null];
                } else {
                    $measurements[] = ['point_id' => $pointId, 'sequence' => $seq++, 'value' => null, 'result' => trim((string) $v)];
                }
            }
        }
    } else {
        foreach (($r['olcumler'] ?? []) as $ptLegacy => $m) {
            $pointId = $idMap['first_off_points'][$ptLegacy] ?? null;
            if ($pointId === null) continue; // nokta yoksa olcum atlanir
            $measurements[] = [
                'point_id' => $pointId,
                'sequence' => 0,
                'value'    => $num($m['deger'] ?? null),
                'result'   => $str($m['sonuc'] ?? null),
            ];
        }
    }
    // gerekce: string dizisi
    $reasons = [];
    foreach (($r['gerekce'] ?? []) as $g) {
        $s = $str($g);
        if ($s !== null && !in_array($s, $reasons, true)) $reasons[] = $s;
    }
    $repo['first_off_records']->updateWithChildren($recordId, [], $measurements, $reasons, null);
    return $res['action'];
});

// =========================================================================
// GRUP 5 — hourly_points -> hourly_records
// =========================================================================

if ($stoppedAt === null)
$runCollection('hourly_points', $D['saatlikNoktalari'] ?? [], function (array $r)
        use ($repo, &$idMap, $str, $num, $resolveProduct, $resolveOperation): string {
    $res = $repo['hourly_points']->etlUpsert($str($r['id'] ?? null), [
        'product_code_id'  => $resolveProduct($str($r['urun'] ?? null)),
        'operation_id'     => $resolveOperation($str($r['operasyon'] ?? null)) ?? throw new EtlSkip('nokta: operasyon bos'),
        'measure_location' => $str($r['olcumYeri'] ?? null) ?? '',
        'type'             => $str($r['tip'] ?? null) ?? 'olcusel',
        'nominal'          => $num($r['nominal'] ?? null),
        'lower_limit'      => $num($r['altLimit'] ?? null),
        'upper_limit'      => $num($r['ustLimit'] ?? null),
        'unit'             => $str($r['birim'] ?? null),
    ]);
    $idMap['hourly_points'][$r['id']] = $res['id'];
    return $res['action'];
});

if ($stoppedAt === null)
$runCollection('hourly_records', $D['saatlikKayitlari'] ?? [], function (array $r)
        use ($repo, &$idMap, $str, $int, $num, $resolveProduct, $resolveOperation): string {
    $res = $repo['hourly_records']->etlUpsert($str($r['id'] ?? null), [
        'product_code_id'  => $resolveProduct($str($r['urun'] ?? null)),
        'operation_id'     => $resolveOperation($str($r['operasyon'] ?? null)) ?? throw new EtlSkip('kayit: operasyon bos'),
        'date'             => $str($r['tarih'] ?? null),
        'shift'            => $str($r['vardiya'] ?? null) ?? '',
        'hour'             => $str($r['saat'] ?? null),
        'personnel_name'   => $str($r['personel'] ?? null),
        'machine_name'     => $str($r['makina'] ?? null),
        'production_count' => $int($r['uretimAdedi'] ?? null),
    ]);
    $recordId = $res['id'];

    // degerler: {noktaLegacyId: [deger,...]} -> [{point_id, sequence, value}]
    $measurements = [];
    foreach (($r['degerler'] ?? []) as $ptLegacy => $vals) {
        $pointId = $idMap['hourly_points'][$ptLegacy] ?? null;
        if ($pointId === null || !is_array($vals)) continue;
        $seq = 0;
        foreach ($vals as $v) {
            $measurements[] = ['point_id' => $pointId, 'sequence' => $seq++, 'value' => $num($v)];
        }
    }
    $repo['hourly_records']->updateWithMeasurements($recordId, [], $measurements, null);
    return $res['action'];
});

// =========================================================================
// GRUP 6 — purchase_requests -> purchase_receipts -> incoming_inspections
// =========================================================================

if ($stoppedAt === null)
$runCollection('purchase_requests', $D['satinalmaIstekleri'] ?? [], function (array $r)
        use ($repo, &$idMap, &$ref, &$materialIssues, $str, $num): string {
    // Kaynak: urun = GERCEK kod (material_code_id'ye cozulur), malzeme = SERBEST aciklama
    // (material_description sutununa yazilir; migration 044). Onceden malzeme kod sanilip
    // cozulmeye calisiliyor, material_code_id NULL kaliyor ve metin note'a ekleniyordu
    // (36 kayit) — duzeltildi. Serbest-metin isteklerde kod NULL kalabilir (migration 028).
    $code    = $str($r['urun'] ?? null);        // gercek kod
    $matDesc = $str($r['malzeme'] ?? null);     // serbest malzeme aciklamasi
    $note    = $str($r['not'] ?? null);
    $materialId = ($code !== null && isset($ref['product'][$code]))
        ? $ref['product'][$code]
        : null;
    if ($code !== null && $materialId === null) {
        $materialIssues[] = ['id' => $r['id'] ?? '', 'malzeme' => $code];
    }
    $res = $repo['purchase_requests']->etlUpsert($str($r['id'] ?? null), [
        'material_code_id'     => $materialId,
        'material_description' => $matDesc,
        // product_code_id ("hangi urun icin") kaynak alani urun ile aynidir — dokunulmadi.
        'product_code_id'  => isset($r['urun']) ? ($ref['product'][$str($r['urun'])] ?? null) : null,
        'quantity'         => $num($r['miktar'] ?? null),
        'unit'             => $str($r['birim'] ?? null),
        'supplier'         => $str($r['tedarikci'] ?? null),
        'request_date'     => $str($r['istekTarihi'] ?? null),
        'expected_date'    => $str($r['beklenenTarih'] ?? null),
        'order_id'         => $idMap['orders'][$r['orderId'] ?? ''] ?? null,
        'note'             => $note,
    ]);
    $idMap['purchase_requests'][$r['id']] = $res['id'];
    return $res['action'];
});

if ($stoppedAt === null)
$runCollection('purchase_receipts', $D['satinalmaGirisleri'] ?? [], function (array $r)
        use ($repo, &$idMap, $str, $num): string {
    $reqId = $idMap['purchase_requests'][$r['satinalmaIstegiId'] ?? ''] ?? null;
    if ($reqId === null) throw new EtlSkip("giris: istek bulunamadi ({$r['satinalmaIstegiId']})");
    $res = $repo['purchase_receipts']->etlUpsert($str($r['id'] ?? null), [
        'purchase_request_id' => $reqId,
        'date'                => $str($r['tarih'] ?? null),
        'quantity'            => $num($r['miktar'] ?? null),
        'note'                => $str($r['not'] ?? null),
    ]);
    $idMap['purchase_receipts'][$r['id']] = $res['id'];
    return $res['action'];
});

if ($stoppedAt === null)
$runCollection('incoming_inspections', $D['girisKaliteKontrolleri'] ?? [], function (array $r)
        use ($repo, &$idMap, &$ref, &$multiReceiptIssues, $str, $num, $int): string {
    // satinalmaGirisId (tekil) cogunlukla bos; gercek bag satinalmaGirisIdleri (liste)
    // alaninda. Tekil bossa listenin ILK elemani alinir; sema tek bag tutar.
    $receiptLegacy = $str($r['satinalmaGirisId'] ?? null);
    $matCode = $str($r['malzeme'] ?? null);
    if ($receiptLegacy === null) {
        $list = $r['satinalmaGirisIdleri'] ?? [];
        if (is_array($list) && $list !== []) {
            $receiptLegacy = $str($list[0] ?? null);
            if (count($list) > 1) {
                // Coklu bag: yalniz ilki baglanir, kalanlar duser. Ayri karar; burada uyari.
                $multiReceiptIssues[] = [
                    'malzeme' => $matCode ?? '(kod yok)',
                    'tarih'   => $str($r['kontrolTarihi'] ?? null) ?? '(tarih yok)',
                    'dropped' => count($list) - 1,
                ];
            }
        }
    }
    $res = $repo['incoming_inspections']->etlUpsert($str($r['id'] ?? null), [
        // legacy referans korunur (eslesmese de); yeni FK varsa cozulur.
        'legacy_purchase_receipt_id' => $receiptLegacy,
        'purchase_receipt_id' => $receiptLegacy !== null ? ($idMap['purchase_receipts'][$receiptLegacy] ?? null) : null,
        'supplier'            => $str($r['tedarikci'] ?? null),
        'material_code_id'    => $matCode !== null ? ($ref['product'][$matCode] ?? null) : null,
        'drawing_no'          => $str($r['cizimNo'] ?? null),
        'reason'              => $str($r['gozlemNedeni'] ?? null),
        'arrival_date'        => $str($r['malzemeGelisTarihi'] ?? null),
        'inspection_date'     => $str($r['kontrolTarihi'] ?? null),
        'received_qty'        => $num($r['gelenAdet'] ?? null),
        'sample_qty'          => $int($r['ornekAdedi'] ?? null),
        'inspector_name'      => $str($r['kontrolEden'] ?? null),
        'overall_result'      => $str($r['genelSonuc'] ?? null),
    ]);
    $inspId = $res['id'];

    // karakteristikler -> [{cols, values:[{value,result}]}]
    $chars = [];
    foreach (($r['karakteristikler'] ?? []) as $c) {
        $values = [];
        foreach (($c['degerler'] ?? []) as $v) {
            if ($v === null || (is_string($v) && trim($v) === '')) {
                $values[] = ['value' => null, 'result' => null];
            } elseif (is_numeric($v)) {
                $values[] = ['value' => (float) $v, 'result' => null];
            } else {
                $values[] = ['value' => null, 'result' => trim((string) $v)];
            }
        }
        $chars[] = [
            'cols' => [
                'char_no'     => $int($c['no'] ?? null) ?? 0,
                'name'        => $str($c['tanim'] ?? null) ?? '',
                'spec_text'   => $str($c['olcu'] ?? null),
                'type'        => $str($c['tip'] ?? null) ?? 'olcusel',
                'nominal'     => $num($c['nominal'] ?? null),
                'lower_limit' => $num($c['altLimit'] ?? null),
                'upper_limit' => $num($c['ustLimit'] ?? null),
                'unit'        => $str($c['birim'] ?? null),
            ],
            'values' => $values,
        ];
    }
    $repo['incoming_inspections']->updateWithChildren($inspId, [], $chars, null);
    return $res['action'];
});

// --- Kalite Kontrol: kontrolPlani -> control_plans, kaliteOlcumleri -> quality_measurements
// operasyon/isMerkezi MEVCUT kayitlara eslenir; yoksa NULL (oto-olusturma YOK — rota disi
// "Hammadde Kabul" gibi degerler operasyon tablosunu kirletmesin). numuneAdedi cogunlukla
// serbest metin ("FR-09 Ölçüm Frekans Tablosu") -> sample_size VARCHAR, $str ile alinir.
$opByName = $repo['operations']->etlMapBy('name');
$wcByName = $repo['work_centers']->etlMapBy('name');
$runCollection('control_plans', $D['kontrolPlani'] ?? [], function (array $r)
        use ($repo, &$idMap, $str, $num, $resolveProduct, $opByName, $wcByName): string {
    $opName = $str($r['operasyon'] ?? null);
    $wcName = $str($r['isMerkezi'] ?? null);
    $res = $repo['control_plans']->etlUpsert($str($r['id'] ?? null), [
        'product_code_id'   => $resolveProduct($str($r['urun'] ?? null)),
        'sequence_label'    => $str($r['sira'] ?? null),
        'operation_id'      => $opName !== null ? ($opByName[$opName] ?? null) : null,
        'operation_label'   => $opName,   // ham metin — rota disi degerlerde grup basligi icin
        'work_center_id'    => $wcName !== null ? ($wcByName[$wcName] ?? null) : null,
        'characteristic'    => $str($r['karakteristik'] ?? null) ?? '',
        'specification_raw' => $str($r['spesifikasyonRaw'] ?? null),
        'type'              => $str($r['tip'] ?? null) ?? 'olcusel',
        'lower_limit'       => $num($r['altLimit'] ?? null),
        'upper_limit'       => $num($r['ustLimit'] ?? null),
        'nominal'           => $num($r['nominal'] ?? null),
        'unit'              => $str($r['birim'] ?? null),
        'measure_method'    => $str($r['olcumYontemi'] ?? null),
        'sample_size'       => $str($r['numuneAdedi'] ?? null),
        'check_frequency'   => $str($r['kontrolSikligi'] ?? null),
        'record_form'       => $str($r['kayitForm'] ?? null),
        'action_on_fail'    => $str($r['aksiyon'] ?? null),
    ]);
    $idMap['control_plans'][$r['id']] = $res['id'];
    return $res['action'];
});

$runCollection('quality_measurements', $D['kaliteOlcumleri'] ?? [], function (array $r)
        use ($repo, &$idMap, $str, $num): string {
    $orderLegacy = $str($r['orderId'] ?? null);
    $planLegacy  = $str($r['kontrolPlaniId'] ?? null);
    $orderId = $orderLegacy !== null ? ($idMap['orders'][$orderLegacy] ?? null) : null;
    $planId  = $planLegacy  !== null ? ($idMap['control_plans'][$planLegacy] ?? null) : null;
    if ($orderId === null) throw new EtlSkip("siparis cozulemedi: $orderLegacy");
    if ($planId === null)  throw new EtlSkip("kontrol plani maddesi cozulemedi: $planLegacy");
    $res = $repo['quality_measurements']->etlUpsert($str($r['id'] ?? null), [
        'order_id'        => $orderId,
        'control_plan_id' => $planId,
        'measured_at'     => $str($r['tarih'] ?? null),
        'shift'           => $str($r['vardiya'] ?? null),
        'value'           => $num($r['deger'] ?? null),
        'result'          => $str($r['sonuc'] ?? null),
        'operator'        => $str($r['operator'] ?? null),
        'note'            => $str($r['not'] ?? null),
    ]);
    return $res['action'];
});

// --- Tedarikci & Site: sites -> sites (dogrudan camelCase -> snake_case) ---
$runCollection('sites', $D['sites'] ?? [], function (array $r)
        use ($repo, $str): string {
    $res = $repo['sites']->etlUpsert($str($r['id'] ?? null), [
        'supplier'  => $str($r['supplier'] ?? null) ?? '',
        'trigo_re'  => $str($r['trigoRE'] ?? null),
        'sqe'       => $str($r['sqe'] ?? null),
        'sqe_email' => $str($r['sqeEmail'] ?? null),
        'sqm'       => $str($r['sqm'] ?? null),
        'sqm_email' => $str($r['sqmEmail'] ?? null),
        'country'   => $str($r['country'] ?? null),
        'city'      => $str($r['city'] ?? null),
        'site_code' => $str($r['siteCode'] ?? null),
    ]);
    return $res['action'];
});

// =========================================================================
// SILINEN KAYIT DENETIMI (hesap) — brief bolum 3. Yazma yok; hem rapor hem
// reconcile bunu kullanir. dry-run'da dis transaction HENUZ acik: upsert'ler
// uygulanmis okunur, ama silinmis-sayisi degismez (upsert'li satirin legacy'si
// yedekte vardir). Silme bundan sonra, rollback'ten ONCE yapilir.
// =========================================================================
$auditSpec = [
    'product_codes'        => 'kodTanimlari',
    'work_centers'         => 'isMerkezleri',
    'operations'           => 'operasyonlarListesi',
    'task_people'          => 'gorevKisiler',
    'terms'                => 'terimCevirileri',
    'operators'            => 'operatorler',
    'product_trees'        => 'urunAgaclari',
    'routes'               => 'routes',
    'capacities'           => 'capacity',
    'tasks'                => 'gorevler',
    'orders'               => 'orders',
    'work_orders'          => 'workorders',
    'downtime_reasons'     => 'durusNedenleri',
    'production'           => 'production',
    'machine_plans'        => 'makinePlani',
    'first_off_points'     => 'firstOffNoktalari',
    'first_off_records'    => 'firstOffKayitlari',
    'hourly_points'        => 'saatlikNoktalari',
    'hourly_records'       => 'saatlikKayitlari',
    'purchase_requests'    => 'satinalmaIstekleri',
    'purchase_receipts'    => 'satinalmaGirisleri',
    'incoming_inspections' => 'girisKaliteKontrolleri',
    'control_plans'        => 'kontrolPlani',
    'quality_measurements' => 'kaliteOlcumleri',
    'sites'                => 'sites',
];
// Referans / oto-olusturulan tablolar: NULL legacy beklenir; reconcile'da da ATLANIR.
$refTables = ['work_centers' => true, 'operations' => true, 'task_people' => true,
    'terms' => true, 'downtime_reasons' => true];

$deletionAudit = []; // col => ['deletedInBackup'=>list, 'nullLegacy'=>int, 'error'=>?string]
foreach ($auditSpec as $col => $srcKey) {
    $backupIds = [];
    foreach (($D[$srcKey] ?? []) as $rec0) {
        $id0 = $rec0['id'] ?? null;
        if ($id0 !== null && $id0 !== '') $backupIds[(string) $id0] = true;
    }
    try {
        $deletionAudit[$col] = $repo[$col]->etlLegacyAudit($backupIds) + ['error' => null];
    } catch (\Throwable $e) {
        $deletionAudit[$col] = ['deletedInBackup' => [], 'nullLegacy' => 0, 'error' => $e->getMessage()];
    }
}

// =========================================================================
// UZLASTIRMA (reconcile) — brief bolum 2. Varsayilan KAPALI (--reconcile / &reconcile=1).
// Yedekte olmayan (legacy_id dolu ama yedekte id yok) kayitlari SERT siler. NULL
// legacy satirlara ASLA dokunmaz. Kapsam: $auditSpec - $refTables. Yalniz butun
// koleksiyonlar hatasiz bittiyse calisir. FK: silinecegi olan tablolara gelen FK'lar
// CASCADE degilse DUR. Silme tek transaction (dry-run'da dis txn ile geri alinir).
// =========================================================================
$reconcileReport = ['requested' => $reconcile, 'ran' => false, 'skippedReason' => null,
    'perTable' => [], 'fkChecked' => [], 'fkBlocked' => []];
if ($reconcile) {
    if ($stoppedAt !== null) {
        $reconcileReport['skippedReason'] = "isleme durdu ({$stoppedAt['collection']}) — reconcile atlandi";
    } else {
        // Silinecek hedefler: ref disi, hatasiz, silinecek id'si olan tablolar.
        $targets = [];
        foreach ($auditSpec as $col => $_) {
            if (isset($refTables[$col])) continue;
            if ($deletionAudit[$col]['error'] !== null) continue;
            $ids = $deletionAudit[$col]['deletedInBackup'];
            if ($ids !== []) $targets[$col] = $ids;
        }
        // FK guvenlik: silinecegi olan tablolara GELEN FK'lar CASCADE olmali.
        $blocked = false;
        foreach ($targets as $col => $_) {
            foreach ($repo[$col]->etlReferencingForeignKeys() as $fk) {
                $line = "{$col} <- {$fk['table']}.{$fk['column']} ({$fk['deleteRule']})";
                $reconcileReport['fkChecked'][] = $line;
                if (strtoupper($fk['deleteRule']) !== 'CASCADE') {
                    $reconcileReport['fkBlocked'][] = $line;
                    $blocked = true;
                }
            }
        }
        if ($blocked) {
            $reconcileReport['skippedReason'] = 'beklenmeyen FK (CASCADE disi) — hicbir sey silinmedi';
        } elseif ($targets === []) {
            $reconcileReport['ran'] = true; // silinecek yok
        } else {
            try {
                // Db::transaction reentrant: dry-run'da acik dis txn'e katilir (commit YOK,
                // sonda rollback); canlida kendi txn'ini acar, hata olursa hepsi geri alinir.
                Db::transaction(function () use ($targets, $repo, &$reconcileReport): void {
                    foreach ($targets as $col => $ids) {
                        $n = $repo[$col]->etlDeleteByLegacyIds($ids);
                        $reconcileReport['perTable'][$col] = ['deleted' => $n, 'ids' => array_slice($ids, 0, 10)];
                    }
                });
                $reconcileReport['ran'] = true;
            } catch (\Throwable $e) {
                $reconcileReport['ran'] = false;
                $reconcileReport['skippedReason'] = 'silme patladi, geri alindi: ' . $e->getMessage();
            }
        }
    }
}

// --- dry-run: her seyi geri al ----------------------------------------------
if ($dryRun && Db::pdo()->inTransaction()) {
    Db::pdo()->rollBack();
}

// =========================================================================
// RAPOR
// =========================================================================
$mode = $dryRun ? 'DRY-RUN (hicbir sey yazilmadi)' : 'CANLI';
echo "\n============================================================\n";
echo " Ozmel v1 -> v2 ETL — $mode\n";
echo " Kaynak: $file\n";
echo "============================================================\n\n";
printf("%-22s %6s %8s %8s %8s %8s\n", 'Koleksiyon', 'Okundu', 'Eklendi', 'Guncel', 'Atlandi', 'OtoRef');
echo str_repeat('-', 68) . "\n";
$tot = ['read' => 0, 'created' => 0, 'updated' => 0, 'skipped' => 0, 'autorefs' => 0];
foreach ($order as $col) {
    $s = $report[$col];
    printf("%-22s %6d %8d %8d %8d %8d\n", $col, $s['read'], $s['created'], $s['updated'], $s['skipped'], $s['autorefs']);
    foreach ($tot as $k => $_) $tot[$k] += $s[$k];
}
echo str_repeat('-', 68) . "\n";
printf("%-22s %6d %8d %8d %8d %8d\n", 'TOPLAM', $tot['read'], $tot['created'], $tot['updated'], $tot['skipped'], $tot['autorefs']);

// Atlanan sebepleri (koleksiyon basina ozet)
$anyReason = false;
foreach ($order as $col) {
    if ($report[$col]['reasons'] !== []) {
        if (!$anyReason) { echo "\n--- Atlama / uyari sebepleri ---\n"; $anyReason = true; }
        echo "\n[$col]\n";
        $counts = array_count_values($report[$col]['reasons']);
        arsort($counts);
        foreach ($counts as $reason => $n) {
            echo "  ($n) $reason\n";
        }
    }
}

// Satinalma isteklerinde urun kodu cozumleme ozeti (her zaman raporlanir).
echo "\nSatinalma istekleri — urun kodu cozulemedi: " . count($materialIssues) . " kayit"
    . ($materialIssues === [] ? " (hepsi koda cozuldu)\n" : "\n");
// Cozulemeyenler material_code_id NULL ile ice alinir; malzeme aciklamasi material_description'a yazilir.
if ($materialIssues !== []) {
    echo "--- Bu istekler NULL material_code_id ile ice alindi (urun kodu bulunamadi) ---\n";
    echo "Kod tanimlaninca ETL tekrar calistirilabilir.\n";
    foreach ($materialIssues as $m) {
        echo "  {$m['id']}: {$m['malzeme']}\n";
    }
}

// Giris kalite — coklu satinalma girisi bagi (yalniz ilki baglandi).
echo "\nGiris kalite — coklu satinalma girisi olan kayit: " . count($multiReceiptIssues) . " kayit"
    . ($multiReceiptIssues === [] ? " (hepsinde tek bag)\n" : " (yalniz ILK bag kuruldu; kalanlar ayri karar)\n");
if ($multiReceiptIssues !== []) {
    foreach ($multiReceiptIssues as $m) {
        echo "  {$m['malzeme']} / {$m['tarih']}: {$m['dropped']} bag dustu\n";
    }
}

// Durus nedeni tohum temizligi + production durus nedeni cozumleme ozeti.
echo "\nDurus nedeni tohumlari (migration 035): {$downtimeSeedCleanup['deleted']} silindi"
    . ($downtimeSeedCleanup['kept'] ? ", {$downtimeSeedCleanup['kept']} korundu (uretim kaydinca kullaniliyor)" : "") . "\n";
echo "Uretim — durus nedeni cozulemedi: " . array_sum($reasonIssues) . " kayit"
    . ($reasonIssues === [] ? " (dolu olanlarin hepsi ada cozuldu)\n" : " (downtime_reason_id NULL birakildi)\n");
if ($reasonIssues !== []) {
    arsort($reasonIssues);
    foreach ($reasonIssues as $name => $n) echo "  ($n) $name\n";
}

// =========================================================================
// SILINEN KAYIT DENETIMI (rapor) — brief bolum 3. Sayilar yukarida ($deletionAudit)
// hesaplandi. (a) DB'de legacy_id dolu ama yedekte yok = v1'de silinmis; (b) legacy_id
// NULL = v2'de dogrudan acilmis. (b) referans/oto disinda 0 beklenir; degilse ISARETLE.
// Reconcile acikken (b) 0'dan buyukse bile silinmez (NULL legacy korunur).
// =========================================================================
echo "\n============================================================\n";
echo " SILINEN KAYIT DENETIMI" . ($reconcileReport['ran'] ? " (reconcile CALISTI — asagidaki sayilar silme oncesi)" : " (salt okuma)") . "\n";
echo "============================================================\n";
printf("%-22s %14s %14s\n", 'Tablo', 'YedekteSilinmis', 'v2Dogrudan');
echo str_repeat('-', 52) . "\n";
$nullFlagged = [];
foreach ($auditSpec as $col => $srcKey) {
    $a = $deletionAudit[$col];
    if ($a['error'] !== null) {
        printf("%-22s %14s %14s\n", $col, 'HATA', preg_replace('/\s+/', ' ', $a['error']));
        continue;
    }
    $delN = count($a['deletedInBackup']);
    printf("%-22s %14d %14d\n", $col, $delN, $a['nullLegacy']);
    if ($delN > 0) {
        $first10 = array_slice($a['deletedInBackup'], 0, 10);
        echo "    yedekte silinmis id (ilk 10): " . implode(', ', $first10) . "\n";
    }
    if ($a['nullLegacy'] > 0 && !isset($refTables[$col])) {
        $nullFlagged[$col] = $a['nullLegacy'];
    }
}
echo str_repeat('-', 52) . "\n";
if ($nullFlagged !== []) {
    echo "\n!!! DIKKAT — referans disi tablolarda legacy_id NULL kayit var (0 bekleniyordu):\n";
    foreach ($nullFlagged as $col => $n) echo "    $col: $n kayit v2'de dogrudan acilmis (reconcile BUNLARA dokunmaz)\n";
} else {
    echo "Referans disi tablolarda v2-dogrudan (NULL legacy) kayit yok.\n";
}

// --- Uzlastirma (reconcile) ozeti ---
echo "\n--- Uzlastirma (reconcile) ---\n";
if (!$reconcileReport['requested']) {
    echo "Kapali (acmak icin --reconcile / &reconcile=1). Hicbir sey silinmedi.\n";
} else {
    if ($reconcileReport['fkChecked'] !== []) {
        echo "FK kontrolu (silinecegi olan tablolara gelen baglar):\n";
        foreach ($reconcileReport['fkChecked'] as $l) echo "  $l\n";
    }
    if ($reconcileReport['skippedReason'] !== null) {
        echo "!!! UZLASTIRMA ATLANDI: {$reconcileReport['skippedReason']}\n";
        foreach ($reconcileReport['fkBlocked'] as $l) echo "    engel: $l\n";
    } elseif ($reconcileReport['ran']) {
        $totDel = 0;
        if ($reconcileReport['perTable'] === []) {
            echo "Silinecek kayit yok (tum tablolar yedekle uyumlu).\n";
        } else {
            echo ($dryRun ? "SILINECEK (dry-run — geri alindi):\n" : "SILINDI (canli):\n");
            foreach ($reconcileReport['perTable'] as $col => $pt) {
                $totDel += $pt['deleted'];
                echo "  $col: {$pt['deleted']} (id ilk 10: " . implode(', ', $pt['ids']) . ")\n";
            }
            echo "  TOPLAM: $totDel satir" . ($dryRun ? " (yazilmadi)" : " silindi") . "\n";
        }
    }
}

// --- Tarih bicimi uyarilari (revision_date) ---
echo "\n--- Tarih bicimi uyarilari (beklenmeyen -> null yazildi) ---\n";
if ($dateIssues === []) {
    echo "Yok. Tum tarihler beklenen bicimde ('-', ISO ve YYYY-MM-DD normalize edildi).\n";
} else {
    echo count($dateIssues) . " beklenmeyen tarih bicimi:\n";
    foreach (array_slice($dateIssues, 0, 20) as $di) {
        echo "  [{$di['col']}] id={$di['id']} deger='{$di['value']}'\n";
    }
    if (count($dateIssues) > 20) echo "  ... (+" . (count($dateIssues) - 20) . " daha)\n";
}

// =========================================================================
// ESLENMEYEN ALANLAR (brief "Dokunma") — spesifikasyonda karsiligi olmayan,
// bilerek eslenmeyen kaynak alanlari. Salt bilgi.
// =========================================================================
$countField = static function (array $rows, string $field): int {
    $n = 0;
    foreach ($rows as $row) {
        if (isset($row[$field]) && $row[$field] !== null && $row[$field] !== '') $n++;
    }
    return $n;
};
$treeConsumed = $countField($D['urunAgaclari'] ?? [], 'tuketildigiOperasyon');
$routeConv    = $countField($D['routes'] ?? [], 'donusumKodu');
echo "\n--- Eslenmeyen alanlar (spesifikasyonda karsiligi yok, bilerek atlandi) ---\n";
echo "  urunAgaclari.tuketildigiOperasyon: $treeConsumed kayitta dolu\n";
echo "  routes.donusumKodu: $routeConv kayitta dolu\n";

if ($stoppedAt !== null) {
    echo "\n!!! ISLEME DURDU — koleksiyon '{$stoppedAt['collection']}' patladi:\n";
    echo "    {$stoppedAt['error']}\n";
    echo "    Onceki koleksiyonlar korundu (kendi transaction'larinda commit edildi).\n";
    exit(2);
}

echo "\nTamam.\n";
exit(0);
