<?php
declare(strict_types=1);

namespace App\Controller;

use App\Core\Context;
use App\Core\Response;
use App\Dto\CapacityExclusion;
use App\Repository\CapacityExclusionRepository;
use App\Validator\CapacityExclusionValidator;
use RuntimeException;

/**
 * Kapasite Analizi'nden haric tutulan gunler — basit CRUD. Tarih + aciklama.
 * Yetki + dogrulama + yanit; SQL Repository'de. Haric kaydi baska tabloca referans
 * verilmez, silme serbest (hard delete).
 */
final class CapacityExclusionController
{
    private CapacityExclusionRepository $repo;

    public function __construct(private Context $ctx)
    {
        $this->repo = new CapacityExclusionRepository($ctx);
    }

    public function index(array $query): never
    {
        $result = $this->repo->paginate(
            (int) ($query['page'] ?? 1),
            (int) ($query['limit'] ?? 1000)
        );
        Response::ok(
            CapacityExclusion::fromRows($result['rows']),
            ['page' => (int) ($query['page'] ?? 1), 'total' => $result['total']]
        );
    }

    public function show(int $id): never
    {
        $row = $this->repo->find($id);
        if ($row === null) {
            Response::fail(404, 'Haric tarih bulunamadi');
        }
        Response::ok(CapacityExclusion::fromRow($row));
    }

    public function store(array $input): never
    {
        $this->requireEditor();

        $v = (new CapacityExclusionValidator())->validate($input, isCreate: true);
        if ($v->fails()) {
            Response::invalid($v->errors());
        }

        $cols = CapacityExclusion::toColumns($input);
        if ($this->repo->dateExists($cols['date'])) {
            Response::invalid(['date' => 'Bu tarih zaten haric listesinde']);
        }

        $id = $this->repo->create($cols);
        Response::created(CapacityExclusion::fromRow($this->repo->find($id)));
    }

    public function update(int $id, array $input): never
    {
        $this->requireEditor();

        $v = (new CapacityExclusionValidator())->validate($input, isCreate: false);
        if ($v->fails()) {
            Response::invalid($v->errors());
        }

        $cols = CapacityExclusion::toColumns($input);
        if (isset($cols['date']) && $this->repo->dateExists($cols['date'], $id)) {
            Response::invalid(['date' => 'Bu tarih zaten haric listesinde']);
        }

        try {
            $this->repo->update($id, $cols, $input['updatedAt'] ?? null);
        } catch (RuntimeException $e) {
            if ($e->getMessage() === 'NOT_FOUND') {
                Response::fail(404, 'Haric tarih bulunamadi');
            }
            if ($e->getMessage() === 'STALE') {
                Response::fail(409, 'Bu kayit siz acdiktan sonra baskasi tarafindan degistirildi. Sayfayi yenileyip tekrar deneyin.', 'STALE');
            }
            throw $e;
        }

        Response::ok(CapacityExclusion::fromRow($this->repo->find($id)));
    }

    public function destroy(int $id): never
    {
        $this->requireEditor();

        if (!$this->repo->delete($id)) {
            Response::fail(404, 'Haric tarih bulunamadi');
        }
        Response::ok(['id' => $id]);
    }

    private function requireEditor(): void
    {
        if (!$this->ctx->isEditor()) {
            Response::fail(403, 'Bu islem icin duzenleme yetkisi gerekiyor', 'READ_ONLY');
        }
    }
}
