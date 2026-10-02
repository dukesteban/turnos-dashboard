-- 004 — dias_cerrados: períodos, no solo días
--
-- Un cierre puede ser un día suelto (feriado) o un rango (vacaciones).
-- `fecha_hasta` NULL = un solo día.
--
-- El UNIQUE(fecha) que tenía la tabla IMPEDÍA cargar dos períodos que empiezan
-- el mismo día: "Vacaciones 01/01 al 15/01" y "Cierre 01/01" convivían. Con
-- rangos la unicidad por fecha de inicio ya no tiene sentido; el solapamiento
-- se valida en la app (`seSuperpone`).
--
-- Idempotente.

ALTER TABLE dias_cerrados ADD COLUMN IF NOT EXISTS fecha_hasta date;

COMMENT ON COLUMN dias_cerrados.fecha_hasta IS
  'Fin del período. NULL = cierre de un solo día. La app valida que no haya rangos superpuestos.';

-- El nombre de la constraint dice 'dias_bloqueados' porque la tabla se llamaba
-- así cuando se creó y después se renombró. Por eso el IF EXISTS con ese nombre.
ALTER TABLE dias_cerrados DROP CONSTRAINT IF EXISTS dias_bloqueados_fecha_key;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dias_cerrados'::regclass AND contype = 'u'
  ) THEN
    RAISE NOTICE 'AVISO: dias_cerrados tiene algún UNIQUE sin nombre conocido; revisar a mano.';
  END IF;
END $$;
