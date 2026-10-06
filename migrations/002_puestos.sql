-- 002 — puestos (layout físico del lavadero)
--
-- Un "puesto" es una ubicación física: el box 1, el box 2, etc. La agenda los
-- dibuja como columnas.
--
-- `puestos.empleado_id` dice QUIÉN está en ese puesto. De ahí sale el puesto de
-- un empleado (`puestoDeEmpleado`), y de ahí el empleado de un turno.
-- El vínculo es 1 a 1 entre los puestos ACTIVOS: no puede haber dos puestos
-- activos con el mismo empleado.
--
-- Idempotente.

CREATE TABLE IF NOT EXISTS puestos (
  id          bigserial PRIMARY KEY,
  nombre      text        NOT NULL DEFAULT 'Puesto',
  -- SET NULL: si se da de baja el empleado, el puesto queda libre pero no se borra.
  empleado_id bigint      REFERENCES empleados(id) ON DELETE SET NULL,
  activo      boolean     NOT NULL DEFAULT true,
  orden       integer     NOT NULL DEFAULT 0,
  created_at  timestamptz DEFAULT now()
);

COMMENT ON TABLE  puestos               IS 'Layout físico del lavadero: cada fila es una columna de la agenda.';
COMMENT ON COLUMN puestos.empleado_id   IS 'Quién atiende este puesto. Derivado: el puesto de un empleado sale de acá.';
COMMENT ON COLUMN puestos.orden         IS 'Orden de izquierda a derecha en la agenda.';

CREATE UNIQUE INDEX IF NOT EXISTS puestos_nombre_unico
  ON puestos (lower(btrim(nombre)));

-- Un empleado no puede estar en dos puestos activos a la vez.
-- Parcial: los puestos inactivos pueden repetir empleado sin conflicto.
CREATE UNIQUE INDEX IF NOT EXISTS idx_puestos_empleado_unico
  ON puestos (empleado_id)
  WHERE empleado_id IS NOT NULL AND activo = true;

ALTER TABLE puestos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS puestos_all ON puestos;
CREATE POLICY puestos_all ON puestos FOR ALL TO public USING (true) WITH CHECK (true);
