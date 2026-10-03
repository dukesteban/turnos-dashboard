# Migraciones — CarWash Dashboard

Todo el trabajo de **schema** de este proyecto vive acá. Antes estas cambios se
aplicaban directo contra la base por MCP, sin registro: si se restauraba la
base, se perdía todo y nadie sabía qué se había aplicado.

## Cómo se aplican

En orden, del 001 al 010. Todas son **idempotentes**: correrlas dos veces no
rompe nada, así que podés aplicarlas sobre una base ya actualizada.

```bash
# Con psql
psql "$DATABASE_URL" -f migrations/001_empleados_y_comisiones.sql
psql "$DATABASE_URL" -f migrations/002_puestos.sql
# ... y así hasta el 010

# O todas de una, en orden:
for f in migrations/0*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

Desde el MCP de Supabase se corre el contenido del archivo como un solo
`execute_sql`. Cada uno está armado para ir solo.

## Qué hay en cada una

| # | Archivo | Qué hace |
|---|---|---|
| 001 | `empleados_y_comisiones.sql` | Tabla `empleados` + `comisiones_empleado` |
| 002 | `puestos.sql` | Tabla `puestos` (layout físico del lavadero) |
| 003 | `turnos_empleado_y_puesto.sql` | `turnos.empleado_id` + `turnos.puesto_id` |
| 004 | `dias_cerrados_rangos.sql` | `dias_cerrados.fecha_hasta` y saca el `UNIQUE(fecha)` |
| 005 | `empleados_jornada.sql` | `boolean[] dias_trabaja` → `jsonb jornada` con horarios |
| 006 | `turnos_servicio_id_final.sql` | `turnos.servicio_id_final` (el servicio cobrado) |
| 007 | `ausencias.sql` | Tabla `ausencias` (vacaciones, licencias, Illnesses) |
| 008 | `indices_unicos_catalogos.sql` | Evita catálogos duplicados |
| 009 | `telefono_denormalizado.sql` | `NULL` en vez de `''`, fusiona cliente duplicado |
| 010 | `turnos_hora_coincide.sql` | CHECK: `hora` y `hora_inicio` no pueden divergir |
| 011 | `retirar_puestos.sql` | **Borra la tabla `puestos`**: la agenda ya usa columnas por empleado |

### Sobre 002 y 011

Se aplican juntas y se anulan: 002 crea `puestos` y 011 la borra. Se dejaron las
dos para que el historial se lea en orden.

`turnos.puesto_id` **se conserva con sus 74 valores**: es el histórico de en qué
box se lavó cada turno. Perdió su FOREIGN KEY, no sus datos. Para borrar también
la columna hace falta una `012` aparte.

## Bases

| Base | project_ref | Estado |
|---|---|---|
| `test-lavadero` | `ycrhgxwnikksmwyofzmv` | Al día (001–010 aplicados) |
| `lavadero-ryf` | `tvzfsbudhuegsptaokng` |tiene 001–003. Faltan **004–010** |

Para ponerse RYF al día: correr del 004 en adelante. Los tres primeros son
no-ops seguros.

## ⚠️ No cubre las tablas heredadas

Estas migraciones documentan **lo que se agregó/modificó desde que existe el
repositorio**. Las tablas base (`clientes`, `telefonos`, `servicios`,
`metodos_pago`, `horarios_atencion`, `dias_cerrados`, `configuracion`,
`usuarios`, `turnos`) se crearon antes y no hay registro de su DDL original.

Para una base **vacía** no alcanza: falta el DDL de las heredadas. Si hacés
falta, se puede generar con `pg_dump --schema-only` sobre `test-lavadero`.
