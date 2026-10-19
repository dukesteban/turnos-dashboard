import { formatearMoneda, monedaParaEditar, parsearMoneda } from './moneda';

describe('formatearMoneda', () => {
  it('agrega el simbolo, los miles y los dos decimales', () => {
    expect(formatearMoneda(1000)).toBe('$1.000,00');
    expect(formatearMoneda(100000)).toBe('$100.000,00');
    expect(formatearMoneda(1234567.5)).toBe('$1.234.567,50');
  });

  it('muestra los centavos aunque sean cero', () => {
    expect(formatearMoneda(20000)).toBe('$20.000,00');
    expect(formatearMoneda(0)).toBe('$0,00');
  });

  it('no rompe con null, undefined ni basura', () => {
    expect(formatearMoneda(null)).toBe('$0,00');
    expect(formatearMoneda(undefined)).toBe('$0,00');
    expect(formatearMoneda(NaN)).toBe('$0,00');
  });
});

describe('parsearMoneda', () => {
  it('lee el formato argentino', () => {
    expect(parsearMoneda('$1.000,00')).toBe(1000);
    expect(parsearMoneda('1.234,56')).toBe(1234.56);
    expect(parsearMoneda('100.000')).toBe(100000);
  });

  it('lee el formato con punto decimal, que es el que se escribe apurado', () => {
    expect(parsearMoneda('1000.50')).toBe(1000.5);
    expect(parsearMoneda('1234.5')).toBe(1234.5);
  });

  it('no confunde los miles con los decimales', () => {
    // El caso que importa: si `1.000` se leyera como 1,0 el monto queda
    // mil veces mas chico y nadie lo nota hasta que cierra la caja.
    expect(parsearMoneda('1.000')).toBe(1000);
    expect(parsearMoneda('1.000.000')).toBe(1000000);
  });

  it('acepta lo que se escribe sin simbolo ni separadores', () => {
    expect(parsearMoneda('1500')).toBe(1500);
    expect(parsearMoneda(' 2500 ')).toBe(2500);
  });

  it('devuelve 0 con vacio o texto sin numeros', () => {
    expect(parsearMoneda('')).toBe(0);
    expect(parsearMoneda('   ')).toBe(0);
    expect(parsearMoneda('abc')).toBe(0);
    expect(parsearMoneda(null)).toBe(0);
    expect(parsearMoneda(undefined)).toBe(0);
  });

  it('deja pasar un numero tal cual', () => {
    expect(parsearMoneda(1000)).toBe(1000);
    expect(parsearMoneda(0)).toBe(0);
  });
});

describe('monedaParaEditar', () => {
  it('saca el simbolo y deja la coma decimal', () => {
    expect(monedaParaEditar(1000)).toBe('1000');
    expect(monedaParaEditar(1000.5)).toBe('1000,5');
  });

  it('cero queda vacio, para no tener que borrarlo antes de escribir', () => {
    expect(monedaParaEditar(0)).toBe('');
    expect(monedaParaEditar(null)).toBe('');
  });
});
