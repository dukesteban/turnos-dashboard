-- Datos fiscales y de contacto de las personas, y el teléfono de emergencia que usa
-- el bot de WhatsApp cuando algo se rompe.
--
-- Todo opcional: son columnas con default null, así que a las fichas que ya existen
-- no hay que tocarles nada y los formularios pueden dejarlas vacías.

-- ─── CUIT/CUIL y dirección ───
-- proveedores ya tenía `domicilio`, que es la dirección. Se le agrega solo el CUIT.
alter table public.clientes    add column if not exists cuit_cuil text;
alter table public.clientes    add column if not exists direccion  text;
alter table public.empleados   add column if not exists cuit_cuil text;
alter table public.empleados   add column if not exists direccion  text;
alter table public.proveedores add column if not exists cuit_cuil text;

comment on column public.clientes.cuit_cuil    is 'CUIT o CUIL. Opcional.';
comment on column public.clientes.direccion     is 'Dirección. Opcional.';
comment on column public.empleados.cuit_cuil   is 'CUIT o CUIL. Opcional.';
comment on column public.empleados.direccion    is 'Dirección. Opcional.';
comment on column public.proveedores.cuit_cuil is 'CUIT o CUIL. Opcional.';

-- ─── Teléfono de emergencia del bot ───
-- El bot lo lee cuando falla y le pasa el número al cliente, para que tenga por
-- dónde llamar en vez de quedarse con un "probá más tarde" sin salida.
insert into public.configuracion (clave, valor)
values ('telefono_emergencia', '')
on conflict (clave) do nothing;

-- ─── El rol del empleado se puede leer también por secretario ───
-- El rol de cada empleado vive en `usuarios.rol` (misma fila que su login). Hasta
-- ahora la tabla era solo de admin, así que ni el secretario podía ver quién es
-- qué en la pantalla de Empleados. Se abre la LECTURA, nada más: crear, editar y
-- borrar usuarios siguen siendo de admin.
drop policy if exists usuarios_leer on public.usuarios;
create policy usuarios_leer on public.usuarios
  for select
  using (rol_actual() = any (array['admin', 'secretario']));