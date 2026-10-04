import { TestBed } from '@angular/core/testing';
import { AgendaComponent } from './agenda';
import { SupabaseService } from '../../services/supabase';
import {
  crearSupabaseMock, EMP_JUAN, EMP_ESTEBAN, EMP_INACTIVO, turno,
} from '../../testing/supabase-mock';

/**
 * Tests de COMPONENTE de la Agenda.
 *
 * Estos apuntan a la clase de bug que más mordió: los que NO viven en una
 * función pura sino en el estado del componente. Los 15 bugs anteriores
 * (selector decorativo, cache vacía, flags que no se resetean) eran de esta
 * clase, y ninguna función de `utils/` los hubiera agarrado.
 *
 * Fechas de referencia (diciembre 2026): 05 = sábado, 07 = lunes,
 * 01 = martes. Juan = L-V, Esteban = L,M,J,V (no miércoles).
 */

function montar(over: Record<string, any> = {}) {
  const mock = crearSupabaseMock(over);
  TestBed.configureTestingModule({
    providers: [{ provide: SupabaseService, useValue: mock }],
  });
  // Se devuelve el fixture y no solo la instancia: hay tests que necesitan
  // mirar el DOM renderizado (las bandas de columna de la vista Semana).
  const fixture = TestBed.createComponent(AgendaComponent);
  const cmp = fixture.componentInstance;
  return { cmp, mock, fixture };
}

/** Deja que los `await` de ngOnInit terminen. */
const settle = () => new Promise(r => setTimeout(r, 0));

/** Mueve la agenda a una fecha concreta y limpia la cache de columnas. */
const irA = (cmp: any, y: number, m: number, d: number) => {
  cmp.fechaActual = new Date(y, m - 1, d);
  cmp.limpiarCacheColumnas();
};

describe('Agenda — carga inicial', () => {
  it('trae los empleados y arma la cache de jornadas', async () => {
    const { cmp } = montar();
    await cmp.ngOnInit();
    await settle();

    expect(cmp.empleados.length).toBe(2);
    expect(cmp.jornadaDe(EMP_JUAN.id).length).toBe(7);
    expect(cmp.jornadaDe(EMP_ESTEBAN.id).length).toBe(7);
  });

  // REGRESIÓN: el getter columnasAgenda se evalúa en un render temprano, cuando
  // this.empleados todavía está vacío, y cacheaba un [] que nadie invalidaba.
  // El build, el typecheck y los tests de utils pasaban igual: la grilla quedaba
  // vacía sin que nada lo detectara.
  //
  // QUÉ GARANTIZA ESTE TEST: que las columnas aparezcan DESPUÉS de cargar.
  // Verificado rompiendo el código: quitar las DOS limpiezas de cache lo pone
  // en rojo. Quitar solo una no lo detecta, porque en esta secuencia cualquiera
  // de las dos alcanza. Para cubrir esa mitad haría falta simular los renders
  // intermedios de Angular, que un test de componente no reproduce.
  it('las columnas NO quedan cacheadas como vacías tras cargar los empleados', async () => {
    const { cmp } = montar();
    irA(cmp, 2026, 12, 7);   // lunes: labran los dos. Importante: la fecha por
                              // defecto es HOY y podria ser un dia sin gente.
    const columnasTempranas = cmp.columnasAgenda.length;

    await cmp.ngOnInit();
    await settle();

    expect(columnasTempranas).toBe(0);       // todavia no habia empleados
    expect(cmp.columnasAgenda.length).toBe(2); // y despues SI
  });

  it('no consulta la tabla `puestos` en ningún momento', async () => {
    const { cmp, mock } = montar();
    await cmp.ngOnInit();
    await settle();
    cmp.columnasAgenda;

    expect(mock.llamadas.filter((c: string) => /puesto/i.test(c))).toEqual([]);
  });
});

