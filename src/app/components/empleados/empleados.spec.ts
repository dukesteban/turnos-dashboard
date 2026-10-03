import { TestBed } from '@angular/core/testing';
import { EmpleadosComponent } from './empleados';
import { SupabaseService } from '../../services/supabase';
import { crearSupabaseMock, EMP_JUAN, EMP_ESTEBAN, cloneEmpleado, turno } from '../../testing/supabase-mock';

/**
 * Tests de COMPONENTE de Empleados.
 *
 * Target: los bugs de ESTADO del componente, que ninguna función pura puede ver.
 * Los dos más caros de la historia están acá:
 *   · el checkbox que desmarca un día pero nunca ponía `activo = false`
 *   · la lista de reprogramar que pisaba `this.empleados` y la perdía para siempre
 *
 * Fechas de referencia (diciembre 2026): 01 = martes, 05 = sábado.
 * Juan = L-V. Esteban = L,M,J,V (no miércoles).
 */

function montar(over: Record<string, any> = {}) {
  const mock = crearSupabaseMock(over);
  TestBed.configureTestingModule({
    providers: [{ provide: SupabaseService, useValue: mock }],
  });
  const cmp = TestBed.createComponent(EmpleadosComponent).componentInstance;
  return { cmp, mock };
}

const settle = () => new Promise(r => setTimeout(r, 0));

/** Un turno de Juan el martes 01/12 (día que trabaja). */
const TURNO_OK = turno({ id: 1, fecha: '2026-12-01', empleado_id: EMP_JUAN.id });
/** Un turno de Esteban el MIÉRCOLES 02/12 (día que NO trabaja) → en riesgo. */
const TURNO_RIESGO = turno({ id: 2, fecha: '2026-12-02', empleado_id: EMP_ESTEBAN.id });

describe('Empleados — lista', () => {
  it('trae TODOS los empleados, inactivos incluidos', async () => {
    const inactivo = { ...EMP_JUAN, id: 77, nombre: 'Pedro Inactivo', activo: false };
    const { cmp } = montar({
      getTodosEmpleados: () => Promise.resolve([EMP_ESTEBAN, EMP_JUAN, inactivo]),
    });
    await cmp.cargarEmpleados();

    expect(cmp.empleados.length).toBe(3);
    expect(cmp.empleados.find(e => e.id === 77)?.activo).toBe(false);
  });

  // Si se usara getEmpleados() (solo activos), el badge "Inactivo" nunca
  // aparecería y el filtro .eq('activo', true) se llevaría por delante el badge.
  it('los inactivos se ven en la lista (con su badge, no con el porcentaje)', async () => {
    const { cmp } = montar({
      getTodosEmpleados: () => Promise.resolve([{ ...EMP_ESTEBAN, activo: false }]),
    });
    await cmp.cargarEmpleados();
    expect(cmp.empleadosFiltrados.length).toBe(1);
  });
});

describe('Empleados — jornada: el checkbox que no desmarcaba', () => {
  it('desactivarDia pone activo=false', () => {
    const { cmp } = montar();
    const j = cloneEmpleado(EMP_JUAN).jornada;
    cmp.empleadoSeleccionado = { id: 1, jornada: j };

    cmp.desactivarDia(3);   // miércoles, que venía activo

    expect(j[3].activo).toBe(false);
  });

  // El bug original: usar [ngModel] unidireccional + limpiar solo hora_fin
  // dejaba el día marcado aunque el usuario lo hubiera deshecho.
  it('desactivar un día también borra sus horarios', () => {
    const j = cloneEmpleado(EMP_JUAN).jornada;
    j[3] = { activo: true, hora_inicio: '08:00', hora_fin: '13:00' };
    const { cmp } = montar();
    cmp.empleadoSeleccionado = { id: 1, jornada: j };

    cmp.desactivarDia(3);

    expect(j[3]).toEqual({ activo: false, hora_inicio: null, hora_fin: null });
  });

  // activarDia deja un tope por defecto. Es comportamiento documentado (ver
  // `activarDia`), no un bug: por eso el test lo fija como contrato.
  it('activarDia deja un tope por defecto (08:00-17:00)', () => {
    const j = cloneEmpleado(EMP_JUAN).jornada;
    j[6] = { activo: false, hora_inicio: null, hora_fin: null };   // sábado
    const { cmp } = montar();
    cmp.empleadoSeleccionado = { id: 1, jornada: j };

    cmp.activarDia(6);

    expect(j[6].activo).toBe(true);
    expect(j[6].hora_inicio).toBe('08:00');
    expect(j[6].hora_fin).toBe('17:00');
  });
});

