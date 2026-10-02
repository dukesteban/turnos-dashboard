import { telefonoValido, problemaTelefono } from './telefono';

/**
 * Los dos primeros casos son REALES: en la base había nombres guardados en el
 * campo teléfono ("Esteban Aguero", "Tu número"). Con esas filas la app creía
 * que el cliente tenía teléfono y el WhatsApp se mandaba a un nombre.
 */
describe('telefonoValido', () => {
  it('rechaza un nombre en el campo teléfono', () => {
    expect(telefonoValido('Esteban Aguero')).toBe(false);
  });

  it('rechaza un placeholder', () => {
    expect(telefonoValido('Tu número')).toBe(false);
  });

  it('rechaza vacío o solo espacios', () => {
    expect(telefonoValido('   ')).toBe(false);
  });

  it('rechaza muy pocos dígitos', () => {
    expect(telefonoValido('123')).toBe(false);
  });

  it('acepta 10 dígitos', () => {
    expect(telefonoValido('1123456789')).toBe(true);
  });

  it('acepta espacios', () => {
    expect(telefonoValido('11 2345-6789')).toBe(true);
  });

  it('acepta formato internacional', () => {
    expect(telefonoValido('+54 9 11 2345 6789')).toBe(true);
  });

  it('acepta paréntesis', () => {
    expect(telefonoValido('(011) 2345-6789')).toBe(true);
  });

  it('acepta guiones y más', () => {
    expect(telefonoValido('+1-555-0100')).toBe(true);
  });
});

describe('problemaTelefono', () => {
  it('devuelve null cuando está bien', () => {
    expect(problemaTelefono('1123456789')).toBeNull();
  });

  it('dice cuántos dígitos faltan', () => {
    expect(problemaTelefono('12')).toMatch(/2 dígitos/);
  });

  it('avisa si es demasiado largo', () => {
    expect(problemaTelefono('1234567890123456789')).toMatch(/demasiado largo/);
  });

  it('avisa que tiene letras', () => {
    expect(problemaTelefono('Esteban Aguero')).toMatch(/tiene letras/);
  });

  it('detecta letras con acentos', () => {
    expect(problemaTelefono('José Ramírez')).toMatch(/tiene letras/);
  });

  // El mensaje tiene que ser legible. Una versión anterior separaba cada letra
  // con espacios y llegaba a imprimir "E s t e b a n A g u r o", que no dice nada.
  it('NUNCA separa las letras con espacios', () => {
    expect(problemaTelefono('Esteban Aguero')).not.toMatch(/E s t/);
  });

  it('muestra un ejemplo de formato válido', () => {
    expect(problemaTelefono('Esteban Aguero')).toMatch(/Ej: 11 2345-6789/);
  });

  it('nombra el símbolo inválido', () => {
    expect(problemaTelefono('1123*4567')).toMatch(/no se puede usar/);
  });

  it('el ejemplo del símbolo es concreto', () => {
    expect(problemaTelefono('1123*4567')).toMatch(/"\*"/);
  });
});
