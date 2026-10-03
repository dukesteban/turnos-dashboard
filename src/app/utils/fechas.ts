export const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

/**
 * Nombre del mes en español.
 * @param indice 0-11, igual que Date.getMonth()
 * @param anio si se pasa, se agrega al final ("Octubre 2026")
 */
export function nombreMes(indice: number, anio?: number): string {
  const nombre = MESES[indice];
  if (!nombre) return '';
  return anio != null ? `${nombre} ${anio}` : nombre;
}

// ── DISPONIBILIDAD DEL EMPLEADO ────────────────────────────────────────
// Dos capas, igual que el negocio (horarios + dias_cerrados):
//   1) jornada:  que dias/sostrabaja normalmente  (patron recurrente)
//   2) ausencias: fechas puntuales donde NO esta   (excepcion)

export const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export interface SlotJornada {
  activo: boolean;
  hora_inicio: string | null;
  hora_fin: string | null;
}

/** '08:00:00' | '08:00' -> minutos desde medianoche */
export function aMinutos(hora: string): number {
  const [h, m] = (hora || '').split(':');
  return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0);
}

/** Dia de la semana 0=domingo (mismo criterio que Date.getDay) */
export function dowDe(fecha: string): number {
  return new Date(`${fecha}T12:00:00`).getDay();
}

/**
 * Normaliza la jornada a SIEMPRE 7 slots (0=domingo).
 * Acepta el formato nuevo (jsonb) y el viejo (boolean[]) para que una fila
 * a medio migrar no rompa.
 */
export function normalizarJornada(j: any): SlotJornada[] {
  const libre = (): SlotJornada => ({ activo: false, hora_inicio: null, hora_fin: null });
  if (!Array.isArray(j)) return [libre(), libre(), libre(), libre(), libre(), libre(), libre()];
  return Array.from({ length: 7 }, (_, i) => {
    const s = j[i];
    if (s == null) return libre();
    if (typeof s === 'boolean') return { activo: s, hora_inicio: null, hora_fin: null };
    return {
      activo: s.activo === true || s.activo === 'true',
      hora_inicio: s.hora_inicio || null,
      hora_fin: s.hora_fin || null,
    };
  });
}

/**
 * Capa 1: la jornada semanal del empleado cubre este turno?
 * Devuelve el motivo del rechazo para poder mostrarlo en la UI.
 */
export function jornadaCubre(
  jornada: any, fecha: string, horaInicio: string, duracionMin: number
): { ok: boolean; motivo?: string } {
  const slot = normalizarJornada(jornada)[dowDe(fecha)];
  if (!slot.activo) return { ok: false, motivo: 'No trabaja ese día' };

  // Con tope horario: el servicio tiene que ENTRAR completo, no solo empezar.
  if (slot.hora_fin) {
    const ini = aMinutos(horaInicio);
    const fin = ini + (duracionMin || 45);
    if (fin > aMinutos(slot.hora_fin)) {
      const hasta = slot.hora_fin.slice(0, 5);
      return { ok: false, motivo: `Ese día sale a las ${hasta}` };
    }
  }
  return { ok: true };
}

/**
 * Capa 2: alguna ausencia tapa este turno?
 * Sin hora_inicio/hora_fin la ausencia tapa el dia entero.
 */
export function turnoTocadoPorAusencia(
  ausencias: any[], fecha: string, horaInicio: string, duracionMin: number
): any | null {
  if (!ausencias?.length) return null;
  const ini = aMinutos(horaInicio);
  const fin = ini + (duracionMin || 45);

  return ausencias.find((a: any) => {
    if (!a || a.empleado_id == null) return false;
    const desde = a.desde;
    const hasta = a.hasta || a.desde;
    if (fecha < desde || fecha > hasta) return false;
    if (!a.hora_inicio && !a.hora_fin) return true;          // dia completo
    return ini < aMinutos(a.hora_fin) && fin > aMinutos(a.hora_inicio);   // solapa
  }) || null;
}

/** Texto legible de una ausencia, para badges y mensajes. */
export function textoAusencia(a: any): string {
  if (!a) return '';
  if (a.tipo === 'medio_jornada') {
    return `Sale a las ${(a.hora_fin || '').slice(0, 5)}`;
  }
  const hasta = a.hasta && a.hasta !== a.desde ? ` al ${a.hasta.slice(8, 10)}/${a.hasta.slice(5, 7)}` : '';
  return `${a.tipo === 'vacaciones' ? 'Vacaciones' : a.tipo === 'baja' ? 'Baja' : 'Ausente'}${hasta}`;
}

/** Datos que decide si un empleado tiene columna en la agenda de una fecha. */
export interface EstadoColumna {
  activo: boolean;
  trabaja: boolean;
  tieneAusencia: boolean;
  tieneTurnosEnRiesgo: boolean;
}

/**
 * ¿Tiene columna este empleado en la agenda?
 *
 * Regla de la agenda con columnas por empleado. Sale TRUE si:
 *   - esta ACTIVO, y ademas
 *   - trabaja ese dia (jornada), O
 *   - tiene una ausencia ese dia (se ve rayada), O
 *   - tiene turnos EN RIESGO ese dia (se ve marcada para resolverlos)
 *
 * La tercera clausula es la que no se puede sacar: sin ella, un turno que quedo
 * fuera de la jornada (al cambiarle los dias, o al cargarle una ausencia
 * encima) desapareceria de la agenda y no habria forma de verlo para
 * reprogramarlo. Los dias normales siguen mostrando solo a quien labra.
 *
 * Lo unico que nunca da columna es un empleado INACTIVO.
 */
export function debeMostrarColumna(e: EstadoColumna): boolean {
  if (!e.activo) return false;
  return e.trabaja || e.tieneAusencia || e.tieneTurnosEnRiesgo;
}