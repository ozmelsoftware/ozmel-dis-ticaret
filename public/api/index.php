<?php
declare(strict_types=1);

/**
 * Tek giris noktasi.
 *
 * mod_security PUT/DELETE'i (ve bazen bu kelimeleri bile) 403 ile kesiyor.
 * Bu yuzden yazma islemleri POST + ?op= ile yapilir — v1'de kanitlanmis desen:
 *
 *   GET   api/work-centers?page=1&limit=50
 *   GET   api/work-centers/12
 *   POST  api/work-centers
 *   POST  api/work-centers/12?op=guncelle
 *   POST  api/work-centers/12?op=sil
 */

use App\Core\Context;
use App\Core\Response;

spl_autoload_register(static function (string $class): void {
    if (!str_starts_with($class, 'App\\')) {
        return;
    }
    $path = dirname(__DIR__, 2) . '/src/' . str_replace('\\', '/', substr($class, 4)) . '.php';
    if (is_file($path)) {
        require $path;
    }
});

$config = require dirname(__DIR__, 2) . '/config.php';
header('Access-Control-Allow-Origin: ' . ($config['allowed_origin'] ?? ''));
header('Access-Control-Allow-Headers: Content-Type, X-Session-Token');
header('Vary: Origin');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// --- rota cozumleme --------------------------------------------------------
// /public/api/index.php/work-centers/12  ->  ['work-centers', '12']
$path    = trim($_SERVER['PATH_INFO'] ?? '', '/');
$parts   = $path === '' ? [] : explode('/', $path);
$resource = $parts[0] ?? '';
$id       = isset($parts[1]) && ctype_digit($parts[1]) ? (int) $parts[1] : null;
$op       = strtolower($_GET['op'] ?? '');
// Sayisal olmayan alt-yol (or. work-orders/batch) — kaynaga ozgu toplu islemler icin.
$sub      = (isset($parts[1]) && !ctype_digit($parts[1])) ? strtolower($parts[1]) : '';

if ($resource === '') {
    Response::ok(null, ['service' => 'ozmel-api', 'version' => 2]);
}

$ctx = Context::fromRequest();

$routes = [
    'work-centers' => App\Controller\WorkCenterController::class,
    'operators'    => App\Controller\OperatorController::class,
    'operations'   => App\Controller\OperationController::class,
    'product-codes' => App\Controller\ProductCodeController::class,
    'terms'         => App\Controller\TermController::class,
    'working-hours' => App\Controller\WorkingHoursController::class,
    'product-trees' => App\Controller\ProductTreeController::class,
    'routes'        => App\Controller\RouteController::class,
    'capacities'    => App\Controller\CapacityController::class,
    'orders'        => App\Controller\OrderController::class,
    'work-orders'   => App\Controller\WorkOrderController::class,
    'production'    => App\Controller\ProductionController::class,
    'machine-plans' => App\Controller\MachinePlanController::class,
    'downtime-reasons' => App\Controller\DowntimeReasonController::class,
    'first-off-points' => App\Controller\FirstOffPointController::class,
    'first-off-records' => App\Controller\FirstOffRecordController::class,
    'hourly-points' => App\Controller\HourlyPointController::class,
    'hourly-records' => App\Controller\HourlyRecordController::class,
    'incoming-inspections' => App\Controller\IncomingInspectionController::class,
    'sites'         => App\Controller\SiteController::class,
    'control-plans' => App\Controller\ControlPlanController::class,
    'quality-measurements' => App\Controller\QualityMeasurementController::class,
    'task-people'   => App\Controller\TaskPersonController::class,
    'tasks'         => App\Controller\TaskController::class,
    'purchase-requests' => App\Controller\PurchaseRequestController::class,
    'purchase-receipts' => App\Controller\PurchaseReceiptController::class,
    // Salt okunur toplu rapor uc noktalari (CRUD degil; yalnizca GET index).
    'dashboard'     => App\Controller\DashboardController::class,
    // (sales-reports uc noktasi Adim 3'te kaldirildi — Satis Raporlari artik
    //  istemcide listAll ile hesaplaniyor, ayri BE yok.)
    'order-statuses' => App\Controller\OrderStatusController::class,
    // Kullanici Yonetimi — paylasilan v1 users tablosu (op=sifre ozel islemi var).
    'users'         => App\Controller\UserController::class,
    // Oturum sahibi — GET api/me -> {displayName, role, username}.
    'me'            => App\Controller\MeController::class,
    // Global arama (Cmd/Ctrl+K) — GET api/search?q= -> [{type, id, label, meta}].
    'search'        => App\Controller\SearchController::class,
];

// Tek-satir konfig kaynaklari: id yok. GET tek nesne doner, POST ?op=guncelle gunceller.
$singletons = ['working-hours'];

if (!isset($routes[$resource])) {
    Response::fail(404, "Bilinmeyen kaynak: $resource");
}

$controller = new $routes[$resource]($ctx);
$method     = $_SERVER['REQUEST_METHOD'];
$input      = [];

if ($method === 'POST') {
    $raw   = file_get_contents('php://input') ?: '';
    $input = json_decode($raw, true) ?? [];
    if (!is_array($input)) {
        Response::fail(400, 'Gecersiz JSON govdesi');
    }
}

try {
    if (in_array($resource, $singletons, true)) {
        // Tekil konfig: id kullanilmaz. show() tek nesne, update() id'siz gunceller.
        if ($method === 'GET') {
            $controller->show();
        }
        if ($method === 'POST' && $op === 'guncelle') {
            $controller->update($input);
        }
        Response::fail(400, 'Gecersiz islem — GET ya da POST ?op=guncelle bekleniyordu');
    }

    if ($method === 'GET') {
        $id === null ? $controller->index($_GET) : $controller->show($id);
    }

    if ($method === 'POST') {
        // Toplu islem (or. POST work-orders/batch) — tek transaction, hepsi ya da hicbiri.
        if ($sub === 'batch' && $id === null) {
            if (!method_exists($controller, 'batch')) {
                Response::fail(400, 'Bu kaynak toplu islemi desteklemiyor');
            }
            $controller->batch($input);
        }
        if ($op === 'sil' && $id !== null) {
            $controller->destroy($id);
        }
        if ($op === 'guncelle' && $id !== null) {
            $controller->update($id, $input);
        }
        // Kaynaga ozgu ek islemler (or. users ?op=sifre). Yalnizca ilgili controller
        // metodu tanimliysa cagrilir; degilse net hata.
        if ($op === 'sifre' && $id !== null) {
            if (!method_exists($controller, 'resetPassword')) {
                Response::fail(400, 'Bu kaynak sifre islemini desteklemiyor');
            }
            $controller->resetPassword($id, $input);
        }
        if ($op === '' && $id === null) {
            $controller->store($input);
        }
        Response::fail(400, 'Gecersiz islem — ?op=guncelle veya ?op=sil bekleniyordu');
    }

    Response::fail(405, "Desteklenmeyen metot: $method");
} catch (RuntimeException $e) {
    // BaseRepository::delete() FK ihlalinde IN_USE firlatir — silme reddi 409.
    if ($e->getMessage() === 'IN_USE') {
        Response::fail(409, 'Bu kayıt başka yerlerde kullanıldığı için silinemez. Önce bağlı kayıtları kaldırın.', 'IN_USE');
    }
    error_log('[ozmel-api] ' . $e->getMessage());
    Response::fail(500, 'Sunucu hatasi');
} catch (Throwable $e) {
    error_log('[ozmel-api] ' . $e->getMessage());
    Response::fail(500, 'Sunucu hatasi');
}
