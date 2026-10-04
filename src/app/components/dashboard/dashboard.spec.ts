import { TestBed } from '@angular/core/testing';
import { DashboardComponent } from './dashboard';
import { SupabaseService } from '../../services/supabase';
import {
  crearSupabaseMock, EMP_JUAN, EMP_ESTEBAN, cloneEmpleado, turno,
} from '../../testing/supabase-mock';

/**
 * Tests de COMPONENTE del Dashboard.
 *
 * Es el componente con más lógica de validación de toda la app (agendar, marcar
 * atendido, reprogramar) y era el único grande SIN cobertura.
 *
 * Los dos bugs históricos más caros de esta pantalla están acá:
 *   · el selector de empleado del alta de turno era DECORATIVO (se guardaba el
 *     empleado viejo aunque eligieras otro)
 *   · `actualizarEmpleadosReprogramar` reasignaba `this.empleados` con un filter
 *     y la lista original se perdía para siempre
 *
 * Y el third bug, más reciente: `empleadoEstaOcupado` (que reemplazó al viejo
 * `puestoEstaOcupado`) es lo que impide la doble reserva. Hay tests que lo fijan
 * para que nadie lo saque por "innecesario".
 *
 * Fechas de referencia: 2026-12-01 es martes. Juan = L-V. Esteban = L,M,J,V.
 */

function montar(over: Record<string, any> = {}) {
  const mock = crearSupabaseMock(over);
  TestBed.configureTestingModule({
    providers: [{ provide: SupabaseService, useValue: mock }],
  });
  const cmp = TestBed.createComponent(DashboardComponent).componentInstance;
  return { cmp, mock };
}

/** Monta y deja correr `ngOnInit`, que es lo que carga empleados y teléfonos. */
async function montarCargado(over: Record<string, any> = {}) {
  const r = montar(over);
  await r.cmp.ngOnInit();
  return r;
}

const settle = () => new Promise(r => setTimeout(r, 0));

/** Ambos pueden atender el martes 01/12 a las 10:00. */
const ambosDisponibles = () => Promise.resolve([
  { empleado_id: EMP_JUAN.id, nombre: EMP_JUAN.nombre, puede_atender: true, libre: true, agendable: true },
  { empleado_id: EMP_ESTEBAN.id, nombre: EMP_ESTEBAN.nombre, puede_atender: true, libre: true, agendable: true },
]);

describe('Dashboard — carga', () => {
  it('ngOnInit trae empleados, metodos de pago y el mapa de telefonos', async () => {
    const { cmp } = await montarCargado({
      getTelefonosPorCliente: () => Promise.resolve({ 1: '11 5555-1111' }),
    });

    expect(cmp.empleados.length).toBe(2);
    expect(cmp.metodosPago.length).toBe(1);
    expect(cmp.telefonosPorCliente[1]).toBe('11 5555-1111');
  });

  it('el telefono sale del mapa ACTUAL, no del snapshot del turno', async () => {
    // El snapshot dice '' pero el cliente ya tiene telefono cargado: la pantalla
    // debe mostrar el nuevo. Antes decia "Sin telefono" y el WhatsApp iba al viejo.
    const { cmp } = await montarCargado({
      getTelefonosPorCliente: () => Promise.resolve({ 1: '11 5555-1111' }),
    });

    expect(cmp.telefonoDe({ cliente_id: 1, cliente_telefono: '' })).toBe('11 5555-1111');
    // Si el mapa no lo tiene, cae al snapshot: los turnos viejos siguen mostrando algo.
    expect(cmp.telefonoDe({ cliente_id: 99, cliente_telefono: '11 5555-9999' })).toBe('11 5555-9999');
  });

  it('sin telefono registrado devuelve null (no una cadena vacia)', async () => {
    const { cmp } = await montarCargado();
    expect(cmp.telefonoDe({ cliente_id: 1, cliente_telefono: null })).toBeNull();
    expect(cmp.telefonoDe({ cliente_id: 1, cliente_telefono: '' })).toBeNull();
    expect(cmp.telefonoDe(null)).toBeNull();
  });

  // La columna Puesto se fue con la migracion 011. Si alguien reintroduce el
  // fallback, el turno se muestra con el empleado de otro.
  it('empleadoDeTurno usa solo empleado_id, sin mirar puesto_id', async () => {
    const { cmp } = await montarCargado();
    expect(cmp.empleadoDeTurno({ empleado_id: 8, puesto_id: 1 })).toBe(8);
    expect(cmp.empleadoDeTurno({ empleado_id: null, puesto_id: 1 })).toBeNull();
    expect(cmp.nombreEmpleadoDeTurno({ empleado_id: 1 })).toBe(EMP_JUAN.nombre);
    expect(cmp.nombreEmpleadoDeTurno({})).toBe('Sin empleado');
  });
});

