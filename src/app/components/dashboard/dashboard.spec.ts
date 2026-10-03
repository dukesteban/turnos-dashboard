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
