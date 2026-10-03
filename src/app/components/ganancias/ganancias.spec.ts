import { TestBed } from '@angular/core/testing';
import { GananciasComponent } from './ganancias';
import { SupabaseService } from '../../services/supabase';
import { crearSupabaseMock, ganancia } from '../../testing/supabase-mock';

/**
 * Tests de Ganancias.
 *
 * Esta pantalla casi no escribe: todo son getters que arman el gráfico y las
 * tarjetas. El riesgo real NO es "que se rompa", son dos cosas:
 *
 *   1. Los getters devuelven `null` / `"undefined"` / la palabra `"null"` en vez
 *      de un texto, y la pantalla lo muestra tal cual. Pasa en los getters que
 *      usan la propiedad cruda como clave de un objeto.
 *   2. La navegación por meses, que es aritmética de `Date` y tiene trampas
 *      conocidas (31 de enero + 1 mes = 3 de marzo).
 */

function montar(over: Record<string, any> = {}) {
  const mock = crearSupabaseMock(over);
  TestBed.configureTestingModule({
    providers: [{ provide: SupabaseService, useValue: mock }],
  });
  const cmp = TestBed.createComponent(GananciasComponent).componentInstance;
  return { cmp, mock };
}

/** mocked sincrónico: el mock devuelve promesas ya resueltas. */
const settle = () => new Promise(r => setTimeout(r, 0));

describe('Ganancias — carga', () => {
  it('carga los horarios y los datos al iniciar', async () => {
    const { cmp } = montar();
    await cmp.ngOnInit();
    expect(cmp.horaInicio).toBe(8);
    expect(cmp.horaFin).toBe(20);
    expect(cmp.cargando).toBe(false);
  });

  it('deriva horaInicio/horaFin del MIN y MAX de los horarios activos', async () => {
    const { cmp } = montar({
      getHorarios: () => Promise.resolve([
        { dia_semana: 1, hora_inicio: '09:00', hora_fin: '13:00', activo: true },
        { dia_semana: 2, hora_inicio: '07:30', hora_fin: '17:00', activo: true },
        // inactivos: NO cuentan para el rango, pero el grafico tiene que
        // seguir mostrando lo que hay
        { dia_semana: 0, hora_inicio: '00:00', hora_fin: '23:59', activo: false },
      ]),
    });
    await cmp.cargarHorarios();
    expect(cmp.horaInicio).toBe(7);
    expect(cmp.horaFin).toBe(17);
  });

  it('redondea hacia arriba la hora de fin si tiene minutos', async () => {
    // 20:30 -> la barra necesita cubrir hasta las 21:00
    const { cmp } = montar({
      getHorarios: () => Promise.resolve([
        { dia_semana: 1, hora_inicio: '08:00', hora_fin: '20:30', activo: true },
      ]),
    });
    await cmp.cargarHorarios();
    expect(cmp.horaFin).toBe(21);
  });

  it('si no hay horarios, deja los defaults sin romper', async () => {
    const { cmp } = montar({ getHorarios: () => Promise.resolve([]) });
    await cmp.cargarHorarios();
    expect(cmp.horaInicio).toBe(8);
    expect(cmp.horaFin).toBe(20);
  });

  it('cargarDatos baja el flag `cargando` aunque getGanancias devuelva vacío', async () => {
    const { cmp } = montar({ getGanancias: () => Promise.resolve([]) });
    await cmp.cargarDatos();
    expect(cmp.cargando).toBe(false);
    expect(cmp.turnos).toEqual([]);
  });
});

