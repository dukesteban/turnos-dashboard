-- obtener_o_crear_cliente() no andaba al CREAR un cliente nuevo.
--
-- La funcion declara `RETURNS TABLE(id integer, nombre text)`. En PL/pgSQL ese
-- `nombre` es una variable de salida, y el `where nombre like 'Cliente Nuevo %'`
-- de adentro es ambiguo entre esa variable y la columna de la tabla. Postgres tira
-- "column reference nombre is ambiguous" y no se puede crear ningun cliente nuevo
-- desde el bot.
--
-- Solo reventaba en la rama de creacion (si encuentra el numero por digitos no
-- toca esa linea), asi que con las fichas ya registradas nunca se vio.
--
-- Se califica con clientes.nombre. Es lo mismo que ya se hacia con `returning
-- clientes.id`, que si estaba cualificado.
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
    -- El numero sale del MAXIMO del sufijo, no de count(*) + 1: si se borra un
    -- "Cliente Nuevo 3", el conteo da 5 y el siguiente seria "Cliente Nuevo 5",
    -- que ya existe, y revienta contra el indice unico de nombre.
    select coalesce(max(substring(clientes.nombre from 'Cliente Nuevo ([0-9]+)')::int), 0) + 1
      into v_contador
    from clientes
    where clientes.nombre ~ '^Cliente Nuevo [0-9]+$';

    v_nombre := 'Cliente Nuevo ' || v_contador;

    insert into clientes (nombre) values (v_nombre)
    returning clientes.id into v_cliente_id;

    insert into telefonos (cliente_id, telefono, principal)
    values (v_cliente_id, p_telefono, true);
  end if;

  return query select v_cliente_id, v_nombre;
end;
$$;