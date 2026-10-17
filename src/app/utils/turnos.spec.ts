import { soloLosTurnosDe, soloLasColumnasDe, confirmarVolverAPendiente } from './turnos';

// ═════════════════════════════════════════════════════════════════════
// EL FILTRO DE TURNOS DEL ROL EMPLEADO
//
// El riesgo NO es que filtre de mas o de menos en el caso obvio. Es el que no da
// ningun error: `empleado_id` viene de la base como entero y de la sesión como JSON,
// y un `===` entre `1` y `"1"` da falso. El síntoma es una agenda vacía sin excepción,
// sin log y sin ningún error en ninguna parte: solo que "no hay turnos".
// ═════════════════════════════════════════════════════════════════════

const T1 = { id: 1, empleado_id: 1, fecha: '2026-10-06' };
const T2 = { id: 2, empleado_id: 2, fecha: '2026-10-06' };
const T3 = { id: 3, empleado_id: 1, fecha: '2026-10-07' };
const SIN_EMPLEADO = { id: 4, empleado_id: null, fecha: '2026-10-06' };
const TODOS = [T1, T2, T3, SIN_EMPLEADO];

describe('soloLosTurnosDe', () => {
  it('deja los del empleado y saca los de los demas', () => {
    const r = soloLosTurnosDe(TODOS, 1);
    expect(r.length).toBe(2);
    expect(r.every(t => Number(t.empleado_id) === 1)).toBe(true);
  });

  it('con null devuelve la lista entera, sin copiar', () => {
    // null = "ve todos". Es el caso del admin, del secretario, y del rol empleado sin
    // empleado_id vinculado.
    expect(soloLosTurnosDe(TODOS, null)).toBe(TODOS);
    // `undefined` llega cuando el `empleado_id` no vino en el JSON de la sesion, y el
    // chequeo del filtro tiene que contemplarlo igual que el `null`.
    expect(soloLosTurnosDe(TODOS, undefined as any)).toBe(TODOS);
  });

  it('compara como numero, no como texto', () => {
    // El bug sin error: si el id llega como string desde la sesión, con `===` esto
    // devuelve [] y el empleado ve una agenda vacía.
    expect(soloLosTurnosDe(TODOS, '1' as any).length).toBe(2);
    expect(soloLosTurnosDe([{ ...T1, empleado_id: '1' }], 1).length).toBe(1);
    expect(soloLosTurnosDe([{ ...T1, empleado_id: '1' }], 2).length).toBe(0);
  });

  it('un turno sin empleado NO es de nadie y no se lo muestra al empleado', () => {
    // `empleado_id` en NULL es un turno viejo, sin box asignado. Al admin y al
    // secretario sí se lo ve, pero no son sus turnos.
    expect(soloLosTurnosDe(TODOS, 1).some(t => t.id === 4)).toBe(false);
    // Y al admin (null) sigue apareciendo.
    expect(soloLosTurnosDe(TODOS, null).some(t => t.id === 4)).toBe(true);
  });

  it('un empleado que no existe devuelve lista vacia, no todos los turnos', () => {
    // El fallo al revés es peor: si un id no matchea ninguno y el filtro devolviera
    // todo, el empleado vería los turnos de todos.
    expect(soloLosTurnosDe(TODOS, 999)).toEqual([]);
  });

  it('no explota con lista vacia o indefinida', () => {
    expect(soloLosTurnosDe([], 1)).toEqual([]);
    expect(soloLosTurnosDe(null as any, 1)).toEqual([]);
    expect(soloLosTurnosDe(undefined as any, null)).toEqual([]);
  });
});