describe('Ganancias — totales', () => {
  it('totalGanancias suma precio_final si existe, si no precio', () => {
    const { cmp } = montar();
    cmp.turnos = [
      ganancia({ precio: 10000, precio_final: 12000 }),
      ganancia({ precio: 8000, precio_final: null }),   // usa precio
    ];
    expect(cmp.totalGanancias).toBe(20000);
  });

  it('totalGanancias no se rompe con precio null ni texto', () => {
    const { cmp } = montar();
    cmp.turnos = [ganancia({ precio: null, precio_final: null })];
    expect(cmp.totalGanancias).toBe(0);
  });

  it('totalAtendidos cuenta los turnos que trajo la consulta', () => {
    const { cmp } = montar();
    cmp.turnos = [ganancia(), ganancia(), ganancia()];
    expect(cmp.totalAtendidos).toBe(3);
  });

  it('totalPorMetodoPago agrupa, suma y ordena de MAYOR total a menor', () => {
    const { cmp } = montar();
    cmp.turnos = [
      ganancia({ metodo_pago: 'Efectivo', precio: 1000 }),
      ganancia({ metodo_pago: 'Tarjeta', precio: 5000 }),
      ganancia({ metodo_pago: 'Efectivo', precio: 2000 }),
    ];
    const r = cmp.totalPorMetodoPago;
    // Ordena por plata, no por cantidad: Tarjeta (5000) antes que Efectivo (3000).
    expect(r[0].metodo).toBe('Tarjeta');
    expect(r[0].total).toBe(5000);
    expect(r[1].metodo).toBe('Efectivo');
    expect(r[1].cantidad).toBe(2);
    expect(r[1].total).toBe(3000);
  });

  it('los turnos sin metodo_pago van al grupo "Sin registrar", no a una clave "null"', () => {
    const { cmp } = montar();
    cmp.turnos = [ganancia({ metodo_pago: null, precio: 1000 })];
    const r = cmp.totalPorMetodoPago;
    expect(r.length).toBe(1);
    expect(r[0].metodo).toBe('Sin registrar');
  });

  it('metodoPagoMasUsado cae en "Sin registrar", no en el texto "null"', () => {
    // BUG ARREGlado: el getter usaba `conteo[t.metodo_pago]` sin fallback, asi
    // que con metodo_pago null la clave era la string "null" y la tarjeta de la
    // pantalla mostraba literalmente la palabra null.
    const { cmp } = montar();
    cmp.turnos = [ganancia({ metodo_pago: null }), ganancia({ metodo_pago: null })];
    expect(cmp.metodoPagoMasUsado).toBe('Sin registrar');
  });

  it('metodoPagoMasUsado elige el mas repetido, no el de mayor total', () => {
    const { cmp } = montar();
    cmp.turnos = [
      ganancia({ metodo_pago: 'Efectivo', precio: 100 }),      // 1 vez, $
      ganancia({ metodo_pago: 'Tarjeta', precio: 100000 }),
      ganancia({ metodo_pago: 'Tarjeta', precio: 100000 }),
    ];
    expect(cmp.metodoPagoMasUsado).toBe('Tarjeta');
  });

  it('metodoPagoMasUsado y servicioMasVendido devuelven "-" sin datos', () => {
    const { cmp } = montar();
    cmp.turnos = [];
    expect(cmp.metodoPagoMasUsado).toBe('-');
    expect(cmp.servicioMasVendido).toBe('-');
  });

  it('servicioMasVendido prefiere el nombre final sobre el original', () => {
    const { cmp } = montar();
    cmp.turnos = [
      ganancia({ servicio_nombre: 'Lavado simple', servicio_nombre_final: 'Lavado premium' }),
    ];
    expect(cmp.servicioMasVendido).toBe('Lavado premium');
  });

  it('servicioMasVendido cae en "Sin especificar" si no hay ningun nombre', () => {
    const { cmp } = montar();
    cmp.turnos = [ganancia({ servicio_nombre: null, servicio_nombre_final: null })];
    expect(cmp.servicioMasVendido).toBe('Sin especificar');
  });

  it('totalPorServicio solo mira los atendidos y ordena por total', () => {
    const { cmp } = montar();
    cmp.turnos = [
      ganancia({ estado: 'atendido', servicio_nombre: 'A', precio: 100 }),
      ganancia({ estado: 'atendido', servicio_nombre: 'B', precio: 9000 }),
      ganancia({ estado: 'pendiente', servicio_nombre: 'C', precio: 500000 }),
    ];
    const r = cmp.totalPorServicio;
    expect(r.length).toBe(2);        // C excluido: no esta atendido
    expect(r[0].nombre).toBe('B');
  });
});

describe('Ganancias — rangos de fecha', () => {
  it('vista dia: desde y hasta son el mismo dia', () => {
    const { cmp } = montar();
    cmp.vista = 'dia';
    cmp.fechaActual = new Date(2026, 9, 2);   // 2 de octubre
    expect(cmp.getRango()).toEqual({ desde: '2026-10-02', hasta: '2026-10-02' });
  });

  it('vista mes: del 1 al ULTIMO dia del mes', () => {
    const { cmp } = montar();
    cmp.vista = 'mes';
    cmp.fechaActual = new Date(2026, 1, 15);   // febrero 2026
    expect(cmp.getRango()).toEqual({ desde: '2026-02-01', hasta: '2026-02-28' });
  });

  it('vista mes: febrero bisiesto llega al 29', () => {
    const { cmp } = montar();
    cmp.vista = 'mes';
    cmp.fechaActual = new Date(2028, 1, 10);
    expect(cmp.getRango().hasta).toBe('2028-02-29');
  });

  it('vista mes: enero cierra el 31', () => {
    const { cmp } = montar();
    cmp.vista = 'mes';
    cmp.fechaActual = new Date(2026, 0, 31);
    expect(cmp.getRango()).toEqual({ desde: '2026-01-01', hasta: '2026-01-31' });
  });
});