describe('Dashboard — alta de turno: el empleado es obligatorio', () => {
  const conFormListo = async (over: Record<string, any> = {}) => {
    const r = montar(over);
    r.cmp.servicios = [{ id: 1, nombre: 'Lavado simple', precio: 12000, duracion_minutos: 45, activo: true }];
    r.cmp.horarios = [{ dia_semana: 2, hora_inicio: '08:00', hora_fin: '20:00', activo: true }];
    r.cmp.empleados = [cloneEmpleado(EMP_JUAN), cloneEmpleado(EMP_ESTEBAN)];
    r.cmp.clienteSeleccionadoNuevo = { id: 1, nombre: 'Daniel Prueba', telefonos: [] };
    r.cmp.nuevoTurnoFecha = '2026-12-01';   // martes
    r.cmp.nuevoTurnoHora = '10:00';
    r.cmp.nuevoTurnoServicioId = 1;
    return r;
  };

  it('sin empleado elegido NO guarda y explica por que', async () => {
    const guardados: any[] = [];
    const { cmp } = await conFormListo({
      crearTurnoManual: (t: any) => { guardados.push(t); return Promise.resolve(t); },
    });
    cmp.nuevoTurnoEmpleadoId = null;

    await cmp.guardarNuevoTurno();

    expect(cmp.errorNuevoTurno).toMatch(/empleado/i);
    expect(guardados).toEqual([]);
  });

  it('no escribe `puesto_id` en el turno nuevo', async () => {
    const guardados: any[] = [];
    const { cmp } = await conFormListo({
      crearTurnoManual: (t: any) => { guardados.push(t); return Promise.resolve(t); },
    });
    cmp.nuevoTurnoEmpleadoId = EMP_ESTEBAN.id;

    await cmp.guardarNuevoTurno();

    expect(guardados.length).toBe(1);
    expect(guardados[0].empleado_id).toBe(EMP_ESTEBAN.id);
    expect('puesto_id' in guardados[0]).toBe(false);
  });

  it('calcula la hora fin con la duracion del servicio', async () => {
    const guardados: any[] = [];
    const { cmp } = await conFormListo({
      crearTurnoManual: (t: any) => { guardados.push(t); return Promise.resolve(t); },
    });
    cmp.nuevoTurnoEmpleadoId = EMP_JUAN.id;

    await cmp.guardarNuevoTurno();

    expect(guardados.length).toBe(1);
    expect(guardados[0].hora_inicio).toBe('10:00');
    expect(guardados[0].hora_fin).toBe('10:45');   // +45 min
    expect(cmp.errorNuevoTurno).toBe('');
  });

  it('sin telefono manda null, no cadena vacia', async () => {
    // `cliente_telefono` quedo sin NOT NULL justamente para que null signifique
    // "no tiene". Mandar '' seria un tercer estado que el snapshotea.
    const guardados: any[] = [];
    const { cmp } = await conFormListo({
      crearTurnoManual: (t: any) => { guardados.push(t); return Promise.resolve(t); },
    });
    cmp.nuevoTurnoEmpleadoId = EMP_JUAN.id;

    await cmp.guardarNuevoTurno();

    expect(guardados[0].cliente_telefono).toBeNull();
  });

  // ESTE es el chequeo que reemplazo a `puestoEstaOcupado`. Si alguien lo saca
  // "porque el empleado no se repite", vuelve la doble reserva.
  it('no guarda si el empleado ya tiene un turno a esa hora', async () => {
    const guardados: any[] = [];
    const { cmp } = await conFormListo({
      empleadoEstaOcupado: () => Promise.resolve(true),
      crearTurnoManual: (t: any) => { guardados.push(t); return Promise.resolve(t); },
    });
    cmp.nuevoTurnoEmpleadoId = EMP_JUAN.id;

    await cmp.guardarNuevoTurno();

    expect(guardados).toEqual([]);
    expect(cmp.errorNuevoTurno).toMatch(/ya tiene un turno/i);
  });

  it('no guarda si el empleado no puede trabajar ese dia', async () => {
    const guardados: any[] = [];
    const { cmp } = await conFormListo({
      empleadoPuedeAtender: () => Promise.resolve({ ok: false, motivo: 'No trabaja los martes' }),
      crearTurnoManual: (t: any) => { guardados.push(t); return Promise.resolve(t); },
    });
    cmp.nuevoTurnoEmpleadoId = EMP_JUAN.id;

    await cmp.guardarNuevoTurno();

    expect(guardados).toEqual([]);
    expect(cmp.errorNuevoTurno).toMatch(/No trabaja los martes/);
  });

  it('rechaza una hora fuera del horario de atencion', async () => {
    const guardados: any[] = [];
    const { cmp } = await conFormListo({
      crearTurnoManual: (t: any) => { guardados.push(t); return Promise.resolve(t); },
    });
    cmp.nuevoTurnoEmpleadoId = EMP_JUAN.id;
    cmp.nuevoTurnoHora = '22:00';   // el horario cierra 20:00

    await cmp.guardarNuevoTurno();

    expect(guardados).toEqual([]);
    expect(cmp.errorNuevoTurno).toMatch(/horario/i);
  });

  it('el combo muestra SOLO quien puede trabajar en esa fecha y hora', async () => {
    // El martes solo puede Juan; Esteban no.
    const { cmp } = await conFormListo({
      getEmpleadosDisponibles: () => Promise.resolve([
        { empleado_id: EMP_JUAN.id, puede_atender: true, libre: true },
        { empleado_id: EMP_ESTEBAN.id, puede_atender: false, libre: true, motivo_bloqueo: 'Vacaciones' },
      ]),
    });

    await cmp.actualizarEmpleadosLibres();

    expect(cmp.empleadosLibres.map(e => e.id)).toEqual([EMP_JUAN.id]);
  });

  it('tambien saca del combo a quien esta OCUPADO, no solo a quien no puede', async () => {
    const { cmp } = await conFormListo({
      getEmpleadosDisponibles: () => Promise.resolve([
        { empleado_id: EMP_JUAN.id, puede_atender: true, libre: false },  // puede pero esta ocupado
        { empleado_id: EMP_ESTEBAN.id, puede_atender: true, libre: true },
      ]),
    });

    await cmp.actualizarEmpleadosLibres();

    expect(cmp.empleadosLibres.map(e => e.id)).toEqual([EMP_ESTEBAN.id]);
  });

  it('si el empleado elegido queda fuera de la lista, se limpia la seleccion', async () => {
    const { cmp } = await conFormListo({
      getEmpleadosDisponibles: () => Promise.resolve([
        { empleado_id: EMP_JUAN.id, puede_atender: true, libre: true },
      ]),
    });
    cmp.nuevoTurnoEmpleadoId = EMP_ESTEBAN.id;

    await cmp.actualizarEmpleadosLibres();

    expect(cmp.nuevoTurnoEmpleadoId).toBeNull();
  });

  it('sin fecha/hora/servicio no se consulta nada y la lista queda vacia', async () => {
    const { cmp, mock } = await conFormListo();
    cmp.nuevoTurnoFecha = '';

    await cmp.actualizarEmpleadosLibres();

    expect(cmp.empleadosLibres).toEqual([]);
    expect(mock.llamadas).not.toContain('getEmpleadosDisponibles');
  });

  it('abre el modal con todo limpio', async () => {
    const { cmp } = montar();
    cmp.errorNuevoTurno = 'basura';
    cmp.nuevoTurnoEmpleadoId = 99;

    cmp.cerrarModalNuevoTurno();
    cmp.abrirModalNuevoTurno();

    expect(cmp.errorNuevoTurno).toBe('');
    expect(cmp.nuevoTurnoEmpleadoId).toBeNull();
    expect(cmp.empleadosLibres).toEqual([]);
  });
});

