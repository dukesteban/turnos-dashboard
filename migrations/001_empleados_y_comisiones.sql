-- 001 — empleados y comisiones por servicio
--
-- `empleados` es el padrón del personal. El puesto (dónde está parado) va en
-- `puestos` (002) y se deriva del empleado, no al revés.
--
-- Idempotente.

CREATE TABLE IF NOT EXISTS empleados (
  id                  bigserial PRIMARY KEY,
  nombre              text        NOT NULL,
  telefono            text,
  comision_porcentaje integer     DEFAULT 10,
  created_at          timestamptz DEFAULT now(),
  activo              boolean     DEFAULT true
);

COMMENT ON TABLE empleados IS 'Padrón de empleados. Su jornada se define en la columna `jornada` (005).';

-- Un empleado aparece una sola vez, sin importar cómo se escriban espacios o mayúsculas.
CREATE UNIQUE INDEX IF NOT EXISTS empleados_nombre_unico
  ON empleados (lower(btrim(nombre)));

-- Comisión: no es un porcentaje único por empleado, sino por (empleado, servicio).
-- El mismo empleado puede cobrar 10% en un servicio y 15% en otro.
CREATE TABLE IF NOT EXISTS comisiones_empleado (
  id          bigserial PRIMARY KEY,
  empleado_id bigint  REFERENCES empleados(id) ON DELETE CASCADE,
  servicio_id bigint  REFERENCES servicios(id)  ON DELETE CASCADE,
  porcentaje  integer NOT NULL DEFAULT 0,
  created_at  timestamptz DEFAULT now(),
  CONSTRAINT comisiones_empleado_empleado_id_servicio_id_key UNIQUE (empleado_id, servicio_id)
);

CREATE INDEX IF NOT EXISTS comisiones_empleado_empleado
  ON comisiones_empleado (empleado_id);

-- Va aparte del CREATE TABLE porque `CREATE TABLE IF NOT EXISTS` es no-op si la
-- tabla ya existe: el CHECK nunca se agregaría a una base que ya la tenía.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'comisiones_porcentaje_rango'
  ) THEN
    ALTER TABLE comisiones_empleado
      ADD CONSTRAINT comisiones_porcentaje_rango
      CHECK (porcentaje IS NULL OR (porcentaje >= 0 AND porcentaje <= 100));
  END IF;
END $$;

-- RLS: la app es de un solo tenant y sin login, así que la política es abierta.
-- Importante: sin esto Supabase PostgREST no devuelve NADA.
ALTER TABLE empleados            ENABLE ROW LEVEL SECURITY;
ALTER TABLE comisiones_empleado ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS empleados_all            ON empleados;
CREATE POLICY empleados_all ON empleados            FOR ALL TO public USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS comisiones_empleado_all ON comisiones_empleado;
CREATE POLICY comisiones_empleado_all ON comisiones_empleado FOR ALL TO public USING (true) WITH CHECK (true);
