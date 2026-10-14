-- ══════════════════════════════════════════════════════════════════════
-- CARGA DE PRUEBA — PELUQUERÍA "RyF" (base ryf)
-- ══════════════════════════════════════════════════════════════════════
--
-- La base ryf estaba VACÍA: cero servicios, cero empleados, cero clientes. Solo
-- el esquema. Con eso el bot no puede probar nada: `listar_servicios` devuelve
-- vacío y le dice al cliente que no hay servicios.
--
-- Esto es DATA DE PRUEBA, no esquema. El repo lo trae para poder levantar ryf con
-- contenido de punta a punta, y al final del script se deja TODO en cero, como
-- estaba.
--
-- Los horarios de atención NO se tocan: ryf ya tiene los 11, iguales a los de
-- test (lun a vie 08:00-12:00 y 14:00-20:00, sábado solo 08:00-12:00).

-- ─── Servicios ───
insert into public.servicios (nombre, precio, duracion_minutos, activo) values
  ('Corte de pelo caballero',   8000,  30, true),
  ('Corte de pelo dama',       12000,  45, true),
  ('Coloración completa',      45000, 120, true),
  ('Alisado',                  60000, 150, true),
  ('Balayage',                 75000, 180, true),
  ('Lavado y alisado',         58000, 150, true),
  ('Peinado para evento',      18000,  45, true),
  ('Manicura',                 10000,  40, true),
  ('Depilación de axilas',      7000,  20, true),
  ('Diseño de cejas',           9000,  30, true);

-- ─── Empleados ───
-- Jornada en orden domingo..sábado, el mismo formato que usa la app.
-- Una trabaja hasta las 18 y otra hasta las 13 el sábado, a propósito: sirve para
-- probar que el bot NO ofrezca a alguien fuera de su jornada. Es el mismo caso que
-- pegaba con Esteban y los miércoles.
--
-- Nota sobre `id`: se dejan fijos (901..904) para que las pruebas puedan
-- mencionarlos y borrar todo sea exactamente lo que se puso.
insert into public.empleados (id, nombre, telefono, comision_porcentaje, activo, jornada) values
  (901, 'Sofía Ramírez',   '3765381363', 18, true,
    '[
      {"activo":false,"hora_inicio":null,"hora_fin":null},
      {"activo":true,"hora_inicio":"09:00","hora_fin":"18:00"},
      {"activo":true,"hora_inicio":"09:00","hora_fin":"18:00"},
      {"activo":true,"hora_inicio":"09:00","hora_fin":"18:00"},
      {"activo":true,"hora_inicio":"09:00","hora_fin":"18:00"},
      {"activo":true,"hora_inicio":"09:00","hora_fin":"18:00"},
      {"activo":true,"hora_inicio":"09:00","hora_fin":"13:00"}
    ]'::jsonb),
  (902, 'Valentina Cruz',  '3765381364', 22, true,
    '[
      {"activo":false,"hora_inicio":null,"hora_fin":null},
      {"activo":true,"hora_inicio":"10:00","hora_fin":"19:00"},
      {"activo":true,"hora_inicio":"10:00","hora_fin":"19:00"},
      {"activo":true,"hora_inicio":"10:00","hora_fin":"19:00"},
      {"activo":true,"hora_inicio":"10:00","hora_fin":"19:00"},
      {"activo":true,"hora_inicio":"10:00","hora_fin":"19:00"},
      {"activo":false,"hora_inicio":null,"hora_fin":null}
    ]'::jsonb),
  (903, 'Camila Duarte',   '3765381365', 15, true,
    '[
      {"activo":false,"hora_inicio":null,"hora_fin":null},
      {"activo":true,"hora_inicio":"08:00","hora_fin":"14:00"},
      {"activo":true,"hora_inicio":"08:00","hora_fin":"14:00"},
      {"activo":true,"hora_inicio":"08:00","hora_fin":"14:00"},
      {"activo":true,"hora_inicio":"08:00","hora_fin":"14:00"},
      {"activo":true,"hora_inicio":"08:00","hora_fin":"14:00"},
      {"activo":false,"hora_inicio":null,"hora_fin":null}
    ]'::jsonb),
  -- El ÚNICO que trabaja el domingo, para probar el caso contrario: sí aparece
  -- cuando le preguntan quién trabaja el domingo.
  (904, 'Martín Acosta',   '3765381366', 12, true,
    '[
      {"activo":true,"hora_inicio":"09:00","hora_fin":"13:00"},
      {"activo":false,"hora_inicio":null,"hora_fin":null},
      {"activo":false,"hora_inicio":null,"hora_fin":null},
      {"activo":false,"hora_inicio":null,"hora_fin":null},
      {"activo":false,"hora_inicio":null,"hora_fin":null},
      {"activo":false,"hora_inicio":null,"hora_fin":null},
      {"activo":false,"hora_inicio":null,"hora_fin":null}
    ]'::jsonb);

-- ─── Comisiones por servicio ───
-- Solo para Camila, que es la que más rota: sin esto la app le muestra la
-- comisión general y las pruebas de comisión no dicen nada.
insert into public.comisiones_empleado (empleado_id, servicio_id, porcentaje)
select 903, s.id, 20 from public.servicios s
where s.nombre in ('Corte de pelo caballero', 'Corte de pelo dama', 'Peinado para evento');

-- ─── Dirección de ejemplo ───
-- Es la clave que el bot lee para responder "¿dónde quedan?". Con esto se puede
-- probar la ruta CON dato. Para probar la de SIN dato, borrarla.
insert into public.configuracion (clave, valor) values
  ('direccion', 'Av. San Marcos 1234, Posadas, Misiones')
on conflict (clave) do update set valor = excluded.valor;

insert into public.configuracion (clave, valor) values
  ('descripcion', 'Peluquería y estética')
on conflict (clave) do update set valor = excluded.valor;

-- ══════════════════════════════════════════════════════════════════════
-- DESCARTE
-- ══════════════════════════════════════════════════════════════════════
-- Para dejar la base como estaba, después de probar:
--
--   delete from public.comisiones_empleado where empleado_id between 901 and 904;
--   delete from public.turnos            where empleado_id between 901 and 904;
--   delete from public.conversaciones;
--   delete from public.clientes;
--   delete from public.telefonos;
--   delete from public.empleados        where id between 901 and 904;
--   delete from public.servicios;
--   update public.configuracion set valor = ''
--     where clave in ('direccion', 'descripcion');
--
-- El orden importa: los turnos y las comisiones van primero porque apuntan a los
-- empleados por id. Los horarios de atención no se tocan en ningún caso.