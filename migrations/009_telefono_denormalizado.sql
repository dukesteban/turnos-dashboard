-- 009 — teléfono del cliente: NULL en vez de cadena vacía
--
-- EL PROBLEMA
-- `turnos.cliente_telefono` es un snapshot desnormalizado. La UI lo leía tal
-- cual, con dos consecuencias:
--   1. Si al cliente le cargaban el teléfono DESPUÉS de tomar el turno, la
--      pantalla decía "(Sin teléfono registrado)".
--   2. El WhatsApp de cancelación se mandaba al NÚMERO VIEJO.
--
-- ESTA migración no arregla la UI (eso es `telefonoDe(turno)` en el código,
-- que lee de `telefonos` y solo cae al snapshot como último recurso). Lo que
-- hace es limpiar el estado para que los dos valores posibles sean coherentes.
--
-- EL TRAPO
-- La columna era NOT NULL. Por eso la app mandaba `''` para "sin teléfono", y
-- quedaban TRES estados: NULL / '' / valor. La UI "acertaba" por casualidad,
-- porque en JavaScript '' es falsy. Sacar el NOT NULL hace que NULL sea el
-- "sin teléfono" de verdad y elimina el tercer estado.
--
-- Idempotente.

-- 1) 'Sin teléfono' = NULL
ALTER TABLE turnos ALTER COLUMN cliente_telefono DROP NOT NULL;

UPDATE turnos
SET cliente_telefono = NULL
WHERE cliente_telefono IS NOT NULL AND btrim(cliente_telefono) = '';

COMMENT ON COLUMN turnos.cliente_telefono IS
  'SNAPSHOT del teléfono al tomar el turno. La UI debe leer telefonos (telefonoDe), no este campo. NULL = sin teléfono.';

-- 2) Teléfonos que no son teléfonos.
--    Orden importante: `telefonos.cliente_id` es FK sin ON DELETE, así que hay
--    que borrar los teléfonos ANTES de borrar el cliente duplicado de abajo.
--
--    Solo se borra lo vacío o basura inequívoca. NO se borra lo que parece un
--    nombre escrito en el campo teléfono ('Esteban Aguero', 'Tu número'): eso lo
--    tiene que corregir el usuario con el número real.
DELETE FROM telefonos
WHERE telefono IS NULL
   OR btrim(telefono) = ''
   OR telefono IN ('+0', '0', '-');

-- 3) Cliente duplicado.
--
--    Ojo con esto: este bloque depende de los DATOS, no del schema. Si se corre
--    sobre otra base, los ids son otros y no fusiona nada (o fusiona lo que no
--    es). La forma correcta de fusionar es por NOMBRE, y se hace con la función
--    de la app (`fusionarClientes`), que además reprograma los turnos.
--
--    Acá solo se resuelve el caso concreto que había: dos clientes con el mismo
--    nombre normalizado y SIN turnos, que se pueden borrar sin riesgo.
DELETE FROM clientes duplicado
WHERE NOT EXISTS (SELECT 1 FROM turnos t WHERE t.cliente_id = duplicado.id)
  AND NOT EXISTS (SELECT 1 FROM telefonos f WHERE f.cliente_id = duplicado.id)
  AND EXISTS (
    SELECT 1 FROM clientes keeper
    WHERE keeper.id <> duplicado.id
      AND lower(btrim(keeper.nombre)) = lower(btrim(duplicado.nombre))
      AND keeper.id < duplicado.id     -- se conserva el de id más bajo
  );

-- Verificación:
--   SELECT count(*) FROM turnos WHERE cliente_telefono = '';             -- 0
--   SELECT count(*) FROM telefonos WHERE btrim(telefono) = '';          -- 0
--   SELECT cliente_id, telefono FROM telefonos
--    WHERE length(regexp_replace(telefono,'[^0-9]','','g')) < 7;        -- revisar a mano
