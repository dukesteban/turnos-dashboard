-- 010 — blindar la duplicación de `turnos.hora`
--
-- `turnos` tiene TRES columnas de horario:
--
--   hora        "¿a qué hora?"            la vieja, duplicada
--   hora_inicio "¿a qué hora empieza?"     la oficial (se escribe con hora_fin)
--   hora_fin    "¿hasta qué hora?"         = hora_inicio + duración del servicio
--
-- Historia: los turnos tenían solo `hora`. Cuando a los servicios les apareció
-- duración (45/60/90 min) hubo que agregar `hora_fin` para poder armar un RANGO y
-- detectar superposiciones. Después, al hacer la Agenda, se agregó `hora_inicio`
-- como hora de inicio "oficial" y nadie borró la vieja `hora`.
--
-- `hora_inicio` + `hora_fin` son las que permiten detectar superposición:
--     .lt('hora_inicio', horaFin)   -- mi turno empieza antes de que termine el otro
--     .gt('hora_fin', inicio)       -- mi turno termina después de que empiece el otro
-- `hora` sola no alcanza, y hoy solo se usa para ORDENAR en dos consultas.
--
-- ESTA MIGRACIÓN NO BORRA NADA. Solo pone un CHECK para que las dos columnas no
-- puedan divergir nunca más. Es el primer paso de los dos:
--
--   paso 1 (este)  → el CHECK hace segura la redundancia
--   paso 2 (futuro) → borrar `hora`: 18 lecturas, 4 escrituras, 2 order by,
--                      1 select. Ahora es una limpieza sin riesgo.
--
-- Idempotente.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turnos_hora_coincide'
  ) THEN
    ALTER TABLE turnos
      ADD CONSTRAINT turnos_hora_coincide
      CHECK (hora_inicio IS NULL OR hora = hora_inicio);
  END IF;
END $$;

COMMENT ON COLUMN turnos.hora IS
  'Duplicada de hora_inicio. Las dos se escriben siempre juntas (ver CHECK turnos_hora_coincide). Candidata a borrar: la app ya lee hora_inicio y solo usa esta para ordenar.';

-- Verificación: debe dar 0. Si da filas, hay drift heredado que sincronizar antes.
--
--   SELECT id, hora, hora_inicio FROM turnos
--    WHERE hora IS DISTINCT FROM hora_inicio AND hora_inicio IS NOT NULL;