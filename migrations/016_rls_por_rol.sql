-- ═══════════════════════════════════════════════════════════════════════════
-- 016 - LA BASE DEJA DE ESTAR ABIERTA A CUALQUIERA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- QUE HACIA ESTO ANTES
--
-- Las 17 politicas de RLS eran `TO public USING (true) WITH CHECK (true)`, o sea
-- "cualquiera puede leer y escribir todo". Y la app entra con la clave `sb_publishable_`,
-- que va escrita adentro del bundle y se lee abriendo las DevTools del navegador.
--
-- O sea que con abrir la consola se leian TODOS los clientes, los turnos y el dinero, y
-- se modificaba lo que quisiera, sin importar el rol. Eso no lo introdujo la migracion
-- 015 de los roles: venia desde el principio. Los roles mejoraron lo que se VE en
-- pantalla, pero no lo que se puede HACER con la clave.
--
-- QUE HACE ESTA
--
-- Las politicas pasan a preguntar QUIEN esta preguntando, leyendo el rol del JWT de
-- Supabase Auth. Con eso:
--
--   - Sin sesion (la clave sola): no lee ni escribe NADA. Esto es lo importante.
--     Antes, con la clave sola se leia todo.
--   - Con sesion: cada rol hace lo que la app ya le deja hacer en pantalla.
--
-- POR QUE EL ROL VIENE DEL JWT Y NO DE LA TABLA `usuarios`
--
-- Un JWT lo firma el servidor. Una fila de tabla la puede escribir cualquiera que tenga
-- una sesion de autorizacion. Si el rol se leyera de `usuarios` dentro de la politica,
-- un empleado podria hacer `UPDATE usuarios SET rol='admin'` y seria admin. El rol va en
-- `app_metadata` porque ahi no escribe el cliente: lo escribe el admin del proyecto
-- (la funcion de borde `admin-usuarios`).
--
-- POR QUE `rol_actual()` NO ES SECURITY DEFINER
--
-- Una politica corre con los permisos del usuario que consulta. Si `rol_actual()` leyera
-- de una tabla, esa lectura se evaluaria contra las politicas de esa tabla... que es lo
-- que estamos cerrando. Seria un deadlock: la politica necesita leer `usuarios` para
-- decidir si puede leer `usuarios`.
--
-- Leer el JWT esquiva el problema entero: el JWT lo manda el cliente, pero va firmado, y
-- Postgres verifica la firma con la clave publica del proyecto. Forgearlo no es cuestión
-- de escribir un string en la consola.
--
-- QUE NO SE TOCA, Y POR QUE
--
-- `conversaciones` sigue abierta. No la usa la app: la usa el bot de n8n, y no se sabe
-- con que clave entra. Cerrarla a ciegas rompe el bot. Es el hueco que queda, y esta
-- anotado en README.md.
--
-- COMO SE DESHACE
--
--   ALTER TABLE public.<tabla> DISABLE ROW LEVEL SECURITY;   -- por tabla
--
-- O, para volver atras del todo y dejar la base como estaba (esto reabre todo):
--
--   DO $$ DECLARE t text; BEGIN
--     FOR t IN SELECT tablename FROM pg_policies WHERE schemaname='public' LOOP
--       EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
--     END LOOP; END $$;
--
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══ 1. LAS DOS FUNCIONES DE APOYO ═══════════════════════════════════════════

-- El rol de quien consulta: 'admin', 'secretario', 'empleado' o 'anonimo'.
--
-- El COALESCE con 'anonimo' NO es cosmetico: sin sesion, `auth.jwt()` es NULL, el `->>`
-- da NULL, y una politica con `rol_actual() = 'admin'` daria NULL, que en SQL no es
-- verdadero. O sea que el comparador ya rechazaria. El 'anonimo' hace que se pueda
-- escribir `rol_actual() = ANY(ARRAY['admin',...])` sin desbalances con NULL.
CREATE OR REPLACE FUNCTION public.rol_actual() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(auth.jwt() -> 'app_metadata' ->> 'rol', 'anonimo');
$$;

COMMENT ON FUNCTION public.rol_actual() IS
  'El rol de quien consulta, leido del app_metadata del JWT de Supabase Auth. "anonimo" si no hay sesion.';


