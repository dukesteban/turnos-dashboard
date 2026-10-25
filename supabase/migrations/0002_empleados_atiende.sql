-- ============================================================
-- empleados.atiende
-- ------------------------------------------------------------
-- Separa "trabaja en el local" de "toma turnos".
--
-- Un secretario o un administrativo sigue siendo un empleado (aparece en
-- Personas > Empleados y cobra en Caja), pero no tiene que ofrecerse como
-- opción en la Agenda, en los selectores de turno ni en el bot de WhatsApp.
--
-- Por defecto true: todos los empleados que ya existían siguen atendiendo
-- exactamente como antes. Se apaga desde Personas > Empleados > Permisos.
-- ============================================================

ALTER TABLE public.empleados
  ADD COLUMN IF NOT EXISTS atiende boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.empleados.atiende IS
  'Si atiende turnos: aparece en Agenda, en los selectores de turno y en las opciones del bot. Los que no atienden (ej. secretarios) quedan fuera de esas listas.';
