-- 026: ultimos errores del bot, visibles sin logs de la plataforma
--
-- POR QUE
--
-- Cuando el bot falla, le manda al cliente "se me cayó la conexión", y el que
-- atiende en el local no tiene forma de saber la diferencia entre:
--
--   · Claude se cayó un segundo (no pasa nada)
--   · la API key venció (hay que ir a buscarla)
--   · se le acabaron los tokens (hay que esperar o cambiar de plan)
--   · un bug en el código (hay que arreglarlo)
--
-- Son cuatro problemas distintos y ninguno de los cuatro se arregla igual.
--
-- El error tecnico va a `console.error`, que esta bien para quien tiene el
-- dashboard de Supabase abierto con logs en vivo. El dueño del local no tiene
-- eso. Y cuando algo falla a las 3 de la mañana, el unico sintoma que le llega
-- es un cliente despues diciendo "no me contesta".
--
-- Que una falla se guarde sola, con el mensaje crudo de la API, y se pueda
-- leer desde el panel o con una consulta. Es la diferencia entre "se cayo la
-- conexion" y "Claude 429: rate_limit_error".
--
-- La columna es nullable y no se limpia sola: guarda el ULTIMO error. Cuando el
-- bot vuelve a funcionar bien se escribe NULL, asi que si hay algo escrito es
-- que fallo de verdad y no quedó viejo.

alter table conversaciones add column if not exists ultimo_error text;

comment on column conversaciones.ultimo_error is
  'Ultimo error tecnico del bot para este telefono. Se borra (NULL) en el primer mensaje que responde bien.';