describe('Ganancias — grafico', () => {
  it('vista dia: una barra por hora, del inicio al fin del horario', () => {
    const { cmp } = montar();
    cmp.vista = 'dia';
    cmp.horaInicio = 8;
    cmp.horaFin = 11;
    cmp.turnos = [];
    const g = cmp.datosGrafico;
    expect(g.map(d => d.label)).toEqual(['8:00', '9:00', '10:00', '11:00']);
  });

  it('vista dia: un turno MAS TARDE que el horario solo estira hacia arriba', () => {
    const { cmp } = montar();
    cmp.vista = 'dia';
    cmp.horaInicio = 9;
    cmp.horaFin = 10;
    cmp.turnos = [ganancia({ hora_inicio: '12:00:00', hora: '12:00:00' })];
    const labels = cmp.datosGrafico.map(d => d.label);
    expect(labels[0]).toBe('9:00');   // el min NO se toca
    expect(labels[labels.length - 1]).toBe('12:00');
  });

  it('vista dia: un turno MAS TEMPRANO que el horario solo estira hacia abajo', () => {
    const { cmp } = montar();
    cmp.vista = 'dia';
    cmp.horaInicio = 9;
    cmp.horaFin = 10;
    cmp.turnos = [ganancia({ hora_inicio: '07:30:00', hora: '07:30:00' })];
    const labels = cmp.datosGrafico.map(d => d.label);
    expect(labels[0]).toBe('7:00');
    expect(labels[labels.length - 1]).toBe('10:00');   // el max NO se toca
  });

  it('vista dia: los atendidos usan precio_final, los pendientes usan precio', () => {
    const { cmp } = montar();
    cmp.vista = 'dia';
    cmp.horaInicio = 10;
    cmp.horaFin = 10;
    cmp.turnos = [
      ganancia({ hora_inicio: '10:00:00', hora: '10:00:00', estado: 'atendido', precio: 100, precio_final: 999 }),
      ganancia({ hora_inicio: '10:00:00', hora: '10:00:00', estado: 'pendiente', precio: 555, precio_final: null }),
    ];
    const barra = cmp.datosGrafico.find(d => d.label === '10:00')!;
    expect(barra.total).toBe(999 + 555);
    expect(barra.cantidad).toBe(2);
  });

  it('vista dia: los segundos de la hora no crean una barra nueva', () => {
    const { cmp } = montar();
    cmp.vista = 'dia';
    cmp.horaInicio = 14;
    cmp.horaFin = 14;
    cmp.turnos = [ganancia({ hora_inicio: '14:45:00', hora: '14:45:00' })];
    const g = cmp.datosGrafico;
    expect(g.length).toBe(1);
    expect(g[0].total).toBeGreaterThan(0);
  });

  it('vista mes: una barra por dia del mes', () => {
    const { cmp } = montar();
    cmp.vista = 'mes';
    cmp.fechaActual = new Date(2026, 1, 1);   // febrero: 28 dias
    cmp.turnos = [];
    const g = cmp.datosGrafico;
    expect(g.length).toBe(28);
    expect(g[0].label).toBe('01');
    expect(g[27].label).toBe('28');
  });

  it('vista mes: los turnos caen en la barra de SU dia', () => {
    const { cmp } = montar();
    cmp.vista = 'mes';
    cmp.fechaActual = new Date(2026, 9, 1);
    cmp.turnos = [ganancia({ fecha: '2026-10-15' })];
    const g = cmp.datosGrafico;
    expect(g.find(d => d.label === '15')!.cantidad).toBe(1);
    expect(g.find(d => d.label === '01')!.cantidad).toBe(0);
  });

  it('vista mes: un turno con fecha rota no rompe (se ignora, no lanza)', () => {
    const { cmp } = montar();
    cmp.vista = 'mes';
    cmp.fechaActual = new Date(2026, 9, 1);
    cmp.turnos = [ganancia({ fecha: 'basura' }), ganancia({ fecha: null })];
    expect(() => cmp.datosGrafico).not.toThrow();
    expect(cmp.datosGrafico.every(d => d.total === 0)).toBe(true);
  });

  it('maxGrafico nunca da 0 (evita division por cero en el ancho de las barras)', () => {
    const { cmp } = montar();
    cmp.vista = 'dia';
    cmp.horaInicio = 9;
    cmp.horaFin = 9;
    cmp.turnos = [];
    expect(cmp.maxGrafico).toBe(1);
  });
});

