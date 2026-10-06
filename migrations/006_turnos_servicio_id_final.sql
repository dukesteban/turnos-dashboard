-- 006 — turnos.servicio_id_final: el servicio REALMENTE cobrado
--
-- `turnos.servicio_id` / `servicio_nombre` / `precio` son lo RESERVADO:
-- lo que el cliente pidió al agendar.
-- `servicio_id_final` / `servicio_nombre_final` / `precio_final` son lo COBRADO.
--
-- DIFIEREN distinto y no es drift: el cliente agendó "Lavado simple" ($12.000) y
-- al final se le hizo "Lavado completo" ($20.000).
--
-- OJO: esta columna NO tiene FOREIGN KEY a propósito. Es el mismo criterio que
-- `cliente_nombre`: es un snapshot de lo cobrado, y el servicio se puede dar de
-- baja sin perder el registro de lo que se cobró. Si un día el servicio se
-- borra, el turno histórico tiene que seguir mostrando qué se facturó.
--
-- Idempotente.

ALTER TABLE turnos ADD COLUMN IF NOT EXISTS servicio_id_final integer;

COMMENT ON COLUMN turnos.servicio_id_final IS
  'Servicio realmente cobrado (FK lógica a servicios, sin constraint a propósito: es un snapshot histórico). NULL = se cobró lo que se reservó.';
COMMENT ON COLUMN turnos.servicio_nombre_final IS
  'Nombre del servicio cobrado. Snapshot: sobrevive al borrado del servicio.';
COMMENT ON COLUMN turnos.precio_final IS
  'Precio realmente cobrado. NULL = se cobró el precio reservado.';

-- Si el turno fue cobrado con el mismo servicio que el reservado, no hace falta
-- guardar el_final: queda NULL y la app lo resuelve.
UPDATE turnos
SET servicio_id_final = NULL
WHERE servicio_nombre_final IS NOT NULL
  AND servicio_nombre_final = servicio_nombre;
