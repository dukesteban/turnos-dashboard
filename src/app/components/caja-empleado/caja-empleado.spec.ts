import { TestBed } from '@angular/core/testing';
import { CajaEmpleadoComponent } from './caja-empleado';
import { AuthService } from '../../services/auth';
import { SupabaseService } from '../../services/supabase';
import {
  crearSupabaseMock, crearAuthMock, EMP_JUAN, EMP_ESTEBAN, ganancia,
} from '../../testing/supabase-mock';

/**
 * Tests de "Mi caja".
 *
 * La pantalla tiene dos riesgos, y los dos son de plata:
 *
 *   1. Que se cuele un turno o un pago de OTRO empleado. Acá no hay selector:
 *      el filtro es lo único que separa "mi caja" de "la caja del local".
 *   2. Que la comisión se calcule con el porcentaje equivocado. El específico
 *      por servicio pisa al general; invertir el orden paga de menos o de más.
 */

const PAGO = (over: Record<string, any> = {}) => ({
  id: 1, empleado_id: EMP_JUAN.id, fecha: '2026-10-05', monto: 5000,
  metodo: 'efectivo', notas: null,
  ...over,
});

function montar(over: Record<string, any> = {}, authOver: Record<string, any> = {}) {
  const mock = crearSupabaseMock(over);
  const auth = crearAuthMock({
    getRol: () => 'empleado',
    esAdmin: () => false,
    esSecretario: () => false,
    esEmpleado: () => true,
    getEmpleadoId: () => EMP_JUAN.id,
    soloSusTurnos: () => true,
    empleadoParaFiltrarTurnos: () => EMP_JUAN.id,
    puedeVer: () => false,
    puedeEscribirCaja: () => false,
    ...authOver,
  });

  TestBed.configureTestingModule({
    providers: [
      { provide: SupabaseService, useValue: mock },
      { provide: AuthService, useValue: auth },
    ],
  });

  const fixture = TestBed.createComponent(CajaEmpleadoComponent);
  return { cmp: fixture.componentInstance, mock, fixture };
}

/** Monta y deja correr `ngOnInit`, que es lo que trae los datos. */
async function montarCargado(over: Record<string, any> = {}, authOver: Record<string, any> = {}) {
  const r = montar(over, authOver);
  await r.cmp.ngOnInit();
  return r;
}

const TURNOS = [
  // Dos de Juan, con servicios distintos para probar los dos porcentajes.
  ganancia({ id: 1, empleado_id: EMP_JUAN.id, servicio_id: 1, precio: 12000 }),
  ganancia({ id: 2, empleado_id: EMP_JUAN.id, servicio_id: 2, precio: 20000 }),
  // Uno de Esteban: NO tiene que aparecer ni sumar.
  ganancia({ id: 3, empleado_id: EMP_ESTEBAN.id, servicio_id: 1, precio: 99999 }),
];

const PAGOS = [
  PAGO({ id: 1, monto: 5000 }),
  PAGO({ id: 2, empleado_id: EMP_ESTEBAN.id, monto: 7000 }),
];

const COMISIONES = [
  // Juan cobra 40% en el servicio 2; en el resto, su 15% general.
  { empleado_id: EMP_JUAN.id, servicio_id: 2, porcentaje: 40 },
];

function datos(over: Record<string, any> = {}) {
  return {
    getGanancias: () => Promise.resolve(TURNOS),
    getPagosEmpleado: () => Promise.resolve(PAGOS),
    getComisionesEmpleado: () => Promise.resolve(COMISIONES),
    getTodosEmpleados: () => Promise.resolve([EMP_JUAN, EMP_ESTEBAN]),
    ...over,
  };
}

describe('Mi caja — solo lo mío', () => {
  it('descarta los turnos de otro empleado', async () => {
    const { cmp } = await montarCargado(datos());

    expect(cmp.turnos.length).toBe(2);
    expect(cmp.turnos.every((t: any) => t.empleado_id === EMP_JUAN.id)).toBe(true);
  });

  it('descarta los pagos de otro empleado', async () => {
    const { cmp } = await montarCargado(datos());

    expect(cmp.pagos.length).toBe(1);
    expect(cmp.totalPagado).toBe(5000);
  });

  it('con la URL a mano y sin empleado_id no muestra nada', async () => {
    const { cmp } = await montarCargado(datos(), { getEmpleadoId: () => null });

    expect(cmp.turnos).toEqual([]);
    expect(cmp.pagos).toEqual([]);
    expect(cmp.totalComisiones).toBe(0);
  });
});

