-- 028: limpieza semanal de las tablas que el bot escribe y nadie borra
--
-- ─── POR QUÉ ───
--
-- Hay tres tablas que crecen solas y no las limpia nadie:
--
--   · mensajes_procesados      1 fila por mensaje de WhatsApp
--   · recordatorios_enviados   1 fila por recordatorio mandado
--   · conversaciones           1 fila por teléfono, con el chat entero adentro
--
-- Las dos primeras son chicas y en la práctica no molestan: una peluquería con mil
-- mensajes por mes mete unos 60 kB. Se limpian igual porque no cuesta nada y
-- porque es mejor una base que no crece "por las dudas" que enterarse tarde. La
-- tercera es la que de verdad va a crecer, pero NO se toca acá: borrar el
-- historial de una conversación es una decisión que necesita criterio (cuánto
-- guardar, qué resumir, qué se le puede quitar a un cliente), no una tarea de
-- limpieza. Eso se hace a mano, cuando se vea que aprieta.
--
-- ─── POR QUÉ JUSTO ESTOS CORTES ───
--
-- mensajes_procesados: Meta reintenta el webhook cuando no recibe respuesta a
-- tiempo, y reintenta por HORAS, no por meses. Lo que tenga más de 30 días no va
-- a volver nunca y el id se puede borrar sin riesgo.
--
-- recordatorios_enviados: hay que mirar dos cosas acá.
--
-- La primera: su fila es la que garantiza que no se manden DOS recordatorios del
-- mismo turno. El cron solo consulta los ids de los turnos candidatos (los de
-- mañana), así que borrar lo que ya pasó no puede afectar ningún envío: un turno
-- del martes pasado jamás va a volver a ser candidato.
--
-- La segunda, y es la que cambia el criterio: la foreign key contra `turnos` es
-- ON DELETE CASCADE. O sea que los registros huérfanos NO EXISTEN: si borrás un
-- turno, su fila de recordatorio se va con él. Una limpieza por "no existe el
-- turno" sería código muerto, borraría cero filas para siempre.
--
-- El problema real es otro: la fila NO se va sola si el turno NO se borra. Y los
-- turnos no se borran solos, se acumulan. Entonces la tabla crece con la cantidad
-- de turnos que el local hizo en su vida. Por eso el corte es por FECHA y no por
-- existencia.
--
-- ─── PROGRAMACIÓN ───
--
-- Domingo a las 3 de la mañana, UTC. El local está cerrado y no hay turnos de
-- mañana que un borrado pueda tocar. El horario es UTC y no hora de Argentina:
-- Argentina no tiene horario de verano desde 2009, así que las 3 UTC son la 1 de
-- la madrugada todo el año. Da igual: es una tarea que no necesita el reloj.

-- ─── La limpieza ───

create or replace function public.limpiar_tablas_bot()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mensajes integer := 0;
  v_recordatorios integer := 0;
begin
  -- Los mensajes ya viejos no van a ser reintentados nunca.
  delete from public.mensajes_procesados
   where processed_at < now() - interval '30 days';
  get diagnostics v_mensajes = row_count;

  -- Los recordatorios de turnos que ya pasaron. "Pasó" quiere decir más de un día:
  -- el cron corre cada 15 minutos y mira los turnos de MAÑANA, así que dejar un
  -- margen de un día asegura que jamás se borre nada que todavía sea candidato.
  delete from public.recordatorios_enviados r
   where exists (
     select 1 from public.turnos t
      where t.id = r.turno_id
        and t.fecha < (current_date - 1)
   );
  get diagnostics v_recordatorios = row_count;

  return jsonb_build_object(
    'mensajes_procesados_borrados',   v_mensajes,
    'recordatorios_enviados_borrados', v_recordatorios,
    'cuando', now()
  );
end;
$$;

comment on function public.limpiar_tablas_bot() is
  'Borra mensajes_procesados de mas de 30 dias y recordatorios de turnos que ya no existen.';

-- ─── Programarla ───
--
-- Se desprograma primero porque cron.schedule con un nombre repetido AGREGA un job
-- en vez de reemplazarlo. Correr esta migración dos veces dejaba dos limpiezas por
-- semana: inofensivo, pero basura que queda.

do $$
declare
  v_existente text;
begin
  select jobname into v_existente from cron.job where jobname = 'limpieza-tablas-bot';
  if v_existente is not null then
    perform cron.unschedule('limpieza-tablas-bot');
  end if;
end;
$$;

select cron.schedule(
  'limpieza-tablas-bot',
  '0 3 * * 0',
  $$select public.limpiar_tablas_bot()$$
);

-- Para correrla a mano cuando haga falta:
--
--   select public.limpiar_tablas_bot();
--
-- Para ver cuando corrió:
--
--   select start_time, status, left(return_message, 200) as resultado
--     from cron.job_run_details
--    where jobname = 'limpieza-tablas-bot'
--    order by start_time desc limit 5;