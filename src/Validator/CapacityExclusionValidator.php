<?php
declare(strict_types=1);

namespace App\Validator;

use App\Core\Validator;

final class CapacityExclusionValidator extends Validator
{
    public function validate(array $input, bool $isCreate): static
    {
        if ($isCreate || array_key_exists('date', $input)) {
            $this->required($input, 'date', 'Tarih')
                 ->date($input, 'date', 'Tarih');
        }
        $this->maxLength($input, 'note', 255, 'Aciklama');
        return $this;
    }
}