describe('Ganancias — navegacion', () => {
  it('navegar en vista dia suma un dia', () => {
    const { cmp } = montar();
    cmp.vista = 'dia';
    cmp.fechaActual = new Date(2026, 9, 30);
    cmp.navegar(1);
    expect(cmp.fechaActual.getDate()).toBe(31);
  });

  it('navegar en vista dia CRUZA el mes bien', () => {
    const { cmp } = montar();
    cmp.vista = 'dia';
    cmp.fechaActual = new Date(2026, 9, 31);   // 31 de octubre
    cmp.navegar(1);
    expect(cmp.fechaActual.getMonth()).toBe(10);  // noviembre
    expect(cmp.fechaActual.getDate()).toBe(1);
  });

  it('navegar en vista mes suma un mes', () => {
    const { cmp } = montar();
    cmp.vista = 'mes';
    cmp.fechaActual = new Date(2026, 0, 15);
    cmp.navegar(1);
    expect(cmp.fechaActual.getMonth()).toBe(1);
  });

  it('navegar en vista mes desde el 31 NO se salta de mes', () => {
    // BUG: Date.setMonth(1) sobre 31 de enero landing en "31 de febrero", que
    // JS normaliza a 3 de marzo. El usuario ve SALTA de enero a marzo. Se
    // arregla clampeando al ultimo dia del mes destino.
    const { cmp } = montar();
    cmp.vista = 'mes';
    cmp.fechaActual = new Date(2026, 0, 31);   // 31 de enero
    cmp.navegar(1);
    expect(cmp.fechaActual.getMonth()).toBe(1);  // tiene que quedar en febrero
    expect(cmp.fechaActual.getDate()).toBeLessThanOrEqual(28);
  });

  it('navegar recarga los datos del nuevo periodo', async () => {
    const { cmp, mock } = montar();
    cmp.vista = 'mes';
    cmp.fechaActual = new Date(2026, 0, 15);
    cmp.navegar(1);
    await settle();
    expect(mock.llamadas.filter((c: string) => c === 'getGanancias').length).toBeGreaterThan(0);
  });

  it('irADia salta a ese dia y cambia a vista dia', async () => {
    const { cmp } = montar();
    cmp.vista = 'mes';
    cmp.fechaActual = new Date(2026, 9, 1);   // octubre 2026
    cmp.irADia('15');
    await settle();
    expect(cmp.vista).toBe('dia');
    expect(cmp.fechaActual.getDate()).toBe(15);
    expect(cmp.fechaActual.getMonth()).toBe(9);
  });

  it('irADia no hace nada en vista dia', () => {
    const { cmp } = montar();
    cmp.vista = 'dia';
    const antes = cmp.fechaActual;
    cmp.irADia('15');
    expect(cmp.fechaActual).toBe(antes);
  });

  it('cambiarVista actualiza la vista y reinicia a hoy', () => {
    const { cmp } = montar();
    cmp.vista = 'mes';
    cmp.fechaActual = new Date(2000, 0, 1);
    cmp.cambiarVista('dia');
    expect(cmp.vista).toBe('dia');
    expect(cmp.fechaActual.getFullYear()).toBe(new Date().getFullYear());
  });
});

describe('Ganancias — titulo', () => {
  it('vista dia muestra el nombre del dia y dd/mm', () => {
    const { cmp } = montar();
    cmp.vista = 'dia';
    cmp.fechaActual = new Date(2026, 9, 2);   // viernes
    expect(cmp.tituloFecha).toBe('Viernes 02/10');
  });

  it('vista mes muestra el nombre del mes con el anio', () => {
    const { cmp } = montar();
    cmp.vista = 'mes';
    cmp.fechaActual = new Date(2026, 9, 2);
    expect(cmp.tituloFecha).toMatch(/octubre/i);
    expect(cmp.tituloFecha).toMatch(/2026/);
  });
});