describe('Dashboard — reprogramar: la lista NO se come a la original', () => {
  // BUG HISTORICO: aca se reasignaba `this.empleados` con un filter. La lista
  // original se perdia para siempre y despues no se podian agendar turnos con
  // los demas.
  it('this.empleados sigue intacta despues de filtrar', async () => {
    const { cmp } = montar({ getEmpleadosDisponibles: ambosDisponibles });
    cmp.empleados = [cloneEmpleado(EMP_JUAN), cloneEmpleado(EMP_ESTEBAN)];
    cmp.servicios = [{ id: 1, duracion_minutos: 45 }];
    cmp.nuevaFecha = '2026-12-01';
    cmp.nuevaHora = '10:00';

    await cmp.actualizarEmpleadosReprogramar();

    expect(cmp.empleados.length).toBe(2);
    expect(cmp.empleadosReprogramar.length).toBe(2);
    expect(cmp.empleadosReprogramar).not.toBe(cmp.empleados);
  });

  it('el que NO puede atender queda fuera del combo, pero avisa', async () => {
    const { cmp } = montar({
      getEmpleadosDisponibles: () => Promise.resolve([
        { empleado_id: EMP_JUAN.id, puede_atender: true, libre: true },
        { empleado_id: EMP_ESTEBAN.id, puede_atender: false, libre: true },
      ]),
    });
    cmp.empleados = [cloneEmpleado(EMP_JUAN), cloneEmpleado(EMP_ESTEBAN)];
    cmp.servicios = [{ id: 1, duracion_minutos: 45 }];
    cmp.nuevaFecha = '2026-12-01';
    cmp.nuevaHora = '10:00';
    cmp.nuevoEmpleadoId = EMP_ESTEBAN.id;

    await cmp.actualizarEmpleadosReprogramar();

    // Aparece en la lista (para no perder al elegido) y con el aviso prendido.
    expect(cmp.empleadosReprogramar.map(e => e.id)).toContain(EMP_ESTEBAN.id);
    expect(cmp.empleadoReprogramarNoPuede).toBe(true);
  });

  it('sin fecha no filtra: deja la lista completa y sin avisos', async () => {
    const { cmp, mock } = montar();
    cmp.empleados = [cloneEmpleado(EMP_JUAN), cloneEmpleado(EMP_ESTEBAN)];
    cmp.nuevaFecha = '';

    await cmp.actualizarEmpleadosReprogramar();

    expect(cmp.empleadosReprogramar.length).toBe(2);
    expect(cmp.empleadoReprogramarNoPuede).toBe(false);
    expect(mock.llamadas).not.toContain('getEmpleadosDisponibles');
  });

  it('activarEditarTurno deja elegido el empleado del turno, no el primero', async () => {
    const { cmp } = montar({ getEmpleadosDisponibles: ambosDisponibles });
    cmp.empleados = [cloneEmpleado(EMP_JUAN), cloneEmpleado(EMP_ESTEBAN)];
    cmp.servicios = [{ id: 1, duracion_minutos: 45 }];
    // El turno es de Esteban. La lista del mock empieza con Juan.
    cmp.turnoSeleccionado = turno({ empleado_id: EMP_ESTEBAN.id, hora_inicio: '14:30:00' });

    cmp.activarEditarTurno();

    expect(cmp.modoEditarTurno).toBe(true);
    expect(cmp.nuevoEmpleadoId).toBe(EMP_ESTEBAN.id);
    expect(cmp.nuevaHora).toBe('14:30');
  });

  it('salirDeEditarTurno limpia TODOS los carteles', async () => {
    const { cmp } = montar();
    cmp.empleados = [cloneEmpleado(EMP_JUAN), cloneEmpleado(EMP_ESTEBAN)];
    cmp.modoEditarTurno = true;
    cmp.editandoTurno = true;
    cmp.errorEditarTurno = 'algo';
    cmp.empleadoReprogramarNoPuede = true;

    cmp.salirDeEditarTurno();

    expect(cmp.modoEditarTurno).toBe(false);
    expect(cmp.editandoTurno).toBe(false);
    expect(cmp.errorEditarTurno).toBe('');
    expect(cmp.empleadoReprogramarNoPuede).toBe(false);
    expect(cmp.empleadosReprogramar.length).toBe(2);
  });
});

