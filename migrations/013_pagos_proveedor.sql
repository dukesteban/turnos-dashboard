-- 013 — pagos a proveedores (con parcialidades)
--
-- MOTIVACIÓN
-- La caja mostraba "Compras a proveedores −$12.000" usando el total de
-- `compras_proveedor`. Eso mezcla dos cosas distintas:
--
--   · lo que se COMPRÓ   (una compra es un gasto, no necesariamente un pago)
--   · lo que se PAGÓ     (lo que de verdad salió de la cuenta)
--
-- El usuario leyó "−$12.000" como "debo 12.000", y tiene razón: si compraste
-- algo y todavía no lo pagaste, no debés nada. El número que sale de la cuenta
-- es el que se pagó, no el que se compró.
--
-- POR QUÉ UNA TABLA NUEVA Y NO UNA COLUMNA "PAGADA" EN `compras_proveedor`
-- Porque a los proveedores se les paga por partes: comprás 100.000 el lunes,
-- abonás 40.000 y 60.000 después. Con una columna booleana `pagada` una
-- compra queda pagada o impagada, y no hay forma de registrar el abono
-- intermedio ni de saber cuánto falta.
--
-- `pagos_proveedor` es un LIBRO DE ABONOS: varios pagos por compra, del mismo
-- proveedor o de compras distintas. El saldo por proveedor se calcula
-- comparando el total pagado contra el total comprado.
--
-- DECISIÓN: MONTOS EN LA TABLA, NO PORCENTAJES
-- Igual que en `pagos_empleado`: `monto` es el número que se dio. Guardar el %
-- y recalcular sobre el precio del insumo haría que un abono quedara viejo.
--
-- `compra_id` es opcional a propósito: se puede pagar a un proveedor por
-- compras que ya se vencieron, o saldar una deuda de meses anteriores sin
-- que haya una compra del período que la referencie. Con `NOT NULL` esa
-- situación, que es la más común al cierre de mes, no se podría registrar.
--
-- RLS: sin esto PostgREST no devuelve NADA. Es el error más común al crear una
-- tabla.
--
-- Idempotente.

-- ── PAGOS A PROVEEDORES ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS pagos_proveedor (
  id            serial PRIMARY KEY,
  proveedor_id  integer NOT NULL REFERENCES proveedores(id) ON DELETE CASCADE,
  fecha         date    NOT NULL,
  monto         numeric(12,2) NOT NULL CHECK (monto > 0),
  -- A qué compra se le imputa este abono, si se sabe. NULL = pago a cuenta, o
  -- saldo de una compra vieja que no está en la base.
  compra_id     integer REFERENCES compras_proveedor(id) ON DELETE SET NULL,
  -- Texto suelto y no FK, por el mismo motivo que en `pagos_empleado`: el
  -- método con el que se le paga a un proveedor (transferencia) no es
  -- necesariamente el mismo que se acepta en el mostrador.
  metodo        text    NOT NULL DEFAULT 'transferencia',
  notas         text,
  created_at    timestamptz DEFAULT now()
);

COMMENT ON TABLE  pagos_proveedor              IS 'Abonos REALES a proveedores. Varios por compra: a los proveedores se les paga por partes.';
COMMENT ON COLUMN pagos_proveedor.monto         IS 'Cuánto se abonó, en la moneda del negocio. Guardar el monto y no un porcentaje para que cambiar el precio de un insumo no altere un abono ya hecho.';
COMMENT ON COLUMN pagos_proveedor.compra_id     IS 'Compra a la que se imputa el abono. NULL = pago a cuenta o saldo de una compra vieja.';
COMMENT ON COLUMN pagos_proveedor.metodo        IS 'efectivo | transferencia | otro. Texto y no FK a proposito.';

-- La consulta de la caja: "qué se pagó a proveedores en este período".
CREATE INDEX IF NOT EXISTS pagos_proveedor_fecha
  ON pagos_proveedor (fecha);

-- Y "cuánto se le pagó a ESTE proveedor", que es el saldo por proveedor.
CREATE INDEX IF NOT EXISTS pagos_proveedor_prov_fecha
  ON pagos_proveedor (proveedor_id, fecha);

-- Un proveedor no puede tener dos abonos con el mismo importe el mismo día sin
-- querer: es casi siempre un doble clic. No es UNIQUE porque dos abonos
-- iguales el mismo día pueden ser legítimos (dos transferencias de 5.000).
-- Por eso NO lleva índice único: la garantía la da el formulario, que avisa
-- cuando el abono supera lo pendiente del proveedor.

ALTER TABLE pagos_proveedor ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pagos_proveedor_all ON pagos_proveedor;
CREATE POLICY pagos_proveedor_all ON pagos_proveedor FOR ALL TO public USING (true) WITH CHECK (true);
