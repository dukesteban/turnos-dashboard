/**
 * Formato y lectura de montos en pesos argentinos.
 *
 * Vive aparte de la directiva a proposito: la directiva necesita un DOM, estas
 * dos funciones no, y asi se pueden probar sin montar un componente.
 */

/** `1234.5` -> `$1.234,50` */
export function formatearMoneda(valor: number | null | undefined): string {
  const n = Number(valor);
  const seguro = Number.isFinite(n) ? n : 0;
  const numero = seguro.toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `$${numero}`;
}

/**
 * Convierte lo que hay escrito en un input a numero.
 *
 * Hay que aceptar las dos formas porque conviven: `1.000,50` (la argentina, con
 * punto de miles y coma decimal) y `1000.50` (la que escribe mucha gente con el
 * teclado numerico). Si se interpreta mal, `1.000,50` se lee como 1,000.50 y el
 * monto queda cien veces mas chico.
 *
 * La regla para el punto solo: `1.000` y `1.000.000` son miles, pero `1000.50`
 * es decimal. Se distingue por la cantidad de digitos despues del ultimo punto.
 */
export function parsearMoneda(texto: string | number | null | undefined): number {
  if (typeof texto === 'number') return Number.isFinite(texto) ? texto : 0;

  let s = (texto || '').replace(/[^\d.,-]/g, '').trim();
  if (!s) return 0;

  if (s.includes(',')) {
    // Con coma, los puntos son separadores de miles: 1.000,50 -> 1000.50
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes('.')) {
    const partes = s.split('.');
    const decimales = partes[partes.length - 1].length;
    // `1.000` o `1.000.000` son miles; `1000.50` es decimal.
    if (partes.length > 2 || decimales === 3) s = s.replace(/\./g, '');
  }

  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/** Lo que se muestra DENTRO del input mientras se edita: sin simbolo, con coma. */
export function monedaParaEditar(valor: number | null | undefined): string {
  const n = Number(valor);
  if (!Number.isFinite(n) || n === 0) return '';
  return String(n).replace('.', ',');
}
