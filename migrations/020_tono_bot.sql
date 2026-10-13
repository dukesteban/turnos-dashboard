-- Tono con el que habla el bot de WhatsApp. Vive en la base y no en el codigo de
-- la funcion de borde a proposito: cambiarle la voz al bot es una decision del
-- negocio, no del software, y no deberia pedir un deploy.
insert into public.configuracion (clave, valor)
values ('tono', 'informal')
on conflict (clave) do nothing;