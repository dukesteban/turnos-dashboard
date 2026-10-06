/**
 * El filtro de turnos por empleado.
 *
 * Vive en un archivo propio y no como metodo de `AuthService` porque NO depende del
 * rol: es una pregunta sobre dos listas de datos. `AuthService` responde "que puede
 * ver este usuario"; esto responde "de estos turnos, cuales le corresponden".
 *
 * Y separarlos hace que la funcion sea testeable sin armar una sesion en
 * `localStorage`, que es lo que habia que hacer si estuviera metida en el servicio.
 */

/**
 * Deja solo los turnos de UN empleado.
 *
 * `empleadoId === null` significa "este usuario ve todos los turnos" y devuelve la
 * lista entera. Es el caso del admin, del secretario, y tambien del rol empleado sin
 * `empleado_id` vinculado: ese usuario ve todos en vez de ver una agenda vacia sin
 * entender por que. La pantalla de Usuarios marca a quien falta vincular.
 *
 * POR QUE `Number()` EN LOS DOS LADOS
 *
 * `empleado_id` viene de la base como entero y del `localStorage` como lo que paso por
 * `JSON.parse`. Un `===` entre `1` y `"1"` da falso, y el síntoma es una agenda vacia
 * sin ningun error en ninguna parte: no hay excepcion, no hay log, solo que "no hay
 * turnos".
 */
export function soloLosTurnosDe(turnos: any[], empleadoId: number | null): any[] {
  if (empleadoId === null || empleadoId === undefined) return turnos || [];
  return (turnos || []).filter((t: any) => Number(t.empleado_id) === Number(empleadoId));
}

/**
 * Lo mismo, pero para las columnas de la Agenda.
 *
 * La agenda tiene una columna por empleado, y el rol empleado tiene que ver SOLO la
 * suya. Sin esto, veria una grilla con los turnos de los demas en columnas ajenas y su
 * propio nombre arriba de una columna entre otras.
 *
 * Ojo con el filtro por `activo`: `soloLosTurnosDe` no lo hace. Un empleado inactivo
 * con su columna vieja abierta tiene que poder verla para entender por que no le
 * cargan turnos; la agenda lo baja con su propio `debeMostrarColumna`.
 */
export function soloLasColumnasDe(columnas: any[], empleadoId: number | null): any[] {
  if (empleadoId === null || empleadoId === undefined) return columnas || [];
  return (columnas || []).filter((c: any) => Number(c?.empleado?.id) === Number(empleadoId));
}