-- El `empleado_id` del usuario que consulta, o NULL.
--
-- NULL = admin o secretario, que no filtran por empleado. Y tambien el caso raro del rol
-- empleado sin `empleado_id`: NULL significa "no puede tocar ningun turno", que es lo
-- correcto. La pantalla de Usuarios lo marca en rojo para que el admin lo arregle.
--
-- El NULLIF antes del cast es obligatorio: si `empleado_id` viniera como cadena vacia,
-- `''::integer` es un ERROR y la consulta entera falla en vez de devolver NULL.
CREATE OR REPLACE FUNCTION public.empleado_actual() RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(auth.jwt() -> 'app_metadata' ->> 'empleado_id', '')::integer;
$$;

COMMENT ON FUNCTION public.empleado_actual() IS
  'El empleado_id del usuario que consulta, del app_metadata del JWT. NULL si es admin o secretario, o si es empleado sin vincular.';


-- ═══ 2. BORRAR LAS POLITICAS VIEJAS ═══════════════════════════════════════════
--
-- Con `DROP POLICY IF EXISTS` sobre pg_policies y no con 17 DROP sueltos: si mañana se
-- agrega una tabla, el `pg_policies` la cubre y no queda colgada con la politica abierta.
--
-- `conversaciones` queda fuera a proposito (ver el bloque 7): su politica actual la usa
-- el bot de n8n y no se reemplaza.

DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT policyname, tablename FROM pg_policies
    WHERE schemaname = 'public'
      AND NOT (tablename = ANY(ARRAY['conversaciones']))
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, p.tablename);
  END LOOP;
END $$;


-- ═══ 3. LAS POLITICAS DE LAS TABLAS QUE NO TIENEN EXCEPCIONES ══════════════════
--
-- El permiso esta en una matriz y las politicas se generan con un FOR, en vez de 60
-- DROP/CREATE a mano. Motivo: la tabla de abajo es la especificacion, y de ahi sale el
-- codigo. Si alguien escribe una politica a mano y no la agrega a la matriz, el proximo
-- que lea la migracion no ve que esa tabla quedo fuera.
--
--   LEEN     = que roles pueden SELECT
--   ESCRIBEN = que roles pueden INSERT / UPDATE / DELETE
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EL CRITERIO, Y POR QUE NO ES "QUE PANTALLA TOCA ESTA TABLA"
-- ═══════════════════════════════════════════════════════════════════════════
--
-- tempted: poner en "solo admin" todo lo que se edita en Configuracion. FUE UN ERROR
-- DEL PRIMER INTENTO y salio verificando con peticiones reales, no leyendo el codigo.
--
-- `servicios`, `horarios_atencion`, `metodos_pago`, `dias_cerrados` y `empleados` se
-- CONFIGURAN en Configuracion (que es solo del admin), pero se LEEN en Agenda y en
-- Dashboard, que son las dos pantallas que ve tambien el empleado. Sin leerlas:
--
--   - el empleado no puede agendar, porque al elegir hora y empleado la pantalla
--     consulta horarios y servicios para saber la duracion y si esta libre;
--   - la Agenda le sale sin precios;
--   - no se ven los dias que el lavadero esta cerrado.
--
-- O sea: "se edita en Config" NO es "solo lo lee el admin". La pregunta correcta es que
-- necesita LEER cada pantalla para funcionar, y esa es la columna LEEN.
--
-- ESCRIBEN si es distinto: cambiar un horario de atencion o un precio es de Config, y
-- por lo tanto del admin. Leerlos es de todos.
--
--   tabla                  LEEN                  ESCRIBEN         quien la edita
--   ─────────────────────  ────────────────────  ───────────────  ─────────────
--   usuarios               admin                 admin            Config
--   configuracion          los tres              admin            Config
--   servicios              los tres              admin            Config
--   horarios_atencion      los tres              admin            Config
--   metodos_pago           los tres              admin            Config
--   dias_cerrados          los tres              admin            Config
--   empleados              los tres              admin, secretario Personas
--   proveedores            admin, secretario      admin, secretario Personas
--   comisiones_empleado    los tres              admin, secretario Personas
--   compras_proveedor      admin, secretario      admin            Caja
--   pagos_empleado         admin, secretario      admin            Caja
--   pagos_proveedor        admin, secretario      admin            Caja
--
-- `usuarios` es la unica que se lee solo como admin: contiene los hashes y las
-- credenciales, y ninguna pantalla de las otras necesita nada de aca (el nombre, el rol
-- y el `empleado_id` de quien esta entró viajan en el JWT).
--
-- Los pagos y las compras quedan en admin+secretario porque son los tres cuadros de
-- Caja, que el secretario abre pero no escribe.

