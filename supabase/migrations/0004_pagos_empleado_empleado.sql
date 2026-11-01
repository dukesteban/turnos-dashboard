-- ============================================================
-- pagos_empleado: el empleado puede leer SUS PROPIOS pagos
-- ------------------------------------------------------------
-- "Mi caja" (/caja-empleado) muestra dos cosas: los turnos que
-- atendió y los pagos que le hicieron. Los turnos ya los puede
-- leer (la política de `turnos` deja pasar al rol empleado y el
-- filtro por persona se hace en el cliente). Los pagos NO:
-- `pagos_empleado_leer` solo permite admin y secretario, así que
-- la consulta le volvía vacía y la pantalla mostraba "no te
-- registraron ningún pago" aunque sí le hubieran pagado.
--
-- Se agrega una política SOLO de lectura y SOLO para sus filas.
-- No se toca la de escritura: el empleado no registra pagos, y
-- ampliarla sería abrir la caja desde la pantalla de él.
--
-- `empleado_id = public.empleado_actual()` y no una comparación
-- contra el nombre ni contra un id que mande el cliente: el id
-- sale del JWT (`app_metadata.empleado_id`), que el usuario no
-- puede editar desde la app.
-- ============================================================

CREATE POLICY pagos_empleado_leer_propios ON public.pagos_empleado
  FOR SELECT TO authenticated
  USING (
    public.rol_actual() = 'empleado'
    AND empleado_id = public.empleado_actual()
  );
