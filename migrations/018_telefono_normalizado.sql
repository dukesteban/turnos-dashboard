-- Los telefonos argentinos llegan en tres formatos distintos y�� el match exacto fallaba:
--   webhook de Meta:      5493815512745   (con el 9)
--   lo que acepta Meta:    543815512745    (sin el 9)
--   como lo carga la app:3815512745  o  +54 9 381...
-- Por eso obtener_o_crear_cliente() no encontraba al cliente y armaba un "Cliente Nuevo N".
--
-- La regla ahora es comparar solo los ULTIMOS 10 DIGITOS (area + numero), que son los
-- que identifican a una persona. El prefijo 54 y el 9 opcional dejan de importar.

-- ─── Helper: ultimos 10 digitos, sin signos ───
create or replace function public.digitos(t text)
returns text
language sql
immutable
as $$
  select coalesce(right(regexp_replace(coalesce(t, ''), '\D', '', 'g'), 10), '');
$$;

comment on function public.digitos(text) is
  'Ultimos 10 digitos de un telefono, para comparar sin prefijo 54 ni el 9 opcional.';

-- ─── El RPC, ahora con comparacion por digitos ───
create or replace function public.obtener_o_crear_cliente(p_telefono text)
returns table(id integer, nombre text)
language plpgsql
as $$
declare
  v_cliente_id int;
  v_nombre      text;
  v_contador    int;
  v_digitos     text;
begin
  v_digitos := public.digitos(p_telefono);

  -- Primero el match por digitos (ignora 54 / 9 / + / espacios).
  select t.cliente_id, c.nombre into v_cliente_id, v_nombre
  from telefonos t
  join clientes c on c.id = t.cliente_id
  where public.digitos(t.telefono) = v_digitos
    and v_digitos <> ''
  limit 1;

  -- Si no hay match pero el numero viene completo, guardar prolijo.
  if v_cliente_id is null and p_telefono is not null and length(regexp_replace(p_telefono, '\D', '', 'g')) >= 10 then
    select count(*) + 1 into v_contador
    from clientes where nombre like 'Cliente Nuevo %';
    v_nombre := 'Cliente Nuevo ' || v_contador;

    insert into clientes (nombre) values (v_nombre)
    returning clientes.id into v_cliente_id;

    insert into telefonos (cliente_id, telefono, principal)
    values (v_cliente_id, p_telefono, true);
  end if;

  return query select v_cliente_id, v_nombre;
end;
$$;

-- ─── Consultar un cliente por telefono sin crearlo (la usa el bot para saludar por nombre) ───
create or replace function public.buscar_cliente_por_telefono(p_telefono text)
returns table(id integer, nombre text, telefono text)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.nombre, t.telefono
  from telefonos t
  join clientes c on c.id = t.cliente_id
  where public.digitos(t.telefono) = public.digitos(p_telefono)
    and public.digitos(p_telefono) <> ''
  order by c.id
  limit 1;
$$;

grant execute on function public.buscar_cliente_por_telefono(text) to anon, authenticated, service_role;

-- ─── Limpieza: los "Cliente Nuevo N" que duplican un cliente real (mismo numero, sin turnos) ───
-- Un cliente real ya existe con ese numero, asi que este es un duplicado que el bot creo
-- cuando fallo el match exacto. No tiene turnos ni pagos: se puede borrar sin riesgo.
do $$
declare v_id int;
begin
  for v_id in
    select c.id
    from clientes c
    where c.nombre like 'Cliente Nuevo %'
      and not exists (select 1 from turnos t where t.cliente_id = c.id)
      and exists (
        select 1
        from telefonos tj
        join telefonos tr on public.digitos(tr.telefono) = public.digitos(tj.telefono)
        join clientes real on real.id = tr.cliente_id
        where tj.cliente_id = c.id
          and real.nombre not like 'Cliente Nuevo %'
      )
  loop
    -- primero los telefonos, despues el cliente (FK)
    delete from telefonos where cliente_id = v_id;
    delete from clientes where id = v_id;
    raise notice 'duplicado borrado: cliente %', v_id;
  end loop;
end $$;