describe('Agenda — regla de columnas por fecha', () => {
  it('día que ambos trabajan: dos columnas, alfabéticas', async () => {
    const { cmp } = montar();
    await cmp.ngOnInit(); await settle();
    irA(cmp, 2026, 12, 7);   // lunes

    expect(cmp.columnasAgenda.map(c => c.empleado.nombre))
      .toEqual(['Esteban Agüero', 'Juan Pérez']);
  });

  it('miércoles: solo Juan (Esteban no trabaja ese día)', async () => {
    const { cmp } = montar();
    await cmp.ngOnInit(); await settle();
    irA(cmp, 2026, 12, 2);   // miércoles

    expect(cmp.columnasAgenda.map(c => c.empleado.nombre)).toEqual(['Juan Pérez']);
  });

  it('sábado: sin columnas', async () => {
    const { cmp } = montar();
    await cmp.ngOnInit(); await settle();
    irA(cmp, 2026, 12, 5);   // sábado

    expect(cmp.columnasAgenda.length).toBe(0);
  });

  it('inactivo: nunca tiene columna, aunque labre todos los días', async () => {
    const { cmp } = montar({ getEmpleados: () => Promise.resolve([EMP_INACTIVO]) });
    await cmp.ngOnInit(); await settle();
    irA(cmp, 2026, 12, 7);   // lunes, día que el inactivo "trabaja"

    expect(cmp.columnasAgenda.length).toBe(0);
  });

  // El mock devuelve [Juan, Esteban] sin ordenar, a proposito: el orden de la
  // pantalla es una decision SUYA y no puede depender del ORDER BY del servicio.
  it('el orden de columnas es alfabético, sin importar cómo llegue la lista', async () => {
    const { cmp } = montar();
    await cmp.ngOnInit(); await settle();
    irA(cmp, 2026, 12, 7);

    expect(cmp.columnasAgenda.map(c => c.empleado.nombre))
      .toEqual(['Esteban Agüero', 'Juan Pérez']);
  });

  // ESTA es la cláusula que evita que un turno quede invisible.
  it('el turno en riesgo hace aparecer la columna de un día que no labra', async () => {
    // Miércoles: Esteban NO trabaja. Tiene un turno ahí → está en riesgo.
    const enRiesgo = turno({ id: 77, empleado_id: EMP_ESTEBAN.id, fecha: '2026-12-02' });
    const { cmp } = montar({ getTurnos: () => Promise.resolve([enRiesgo]) });
    await cmp.ngOnInit(); await settle();
    irA(cmp, 2026, 12, 2);

    // Con la regla de riesgo: la columna de Esteban aparece y se marca.
    const esteban = cmp.columnasAgenda.find(c => c.empleado.id === EMP_ESTEBAN.id);
    expect(esteban).toBeDefined();
    expect(esteban.trabaja).toBe(false);
    expect(esteban.tieneTurnosEnRiesgo).toBe(true);
    expect(esteban.ausente).toBe(false);
  });

  it('sin el turno en riesgo, ese mismo día no aparece la columna', async () => {
    // El mismo miércoles, pero sin turnos: la columna de Esteban no debe existir.
    const { cmp } = montar();
    await cmp.ngOnInit(); await settle();
    irA(cmp, 2026, 12, 2);

    expect(cmp.columnasAgenda.find(c => c.empleado.id === EMP_ESTEBAN.id)).toBeUndefined();
  });

  it('una ausencia hace aparecer la columna aunque no labre', async () => {
    const vac = { empleado_id: EMP_ESTEBAN.id, desde: '2026-12-05', hasta: '2026-12-05',
      hora_inicio: null, hora_fin: null, tipo: 'vacaciones', motivo: null };
    const { cmp } = montar({ getAusencias: () => Promise.resolve([vac]) });
    await cmp.ngOnInit(); await settle();
    irA(cmp, 2026, 12, 5);   // sábado

    const esteban = cmp.columnasAgenda.find(c => c.empleado.id === EMP_ESTEBAN.id);
    expect(esteban).toBeDefined();
    expect(esteban.ausente).toBe(true);
    expect(cmp.motivoColumnaAusente(EMP_ESTEBAN.id, '2026-12-05')).toBe('Vacaciones');
  });
});

