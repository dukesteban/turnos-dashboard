-- 015 - usuarios: rol y empleado vinculado
--
-- MOTIVACIÓN
--
-- La app tiene usuarios con nombre y contraseña (SHA-256), pero TODOS hacen lo mismo:
-- ven las cinco pantallas y escriben en todas. Con un lavadero donde hay gente que
-- solo atiende turnos y gente que lleva la caja, eso no sirve.
--
-- QUÉ AGREGAN ESTAS DOS COLUMNAS
--
--   rol          'admin' | 'secretario' | 'empleado'
--   empleado_id   a qué empleado de la tabla `empleados` corresponde este usuario
--
-- El vínculo con el empleado es lo que hace que el rol 'empleado' sirva de algo: sin
-- un `empleado_id` no hay forma de saber qué turnos son "los suyos". Es la única forma
-- de que la pantalla filtre, porque el usuario escribe un nombre ("juan") y el turno
-- tiene un `empleado_id` numérico.
--
-- POR QUÉ `ON DELETE SET NULL` Y NO `CASCADE`
--
-- Inactivar o borrar un empleado no tiene que borrar su usuario ni dejarlo apuntando
-- a algo que no existe. La fila del usuario queda con `empleado_id` en NULL, que se
-- lee como "este usuario no está vinculado a ningún empleado", y desde la pantalla de
-- Usuarios se ve y se corrige.
--
-- POR QUÉ EL ROL NO TIENE DEFAULT DESPUÉS DE ESTA MIGRACIÓN
--
-- La columna nace con `DEFAULT 'secretario'` solo para poder filledar las filas que ya
-- existen sin que la tabla se bloquee, y al final se le saca. Sin default, todo INSERT
-- tiene que decir el rol a mano: si mañana se agrega un usuario por SQL o por un
-- script y se olvida el rol, la base lo rechaza en vez de darle el permiso máximo sin
-- querer.
--
-- Idempotente.

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS rol text NOT NULL DEFAULT 'secretario';

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS empleado_id integer REFERENCES empleados(id) ON DELETE SET NULL;

-- Las filas que ya existían eran admins: hasta ahora no había roles y todo el que
-- entraba podía hacer de todo. Asignarlas a cualquiera menos admin sería bajarles los
-- permisos sin avisar.
UPDATE usuarios SET rol = 'admin';

-- A partir de acá el rol hay que elegirlo siempre.
ALTER TABLE usuarios ALTER COLUMN rol DROP DEFAULT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usuarios_rol_check'
  ) THEN
    ALTER TABLE usuarios
      ADD CONSTRAINT usuarios_rol_check
      CHECK (rol IN ('admin', 'secretario', 'empleado'));
  END IF;
END $$;

-- Un empleado por usuario, no al revés: si dos personas (el titular y un suplente,
-- por ejemplo) compartieran el mismo `empleado_id`, las dos verían los turnos del
-- mismo y al borrar los turnos "propios" de una se llevarían los de la otra.
-- Parcial porque NULL puede repetirse (usuarios sin vincular), y sin el `WHERE` el
-- índice unique rechazaría el segundo NULL.
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_empleado_unico
  ON usuarios (empleado_id)
  WHERE empleado_id IS NOT NULL;

COMMENT ON COLUMN usuarios.rol IS
  'admin: ve y modifica todo. secretario: ve todo pero no escribe en Caja. empleado: solo Turnos y Agenda, y unicamente sus propios turnos.';
COMMENT ON COLUMN usuarios.empleado_id IS
  'Empleado de la tabla empleados al que pertenece este usuario. NULL = usuario sin vincular: el rol empleado no tendria turnos propios que mostrar.';
COMMENT ON COLUMN usuarios IS
  'Usuarios de la app. El login compara SHA-256 de la contrasena contra password_hash.';

-- Verificación: debe devolver 0 filas.
--
--   -- Todos con rol valido (el CHECK lo garantiza, esto es por si se toco a mano):
--   SELECT usuario, rol FROM usuarios WHERE rol NOT IN ('admin','secretario','empleado');
--
--   -- Ningun empleado en dos usuarios:
--   SELECT empleado_id, count(*) FROM usuarios WHERE empleado_id IS NOT NULL
--    GROUP BY 1 HAVING count(*) > 1;
--
--   -- El admin de antes quedo admin:
--   SELECT usuario, rol FROM usuarios ORDER BY id;