describe('Dashboard — popup y marcar atendido', () => {
  /** El form arranca con servicio/precio/metodo; hay que llenarlos para llegar al chequeo del empleado. */
  const abrirPopupListo = async (cmp: any, over: Record<string, any> = {}) => {
    await cmp.abrirPopup(turno(over));
    cmp.atendidoServicioId = 1;
    cmp.atendidoPrecio = 12000;
    cmp.atendidoMetodoPago = 'efectivo';
  };

  it('cerrarPopup deja limpio el form de reprogramar', async () => {
    // Si no, los carteles reaparecen al abrir el siguiente turno.
    const { cmp } = montar();
    cmp.empleados = [cloneEmpleado(EMP_JUAN)];
    await cmp.abrirPopup(turno({ empleado_id: 1 }));
    cmp.editandoTurno = true;
    cmp.errorEditarTurno = 'ese empleado no puede';
    cmp.empleadoReprogramarNoPuede = true;
    cmp.modoEditarTurno = true;

    cmp.cerrarPopup();

    expect(cmp.mostrarPopup).toBe(false);
    expect(cmp.turnoSeleccionado).toBeNull();
    expect(cmp.modoEditarTurno).toBe(false);
    expect(cmp.editandoTurno).toBe(false);
    expect(cmp.errorEditarTurno).toBe('');
    expect(cmp.empleadoReprogramarNoPuede).toBe(false);
  });

  it('si falta precio o metodo, avisa antes de mirar el empleado', async () => {
    // El orden de las validaciones importa: si el empleado se pidiera primero,
    // el usuario veria "elegi el empleado" cuando lo que le falta es el precio.
    const { cmp } = montar();
    await abrirPopupListo(cmp);
    cmp.atendidoPrecio = 0;
    cmp.atendidoEmpleadoId = null;

    await cmp.confirmarAtendido();

    expect(cmp.errorAtendido).toMatch(/requeridos/i);
  });

  it('sin empleado no se marca como atendido', async () => {
    const marcados: any[] = [];
    const { cmp } = montar({
      marcarAtendido: (id: number, d: any) => { marcados.push({ id, ...d }); return Promise.resolve(); },
    });
    await abrirPopupListo(cmp);
    cmp.atendidoEmpleadoId = null;

    await cmp.confirmarAtendido();

    expect(cmp.errorAtendido).toMatch(/empleado/i);
    expect(marcados).toEqual([]);
  });

  it('si el empleado no puede, no marca como atendido y dice el motivo', async () => {
    const marcados: any[] = [];
    const { cmp } = montar({
      empleadoPuedeAtender: () => Promise.resolve({ ok: false, motivo: 'Vacaciones' }),
      marcarAtendido: (id: number, d: any) => { marcados.push({ id, ...d }); return Promise.resolve(); },
    });
    await abrirPopupListo(cmp);
    cmp.atendidoEmpleadoId = EMP_JUAN.id;

    await cmp.confirmarAtendido();

    expect(cmp.errorAtendido).toMatch(/Vacaciones/);
    expect(marcados).toEqual([]);
  });

  it('excluye al propio turno del chequeo deOccupado', async () => {
    // `empleadoEstaOcupado` recibe el id del turno para no detectarse a si mismo
    // como doble reserva. Si ese parametro se pierde, marcar atendido nunca
    // funciona sobre un turno ya ocupado.
    const llamadoCon: any[] = [];
    const { cmp } = montar({
      empleadoEstaOcupado: (...args: any[]) => { llamadoCon.push(args); return Promise.resolve(false); },
      marcarAtendido: () => Promise.resolve(),
    });
    await abrirPopupListo(cmp, { id: 77 });
    cmp.atendidoEmpleadoId = EMP_JUAN.id;

    await cmp.confirmarAtendido();

    expect(llamadoCon.length).toBe(1);
    expect(llamadoCon[0][4]).toBe(77);   // 5to parametro = id del turno excluido
  });
});

