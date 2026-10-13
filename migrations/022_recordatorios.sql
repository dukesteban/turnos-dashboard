-- Recordatorios de turno por WhatsApp.
--
-- Antes no habia NADA: las claves `recordatorio_cuando` y `recordatorio_hora` se
-- guardaban desde Configuracion y no las leia nadie. Eramos un selector sin nada
-- detras.
--
-- Esto arma las tres piezas:
--   1. la tabla que marca que turno ya se aviso, para no mandarlo dos veces
--   2. pg_cron + pg_net, que disparan la funcion de borde cada 15 minutos
--   3. el secreto compartido, en Vault, para que no pueda llamarla cualquiera

-- ─── 1. Control de envios ───
-- Una fila por turno. El indice unico en turno_id es lo que garantiza que no se
-- mande dos veces el mismo, aunque la tarea se dispare dos veces.
create table if not exists public.recordatorios_enviados (
  id          serial primary key,
  turno_id    integer not null unique references public.turnos(id) on delete cascade,
  telefono    text,
  enviado_at  timestamptz not null default now(),
  exito       boolean not null default true,
  detalle     text
);

comment on table public.recordatorios_enviados is
  'Que turnos ya recibieron su recordatorio. El unique en turno_id evita el duplicado.';

create index if not exists idx_recordatorios_enviados_fecha on public.recordatorios_enviados (enviado_at desc);

-- RLS sin politicas: solo entra la service_role (la clave de la funcion de borde).
-- La tabla es interna del bot; la app no tiene por que verla.
alter table public.recordatorios_enviados enable row level security;

-- ─── 2. Extensiones y tarea programada ───
-- pg_cron corre la tarea; pg_net hace el POST a la funcion de borde. La alternativa
-- era un cron externo, pero una app estatica en Vercel no tiene donde correrlo.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- ─── 3. Los secretos ───
-- `cron_recordatorios` es la palabra que la funcion exige para aceptar el disparo.
-- `cron_url` es la direccion de la funcion de borde, que es DISTINTA en cada base
-- (el ref del proyecto cambia), asi que se carga aparte en cada una. Por eso el
-- cuerpo del cron la lee de Vault y no la lleva escrita: la misma migracion sirve
-- para las dos bases y no queda una URL de test metida en el repo.
--
-- Para cargar `cron_url` antes de aplicar esta migracion:
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/recordatorios', 'cron_url');
--
-- OJO: se usa `vault.create_secret()` y NO un `insert into vault.secrets`. La tabla
-- tiene permisos de pgsodium que el rol postgres del Management API tampoco tiene, y
-- el insert falla con "permission denied for function _crypto_aead_det_noncegen". La
-- funcion es la unica puerta de escritura.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'cron_recordatorios') then
    perform vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'cron_recordatorios');
  end if;
end $$;

grant usage on schema vault to service_role;
grant select on vault.decrypted_secrets to service_role;

-- ─── Leer el secreto desde la funcion de borde ───
-- `vault.decrypted_secrets` NO se puede leer con el cliente de Supabase: PostgREST
-- solo expone los esquemas de `db-schemas`, y vault no esta ahi. Hace falta una
-- funcion SQL que sea la unica puerta.
--
-- `security definer` + que revoke al PUBLIC: si no, cualquiera que descubre el
-- nombre de la funcion puede leer el secreto desde el navegador con la anon key.
create or replace function public.leer_secreto(p_nombre text)
returns text
language sql
stable
security definer
set search_path = public, vault
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_nombre limit 1;
$$;

revoke all on function public.leer_secreto(text) from public, anon, authenticated;
grant execute on function public.leer_secreto(text) to service_role;

-- La tarea dispara cada 15 minutos. NO decide aca si es la hora: eso lo mira la
-- funcion, que compara contra `recordatorio_hora` en hora de Argentina. Si el cron
-- se atrasa o se patea, la proxima ventana de 15 minutos lo agarra igual.
select cron.schedule(
  'recordatorios-turnos',
  '*/15 * * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'cron_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_recordatorios')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 50000
  );
  $cron$
);