describe('soloLasColumnasDe', () => {
  const C1 = { empleado: { id: 1, nombre: 'Juan' }, activo: true };
  const C2 = { empleado: { id: 2, nombre: 'Esteban' }, activo: true };

  it('deja una sola columna, la del empleado', () => {
    const r = soloLasColumnasDe([C1, C2], 1);
    expect(r.length).toBe(1);
    expect(r[0].empleado.nombre).toBe('Juan');
  });

  it('con null deja todas', () => {
    expect(soloLasColumnasDe([C1, C2], null).length).toBe(2);
  });

  it('no explota con una columna sin empleado', () => {
    // `debeMostrarColumna` opera sobre objetos con forma conocida, pero el filtro se
    // llama antes y no puede confiar en eso.
    expect(soloLasColumnasDe([{ activo: true } as any], 1)).toEqual([]);
    expect(soloLasColumnasDe([null as any, C1], 1).length).toBe(1);
  });

  it('compara como numero, no como texto', () => {
    expect(soloLasColumnasDe([{ empleado: { id: '1' } } as any], 1).length).toBe(1);
  });
});
// ─── EL CARTEL DE "VOLVER A PENDIENTE" ───
//
// `volverAPendiente()` borra metodo_pago, precio_final, observaciones,
// servicio_nombre_final y servicio_id_final, y no se recupera. Los dos popups
// (Agenda y Dashboard) lo llamaban con un clic y sin preguntar nada.

describe('confirmarVolverAPendiente', () => {
  let original: any;

  beforeEach(() => {
    original = (globalThis as any).confirm;
  });

  afterEach(() => {
    (globalThis as any).confirm = original;
  });

  function espiarConfirm(respuesta: boolean): string[] {
    const llamadas: string[] = [];
    (globalThis as any).confirm = (texto: string) => {
      llamadas.push(texto);
      return respuesta;
    };
    return llamadas;
  }

  it('devuelve false si el que aprieta dice que no', () => {
    espiarConfirm(false);
    expect(confirmarVolverAPendiente({ estado: 'atendido', precio_final: 12000 })).toBe(false);
  });

  it('devuelve true si dice que si', () => {
    espiarConfirm(true);
    expect(confirmarVolverAPendiente({ estado: 'atendido', precio_final: 12000 })).toBe(true);
  });

  it('pregunta una sola vez', () => {
    const llamadas = espiarConfirm(true);
    confirmarVolverAPendiente({ estado: 'atendido', precio_final: 12000 });
    expect(llamadas.length).toBe(1);
  });

  it('no pregunta si el turno no estaba atendido', () => {
    const llamadas = espiarConfirm(true);
    expect(confirmarVolverAPendiente({ estado: 'cancelado' })).toBe(true);
    expect(confirmarVolverAPendiente({ estado: 'pendiente' })).toBe(true);
    expect(llamadas.length).toBe(0);
  });

  it('no pregunta si no hay turno', () => {
    const llamadas = espiarConfirm(true);
    expect(confirmarVolverAPendiente(null)).toBe(true);
    expect(llamadas.length).toBe(0);
  });

  it('el cartel nombra cada cosa que se pierde', () => {
    const llamadas = espiarConfirm(true);
    confirmarVolverAPendiente({
      estado: 'atendido',
      servicio_nombre_final: 'Coloración completa',
      precio_final: 45000,
      metodo_pago: 'Efectivo',
      observaciones: 'la clienta trajo el tinte'
    });
    const texto = llamadas[0];
    expect(texto).toContain('Coloración completa');
    expect(texto).toContain('el precio final');
    expect(texto).toContain('Efectivo');
    expect(texto).toContain('las observaciones');
    expect(texto).toContain('no se puede deshacer');
  });

  it('si estaba atendido pero sin datos, avisa igual', () => {
    const llamadas = espiarConfirm(true);
    confirmarVolverAPendiente({ estado: 'atendido' });
    expect(llamadas[0]).toContain('los datos de la atención');
    expect(llamadas[0]).toContain('solo se');
  });

  it('pregunta igual cuando el precio final es 0', () => {
    // Un turno gratis no es menos un turno atendido: el 0 es falsy en JS y la
    // condición `!= null` es justamente la que lo agarra.
    const llamadas = espiarConfirm(true);
    confirmarVolverAPendiente({ estado: 'atendido', precio_final: 0 });
    expect(llamadas[0]).toContain('el precio final');
  });
});