describe('Agenda — columna de un turno', () => {
  it('ubica el turno en la columna de su empleado', async () => {
    const { cmp } = montar();
    await cmp.ngOnInit(); await settle();
    irA(cmp, 2026, 12, 7);   // lunes

    const cols = cmp.columnasAgenda.map(c => c.empleado.id);
    expect(cols[cmp.columnaDeTurno(turno({ empleado_id: EMP_ESTEBAN.id }))])
      .toBe(EMP_ESTEBAN.id);
    expect(cols[cmp.columnaDeTurno(turno({ empleado_id: EMP_JUAN.id }))])
      .toBe(EMP_JUAN.id);
  });

  it('empleadoDeTurno lee empleado_id y no la columna muerta puesto_id', async () => {
    const { cmp } = montar();
    await cmp.ngOnInit(); await settle();

    // puesto_id va con un numero que NO existe en la tabla `puestos`: si el
    // componente lo usara, daria el empleado equivocado.
    expect(cmp.empleadoDeTurno({ empleado_id: 1, puesto_id: 999 })).toBe(1);
    expect(cmp.empleadoDeTurno({ empleado_id: 8, puesto_id: 1 })).toBe(8);
    expect(cmp.empleadoDeTurno(null)).toBeNull();
  });

  it('sin columna para el empleado, el turno cae en la ultima (no desaparece)', async () => {
    const { cmp } = montar();
    await cmp.ngOnInit(); await settle();
    irA(cmp, 2026, 12, 7);

    const orphan = turno({ empleado_id: 12345 });
    const idx = cmp.columnaDeTurno(orphan);
    expect(idx).toBe(cmp.columnasAgenda.length - 1);
  });
});