DO $$
DECLARE
  fila record;
  roles_lectura text;
  roles_escritura text;
  los_tres text[] := ARRAY['admin','secretario','empleado'];
BEGIN
  FOR fila IN
    SELECT * FROM (VALUES
      ('usuarios',            ARRAY['admin'],                 ARRAY['admin']),
      ('configuracion',       los_tres,                       ARRAY['admin']),
      ('servicios',           los_tres,                       ARRAY['admin']),
      ('horarios_atencion',   los_tres,                       ARRAY['admin']),
      ('metodos_pago',        los_tres,                       ARRAY['admin']),
      ('dias_cerrados',       los_tres,                       ARRAY['admin']),
      ('empleados',           los_tres,                       ARRAY['admin','secretario']),
      ('proveedores',         ARRAY['admin','secretario'],    ARRAY['admin','secretario']),
      ('comisiones_empleado', los_tres,                       ARRAY['admin','secretario']),
      ('compras_proveedor',   ARRAY['admin','secretario'],    ARRAY['admin']),
      ('pagos_empleado',      ARRAY['admin','secretario'],    ARRAY['admin']),
      ('pagos_proveedor',     ARRAY['admin','secretario'],    ARRAY['admin'])
    ) AS t(tabla, leer, escribir)
  LOOP
    -- `quote_literal` y no `array_to_string`: este ultimo arma `admin,secretario`, y eso
    -- dentro de `ARRAY[...]` son IDENTIFICADORES de columna, no strings. El error que
    -- tira es `column "admin" does not exist`, que no dice nada de comillas.
    SELECT 'ARRAY[' || string_agg(quote_literal(r), ',') || ']' INTO roles_lectura
      FROM unnest(fila.leer) AS r;
    SELECT 'ARRAY[' || string_agg(quote_literal(r), ',') || ']' INTO roles_escritura
      FROM unnest(fila.escribir) AS r;

    roles_lectura := 'public.rol_actual() = ANY(' || roles_lectura || ')';
    roles_escritura := 'public.rol_actual() = ANY(' || roles_escritura || ')';

    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', fila.tabla);

    -- El DROP antes de cada CREATE es para que la migracion se pueda correr dos veces.
    -- Sin eso, el segundo `CREATE POLICY` muere con "policy already exists" y, como va
    -- dentro de una transaccion, no se aplica NADA: la base queda como estaba y uno
    -- cree que la aplico.
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', fila.tabla || '_leer', fila.tabla);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', fila.tabla || '_crear', fila.tabla);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', fila.tabla || '_editar', fila.tabla);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', fila.tabla || '_borrar', fila.tabla);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)',
      fila.tabla || '_leer', fila.tabla, roles_lectura);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)',
      fila.tabla || '_crear', fila.tabla, roles_escritura);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)',
      fila.tabla || '_editar', fila.tabla, roles_escritura, roles_escritura);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (%s)',
      fila.tabla || '_borrar', fila.tabla, roles_escritura);
  END LOOP;
END $$;


-- ═══ 4. CONFIGURACION: LECTURA PARA QUIEN NO TIENE SESION ═════════════════════
--
-- La pantalla de login muestra el nombre del negocio ANTES de que nadie entre, asi que
-- `anon` tiene que poder leer esta tabla. Se abre solo esta, y en solo lectura: las
-- claves que hay aca son de la app (nombre, recordatorios, limites de cancelacion) y
-- ninguna es un secreto. Si alguna vez se guarda algo secreto en `configuracion`, esto
-- hay que cambiar y el nombre del negocio moverlo a una vista.

ALTER TABLE public.configuracion ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS configuracion_leer_sin_sesion ON public.configuracion;
CREATE POLICY configuracion_leer_sin_sesion ON public.configuracion
  FOR SELECT TO anon, authenticated USING (true);


