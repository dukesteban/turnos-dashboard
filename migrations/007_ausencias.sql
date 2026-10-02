-- 007 — ausencias
--
-- La otra mitad de la disponibilidad. `empleados.jornada` (005) es el patrón
-- SEMANAL que se repite; `ausencias` son las EXCEPCIONES con fecha concreta.
-- Las dos se combinan: un empleado trabaja L-V de 8 a 17, y además tiene una
-- licencia del 12 al 15 de noviembre.
--
-- POR QUÉ NO SE BORRAN LOS TURNOS AFECTADOS
-- Si le cargás una ausencia encima de turnos ya tomados, esos turnos NO se mueven
-- ni se borran: quedan marcados "en riesgo" en la agenda (columna rayada + ✕).
-- El que decida reprogramar o cobrar es el usuario, no la base.
--
-- RANGOS DE HORARIO
-- `hora_inicio`/`hora_fin` en NULL = ausencia de día completo.
-- Si se pone uno, se tienen que poner los dos, y `hora_fin > hora_inicio`.
--
-- Idempotente.

CREATE TABLE IF NOT EXISTS ausencias (
  id          serial PRIMARY KEY,
  empleado_id integer NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  desde       date    NOT NULL,
  hasta       date,
  hora_inicio time,
  hora_fin    time,
  tipo        text    NOT NULL DEFAULT 'ausencia',
  motivo      text,
  created_at  timestamptz DEFAULT now(),

  -- 'hasta' NULL = ausencia de un solo día.
  CONSTRAINT ausencias_rango  CHECK (hasta IS NULL OR hasta >= desde),
  -- O ausencia de día completo, O un rango horario coherente.
  CONSTRAINT ausencias_horas  CHECK (
    (hora_inicio IS NULL AND hora_fin IS NULL)
 OR (hora_inicio IS NOT NULL AND hora_fin IS NOT NULL AND hora_fin > hora_inicio)
  )
);

COMMENT ON TABLE  ausencias              IS 'Excepciones con fecha a la jornada semanal del empleado (vacaciones, licencias, enfermedades).';
COMMENT ON COLUMN ausencias.hasta        IS 'Fin del rango. NULL = un solo día.';
COMMENT ON COLUMN ausencias.hora_inicio  IS 'NULL = ausencia de día completo.';
COMMENT ON COLUMN ausencias.tipo         IS 'ausencia | vacaciones | licencia | enfermedad | permiso | otro.';

-- La consulta de la agenda: "qué ausencias tiene este empleado en esta fecha".
CREATE INDEX IF NOT EXISTS ausencias_emp_fecha
  ON ausencias (empleado_id, desde, hasta);

-- Sin RLS, PostgREST no devuelve NADA: es el error más común al crear una tabla.
ALTER TABLE ausencias ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ausencias_all ON ausencias;
CREATE POLICY ausencias_all ON ausencias FOR ALL TO public USING (true) WITH CHECK (true);