describe('Agenda - la semana: cada dia con SU gente y SU ancho', () => {
  // Dos cosas que se confundieron y hay que fijar por separado:
  //
  // 1. **Quién aparece.** Cada día muestra SOLO a quien atiende ese día. El que
  //    no labra no tiene columna: así se lee de un vistazo quién trabaja cuándo.
  //    (Había una versión que mostraba la unión de la semana y rayaba a los que
  //    no labran; al usuario lo mortificaba ver gente en gris con una ✕.)
  //
  // 2. **Cuánto mide.** El hueco del final venía de que todos los días reservaban
  //    el ancho del día más lleno. Cada día mide lo que necesita, y la grilla
  //    total es la SUMA de esos anchos.

  const listo = async (over: Record<string, any> = {}) => {
    const r = montar(over);
    await r.cmp.ngOnInit();
    await settle();
    r.cmp.vista = 'semana';
    r.cmp.diaInicio = 1;   // lunes
    r.cmp.diaFin = 6;       // sábado
    irA(r.cmp, 2026, 12, 7);
    return r;
  };

  const nombresDe = (cmp: any, dia: Date) =>
    cmp.columnasDe(dia).map((c: any) => c.empleado.nombre);

  it('el miercoles solo aparece Juan: Esteban no labra y no tiene columna', async () => {
    // Esteban = L,M,J,V (no miércoles). Juan = L-V.
    const { cmp } = await listo();
    const miercoles = new Date(2026, 11, 2);
    expect(nombresDe(cmp, miercoles)).toEqual([EMP_JUAN.nombre]);
    expect(nombresDe(cmp, miercoles)).not.toContain(EMP_ESTEBAN.nombre);
  });

  it('el que no labra no aparece NUNCA, ni rayado ni con x', async () => {
    const { cmp } = await listo();
    for (const dia of cmp.diasDeSemana) {
      const cols = cmp.columnasDe(dia);
      for (const col of cols) {
        // Si aparece, tiene que haber un motivo: o labra, o tiene ausencia, o
        // tiene turnos en riesgo. Nunca "aparece porque sí".
        expect(col.trabaja || col.ausente || col.enRiesgo).toBe(true);
      }
    }
  });

  it('cada dia mide lo que necesita su gente, no el maximo de la semana', async () => {
    const { cmp } = await listo();
    const miercoles = new Date(2026, 11, 2);
    const lunes = new Date(2026, 11, 7);

    const anchoMiercoles = cmp.columnasDe(miercoles).length;
    const anchoLunes = cmp.columnasDe(lunes).length;
    expect(anchoMiercoles).toBeLessThan(anchoLunes);

    const px = (n: number) => `${n * (cmp.anchoColEmpleado + cmp.gapColumna)}px`;
    expect(cmp.anchoDeDia(miercoles)).toBe(px(anchoMiercoles));
    expect(cmp.anchoDeDia(lunes)).toBe(px(anchoLunes));
  });

  it('NO hay ancho reservado: el total es la SUMA de los dias', async () => {
    // El bug del hueco: el ancho total se multiplicaba por el maximo de columnas
    // de la semana. Un dia con menos gente dejaba columnas en blanco al final.
    const { cmp } = await listo();
    // Un dia SIN NINGUNA columna igual mide una columna, no cero: si no, el
    // nombre del dia (SAB 12/12) quedaria con ancho cero y no se podria ni
    // leer ni tocar. Es un piso de legibilidad, no un ancho reservado.
    const suma = cmp.diasDeSemana.reduce((s: number, d: Date) => {
      const n = Math.max(cmp.columnasDe(d).length, 1);
      return s + n * (cmp.anchoColEmpleado + cmp.gapColumna);
    }, 0);
    expect(cmp.anchoGrillaSemana).toBe(`${40 + suma}px`);

    // Y da MENOS que el maximo por todos los dias: si no, sigue reservando de
    // mas y vuelven las columnas en blanco.
    const maximo = Math.max(...cmp.diasDeSemana.map((d: Date) => cmp.columnasDe(d).length));
    const porElMaximo = 40 + cmp.diasDeSemana.length * maximo * (cmp.anchoColEmpleado + cmp.gapColumna);
    expect(parseInt(cmp.anchoGrillaSemana, 10)).toBeLessThan(porElMaximo);
  });

  it('un dia sin nadie tiene ancho de UNA columna, no de cero', async () => {
    // El piso de legibilidad: el nombre del dia tiene que seguir viéndose.
    const { cmp } = await listo();
    const sabado = new Date(2026, 11, 12);
    expect(cmp.columnasDe(sabado).length).toBe(0);
    expect(cmp.anchoDeDia(sabado)).toBe(`${1 * (cmp.anchoColEmpleado + cmp.gapColumna)}px`);
  });

  it('el ancho no cambia al moverse de dia, solo al cambiar la gente', async () => {
    const { cmp } = await listo();
    const conDos = cmp.anchoDeDia(new Date(2026, 11, 2));   // 1 empleado
    const conTodos = cmp.anchoDeDia(new Date(2026, 11, 7));  // 2 empleados
    expect(conDos).not.toBe(conTodos);

    // Dos días con la misma gente miden igual.
    expect(cmp.anchoDeDia(new Date(2026, 11, 7))).toBe(cmp.anchoDeDia(new Date(2026, 11, 3)));
  });

  it('el turno de la vista semanal usa las columnas de SU dia', async () => {
    // `posicionTurno` con mini tiene que contar columnas del día del turno. Con
    // el total equivocado el bloque sale más angosto que su columna, porque el
    // ancho es un porcentaje.
    const { cmp } = await listo();
    const miercoles = new Date(2026, 11, 2);
    const cols = cmp.columnasDe(miercoles);
    const total = cols.length;
    const i = cols.findIndex((c: any) => c.empleado.id === EMP_JUAN.id);

    const t = turno({
      empleado_id: EMP_JUAN.id,
      fecha: cmp.fechaISOde(miercoles),
      hora: '10:00',
      hora_inicio: '10:00',
    });
    const pos = cmp.posicionTurno(t, null, true);
    expect(total).toBe(1);
    expect(i).toBe(0);
    expect(pos.left).toBe('calc(0% + 3px)');
    expect(pos.width).toBe('calc(100% - 6px)');
  });

  it('un inactivo no aparece en la semana aunque labre todos los dias', async () => {
    const { cmp } = montar({
      getEmpleados: () => Promise.resolve([EMP_JUAN, EMP_ESTEBAN, EMP_INACTIVO]),
    });
    await cmp.ngOnInit();
    await settle();
    cmp.vista = 'semana';
    irA(cmp, 2026, 12, 7);

    for (const dia of cmp.diasDeSemana) {
      const ids = cmp.columnasDe(dia).map((c: any) => c.empleado.id);
      expect(ids).not.toContain(EMP_INACTIVO.id);
    }
  });

  it('un dia cerrado tampoco inventa columnas', async () => {
    const { cmp } = await listo({
      getDiasCerrados: () => Promise.resolve([{ fecha: '2026-12-07' }]),
    });
    // Aunque el día esté cerrado, las columnas son las de la jornada: el filtro
    // es de la grilla, no del negocio. Lo que se marca es el fondo.
    expect(cmp.esDiaCerrado(new Date(2026, 11, 7))).toBe(true);
    expect(cmp.columnasDe(new Date(2026, 11, 7)).length).toBe(2);
  });

  it('el motivo del cierre se busca por rango, no por igualdad', async () => {
    const { cmp } = await listo({
      // Un cierre de varios dias: tiene fecha_hasta, asi que el match es por
      // inclusion y no por igualdad.
      getDiasCerrados: () => Promise.resolve([
        { fecha: '2026-12-07', fecha_hasta: '2026-12-20', motivo: 'vacaciones' },
      ]),
    });

    expect(cmp.motivoDiaCerrado(new Date(2026, 11, 7))).toBe('vacaciones');  // primero
    expect(cmp.motivoDiaCerrado(new Date(2026, 11, 13))).toBe('vacaciones'); // en el medio
    expect(cmp.motivoDiaCerrado(new Date(2026, 11, 20))).toBe('vacaciones'); // el ultimo

    // Un dia antes y uno despues siguen abiertos.
    expect(cmp.esDiaCerrado(new Date(2026, 11, 6))).toBe(false);
    expect(cmp.esDiaCerrado(new Date(2026, 11, 21))).toBe(false);
    expect(cmp.motivoDiaCerrado(new Date(2026, 11, 21))).toBe('');
  });

  it('un cierre sin motivo no inventa un texto', async () => {
    // `motivo` es nullable en la base y hay cierres guardados vacios. El rayado
    // va igual, pero al lado del dia no tiene que aparecer nada.
    const { cmp } = await listo({
      getDiasCerrados: () => Promise.resolve([
        { fecha: '2026-12-07', fecha_hasta: null, motivo: '' },
      ]),
    });

    expect(cmp.esDiaCerrado(new Date(2026, 11, 7))).toBe(true);
    expect(cmp.motivoDiaCerrado(new Date(2026, 11, 7))).toBe('');
  });

  it('la vista Semana pinta una banda de fondo por cada columna de empleado', async () => {
    // Es lo que deja saber de quién es cada turno con el scroll corrida: el mini
    // header de arriba queda pegado y las bandas llegan hasta abajo.
    //
    // El número de bandas tiene que ser el de ESE día, no el de la semana: el
    // miércoles solo tiene a Juan (Esteban no labra), así que una sola banda. Si
    // acá se contara mal, la última banda se correría y los bloques dejarían de
    // caer dentro de la columna que les corresponde.
    // A proposito NO se usa `listo()`: ese helper dispara `ngOnInit()` a mano y
    // despues `detectChanges()` lo vuelve a ejecutar por el ciclo de vida de
    // Angular, y ahi salta NG0100. Acá se deja que Angular lo corra una sola vez
    // y el segundo `detectChanges` es el que pinta los datos que trajo.
    const { cmp, fixture } = montar();
    cmp.vista = 'semana';
    cmp.diaInicio = 1;   // lunes
    cmp.diaFin = 6;       // sabado
    irA(cmp, 2026, 12, 7);

    fixture.detectChanges();
    // `settle()` y NO `whenStable()`: las promesas del mock ya estan resueltas
    // y la zona no las tiene registradas, asi que `whenStable()` devuelve de
    // una y el `await` no sirve de nada. `settle()` es un macrotask de verdad.
    await settle();
    fixture.detectChanges();

    const cuerpos = fixture.nativeElement.querySelectorAll('.col-dia-cuerpo');
    expect(cuerpos.length).toBe(cmp.diasDeSemana.length);

    // Se comparan los arrays enteros y no uno por uno con `withContext`: esa
    // funcion no existe en la version de Jasmine de este proyecto, y el fallo
    // muestra igual que indice se desvio.
    const esperadas = cmp.diasDeSemana.map((d: Date) => cmp.columnasDe(d).length);
    const pintadas = Array.from(cuerpos as any)
      .map((c: any) => c.querySelectorAll('.columna-fondo-celda').length);

    expect(pintadas).toEqual(esperadas);

    // Y que haya dias con distinta cantidad, para que el test de arriba no sea
    // verde de casualidad con dos bandas siempre.
    expect(Math.max(...esperadas)).toBeGreaterThan(Math.min(...esperadas));
  });

  it('sin fecha_hasta el cierre dura un solo dia', async () => {
    const { cmp } = await listo({
      getDiasCerrados: () => Promise.resolve([
        { fecha: '2026-12-07', fecha_hasta: null, motivo: 'feriado' },
      ]),
    });

    expect(cmp.esDiaCerrado(new Date(2026, 11, 7))).toBe(true);
    expect(cmp.esDiaCerrado(new Date(2026, 11, 8))).toBe(false);
  });
});