-- ═══ 5. TURNOS Y AUSENCIAS: EL EMPLEADO SOLO TOCA LOS SUYOS ════════════════════
--
-- Estas dos van aparte del bucle porque el permiso depende de la FILA, no del rol: un
-- empleado puede tocar sus turnos y no los de otro. Es la unica parte donde hace falta
-- `USING` con una condicion de fila.
--
-- POR QUE EL EMPLEADO PUEDE INSERTAR UN TURNO PARA CUALQUIER EMPLEADO
--
-- Se lo confirmo el usuario: el empleado agenda y crea clientes. Y al agendar tiene que
-- poder elegir a quien sea, que es como funciona la pantalla.
--
-- Y POR QUE PUEDE LEER TODOS LOS TURNOS, NO SOLO LOS SUYOS
--
-- Porque al agendar, la app pregunta que empleados estan libres a esa hora
-- (`getEmpleadosDisponibles`, `empleadoEstaOcupado`). Eso consulta los turnos de TODOS.
-- Si el empleado solo leyera los suyos, la pantalla le ofereceria a alguien que ya esta
-- ocupado y se agendarian dos turnos en el mismo horario. Es peor un error de agenda que
-- un dato visible: la agenda de un lavadero no es un secreto, y el filtro de la pantalla
-- (que si lo aplica) queda siendo la guia de que mira cada uno.
--
-- `WITH CHECK` en UPDATE hace lo mismo que `USING` a proposito: si un empleado pudiera
-- cambiar el `empleado_id` de su turno, podria pasarselo a otro y quedarse sin poder
-- editarlo nunca mas. Con los dos lados iguales, un turno es de uno mientras sea suyo.

ALTER TABLE public.turnos ENABLE ROW LEVEL SECURITY;

CREATE POLICY turnos_leer ON public.turnos
  FOR SELECT TO authenticated USING (public.rol_actual() = ANY(ARRAY['admin','secretario','empleado']));

CREATE POLICY turnos_crear ON public.turnos
  FOR INSERT TO authenticated WITH CHECK (public.rol_actual() = ANY(ARRAY['admin','secretario','empleado']));

CREATE POLICY turnos_editar ON public.turnos
  FOR UPDATE TO authenticated
  USING (
    public.rol_actual() = ANY(ARRAY['admin','secretario'])
    OR (public.rol_actual() = 'empleado'
        AND public.empleado_actual() IS NOT NULL
        AND empleado_id = public.empleado_actual())
  )
  WITH CHECK (
    public.rol_actual() = ANY(ARRAY['admin','secretario'])
    OR (public.rol_actual() = 'empleado'
        AND public.empleado_actual() IS NOT NULL
        AND empleado_id = public.empleado_actual())
  );

CREATE POLICY turnos_borrar ON public.turnos
  FOR DELETE TO authenticated USING (
    public.rol_actual() = ANY(ARRAY['admin','secretario'])
    OR (public.rol_actual() = 'empleado'
        AND public.empleado_actual() IS NOT NULL
        AND empleado_id = public.empleado_actual())
  );


ALTER TABLE public.ausencias ENABLE ROW LEVEL SECURITY;

CREATE POLICY ausencias_leer ON public.ausencias
  FOR SELECT TO authenticated USING (public.rol_actual() = ANY(ARRAY['admin','secretario','empleado']));

CREATE POLICY ausencias_crear ON public.ausencias
  FOR INSERT TO authenticated
  WITH CHECK (
    public.rol_actual() = ANY(ARRAY['admin','secretario'])
    OR (public.rol_actual() = 'empleado'
        AND public.empleado_actual() IS NOT NULL
        AND empleado_id = public.empleado_actual())
  );

CREATE POLICY ausencias_editar ON public.ausencias
  FOR UPDATE TO authenticated
  USING (
    public.rol_actual() = ANY(ARRAY['admin','secretario'])
    OR (public.rol_actual() = 'empleado'
        AND public.empleado_actual() IS NOT NULL
        AND empleado_id = public.empleado_actual())
  )
  WITH CHECK (
    public.rol_actual() = ANY(ARRAY['admin','secretario'])
    OR (public.rol_actual() = 'empleado'
        AND public.empleado_actual() IS NOT NULL
        AND empleado_id = public.empleado_actual())
  );

