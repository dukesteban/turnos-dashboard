-- 029: indices por fecha en turnos
--
-- POR QUE
--
-- La agenda y la caja filtran por `fecha` (semana, mes, rango de caja). Sin
-- indice, Postgres recorre la tabla entera y ordena en memoria. Con 28 turnos
-- de prueba no se nota; con un local que atiende todos los dias durante anos,
-- cada cambio de semana escanea miles de filas para mostrar siete.
--
-- Son DOS indices y no uno porque las consultas no son la misma:
--
--   * (fecha, hora)   -> agenda y dashboard: filtra por rango y ordena por hora.
--   * (estado, fecha) -> caja: WHERE estado = 'atendido' AND fecha BETWEEN ...
--
-- IF NOT EXISTS para poder correrlo dos veces (test y ryf) sin romper.

create index if not exists idx_turnos_fecha_hora
  on public.turnos (fecha, hora);

create index if not exists idx_turnos_estado_fecha
  on public.turnos (estado, fecha);
