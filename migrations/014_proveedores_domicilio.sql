-- 014 - proveedores: domicilio
--
-- MOTIVACIÓN
--
-- `proveedores` tenía nombre, contacto, teléfono y notas. Faltaba lo único que
-- sirve cuando hay que ir: DÓNDE está. "Ledesma SA" con un teléfono no alcanza
-- para llegar; con la dirección sí.
--
-- POR QUÉ UNA COLUMNA NUEVA Y NO DENTRO DE `notas`
--
-- `notas` es texto libre y ya existe: técnicamente se podría escribir la
-- dirección ahí. Es un error de modelado, no una comodidad: un campo que se
-- puede buscar, ordenar o mostrar en un mapa tiene que ser un campo. Con la
-- dirección en `notas` no se puede filtrar "los que son de Córdoba" sin un
-- `ILIKE '%Córdoba%'` sobre texto escrito por una persona, con acentos y abreviaturas
-- distintos cada vez.
--
-- TIPO
--
-- `text` y no una tabla de direcciones con una fila por proveedor: un proveedor
-- tiene UN domicilio en este negocio. Si mañana tiene dos, se agrega la tabla
-- después; mientras tanto una columna evita el JOIN en la pantalla de Caja, que
-- es donde se lee.
--
-- NULLABLE
--
-- Los proveedores que ya están cargados no tienen domicilio y no se les inventa
-- uno. `ADD COLUMN` sin `NOT NULL` los deja en `NULL` y la app muestra "—", que
-- es la señal correcta de "no lo sé".

ALTER TABLE proveedores
  ADD COLUMN IF NOT EXISTS domicilio text;

COMMENT ON COLUMN proveedores.domicilio IS
  'Dirección del proveedor. NULL = no lo sabemos: la app muestra "—" en vez de un hueco vacío.';

-- Verificación: la app lee `domicilio` en el detalle del proveedor y lo manda en
-- `crearProveedor` / `actualizarProveedor`. Si esta consulta devuelve 0 filas con
-- la columna presente, la migración corrió bien.
