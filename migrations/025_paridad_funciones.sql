-- Igualar las tres funciones que faltaban en ryf.
--
-- ─── EL RESULTADO DE LA COMPARACIÓN ───
--
-- Se compararon las dos bases columna por columna y función por función. Quedaron
-- cuatro diferencias de columnas y tres funciones. De las columnas, ninguna la usa
-- la app ni el bot:
--
--   conversaciones.servicio_precio   integer en test, numeric en ryf   (nadie la lee)
--   conversaciones.fecha_propuesta2  vs fecha_propuesta_2             (n8n viejo)
--   conversaciones.hora_propuesta2   vs hora_propuesta_2              (n8n viejo)
--   telefonos.created_at             no existe en ryf                (no se usa)
--   turnos.puesto_id                 no existe en ryf                (columna muerta)
--
-- Estas TRES funciones sí faltaban, y esa parte sí se arregla:
--
--   obtener_o_crear_conversacion  el n8n viejo la usaba; el bot actual hace un
--                                 upsert directo y no la llama
--   quien_soy                     helper de diagnostico: devuelve quién sos en
--                                 RLS y qué rol trae el JWT. Es la que sirve
--                                 cuando una politica no deja pasar algo
--   verificar_disponibilidad      el chequeo de superposición ANTERIOR a la 024

-- ─── Por qué se agregan las tres y no solo las que se usan ───
--
-- La 024 ya prohibió los turnos superpuestos con una restricción `EXCLUDE`, que es
-- más fuerte que cualquier función: no se puede esquivar. `verificar_disponibilidad`
-- queda como la versión consultable para cuando uno quiere preguntar "¿está?",
-- pero ahora por empleado y con un `empleado_id` opcional: antes contaba turnos
-- superpuestos de TODO el negocio, así que en un local con cuatro, dos clientes
-- pausados a la misma hora con personas distintas daba "no disponible" cuando las
-- dos estaban perfectas. El `EXCLUDE` de la 024 ya lo hace bien por empleado.

-- ─── obtener_o_crear_conversacion ───
-- La usaba el flujo n8n. Se trae por paridad y porque el `upsert` del bot es
-- equivalente; si algún día se resucita el flujo viejo, está.
create or replace function public.obtener_o_crear_conversacion(p_telefono text)
returns void
language plpgsql
as $$
begin
  insert into conversaciones (telefono)
  values (p_telefono)
  on conflict (telefono) do nothing;
end;
$$;

-- ─── quien_soy ───
-- Devuelve quién sos dentro de RLS y qué rol trae el JWT. Es la que hay que llamar
-- cuando una política no deja pasar algo y hay que ver si el rol llegó.
--
-- `current_setting('role', true)` y no `current_role()` a secas: el primero no
-- tira error si el setting no existe.
create or replace function public.quien_soy()
returns text
language sql
stable
as $$
  select 'current_user=' || current_user
      || ' | rol_activo=' || current_setting('role', true)
      || ' | jwt_rol=' || coalesce(auth.jwt() ->> 'role','(sin jwt)')
      || ' | jwt_app_rol=' || coalesce(auth.jwt() -> 'app_metadata' ->> 'rol','(sin jwt)');
$$;

-- ─── verificar_disponibilidad ───
-- "Está libre esta franja para ESTE empleado?"
--
-- `p_empleado_id = null` significa "cualquier empleado": sin ese parámetro el
-- chequeo es de todo el negocio, que es lo que hacía la versión vieja y lo que
-- daba falsos negativos con dos personas reservas a la vez.
create or replace function public.verificar_disponibilidad(
  p_fecha date,
  p_hora_inicio time without time zone,
  p_hora_fin time without time zone,
  p_empleado_id bigint default null
)
returns boolean
language plpgsql
stable
as $$
declare
  turnos_superpuestos int;
begin
  select count(*) into turnos_superpuestos
  from turnos
  where fecha = p_fecha
    and estado <> 'cancelado'
    and hora_inicio < p_hora_fin
    and hora_fin > p_hora_inicio
    and (p_empleado_id is null or empleado_id = p_empleado_id);

  return turnos_superpuestos = 0;
end;
$$;

-- Para comparar las bases otra vez:
--
--   select p.proname
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
--    order by 1;