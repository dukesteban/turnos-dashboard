# Estado de las migraciones en cada base

Dos bases, y **no están en el mismo punto**. Esto está escrito porque las
migraciones del repo son las de `test-lavadero` y dos de ellas no se pueden correr
tal cual contra `ryf-lavadero`.

| base | ref | para qué |
|---|---|---|
| `turnos-test` | `ycrhgxwnikksmwyofzmv` | donde se prueba. La usan la app en Vercel y el bot de n8n |
| `ryf-lavadero` | `tvzfsbudhuegsptaokng` | la de producción. Es la que tiene los datos |

Dos apps, cada una con su base:

| URL | ramas | base |
|-----|-------|------|
| `carwash-dashboard-mu.vercel.app` | `main` | `turnos-test` (`ycrhgxwnikksmwyofzmv`) |
| `turnos-ryf.vercel.app` | `ryf` | `ryf-lavadero` (`tvzfsbudhuegsptaokng`) |

Las dos quedaron al día con las mismas migraciones y la misma versión de la app.

---

## Qué se aplicó en ryf, y cuándo

El 6 de octubre de 2026, con el Management API. ryf estaba VACÍA: 0 clientes, 0
empleados, 0 servicios, 0 turnos, 0 teléfonos. Lo único que tenía eran 4 métodos de
pago, 11 horarios de atención, 6 filas de `configuracion`, 1 usuario y 1
conversación.

| migración | en ryf | nota |
|---|---|---|
| 004 `dias_cerrados_rangos` | tal cual | no-op: `fecha_hasta` ya estaba |
| 005 `empleados_jornada` | tal cual | agregó `jornada`; dropeó `dias_trabaja` (0 filas, la app no la usa) |
| 006 `turnos_servicio_id_final` | tal cual | |
| 007 `ausencias` | tal cual | |
| 008 `indices_unicos_catalogos` | **ADAPTADA** | ver abajo |
| 009 `telefono_denormalizado` | tal cual | no-op: 0 filas que limpiar |
| 010 `turnos_hora_coincide` | tal cual | |
| 011 `retirar_puestos` | **NO SE APLICÓ** | ver abajo |
| 012 `caja` | tal cual | creó `pagos_empleado`, `proveedores`, `compras_proveedor` |
| 013 `pagos_proveedor` | tal cual | creó `pagos_proveedor` |
| 014 `proveedores_domicilio` | tal cual | |
| 015 `usuarios_roles` | tal cual | `usuarios.rol` + `empleado_id` |
| 016 `rls_por_rol` | tal cual | las 17 politicas pasan a usar el rol del JWT de Supabase Auth |
| 017 `correo_de_usuario` | tal cual | `public.correo_de_usuario()` para el login |

Las 17 se corrieron una sola vez en cada base. Son idempotentes (`IF NOT EXISTS`,
`CREATE TABLE IF NOT EXISTS`, `DROP ... IF EXISTS`), así que volver a correrlas no
rompe nada, **salvo la 008 y la 011**.

---

## Por qué la 008 está adaptada

Crea cinco índices únicos. Uno de ellos es sobre la tabla `puestos`:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS puestos_nombre_unico
  ON puestos (lower(btrim(nombre)));
```

En ryf **no existe la tabla `puestos`**. Nunca existió: ryf no pasó por la
migración `002_puestos`. En test sí existió, y la 011 la borró.

`CREATE INDEX` no tiene forma de decir "si la tabla está, crealo". Con la tabla
ausente la sentencia falla entera y **no se crea ninguno de los cinco índices**,
ni siquiera los cuatro que sí corresponden.

Por eso en ryf se corrieron los cuatro que aplican:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS clientes_nombre_unico     ON clientes (lower(btrim(nombre)));
CREATE UNIQUE INDEX IF NOT EXISTS servicios_nombre_unico    ON servicios (lower(btrim(nombre))) WHERE nombre IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS metodos_pago_nombre_unico ON metodos_pago (lower(btrim(nombre)));
CREATE UNIQUE INDEX IF NOT EXISTS empleados_nombre_unico    ON empleados (lower(btrim(nombre)));
```

**Si alguna vez se crea la tabla `puestos` en ryf**, hay que correr ese quinto
índice a mano.

## Por qué la 011 no se aplicó

La 011 sirve para deshacer lo que hizo la 002: romper el FK de `turnos.puesto_id`,
documentar la columna como histórica y dropear la tabla `puestos`. En ryf no hay
nada que deshacer.

Si se corriera igual, fallaría en la línea 2, porque hace
`COMMENT ON COLUMN turnos.puesto_id` y esa columna **tampoco existe en ryf**
(`turnos.puesto_id` es una de las diferencias entre las dos bases).

---

## Diferencias que quedan entre las dos bases

Ninguna la arregla una migración del repo: no son de este proyecto.

### `conversaciones`

| | ryf | test |
|---|---|---|
| 2ª propuesta de fecha | `fecha_propuesta_2` | `fecha_propuesta2` |
| 2ª propuesta de hora | `hora_propuesta_2` | `hora_propuesta2` |
| historial del bot | no existe | `historial_claude` |

**La app no toca ninguna de estas columnas** (verificado: no aparecen en ningún
`.ts` ni `.html`). Las usa el bot de n8n en Railway. **No las toques sin avisarle
al que mantiene el bot**, porque el bot y ryf pueden estar esperando la una o la
otra.

### `telefonos`

Le falta `created_at` y el índice único `telefonos_telefono_key` sobre
`telefono`. Los dos son de la creación inicial de la base, no de una migración.
El índice único está en el backlog del proyecto.

### `metodos_pago`

Le falta la policy `service_role_all` vieja. Quedó reemplazada por las de la 016 el
6/10/2026. Dato: la 016 la borra y crea la nueva. No es algo que falte.

### Cosas que NO se tocaron a propósito

- **Los 11 horarios de atención de ryf.** Hay solo 2 horarios distintos
  (08:00–12:00 y 14:00–20:00) repetidos 5 veces cada uno. Ninguna migración los
  toca y la app funciona con los 11. Decisión del dueño: dejarlo así.
- **`empleados.jornada` no tiene DEFAULT.** La app siempre manda la jornada al
  crear un empleado (`empleados.ts`), así que en el uso normal nunca queda NULL.
  Pero un `INSERT` a pelo en SQL (un script, un `psql`) sí la deja en NULL, y un
  empleado sin `jornada` no puede trabajar ningún día. Si alguna vez molesta, el
  arreglo es un DEFAULT con la misma forma que usa `jornadaVaciaPorDefecto()` en
  la app.

---

## Cómo se aplicaron (para reproducir)

Management API, con el token de la cuenta:

```
POST https://api.supabase.com/v1/projects/{ref}/database/query
Authorization: Bearer <access token>
Content-Type: application/json

{ "query": "<el SQL>" }
```

Cada migración se mandó por separado y se verificó el resultado antes de seguir
con la siguiente. Al final se corrió un smoke test de las cinco tablas nuevas
dentro de un `BEGIN ... ROLLBACK`: insertar un empleado, un pago, un proveedor, una
compra, un abono y una ausencia, y comprobar que los tres CHECK/FK rechazar lo que
deben (monto negativo, rango de fechas invertido, empleado inexistente).