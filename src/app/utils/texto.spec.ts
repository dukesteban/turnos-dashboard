import { sinAcentos, contiene, soloDigitos, coincideTelefono } from './texto';

/**
 * Tests del normalizador de texto para busquedas.
 *
 * Cada caso de acá corresponde a un nombre que existe de verdad en la base de
 * prueba o en la vida real. Un buscador que falla con acentos no se nota
 * escribiendo tests sobre palabras sin tilde, asi que estos son todos con
 * tilde.
 */

describe('sinAcentos', () => {
  it('quita las tildes y los digitos', () => {
    expect(sinAcentos('María')).toBe('Maria');
    expect(sinAcentos('Ángel')).toBe('Angel');
    expect(sinAcentos('José Luis')).toBe('Jose Luis');
  });

  it('deja intacto lo que no tiene acentos', () => {
    expect(sinAcentos('Daniel')).toBe('Daniel');
  });

  it('no tira nada con null, undefined o cadena vacia', () => {
    // Los clientes vienen de la base y un nombre puede venir null.
    expect(sinAcentos('')).toBe('');
    expect(sinAcentos(null as any)).toBe('');
    expect(sinAcentos(undefined as any)).toBe('');
  });
});

describe('contiene', () => {
  it('encuentra con y sin acentos, en cualquier combinacion', () => {
    // El caso que importaba: buscar "MARIA" tiene que encontrar a "María".
    expect(contiene('María Gómez', 'MARIA')).toBe(true);
    expect(contiene('María Gómez', 'maria')).toBe(true);
    expect(contiene('María Gómez', 'MARÍA')).toBe(true);
    expect(contiene('MARÍA GÓMEZ', 'maria')).toBe(true);
  });

  it('funciona con todos los acentos', () => {
    expect(contiene('Érica Sánchez', 'erica')).toBe(true);
    expect(contiene('Cañada', 'canada')).toBe(true);
    expect(contiene('Pérez', 'perez')).toBe(true);
    expect(contiene('Ñuñoa', 'nunoa')).toBe(true);   // la Ñ NO es N con tilde
    expect(contiene('Niño', 'nino')).toBe(true);
  });

  it('devuelve false cuando de verdad no esta', () => {
    expect(contiene('María Gómez', 'pedro')).toBe(false);
  });

  it('una consulta vacia no filtra nada', () => {
    expect(contiene('María', '')).toBe(true);
    expect(contiene('', '')).toBe(true);
  });

  it('sirve para telefonos con y sin formato, mientras el formato este en ambos lados', () => {
    expect(contiene('11 5555-1111', '11 5555')).toBe(true);
    expect(contiene('1155551111', '115555')).toBe(true);
  });

  it('no le importa el orden de los argumentos', () => {
    expect(contiene('Mar', 'María')).toBe(false);   // "mar" esta, pero no alcanza
    expect(contiene('María', 'Mar')).toBe(true);
  });
});

describe('soloDigitos', () => {
  it('saca todo lo que no es numero', () => {
    expect(soloDigitos('11 5555-1111')).toBe('1155551111');
    expect(soloDigitos('+54 9 11 5555 1111')).toBe('5491155551111');
  });

  it('devuelve vacio si no hay digitos', () => {
    expect(soloDigitos('Esteban')).toBe('');
    expect(soloDigitos('')).toBe('');
    expect(soloDigitos(null as any)).toBe('');
  });
});

describe('coincideTelefono', () => {
  // El validador ADMITE espacios, guiones y parentesis, asi que las tres
  // formas de abajo pueden estar guardadas en la base al mismo tiempo.
  const FORMAS = ['11 5555-1111', '(011) 15-5555-1111', '1155551111', '+54 9 11 5555 1111'];

  it('buscar solo digitos encuentra cualquier formato guardado', () => {
    for (const guardado of FORMAS) {
      expect(coincideTelefono(guardado, '115555')).toBe(true);
    }
  });

  it('buscar un fragmento con signo encontra el numero sin signo', () => {
    expect(coincideTelefono('+54 9 11 5555 1111', '54911')).toBe(true);
  });

  it('un numero que no esta NO coincide', () => {
    expect(coincideTelefono('11 5555-1111', '9999')).toBe(false);
  });

  it('una consulta sin digitos NO hace match con todos', () => {
    // Sin este caso, buscar "abc" daria la lista entera: el filtro con "" da
    // true para cada cliente y el usuario cree que todos coinciden.
    expect(coincideTelefono('11 5555-1111', 'abc')).toBe(false);
    expect(coincideTelefono('', 'abc')).toBe(false);
  });

  it('una consulta vacia no filtra', () => {
    expect(coincideTelefono('11 5555-1111', '')).toBe(true);
  });
});
