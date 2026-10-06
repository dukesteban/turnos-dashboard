-- 017 - el correo de acceso, derivado del nombre de usuario, en UN solo lugar
--
-- POR QUE ESTA EN LA BASE Y NO EN LA APP
--
-- La app pide "usuario", no correo, y asi se sigue mostrando. Pero Supabase Auth solo
-- entiende correos, asi que hay que traducir: "Jose Perez" -> "jose-perez@carwash.local".
--
-- Esa traduccion la necesitan DOS que no se hablan: la app (para entrar) y la funcion de
-- borde `admin-usuarios` (para crear el usuario de auth). Si cada una tiene su copia y
-- un dia difieren en un detalle -- un guion, una tilde -- el usuario queda creado con un
-- correo y la app busca con el otro. El sintoma es "dice que la contrasena esta mal"
-- cuando la clave esta perfectamente bien, y no hay forma de ver la causa desde la
-- pantalla.
--
-- Por eso la regla vive aca, en SQL, y los dos la llaman.
--
-- QUE PUEDE HACER CADA UNO
--
-- `anon` la puede llamar: es lo que permite entrar. No es un dato sensible: con el
-- nombre de usuario devuelve el correo, y el nombre de usuario ya lo sabe quien esta
-- escribiendo. Lo que NO se puede con esto es entrar: hace falta la clave.
--
-- Lo que sigue being secreta es la clave, y la verifica Supabase Auth, no esta funcion.

CREATE EXTENSION IF NOT EXISTS unaccent;


CREATE OR REPLACE FUNCTION public.correo_de_usuario(p_usuario text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(
    -- El nombre vacio, o hecho solo de simbolos ("!!!"), no tiene un correo derivable.
    -- 'usuario' es un nombre interno que nunca va a chocar con uno real. Devolver vacio
    -- seria peor: la app armaria "@carwash.local", que es un correo invalido y produce
    -- un error de GoTrue que no dice nada util.
    --
    -- `btrim(x, '-')` y no `trim(both '-' from x)`: las dos son lo mismo en Postgres,
    -- pero la segunda no pasa el parser de la migracion.
    nullif(
      btrim(
        regexp_replace(
          unaccent(lower(coalesce(trim(p_usuario), ''))),
          '[^a-z0-9]+', '-', 'g'
        ),
        '-'
      ),
      ''
    ) || '@carwash.local',
    'usuario@carwash.local'
  );
$$;

COMMENT ON FUNCTION public.correo_de_usuario(text) IS
  'El correo de Supabase Auth que corresponde a un nombre de usuario. Vive en la base para que la app y la funcion de borde admin-usuarios hagan la misma cuenta.';

-- `anon` la necesita para entrar. Es una traduccion, no una consulta: no lee ninguna
-- tabla y no devuelve nada que la persona no sepa ya.
GRANT EXECUTE ON FUNCTION public.correo_de_usuario(text) TO anon, authenticated;

-- PostgREST solo expone las funciones que estan en su cache de esquema. Sin esto, la
-- app la puede llamar por SQL pero no por RPC, que es como la llama.
NOTIFY pgrst, 'reload schema';