describe('Dashboard — no consulta lo retirado', () => {
  it('nunca toca la tabla `puestos` ni el doble booking por puesto', async () => {
    const { cmp, mock } = await montarCargado();
    cmp.servicios = [{ id: 1, duracion_minutos: 45 }];
    await cmp.abrirPopup(turno({ empleado_id: 1 }));

    expect(mock.llamadas.filter((c: string) => /puesto/i.test(c))).toEqual([]);
  });
});

describe('Dashboard — buscador de cliente del modal de Nuevo turno', () => {
  // Este buscador antes llamaba `supabase.buscarClientes()`, que era una
  // consulta a la base POR CADA TECLA con `.ilike()`. El `.ilike()` de Postgres
  // además no ignora acentos, así que "maria" no encontraba a "María Gómez":
  // un bug de búsqueda con un costo de red por pulsación.
  //
  // Ahora carga la lista una vez con `getClientes()` y filtra en memoria con
  // `contiene`. Estos tests fijan las dos cosas.

  const CLIENTES = [
    { id: 1, nombre: 'Daniel Prueba', telefonos: [{ id: 10, telefono: '3764123456' }], activo: true },
    { id: 2, nombre: 'María Gómez', telefonos: [{ id: 20, telefono: '3815550000' }], activo: true },
    { id: 3, nombre: 'Jose Luis Diaz', telefonos: [], activo: true },
    { id: 4, nombre: 'Cliente Inactivo', telefonos: [], activo: false },
  ];

  /** Monta con fixture, para poder afirmar sobre el DOM. */
  function montarBuscador(over: Record<string, any> = {}) {
    const mock = crearSupabaseMock({ getClientes: () => Promise.resolve(CLIENTES), ...over });
    TestBed.configureTestingModule({
      providers: [{ provide: SupabaseService, useValue: mock }],
    });
    const fixture = TestBed.createComponent(DashboardComponent);
    return { cmp: fixture.componentInstance, mock, fixture };
  }

  async function listo(over: Record<string, any> = {}) {
    const r = montarBuscador(over);
    r.cmp.abrirModalNuevoTurno();
    await settle();
    return r;
  }

  /**
   * Escribe en el campo DE VERDAD. Asignarle la propiedad al componente tira
   * NG0100: el [(ngModel)] ya fue chequeado y al cambiar el valor de un
   * detectChanges al siguiente Angular lo detecta como cambio en vivo.
   */
  function tocar(fixture: any, valor: string) {
    const input = fixture.nativeElement.querySelector(
      '.popup-overlay input[placeholder*="Buscar cliente"]'
    );
    input.value = valor;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  it('abrir el modal carga los clientes UNA vez', async () => {
    const { cmp, mock } = await listo();
    expect(cmp.todosLosClientes.length).toBe(3);
    expect(mock.llamadas.filter((c: string) => c === 'getClientes').length).toBe(1);
  });

  it('al reabrirlo NO vuelve a pedir la lista', async () => {
    // Reabrir el modal es la operación más común de la pantalla: pedir la lista
    // entera cada vez es justo lo que había que evitar.
    const { cmp, mock } = await listo();
    cmp.abrirModalNuevoTurno();
    await settle();
    expect(mock.llamadas.filter((c: string) => c === 'getClientes').length).toBe(1);
  });

  it('NO consulta la base por tecla', async () => {
    const { cmp, mock } = await listo();
    const antes = mock.llamadas.filter((c: string) => c === 'getClientes').length;
    for (const q of ['d', 'da', 'dan', 'danie', 'daniel']) {
      cmp.busquedaCliente = q;
      cmp.clientesBuscados;
    }
    expect(mock.llamadas.filter((c: string) => c === 'getClientes').length).toBe(antes);
  });

  it('filtra por fragmento del nombre', async () => {
    const { cmp } = await listo();
    cmp.busquedaCliente = 'dan';
    expect(cmp.clientesBuscados.map((c: any) => c.id)).toEqual([1]);
  });

  it('ignora acentos y mayúsculas, a diferencia del .ilike() de Postgres', async () => {
    const { cmp } = await listo();
    for (const q of ['maria', 'MARIA', 'María', 'jose', 'JOSE', 'DIAZ', 'díaz']) {
      cmp.busquedaCliente = q;
      expect(cmp.clientesBuscados.length).toBeGreaterThan(0);
    }
  });

  it('busca también por teléfono', async () => {
    const { cmp } = await listo();
    cmp.busquedaCliente = '3815';
    expect(cmp.clientesBuscados.map((c: any) => c.id)).toEqual([2]);
  });

  it('NO ofrece clientes inactivos', async () => {
    const { cmp } = await listo();
    cmp.busquedaCliente = 'inactivo';
    expect(cmp.clientesBuscados).toEqual([]);
  });

  it('sin texto no hay resultados', async () => {
    const { cmp } = await listo();
    cmp.busquedaCliente = '   ';
    expect(cmp.clientesBuscados).toEqual([]);
  });

  it('el resultado se limita a 8 para no alargar el popup', async () => {
    const muchos = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1, nombre: 'Cliente ' + i, telefonos: [], activo: true,
    }));
    const { cmp } = await listo({ getClientes: () => Promise.resolve(muchos) });
    cmp.busquedaCliente = 'cliente';
    expect(cmp.clientesBuscados.length).toBe(8);
  });

  it('si la carga falla, se puede igual crear el cliente', async () => {
    // Si reventara, el modal de Nuevo turno quedaría inutilizable sin poder dar
    // de alta al cliente que estabas buscando.
    const { cmp } = await listo({ getClientes: () => Promise.reject(new Error('red')) });
    expect(cmp.todosLosClientes).toEqual([]);
    expect(cmp.cargandoClientesBusqueda).toBe(false);
  });

  it('el cliente recién creado aparece al buscarlo de nuevo', async () => {
    // Como el buscador filtra contra la lista en memoria, si el nuevo no se
    // suma no aparece hasta recargar la página.
    let guardado: any = null;
    const { cmp } = await listo({
      crearCliente: (d: any) => { guardado = d; return Promise.resolve({ id: 99, nombre: d }); },
    });
    cmp.nombreNuevoCliente = 'Daniel Nuevo';
    await cmp.crearYSeleccionarCliente();

    expect(guardado).toBeTruthy();
    expect(cmp.todosLosClientes.some((c: any) => c.nombre === guardado)).toBe(true);
    // El punto: aparece al buscarlo.
    cmp.busquedaCliente = 'daniel nue';
    expect(cmp.clientesBuscados.map((c: any) => c.id)).toContain(99);
    // Y la lista sigue ordenada por nombre.
    const nombres = cmp.todosLosClientes.map((c: any) => c.nombre);
    expect(nombres).toEqual([...nombres].sort((a: string, b: string) => a.localeCompare(b, 'es')));
  });

  it('elegir un cliente NO borra el texto, solo lo completa', async () => {
    // Si se limpiara, habría que escribir de nuevo para cambiar de cliente.
    const { cmp } = await listo();
    cmp.seleccionarClienteNuevo({ id: 2, nombre: 'María Gómez', telefonos: [] });
    expect(cmp.clienteSeleccionadoNuevo.id).toBe(2);
    expect(cmp.busquedaCliente).toBe('María Gómez');
  });

  it('el DOM muestra los resultados filtrados, sin consulta nueva', async () => {
    const { fixture, mock } = await listo();
    fixture.detectChanges();
    const antes = mock.llamadas.length;

    // Se escribe en el campo de verdad, no se le asigna la propiedad: asignarla
    // dispara NG0100 porque el `[(ngModel)]` ya se había chequeado.
    const input = fixture.nativeElement.querySelector(
      '.popup-overlay input[placeholder*="Buscar cliente"]'
    );
    input.value = 'maria';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const popup = fixture.nativeElement.querySelector('.popup-overlay');
    expect(popup.querySelectorAll('.dropdown-busqueda .dropdown-item').length).toBe(1);
    expect(popup.textContent).toContain('María Gómez');
    // Lo importante: ni una llamada más a la base.
    expect(mock.llamadas.length).toBe(antes);
  });

  it('elegir un cliente OCULTA el campo, no deja el nombre editable', async () => {
    // Si el input quedara editable con el nombre ya cargado se desincronizaba
    // de `clienteSeleccionadoNuevo`: se veía "el cliente elegido" y se escribia otra
    // cosa, pero se guardaba Pamela.
    const { cmp, fixture } = await listo();
    fixture.detectChanges();
    cmp.seleccionarClienteNuevo({ id: 1, nombre: 'Pamela Agüero', telefonos: [] });
    fixture.detectChanges();

    const popup = fixture.nativeElement.querySelector('.popup-overlay');
    expect(popup.querySelectorAll('input[placeholder*="Buscar cliente"]').length).toBe(0);
    expect(popup.querySelectorAll('.seleccionado-ok').length).toBe(1);
    // Y el desplegable no queda abierto abajo del OK.
    expect(popup.querySelectorAll('.dropdown-busqueda').length).toBe(0);
    expect(popup.querySelectorAll('.crear-inline').length).toBe(0);
  });

  it('"Cambiar" vuelve al buscador y deselecciona', async () => {
    const { cmp, fixture } = await listo();
    fixture.detectChanges();
    cmp.seleccionarClienteNuevo({ id: 1, nombre: 'Pamela Agüero', telefonos: [] });
    fixture.detectChanges();

    const popup = fixture.nativeElement.querySelector('.popup-overlay');
    popup.querySelector('.seleccionado-ok button').click();
    fixture.detectChanges();

    expect(cmp.clienteSeleccionadoNuevo).toBeNull();
    expect(cmp.busquedaCliente).toBe('');
    expect(popup.querySelectorAll('input[placeholder*="Buscar cliente"]').length).toBe(1);
  });

  it('el desplegable muestra el telefono y al elegir queda el nombre', async () => {
    // El desplegable muestra el telefono; al elegir desaparece, asi que el
    // nombre solo tiene que quedar legible en el OK.
    const { cmp, fixture } = await listo();
    fixture.detectChanges();
    tocar(fixture, 'daniel');

    const popup = fixture.nativeElement.querySelector('.popup-overlay');
    expect(popup.textContent).toContain('3764123456');

    cmp.seleccionarClienteNuevo(cmp.clientesBuscados[0]);
    fixture.detectChanges();
    expect(popup.textContent).toContain('Daniel Prueba');
  });

  it('crear un cliente lo deja ELEGIDO y cierra el buscador', async () => {
    // Mismo criterio que el proveedor del popup de compra: crear no obliga a
    // buscarlo de nuevo.
    let creado: any = null;
    const { cmp, fixture } = await listo({
      crearCliente: (d: any) => { creado = d; return Promise.resolve({ id: 99, nombre: d }); },
    });
    // Sin detectChanges en el medio a proposito: si se renderiza el form
    // abierto y despues el metodo lo cierra, Angular ve el cambio como
    // pasando en medio de un ciclo y tira NG0100 en modo desarrollo.
    cmp.busquedaCliente = 'Cliente Inexistente';
    cmp.mostrarFormNuevoCliente = true;
    cmp.nombreNuevoCliente = 'Cliente Inexistente';

    await cmp.crearYSeleccionarCliente();
    fixture.detectChanges();

    const popup = fixture.nativeElement.querySelector('.popup-overlay');
    expect(creado).toBeTruthy();
    expect(cmp.clienteSeleccionadoNuevo.id).toBe(99);
    // El buscador desaparece y queda el OK con el nombre: no hay que buscarlo
    // de nuevo para seguir con el turno.
    expect(popup.querySelectorAll('input[placeholder*="Buscar cliente"]').length).toBe(0);
    expect(popup.querySelectorAll('.seleccionado-ok').length).toBe(1);
    expect(cmp.mostrarFormNuevoCliente).toBe(false);
  });

  // BUG: el estado del form de crear se Filtraba entre aperturas del modal.
  //
  // `abrirModalNuevoTurno()` limpiaba `busquedaCliente` pero NO
  // `mostrarFormNuevoCliente` ni `nombreNuevoCliente`. O sea: se abria, se
  // buscaba un nombre inexistente, se tocaba "Crear", se escribia el nombre, se
  // cerraba el modal sin guardar, y al volver a abrir la cajita de crear ya
  // estaba ABIERTA con el texto del intento anterior.
  //
  // Pasaba desapercibido porque `busquedaCliente = ''` ocultaba el bloque (su
  // `*ngIf` exige texto). Se veía recien al volver a escribir algo que no
  // matcheaba: ahi la cajita aparecia sola, sin pasar por el boton "Crear".
  it('al reabrir, el form de crear NO queda abierto con el intento anterior', async () => {
    const { cmp, fixture } = await listo();

    // Se llega al estado problematico por el DOM REAL, no asignando las
    // propiedades: `[(ngModel)]` escribe el input en un microtask, y cambiar el
    // valor del componente con el form ya renderizado tira NG0100.
    tocar(fixture, 'Cliente Inexistente');
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.btn-crear-inline') as HTMLElement).click();
    fixture.detectChanges();

    const inputNombre = fixture.nativeElement.querySelector('.form-crear-inline input');
    inputNombre.value = 'Cliente Inexistente';
    inputNombre.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(cmp.mostrarFormNuevoCliente).toBe(true);
    expect(cmp.nombreNuevoCliente).toBe('Cliente Inexistente');

    // Salir del modal sin guardar...
    cmp.cerrarModalNuevoTurno();
    fixture.detectChanges();
    expect(cmp.mostrarModalNuevoTurno).toBe(false);

    // ...y volver a abrirlo tiene que arrancar limpio.
    cmp.abrirModalNuevoTurno();
    fixture.detectChanges();

    expect(cmp.mostrarFormNuevoCliente).toBe(false);
    expect(cmp.nombreNuevoCliente).toBe('');
    expect(cmp.busquedaCliente).toBe('');

    // Y al escribir una busqueda que no matchea, aparece el BOTON "Crear", no
    // la cajita ya abierta.
    tocar(fixture, 'Otro Inexistente');
    const popup = fixture.nativeElement.querySelector('.popup-overlay');
    expect(popup.querySelectorAll('.btn-crear-inline').length).toBe(1);
    expect(popup.querySelectorAll('.form-crear-inline').length).toBe(0);
  });

  // El mismo criterio que Caja, que SI lo limpia en `abrirFormCompra`.
  it('cerrar el modal y reabrirlo no deja el cliente elegido puesto', async () => {
    const { cmp, fixture } = await listo();
    cmp.seleccionarClienteNuevo({ id: 1, nombre: 'Daniel Prueba', telefonos: [] });
    fixture.detectChanges();
    expect(cmp.clienteSeleccionadoNuevo).toBeTruthy();

    cmp.cerrarModalNuevoTurno();
    fixture.detectChanges();
    cmp.abrirModalNuevoTurno();
    fixture.detectChanges();

    expect(cmp.clienteSeleccionadoNuevo).toBeNull();
  });
});
