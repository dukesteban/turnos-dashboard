-- 008 — unicidad en los catálogos
--
-- Sin esto se crean duplicados tipo "Cliente Nuevo 3" dos veces, y después el
-- historial queda partido entre dos clientes que son la misma persona.
--
-- El índice va sobre lower(btrim(nombre)) y no sobre `nombre` pelado, así que
-- "  Daniel Prueba " y "daniel prueba" cuentan como el mismo cliente.
--
-- ⚠️ Si esto falla con unique_violation, es que YA hay duplicados en la tabla.
--    No lo resuelvas creando otro índice: primero fusioná los duplicados.
--
-- Idempotente.

CREATE UNIQUE INDEX IF NOT EXISTS clientes_nombre_unico
  ON clientes (lower(btrim(nombre)));

-- Parcial: los servicios borrados dejan nombre NULL y varios NULL pueden convivir.
CREATE UNIQUE INDEX IF NOT EXISTS servicios_nombre_unico
  ON servicios (lower(btrim(nombre)))
  WHERE nombre IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS metodos_pago_nombre_unico
  ON metodos_pago (lower(btrim(nombre)));

-- `puestos` y `empleados` también, por si se corren sobre una base vieja.
CREATE UNIQUE INDEX IF NOT EXISTS empleados_nombre_unico
  ON empleados (lower(btrim(nombre)));

CREATE UNIQUE INDEX IF NOT EXISTS puestos_nombre_unico
  ON puestos (lower(btrim(nombre)));

-- Verificación: debe devolver 0 filas en todas.
--
--   SELECT lower(btrim(nombre)) n, count(*) FROM clientes GROUP BY 1 HAVING count(*) > 1;
--   SELECT lower(btrim(nombre)) n, count(*) FROM servicios GROUP BY 1 HAVING count(*) > 1;
--   SELECT lower(btrim(nombre)) n, count(*) FROM metodos_pago GROUP BY 1 HAVING count(*) > 1;
--   SELECT lower(btrim(nombre)) n, count(*) FROM empleados GROUP BY 1 HAVING count(*) > 1;
--   SELECT lower(btrim(nombre)) n, count(*) FROM puestos GROUP BY 1 HAVING count(*) > 1;