describe('Mi caja — comisiones', () => {
  it('usa el porcentaje POR SERVICIO y, si no hay, el general', async () => {
    const { cmp } = await montarCargado(datos());

    // 12.000 al 15% = 1.800 · 20.000 al 40% = 8.000
    expect(cmp.comisionesDetalle.length).toBe(2);
    expect(cmp.comisionesDetalle.find((c) => c.precio === 12000)?.comision).toBe(1800);
    expect(cmp.comisionesDetalle.find((c) => c.precio === 20000)?.comision).toBe(8000);
    expect(cmp.totalComisiones).toBe(9800);
  });

  it('ordena los turnos con el más nuevo arriba', async () => {
    const { cmp } = await montarCargado(datos({
      getGanancias: () => Promise.resolve([
        ganancia({ id: 1, empleado_id: EMP_JUAN.id, fecha: '2026-10-02', hora_inicio: '09:00:00', precio: 1000 }),
        ganancia({ id: 2, empleado_id: EMP_JUAN.id, fecha: '2026-10-09', hora_inicio: '11:00:00', precio: 1000 }),
      ]),
    }));

    expect(cmp.comisionesDetalle[0].fecha).toBe('2026-10-09');
    expect(cmp.comisionesDetalle[1].fecha).toBe('2026-10-02');
  });

  it('ordena los pagos con el más nuevo arriba', async () => {
    const { cmp } = await montarCargado(datos({
      getPagosEmpleado: () => Promise.resolve([
        PAGO({ id: 1, fecha: '2026-10-02', monto: 1000 }),
        PAGO({ id: 2, fecha: '2026-10-09', monto: 2000 }),
      ]),
    }));

    expect(cmp.pagosOrdenados[0].fecha).toBe('2026-10-09');
  });
});

describe('Mi caja — saldo', () => {
  it('con turnos sin pagar, queda "A cobrar"', async () => {
    const { cmp } = await montarCargado(datos());

    expect(cmp.saldoPendiente).toBe(9800 - 5000);
    expect(cmp.textoSaldo).toBe('A cobrar');
  });

  it('si le pagaron todo, queda "Al día" y en cero', async () => {
    const { cmp } = await montarCargado(datos({
      getPagosEmpleado: () => Promise.resolve([PAGO({ monto: 9800 })]),
    }));

    expect(cmp.saldoPendiente).toBe(0);
    expect(cmp.textoSaldo).toBe('Al día');
  });

  it('si le pagaron de más, NO muestra un número negativo', async () => {
    const { cmp } = await montarCargado(datos({
      getPagosEmpleado: () => Promise.resolve([PAGO({ monto: 15000 })]),
    }));

    expect(cmp.saldoPendiente).toBe(0);
    expect(cmp.textoSaldo).toBe('Al día');
  });
});

describe('Mi caja — período', () => {
  it('el mes va del 1 al último día', async () => {
    const { cmp } = await montarCargado(datos());
    cmp.vista = 'mes';
    cmp.fechaActual = new Date(2026, 1, 15); // febrero 2026

    expect(cmp.getRango()).toEqual({ desde: '2026-02-01', hasta: '2026-02-28' });
  });

  it('la semana va de lunes a domingo', async () => {
    const { cmp } = await montarCargado(datos());
    cmp.vista = 'semana';
    cmp.fechaActual = new Date(2026, 11, 2); // miércoles 02/12/2026

    expect(cmp.getRango()).toEqual({ desde: '2026-11-30', hasta: '2026-12-06' });
  });

  it('un domingo NO salta a la semana siguiente', async () => {
    const { cmp } = await montarCargado(datos());
    cmp.vista = 'semana';
    cmp.fechaActual = new Date(2026, 11, 6); // domingo 06/12/2026

    expect(cmp.getRango().desde).toBe('2026-11-30');
  });

  it('navegar un mes desde el 31 no salta dos meses', async () => {
    const { cmp } = await montarCargado(datos());
    cmp.vista = 'mes';
    cmp.fechaActual = new Date(2026, 0, 31); // 31/01/2026

    cmp.navegar(1);

    // Febrero no tiene 31: se queda en el 28, no en el 3 de marzo.
    expect(cmp.fechaActual.getMonth()).toBe(1);
    expect(cmp.fechaActual.getDate()).toBe(28);
  });
});
