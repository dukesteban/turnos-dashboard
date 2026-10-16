-- 027: no procesar dos veces el mismo mensaje de WhatsApp
--
-- ─── POR QUÉ ───
--
-- Meta reintenta el webhook cuando no recibe 200 a tiempo. Y a tiempo es poco:
-- si la respuesta tarda más de 20 segundos, Meta da el mensaje por caído y lo
-- vuelve a mandar. El bot tarda fácil más de 20 segundos cuando tiene que dar
-- vueltas de herramientas: buscar cliente, ver servicios, ver horarios,
-- reservar, confirmar. O sea, en los turnos largos es la norma y no la excepción.
--
-- Sin nada que lo frene, el bot procesa el reintento como si fuera un mensaje
-- nuevo. Probado mandando el mismo webhook tres veces, que es lo que hace Meta:
--
--   turnos en la base: 1        <- esto lo salvó el resto del sistema
--   mensajes a la clienta: 4     <- y esto no
--
-- Los cuatro con los cuatro links de calendario, porque los cuatro se armaron
-- desde cero. La clienta recibe lo mismo cuatro veces y no entiende si se reservó
-- o no.
--
-- Lo que evita que pase es que haya un id por mensaje. Meta manda `message.id`
-- (wamid.X) y es único e inmutable por mensaje. Si ya lo procesamos, se responde
-- 200 al toque y no se hace nada más.
--
-- ─── POR QUÉ UNA TABLA Y NO UNA COLUMNA ───
--
-- La deduplicación es por MENSAJE, no por conversación: la tabla `conversaciones`
-- tiene una fila por teléfono, y un teléfono recibe cientos de mensajes. Meterlos
-- todos en un array de la fila es una caja de Pandora de tamaño y de fechas. Una
-- fila por mensaje es lo natural, y el índice único del id es lo que hace el
-- trabajo: el insert que falla es la respuesta.
--
-- ─── POR QUÉ NO SE BORRA ───
--
-- Porque si se borra, un reintento tardío (Meta reintenta varias veces con
-- minutos de diferencia) encuentra el id libre y lo procesa. La tabla crece poco:
-- una fila de 40 bytes por mensaje. Con mil mensajes por mes son 40 KB.

create table if not exists public.mensajes_procesados (
  id           text primary key,
  telefono     text,
  processed_at timestamptz not null default now()
);

comment on table public.mensajes_procesados is
  'Ids de mensajes de WhatsApp ya procesados, para ignorar los reintentos del webhook de Meta.';

create index if not exists idx_mensajes_procesados_fecha
  on public.mensajes_procesados (processed_at);

-- RLS como las otras tablas: el panel no la mira, solo la función de borde, que
-- va con la service role y pasa por encima igual.
alter table public.mensajes_procesados enable row level security;

-- Limpieza opcional: se puede borrar lo viejo sin riesgo mientras el reintento de
-- Meta no pase de unas horas.
--
--   delete from mensajes_procesados where processed_at < now() - interval '30 days';