-- 012 — caja: pagos a empleados, proveedores y compras
--
-- MOTIVACIÓN
-- Ganancias solo miraba los INGRESOS. Para cerrar el mes hace falta saber
-- cuánto entró y cuánto salió. Esta migración agrega las dos salidas:
--   · `pagos_empleado`  lo que se le pagó DE VERDAD a cada empleado
--   · `proveedores`      de quién se compra
--   · `compras_proveedor` cada compra concreta
--
-- POR QUÉ `pagos_empleado` Y NO USAR EL PORCENTAJE DIRECTAMENTE
-- El porcentaje de comisión (`empleados.comision_porcentaje` +
-- `comisiones_empleado`) es un CÁLCULO: dice cuánto *debería* cobrar el empleado
-- según los turnos atendidos. El pago real casi nunca coincide exacto, porque:
--   · se le pagan quincenas y no por turno
--   · se le adelanta dinero y se descuenta después
--   · se le paga un extra o se le retiene algo
-- Por eso la caja guarda el pago real y muestra la diferencia contra el
-- cálculo. `calcularComisiones()` sigue siendo la fuente del "sugerido".
--
-- DECISIÓN: MONTOS EN LA TABLA, NO UN PORCENTAJE
-- `pagos_empleado.monto` es el número que se le dio. Guardar el % y recalcular
-- sobre el precio del servicio haría que un pago quedara viejo, o se desactualice
-- solo si cambia el precio de un turno viejo.
--
-- `compras_proveedor` guarda `monto` y `cantidad` por separado, y no un precio
-- unitario: lo que importa para la caja es cuánto se fue, no cuánto cuesta el
-- producto. El precio actual del insumo es información del proveedor, no del
-- gasto.
--
-- RLS: sin esto PostgREST no devuelve NADA. Es el error más común al crear una
-- tabla y por eso está repetido en las 3 de acá.
--
-- Idempotente.

-- ── PAGOS A EMPLEADOS ────────────────────────────────────────
-- Un registro por pago. Varios pagos el mismo día están permitidos a propósito:
-- un empleado puede cobrar la quincena y un extra en la misma fecha.
CREATE TABLE IF NOT EXISTS pagos_empleado (
  id          serial PRIMARY KEY,
  empleado_id integer NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  fecha       date    NOT NULL,
  monto       numeric(12,2) NOT NULL CHECK (monto > 0),
  -- Texto suelto y no FK: el método de pago real es distinto al de los turnos
  -- (aquí puede ser "transferencia" aunque en el mostrador solo acepten
  -- efectivo). Meter FK obligaría a crear métodos de pago de laboratorio.
  metodo      text    NOT NULL DEFAULT 'efectivo',
  notas       text,
  created_at  timestamptz DEFAULT now()
);

COMMENT ON TABLE  pagos_empleado             IS 'Pagos REALES a empleados. La caja los compara contra el cálculo de comisiones para mostrar la diferencia.';
COMMENT ON COLUMN pagos_empleado.monto       IS 'Cuánto se le dio, en la moneda del negocio. Guardar el monto y no el % para que cambiar el precio de un turno viejo no altere un pago ya hecho.';
COMMENT ON COLUMN pagos_empleado.metodo      IS 'efectivo | transferencia | otro. Texto y no FK a proposito.';

-- La consulta de la caja: "qué se pagó en este período".
CREATE INDEX IF NOT EXISTS pagos_empleado_fecha
  ON pagos_empleado (fecha);

-- Y "cuánto se le pagó a ESTE empleado", que es la vista por empleado.
CREATE INDEX IF NOT EXISTS pagos_empleado_emp_fecha
  ON pagos_empleado (empleado_id, fecha);

ALTER TABLE pagos_empleado ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pagos_empleado_all ON pagos_empleado;
CREATE POLICY pagos_empleado_all ON pagos_empleado FOR ALL TO public USING (true) WITH CHECK (true);

-- ── PROVEEDORES ─────────────────────────────────────────────
-- Modelo calcado de `clientes`: nombre único, datos de contacto, se puede
-- inactivar sin borrar (para no perder el historial de compras).
CREATE TABLE IF NOT EXISTS proveedores (
  id         serial PRIMARY KEY,
  nombre     text NOT NULL,
  contacto   text,
  telefono   text,
  notas      text,
  activo     boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

COMMENT ON TABLE proveedores IS 'De quién se compra (quitectos, mayoristas, etc). Modelo igual a clientes: inactivar, no borrar.';

-- Nombre único, ignorando mayúsculas y espacios sobrantes, como en servicios.
-- Es el índice UNIQUE que hace que "Ledesma" y " ledesma  " no se puedan
-- guardar dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS proveedores_nombre_unico
  ON proveedores (lower(btrim(nombre)));

CREATE INDEX IF NOT EXISTS proveedores_activo ON proveedores (activo);

ALTER TABLE proveedores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS proveedores_all ON proveedores;
CREATE POLICY proveedores_all ON proveedores FOR ALL TO public USING (true) WITH CHECK (true);

-- ── COMPRAS A PROVEEDORES ────────────────────────────────────
-- Cada compra concreta. `concepto` es texto libre ("12 bidones de shampoo") en
-- vez de una FK a un catálogo de insumos: para cerrar la caja alcanza con saber
-- cuánto se gastó y con quién. Armar un catálogo de insumos con stock es otro
-- proyecto.
CREATE TABLE IF NOT EXISTS compras_proveedor (
  id            serial PRIMARY KEY,
  proveedor_id  integer NOT NULL REFERENCES proveedores(id) ON DELETE CASCADE,
  fecha         date    NOT NULL,
  concepto      text    NOT NULL,
  cantidad      numeric(10,2) NOT NULL DEFAULT 1 CHECK (cantidad > 0),
  -- Se guarda el TOTAL de la compra, no el precio unitario. Si el proveedor
  -- cambiara el precio del mismo producto, los gastos viejos no se tocan.
  monto         numeric(12,2) NOT NULL CHECK (monto > 0),
  notas         text,
  created_at    timestamptz DEFAULT now()
);

COMMENT ON TABLE  compras_proveedor          IS 'Compras concretas a proveedores (insumos, repuestos, servicios). El total de cada compra.';
COMMENT ON COLUMN compras_proveedor.concepto IS 'Descripción libre: "12 bidones de shampoo". No es FK a un catálogo de insumos: no hay control de stock.';
COMMENT ON COLUMN compras_proveedor.monto    IS 'TOTAL de la compra, no el precio unitario.';

CREATE INDEX IF NOT EXISTS compras_proveedor_fecha
  ON compras_proveedor (fecha);

-- Una fila por proveedor ya se lee bien sin esto, pero el resumen por proveedor
-- del período es la consulta más frecuente de la pantalla.
CREATE INDEX IF NOT EXISTS compras_proveedor_prov_fecha
  ON compras_proveedor (proveedor_id, fecha);

ALTER TABLE compras_proveedor ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS compras_proveedor_all ON compras_proveedor;
CREATE POLICY compras_proveedor_all ON compras_proveedor FOR ALL TO public USING (true) WITH CHECK (true);
