<?php
declare(strict_types=1);

namespace App\Dto;

/**
 * API sozlesmesi — Kapasite Analizi'nden haric tutulan gun. camelCase <-> snake_case siniri.
 *   tarih     -> date   (YYYY-MM-DD)
 *   aciklama  -> note
 */
final class CapacityExclusion
{
    public static function fromRow(array $row): array
    {
        return [
            'id'        => (int) $row['id'],
            'date'      => (string) $row['date'],
            'note'      => $row['note'] !== null ? (string) $row['note'] : null,
            'updatedAt' => (string) $row['updated_at'],
        ];
    }

    /** @param array<array> $rows */
    public static function fromRows(array $rows): array
    {
        return array_map([self::class, 'fromRow'], $rows);
    }

    public static function toColumns(array $input): array
    {
        $out = [];
        if (array_key_exists('date', $input)) {
            $out['date'] = trim((string) $input['date']);
        }
        if (array_key_exists('note', $input)) {
            $val = trim((string) $input['note']);
            $out['note'] = $val === '' ? null : $val;
        }
        return $out;
    }
}