describe('Agenda - saltar a una fecha', () => {
  // Un `montar()` POR TEST, no uno compartido en el `describe`: TestBed no se
  // puede reconfigurar una vez que se instancia, y con un `montar()` en el
  // describe el segundo test revienta con "Cannot configure the test module".
  // Esto no necesita `ngOnInit`: `irAFecha` solo toca `fechaActual`, y lo que se
  // usa aca (jornadas de la semana, turnos) se setea a mano.
  const nuevo = () => montar().cmp;

  // REGRESION DE ZONA HORARIA: `new Date('2026-08-15')` se parsea como MEDIANOCHE
  // UTC, que en cualquier timezone negativo (Argentina, UTC-3) es el 14/08 a las
  // 21:00 local. Un dia antes, siempre, y sin que nada falle.
  //
  // Por eso `irAFecha` descompone el string a mano. Este test mira los
  // componentes de la fecha, no el ISO: comparar el ISO pasaria en un runner en
  // UTC y solo fallaria donde esta de verdad el problema.
  it('cae en el dia exacto, sin corrimiento por zona horaria', () => {
    const cmp = nuevo();
    cmp.irAFecha('2026-08-15');

    expect(cmp.fechaActual.getFullYear()).toBe(2026);
    expect(cmp.fechaActual.getMonth()).toBe(7);   // agosto
    expect(cmp.fechaActual.getDate()).toBe(15);
  });

  it('un input vaciado o con basura no mueve la fecha', () => {
    const cmp = nuevo();
    cmp.irAFecha('2026-08-15');

    // El `input type="date"` entrega '' si el usuario borra el valor a mano.
    cmp.irAFecha('');
    expect(cmp.fechaActual.getDate()).toBe(15);

    cmp.irAFecha('no-es-una-fecha');
    expect(cmp.fechaActual.getDate()).toBe(15);

    cmp.irAFecha('2026-13-45');   // mes 13 no existe
    expect(cmp.fechaActual.getDate()).toBe(15);
  });

  it('en la vista Semana aterriza en la semana que contiene esa fecha', () => {
    const cmp = nuevo();
    cmp.vista = 'semana';
    cmp.diaInicio = 1;   // lunes
    cmp.diaFin = 6;       // sabado
    // El 19/08/2026 es miercoles: la semana va del lunes 17 al sabado 22.
    cmp.irAFecha('2026-08-19');

    const fechas = cmp.diasDeSemana.map((d: Date) => d.toLocaleDateString('en-CA'));
    expect(fechas[0]).toBe('2026-08-17');
    expect(fechas[fechas.length - 1]).toBe('2026-08-22');
    expect(fechas).toContain('2026-08-19');
  });

  it('los turnos que se ven se recalculan solos al cambiar la fecha', () => {
    const cmp = nuevo();
    // `turnosDia` filtra `this.turnos` en memoria por `fechaISO`, asi que cambiar
    // la fecha ya cambia que turnos se ven, sin volver a pedir nada al servidor.
    // Esto fija ese contrato: es lo que hace que `navegarDia` y `irAFecha`
    //_funciones_ de un solo assignment, sin recargas.
    cmp.turnos = [
      turno({ fecha: '2026-08-15', hora_inicio: '10:00:00' }),
      turno({ fecha: '2026-08-15', hora_inicio: '14:00:00' }),
      turno({ fecha: '2026-08-20', hora_inicio: '11:00:00' }),
      turno({ fecha: '2026-08-15', hora_inicio: '09:00:00', estado: 'cancelado' }),
    ];

    cmp.irAFecha('2026-08-15');
    expect(cmp.turnosDia.length).toBe(2);   // el cancelado no cuenta

    cmp.irAFecha('2026-08-20');
    expect(cmp.turnosDia.length).toBe(1);

    cmp.irAFecha('2026-08-17');
    expect(cmp.turnosDia.length).toBe(0);
  });
});