CREATE POLICY ausencias_borrar ON public.ausencias
  FOR DELETE TO authenticated USING (
    public.rol_actual() = ANY(ARRAY['admin','secretario'])
    OR (public.rol_actual() = 'empleado'
        AND public.empleado_actual() IS NOT NULL
        AND empleado_id = public.empleado_actual())
  );


-- ═══ 6. CLIENTES Y TELEFONOS: EL EMPLEADO PUEDE CREAR, NO BORRAR ════════════════
--
-- El usuario confirmo que el empleado puede crear clientes. Lo que NO se le deja es
-- modificar o borrar: la pantalla de clientes (Personas) no la ve el empleado, asi que
-- desde la app no podria hacerlo igual, pero la base tampoco lo tiene que permitir.
--
-- `INSERT` con `WITH CHECK (true)` para los tres: no hay condicion de fila que poner, no
-- hay `empleado_id` en estas tablas.

ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;

CREATE POLICY clientes_leer ON public.clientes
  FOR SELECT TO authenticated USING (public.rol_actual() = ANY(ARRAY['admin','secretario','empleado']));

CREATE POLICY clientes_crear ON public.clientes
  FOR INSERT TO authenticated WITH CHECK (public.rol_actual() = ANY(ARRAY['admin','secretario','empleado']));

CREATE POLICY clientes_editar ON public.clientes
  FOR UPDATE TO authenticated USING (public.rol_actual() = ANY(ARRAY['admin','secretario']))
  WITH CHECK (public.rol_actual() = ANY(ARRAY['admin','secretario']));

CREATE POLICY clientes_borrar ON public.clientes
  FOR DELETE TO authenticated USING (public.rol_actual() = ANY(ARRAY['admin','secretario']));


ALTER TABLE public.telefonos ENABLE ROW LEVEL SECURITY;

CREATE POLICY telefonos_leer ON public.telefonos
  FOR SELECT TO authenticated USING (public.rol_actual() = ANY(ARRAY['admin','secretario','empleado']));

CREATE POLICY telefonos_crear ON public.telefonos
  FOR INSERT TO authenticated WITH CHECK (public.rol_actual() = ANY(ARRAY['admin','secretario','empleado']));

CREATE POLICY telefonos_editar ON public.telefonos
  FOR UPDATE TO authenticated USING (public.rol_actual() = ANY(ARRAY['admin','secretario']))
  WITH CHECK (public.rol_actual() = ANY(ARRAY['admin','secretario']));

CREATE POLICY telefonos_borrar ON public.telefonos
  FOR DELETE TO authenticated USING (public.rol_actual() = ANY(ARRAY['admin','secretario']));


-- ═══ 7. CERRAR LO QUE QUEDARÍA ABIERTO ══════════════════════════════════════════
--
-- Este bloque es la red de seguridad, no parte del permiso.
--
-- Una tabla con RLS apagado es una tabla abierta: da igual que no tenga politicas, la
-- clave publica la lee y la escribe igual. Si mañana alguien agrega una tabla y se
-- olvida de ponerla en la matriz de arriba, sin esto queda abierta en silencio. Con esto,
-- queda cerrada y el `RAISE NOTICE` avisa al correr la migracion.
--
-- `conversaciones` queda fuera de forma explicita: no la usa la app, la usa el bot de
-- n8n, no se sabe con que clave entra y su politica vieja (`service_role_all`, que el
-- bloque 2 respeta) sigue en pie. Es el hueco que queda, anotado en README.md.

DO $$
DECLARE
  t text;
  -- Las que NO se cierran. `conversaciones` esta porque la usa el bot de n8n.
  abiertas text[] := ARRAY['conversaciones'];
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p')
      AND NOT (c.relname = ANY(abiertas))
      AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    RAISE NOTICE '016: %I quedo con RLS activo y sin politica. Nadie la puede leer ni escribir.', t;
  END LOOP;
END $$;


-- ═══ 8. QUE NO SE ROMPA LA REALTIME ═════════════════════════════════════════════
--
-- La app se suscribe a los cambios de `turnos` y `horarios_atencion` con
-- `suscribirTurnos` / `suscribirHorarios`. Realtime revisa las politicas de RLS antes de
-- mandar una fila, asi que las de arriba lo cubren: los tres roles pueden SELECT en esas
-- dos tablas. Si alguna vez se saca el SELECT a alguien, su pantalla deja de
-- actualizarse sola y hay que recargar a mano.
