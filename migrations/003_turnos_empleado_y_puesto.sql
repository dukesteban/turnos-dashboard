-- 003 — turnos: empleado_id y puesto_id
--
-- `turnos` guarda las DOS columnas a propósito, y no es redundancia:
--
--   puesto_id   → el LAYOUT. En qué box se agendó. Se recalcula si el empleado
--                 se mueve de puesto.
--   empleado_id → el SNAPSHOT de quién tomó el turno. Las comisiones se liquidan
--                 con este valor, así que aunque después el empleado se mueva de
--                 box, el turno sigue SIENDO de quien lo hizo.
--
-- "El puesto del turno" siempre se DERIVA del empleado (`puestoDeEmpleado`), no
-- de `turnos.puesto_id`. La columna queda como registro del lugar reservado.
--
-- Idempotente.

ALTER TABLE turnos ADD COLUMN IF NOT EXISTS empleado_id bigint;
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS puesto_id  bigint;

-- NO ACTION a propósito: no se puede borrar un puesto que tiene turnos
-- históricos. Primero hay que reasignarlos.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turnos_empleado_id_fkey'
  ) THEN
    ALTER TABLE turnos
      ADD CONSTRAINT turnos_empleado_id_fkey
      FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turnos_puesto_id_fkey'
  ) THEN
    ALTER TABLE turnos
      ADD CONSTRAINT turnos_puesto_id_fkey
      FOREIGN KEY (puesto_id) REFERENCES puestos(id) ON DELETE NO ACTION;
  END IF;
END $$;

-- La consulta más hot de la agenda: "qué hay en este puesto en esta fecha".
CREATE INDEX IF NOT EXISTS idx_turnos_puesto ON turnos (puesto_id, fecha);
