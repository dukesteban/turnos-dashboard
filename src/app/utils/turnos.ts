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
/**
 * Confirmación antes de volver un turno atendido a pendiente.
 *
 * ─── POR QUÉ ESTA EN UN ARCHIVO APARTE ───
 *
 * El botón "Volver a Pendiente" está en DOS lugares: el popup de la Agenda y el del
 * Dashboard. `volverAPendiente()` borra metodo_pago, precio_final, observaciones,
 * servicio_nombre_final y servicio_id_final, y eso no se recupera. Antes los dos lo
 * llamaban con un clic y sin preguntar nada.
 *
 * Escribido dos veces, pasa lo de siempre: un día se arregla en la Agenda y el
 * Dashboard sigue sin preguntar. Es lo mismo que pasó con el buscador de Personas,
 * duplicado en tres pestañas y una quedó distinta. Acá la diferencia es BORRAR
 * DATOS, así que la duplicación sale más cara.
 *
 * ─── POR QUÉ SOLO PREGUNTA SI ESTABA ATENDIDO ───
 *
 * Volver a pendiente desde 'cancelado' no borra nada: ese turno nunca tuvo datos de
 * atención. Ahí una pregunta de más es ruido, y enseña a ignorar el cartel.
 *
 * ─── POR QUÉ DICE QUÉ SE PIERDE ───
 *
 * Un "¿Estás seguro?" a secas no sirve: el que lo aprieta está atendiendo de a un
 * turno y no sabe que hay un precio final guardado. El cartel nombra las cosas
 * concretas para que la decisión sea informada.
 */
export function confirmarVolverAPendiente(turno: any): boolean {
  if (!turno || turno.estado !== 'atendido') return true;

  const sePierde: string[] = [];
  if (turno.servicio_nombre_final) {
    sePierde.push(`el servicio atendido (${turno.servicio_nombre_final})`);
  }
  if (turno.precio_final != null && turno.precio_final !== '') {
    sePierde.push('el precio final');
  }
  if (turno.metodo_pago) {
    sePierde.push(`la forma de pago (${turno.metodo_pago})`);
  }
  if (turno.observaciones) {
    sePierde.push('las observaciones');
  }

  const lista = sePierde.length ? sePierde.join(', ') : 'los datos de la atención';
  const extra = sePierde.length
    ? ''
    : '\n\nEste turno figure como atendido pero sin datos cargados, así que solo se ' +
      'borra la marca de atendido.';

  return confirm(
    `Si volvés el turno a pendiente se borra ${lista}, y eso no se puede deshacer.` +
    extra +
    '\n\n¿Seguro que querés hacerlo?'
  );
}