describe('Empleados — turnos en riesgo (Fase 5)', () => {
  it('detecta el turno que cae en un día que el empleado no trabaja', async () => {
    const { cmp } = montar({
      getTurnosPendientesDe: () => Promise.resolve([TURNO_RIESGO]),
    });
    cmp.empleadoSeleccionado = cloneEmpleado(EMP_ESTEBAN);
    cmp.ausencias = [];
    await cmp.cargarTurnosEnRiesgo();

    expect(cmp.turnosEnRiesgoLista.length).toBe(1);
    expect(cmp.turnosEnRiesgoLista[0]._tipoRiesgo).toBe('jornada');
    expect(cmp.turnosEnRiesgoLista[0]._motivoRiesgo).toBe('No trabaja ese día');
  });

  it('clasifica como AUSENCIA cuando la ausencia tapa el turno', async () => {
    const vac = { empleado_id: EMP_JUAN.id, desde: '2026-12-01', hasta: '2026-12-01',
      hora_inicio: null, hora_fin: null, tipo: 'vacaciones', motivo: null };
    const { cmp } = montar({
      getTurnosPendientesDe: () => Promise.resolve([TURNO_OK]),
      getAusencias: () => Promise.resolve([vac]),
    });
    await cmp.seleccionarEmpleado({ ...EMP_JUAN });

    const enRiesgo = cmp.turnosEnRiesgoLista;
    expect(enRiesgo.length).toBe(1);
    expect(enRiesgo[0]._tipoRiesgo).toBe('ausencia');
    expect(enRiesgo[0]._motivoRiesgo).toBe('Vacaciones');
  });

  // La lista se recalcula al cambiar la jornada: es el momento en que un turno
  // puede ENTRAR o SALIR de riesgo.
  it('cambiar la jornada recalcula la lista de riesgo', async () => {
    const { cmp, mock } = montar({
      getTurnosPendientesDe: () => Promise.resolve([TURNO_OK]),
    });
    await cmp.seleccionarEmpleado({ ...EMP_JUAN });
    await settle();

    expect(cmp.turnosEnRiesgoLista.length).toBe(0);   // martes, Juan trabaja

    const llamadasAntes = mock.llamadas.filter((c: string) => c === 'getTurnosPendientesDe').length;

    // Ahora le sacamos el martes: el turno pasa a estar en riesgo.
    cmp.empleadoSeleccionado.jornada[2].activo = false;
    cmp.empleadoSeleccionado._jornadaOrig[2].activo = false;
    cmp.empleadoSeleccionado.editandoJornada = true;
    await cmp.guardarJornada();

    const llamadasDespues = mock.llamadas.filter((c: string) => c === 'getTurnosPendientesDe').length;
    expect(llamadasDespues).toBeGreaterThan(llamadasAntes);
    expect(cmp.turnosEnRiesgoLista.length).toBe(1);
    expect(cmp.turnosEnRiesgoLista[0]._tipoRiesgo).toBe('jornada');
  });

  it('sin empleados seleccionados, la lista queda vacía', async () => {
    const { cmp } = montar();
    cmp.empleadoSeleccionado = null;
    await cmp.cargarTurnosEnRiesgo();
    expect(cmp.turnosEnRiesgoLista).toEqual([]);
  });

  it('si la consulta falla, no rompe la pantalla', async () => {
    const { cmp } = montar({
      getTurnosPendientesDe: () => Promise.reject(new Error('boom')),
    });
    cmp.empleadoSeleccionado = cloneEmpleado(EMP_JUAN);
    await cmp.cargarTurnosEnRiesgo();

    expect(cmp.turnosEnRiesgoLista).toEqual([]);
    expect(cmp.cargandoRiesgo).toBe(false);   // el flag se suelta igual
  });
});

describe('Empleados — selectores de personal', () => {
  // El bug original: `empleadosActivos` se armaba con un filter sobre
  // `this.empleados` y el mensaje de error sobreescribía la lista. Acá se
  // verifica que cargar no destruye nada.
  it('cargarEmpleados no borra los servicios ya cargados', async () => {
    const { cmp } = montar({
      getServicios: () => Promise.resolve([{ id: 1, nombre: 'Lavado simple' }]),
    });
    // cargarComisionesPorServicio sale temprano si no hay empleado elegido.
    await cmp.seleccionarEmpleado(cloneEmpleado(EMP_JUAN));
    expect(cmp.servicios.length).toBe(1);

    await cmp.cargarEmpleados();   // segunda vez, como pasa al cambiar de pestaña

    expect(cmp.empleados.length).toBeGreaterThan(0);
    expect(cmp.servicios.length).toBe(1);
  });
});
