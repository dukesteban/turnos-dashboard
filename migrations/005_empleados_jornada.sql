-- 005 — empleados.jornada: de "qué días" a "qué días y a qué horas"
--
-- EL MOTIVO DEL CAMBIO
-- `dias_trabaja` era un boolean[7]: 7 checkboxes que decían SÍ/NO. No decía a
-- qué hora empieza ni termina. Con eso no se podía validar nada: un servicio de
-- 90 min que terminaba a las 21:30 pasaba el filtro aunque el empleado cortara
-- a las 18.
--
-- AHORA
-- `jornada` es un jsonb: 7 slots, uno por día de la semana, en el MISMO orden
-- que antes (0 = domingo, 1 = lunes ... 6 = sábado). Cada slot:
--
--   { "activo": true, "hora_inicio": "08:00", "hora_fin": "17:00" }
--   { "activo": false, "hora_inicio": null,     "hora_fin": null     }
--
-- `hora_inicio` / `hora_fin` en NULL = sin límite de horario ese día (∞).
--
-- LA MIGRACIÓN NO CAMBIA QUÉ DÍAS TRABAJA NADIE: reformatea, nada más.
-- Los `activo` salen tal cual del boolean anterior.
--
-- Idempotente.

ALTER TABLE empleados ADD COLUMN IF NOT EXISTS jornada jsonb;

COMMENT ON COLUMN empleados.jornada IS
  'Patrón semanal: array de 7 slots (0=domingo ... 6=sábado), cada uno {activo, hora_inicio, hora_fin}. NULL en los horarios = sin límite (∞). Reemplaza a dias_trabaja.';

-- Backfill: boolean[] -> jsonb. Solo si la columna vieja todavía existe.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'empleados'
      AND column_name = 'dias_trabaja'
  ) THEN
    -- Un empleado sin dias_trabaja ([] o NULL) queda como estaba, no se inventa.
    EXECUTE $q$
      UPDATE empleados e
      SET jornada = (
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'activo',      COALESCE(e.dias_trabaja[i + 1], false),
                   'hora_inicio', NULL,
                   'hora_fin',    NULL
                 )
                 ORDER BY i
               )
        FROM generate_series(0, 6) AS i
      )
      WHERE e.dias_trabaja IS NOT NULL
        AND e.jornada IS NULL
    $q$;
  END IF;
END $$;

-- Los que no tenían dias_trabaja quedan en L-S sin límite de horario, que es el
-- patrón con el que quedaron cargados los demás.
UPDATE empleados
SET jornada = (
  SELECT jsonb_agg(
           jsonb_build_object('activo', i BETWEEN 1 AND 6, 'hora_inicio', NULL, 'hora_fin', NULL)
           ORDER BY i
         )
  FROM generate_series(0, 6) AS i
)
WHERE jornada IS NULL;

-- Una vez copiado, la columna vieja ya no aporta nada: se va.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'empleados'
      AND column_name = 'dias_trabaja'
  ) THEN
    EXECUTE 'ALTER TABLE empleados DROP COLUMN dias_trabaja';
  END IF;
END $$;
