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