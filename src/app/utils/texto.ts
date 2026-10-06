/**
 * Utilidades de texto para BUSCAR (no para guardar).
 *
 * El problema que resuelve: en español la gente escribe sin acentos casi
 * siempre. Si el cliente se llama "María Gómez" y el usuario busca "maria", con
 * `includes` normal no aparece NADA y el usuario concluye que el cliente no
 * está cargado.
 *
 * Estas funciones son SOLO para comparar. Para GUARDAR hay que usar el nombre
 * tal cual, con sus acentos: "María" se guarda con la í.
 */

/**
 * "María" -> "Maria", "Ángel" -> "Angel", "Ñoño" -> "Nono".
 *
 * `normalize('NFD')` separa la letra base de su tilde/macron, y despues se
 * borran los combinantes (U+0300 a U+036F). Es el metodo estandar: no depende de
 * una tabla de reemplazos escrita a mano, que siempre termina faltando un caso.
 */
export function sinAcentos(s: string): string {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * `includes` que ignora mayusculas, acentos y acentos de apertura (¿, ¡).
 *
 * La Ñ es el caso trampa: no es "N" con tilde arriba, es una letra propia, asi
 * que `normalize('NFD')` NO la descompone y "ñ" != "n". Por eso el `replace`
 * final. Sin esto, buscar "nino" no encuentra a "Niño".
 */
export function contiene(texto: string, consulta: string): boolean {
  const t = sinAcentos(texto || '')
    .toLowerCase()
    .replace(/ñ/g, 'n');
  const q = sinAcentos(consulta || '')
    .toLowerCase()
    .replace(/ñ/g, 'n');
  if (!q) return true;      // consulta vacia = no filtrar
  return t.includes(q);
}

/**
 * Telefonos: solo digitos, para comparar "11 5555-1111" con "1155551111".
 */
export function soloDigitos(s: string): string {
  return (s || '').replace(/\D/g, '');
}

/**
 * Forma de COMPARAR un nombre, para saber si dos son "el mismo".
 *
 * `trim()` solo, que es lo que hacia el chequeo de servicios duplicados, NO
 * alcanza: "Lavado  Simple" (doble espacio) y "Lavado Simple" son el mismo
 * servicio y con `trim()`quedan como dos distintos. Como el índice único de Postgres
 * compara los bytes crudos, los dos pasaban y quedaban DOS servicios que se
 * ven iguales en la pantalla.
 *
 * Sin acentos a propósito: "Cañada" y "Canada" son nombres DISTINTOS para el
 * cliente y para la base, y unificarlos seria peor que mostrar dos.
 */
export function paraComparar(nombre: string): string {
  return (nombre || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * ¿La consulta coincide con este teléfono?
 *
 * Los teléfonos se guardan COMO LOS ESCRIBE EL USUARIO, porque el validador
 * admite espacios, guiones y parentesis: "11 2345-6789", "(011) 15-5555-1111" y
 * "1155551111" son los tres válidos. Buscar "115555" tiene que encontrar a las
 * tres formas, asi que se comparan SOLO digitos.
 *
 * Si la consulta no tiene ningún dígito se compara como texto, para no romper el
 * filtro: buscar "abc" tiene que devolver lista vacía, no todo. (Con la normal
 * esa consulta valdría "" y `includes("")` dá true siempre.)
 */
export function coincideTelefono(guardado: string, consulta: string): boolean {
  const q = soloDigitos(consulta);
  if (!q) return contiene(guardado, consulta);
  return soloDigitos(guardado).includes(q);
}
