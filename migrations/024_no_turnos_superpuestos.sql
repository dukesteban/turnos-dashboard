-- Un empleado no puede tener dos turnos que se pisen.
--
-- ─── POR QUÉ ───
--
-- El bot agendó "corte de pelo" y "lavado y alisado" los dos a las 14:00 con la
-- misma empleada, y quedaron superpuestos en la base y en la app. La causa fue una
-- carrera en la función de borde: las dos `crear_turno` del mismo mensaje se
-- ejecutaban en paralelo, cada una leía la agenda antes de que la otra escribiera,
-- y las dos veían las 14:00 como libres.
--
-- Eso ya está arreglado en el código (las tools de un mismo mensaje se ejecutan una
-- por una). Pero el chequeo "está libre" seguido del guardado NUNCA es atómico, ni
-- en el bot ni en el alta manual de la app: entre que se mira la disponibilidad y
-- se inserta, otra cosa puede entrar. Dos personas agreeing a turno a la vez para el
-- mismo empleado es exactamente el caso.
--
-- Por eso la garantía va ACÁ y no solo en el código. Esta restricción hace que la
-- doble reserva sea imposible, venga de donde venga: si algo se cuela, la base lo
-- rechaza con un error y no queda nada a medias.
--
-- Con `where (estado <> 'cancelado')`: un turno cancelado no ocupa la agenda. Si no,
-- cancelar un turno y volver a reservar la misma franja seguiría dando conflicto.

create extension if not exists btree_gist;

-- Turnos sin empleado asignado no se solapan con nadie, así que se dejan fuera:
-- `empleado_id with =` con un NULL nunca encuentra par, pero agrupan el índice para
-- mejor y dejan explícito que la regla es por empleado.
alter table public.turnos
  drop constraint if exists turnos_empleado_no_se_pisan;

-- `tsrange` y NO `tstzrange`: `hora_inicio` es `time without time zone` y `fecha`
-- es `date`, así que el rango es una_TIMESTAMP_ sin zona. Con `tstzrange` la
-- conversión implícita hace fallar el `alter table` con un 400 sin cuerpo de
-- respuesta, que es una forma horrible de enterarse.
alter table public.turnos
  add constraint turnos_empleado_no_se_pisan
  exclude using gist (
    empleado_id with =,
    tsrange(
      (fecha::timestamp + hora_inicio),
      (fecha::timestamp + hora_fin),
      '[)'
    ) with &&
  )
  where (estado <> 'cancelado');

comment on constraint turnos_empleado_no_se_pisan on public.turnos is
  'Un empleado no puede tener dos turnos que se pisen. Evita la doble reserva venga de donde venga (bot o app).';

-- Para ver los choques antes de aplicar esto en otra base:
--
--   select a.id, b.id, a.empleado_id, a.fecha, a.hora_inicio, a.hora_fin,
--          b.hora_inicio, b.hora_fin
--     from turnos a
--     join turnos b
--       on a.id < b.id
--      and a.empleado_id = b.empleado_id
--      and a.fecha = b.fecha
--      and a.estado <> 'cancelado'
--      and b.estado <> 'cancelado'
--      and a.hora_inicio < b.hora_fin
--      and b.hora_inicio < a.hora_fin;
--
-- Si tira filas, hay que resolverlas ANTES de aplicar la migración: la restricción
-- no se puede crear sobre datos que ya se violan.