-- 011 — retirar la tabla `puestos`
--
-- POR QUE
-- La agenda paso a tener una columna por EMPLEADO en vez de una por puesto.
-- Cuando se revisaron las 9 relaciones y las funciones del servicio, la tabla
-- `puestos` resulto estar usada para UNA sola cosa:
--
--   evitar que dos turnos se superpusieran en el mismo puesto fisico.
--
-- Todo lo demas ya era por empleado:
--
--   · el PAGO      -> `calcularComisiones` filtra por empleado_id y estado
--   · la DISPONIBILIDAD -> jornada + ausencias, por empleado
--   · la COLUMNA   -> ahora es el empleado
--
-- Como puesto<->empleado era 1:1 (2 puestos, 2 empleados, indice unico
-- `idx_puestos_empleado_unico`), "mismo puesto" y "mismo empleado" eran la
-- MISMA condicion. La validacion de doble booking paso a `empleadoEstaOcupado`
-- con `.eq('empleado_id', ...)` y se comporta igual en todos los casos.
--
-- Ademas el modelo obligaba a crear puestos duplicados ("Puesto 2 - Jueves")
-- para cubrir un cambio de un solo dia, que es la misma enfermedad que el
-- cliente duplicado "Cliente Nuevo 3".
--
-- QUE PASA CON turnos.puesto_id
-- La COLUMNA se conserva con sus valores: es el registro historico de en que
-- box se lavo cada turno, y se pierden 74 filas de ese dato si se borra.
-- Lo que se va es la FOREIGN KEY, porque sin la tabla `puestos` los ids ya no
-- apuntan a nada.
--
-- Para borrar tambien la columna (y sus 74 valores), usar la 012.
--
-- Idempotente.

-- 1) Romper el vinculo antes de borrar la tabla: el FK es ON DELETE NO ACTION
--    y sin esto el DROP TABLE falla con 74 filas dependientes.
ALTER TABLE turnos DROP CONSTRAINT IF EXISTS turnos_puesto_id_fkey;

-- 2) Marcar la columna como histórica para que nadie la use por error.
COMMENT ON COLUMN turnos.puesto_id IS
  'HISTORICO, ya no se usa. Era el box fisico del turno. La columna se lleno hasta 2026-10-03 y quedo sin FK porque la tabla `puestos` ya no existe. El PAGO y la DISPONIBILIDAD van por empleado_id. Ver migracion 011.';

-- 3) La tabla. Se van con ella: PK, los dos indices unicos, la politica RLS
--    `puestos_all` y los datos.
DROP TABLE IF EXISTS puestos;

-- Verificación: debe dar 0 filas y 0 constraints.
--
--   SELECT count(*) FROM information_schema.tables
--    WHERE table_schema='public' AND table_name='puestos';                    -- 0
--
--   SELECT count(*) FROM pg_constraint WHERE conname='turnos_puesto_id_fkey'; -- 0
--
--   SELECT count(*) FROM turnos WHERE puesto_id IS NOT NULL;                  -- 74 (histórico)
--
-- La app no debe volver a consultar `puestos`: los metodos getPuestos,
-- crearPuesto, actualizarPuesto, desactivarPuesto, reordenarPuestos,
-- puestoDeEmpleado y puestoEstaOcupado quedaron comentados o eliminados.
