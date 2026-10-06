/**
 * Validación de teléfonos.
 *
 * Existe porque se han guardado NOMBRES en el campo teléfono: "Esteban Aguero",
 * "Tu número". El problema no era visible: la app cree que el cliente tiene
 * teléfono (no muestra el "(Sin teléfono registrado)" en rojo) y el WhatsApp de
 * cancelación se manda a un nombre en vez de a un número.
 *
 * Por eso el filtro no es "no vacío": tiene que PARECER un teléfono.
 */

/** Caracteres admitidos: dígitos y los signos que llevan los teléfonos. */
const CARACTERES_VALIDOS = /^[\d\s+\-()]+$/;

/** Mínimo: un fijo interno. Máximo: un internacional con prefijo. */
const MIN_DIGITOS = 7;
const MAX_DIGITOS = 15;

function digitosDe(valor: string): string {
  return (valor || '').replace(/\D/g, '');
}

/** ¿El texto parece un teléfono? Para usar en validaciones de template. */
export function telefonoValido(valor: string | null | undefined): boolean {
  return problemaTelefono(valor) === null;
}

/**
 * Por qué no se acepta el teléfono, o `null` si está bien.
 *
 * Devolver el motivo en vez de un booleano es a propósito: el error tiene que
 * decir QUÉ está mal ("solo tiene 3 dígitos") y no un genérico "inválido", que
 * es lo que hace que el usuario no entienda qué escribir.
 */
export function problemaTelefono(valor: string | null | undefined): string | null {
  const limpio = (valor || '').trim();

  if (!limpio) return 'El teléfono está vacío.';

  if (!CARACTERES_VALIDOS.test(limpio)) {
    // El caso real es "se escribió un nombre en el campo teléfono". Enumerar los
    // caracteres sobrantes no ayuda: "Esteban Aguero" son 12 distintos (E y e
    // cuentan aparte) y el mensaje se vuelve un muro de letras.
    // Para ese caso alcanza con decir que hay letras y mostrar un ejemplo válido.
    if (/[a-záéíóúüñ]/i.test(limpio)) {
      return 'No parece un teléfono: tiene letras. Solo números y los signos + - ( ). Ej: 11 2345-6789';
    }
    const simbolos = [...new Set(limpio.match(/[^\d\s+\-()]/g) || [])].join(' ');
    return `El símbolo "${simbolos}" no se puede usar en un teléfono.`;
  }

  const digitos = digitosDe(limpio).length;
  if (digitos < MIN_DIGITOS) {
    return `Tiene ${digitos} ${digitos === 1 ? 'dígito' : 'dígitos'}. Un teléfono tiene al menos ${MIN_DIGITOS}.`;
  }
  if (digitos > MAX_DIGITOS) {
    return `Tiene ${digitos} dígitos, demasiado largo (máximo ${MAX_DIGITOS}).`;
  }

  return null;
}
