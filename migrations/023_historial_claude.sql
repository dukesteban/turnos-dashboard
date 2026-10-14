-- `conversaciones.historial_claude`: la memoria del bot.
--
-- ─── POR QUÉ ESTA MIGRACIÓN ───
--
-- El `README.md` la listaba entre las "diferencias que quedan entre las dos bases":
-- existe en test y no en ryf, con la nota de no tocarla porque la usaba el bot de
-- n8n en Railway.
--
-- Ese bot ya no está. El agente de WhatsApp ahora es la función de borde
-- `whatsapp-bot`, en este mismo proyecto, y lee y escribe ESTA columna:
--
--   · la lee  para armar el historial que se le pasa al modelo
--   · la escribe con el `upsert` de cada mensaje
--
-- Sin la columna en ryf, `sb.from('conversaciones').select('*')` no la trae, el
-- historial llega siempre vacío, y el bot trata CADA mensaje como el primero de la
-- conversación: se vuelve a presentar, no recuerda lo que se acababa de acordar y
-- pide de nuevo datos que el cliente ya dio. No se veía ningún error en ninguna
-- parte: el `upsert` fallaba, se loggedaba con `console.error` y la conversación
-- seguía como si nada.
--
-- Con `if not exists` es segura en las dos bases: en test la columna ya está y no
-- hace nada.

alter table public.conversaciones
  add column if not exists historial_claude text;

comment on column public.conversaciones.historial_claude is
  'Historial de la conversación en formato de la API de Anthropic, como JSON. Lo escribe y lee la función de borde whatsapp-bot.';

-- ─── Por qué NO se unifica el nombre de la 2ª propuesta ───
--
-- En ryf se llaman `fecha_propuesta_2` / `hora_propuesta_2` y en test
-- `fecha_propuesta2` / `hora_propuesta2`. No se tocan: son de la versión vieja del
-- bot y la app no las mira. Renombrarlas "para dejar parecidas las bases" rompe el
-- bot viejo si alguien todavía lo tiene corriendo en Railway, y no arregla nada.

-- Para diagnostico: si esto devuelve 0 filas, el bot no tiene memoria en esta base.
--
--   select count(*) from conversaciones where historial_claude is not null;