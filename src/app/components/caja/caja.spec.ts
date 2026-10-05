import { TestBed } from '@angular/core/testing';
import { CajaComponent } from './caja';
import { SupabaseService } from '../../services/supabase';
import { crearSupabaseMock, ganancia } from '../../testing/supabase-mock';

/**
 * Tests de Caja.
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
  // Se devuelve el `fixture` y no solo la instancia: los tests de DOM necesitan
  // `fixture.detectChanges()`. `cmp.cdr` es privado y no se puede tocar desde
  // afuera.
  const fixture = TestBed.createComponent(CajaComponent);
  const cmp = fixture.componentInstance;
  return { cmp, mock, fixture };
}

/** mocked sincrónico: el mock devuelve promesas ya resueltas. */
const settle = () => new Promise(r => setTimeout(r, 0));

// ══════════════════════════════════════════════════════════════
// CAJA: ingresos − pagos − compras
//
// El núcleo de la pantalla es un número: `balance`. Todo lo demás existe para
// poder explicar de dónde sale ese número, así que los tests se concentran en
// tres riesgos:
//
//   1. Que el balance armute mal: un pago sin sugerencia (quincena atrasada) o
//      una sugerencia sin pago (nadie le pagó todavía) tienen que aparecer igual.
//   2. Que el signo se invierta: todo se resta, y un `+` perdido manda a hacer
//      caja un número que no existe.
//   3. Que las validaciones dejen pasar lo que la base va a rechazar con un
//      error de Postgres que el usuario no entiende.
// ══════════════════════════════════════════════════════════════

const PAGO_JUAN = (monto: number, fecha = '2026-10-05') => ({
  id: 1, empleado_id: 1, fecha, monto,
  metodo: 'efectivo', notas: null,
  empleados: { nombre: 'Juan Pérez', activo: true },
});

const SUGERIDO = (empleadoId: number, nombre: string, sugerido: number, turnos = 5) => ({
  empleado_id: empleadoId, nombre, sugerido, turnos,
});

const COMPRA = (id: number, proveedorId: number, nombre: string, monto: number, fecha = '2026-10-08') => ({
  id, proveedor_id: proveedorId, fecha,
  concepto: 'Shampoo', cantidad: 2, monto, notas: null,
  proveedores: { nombre, activo: true },
});

describe('Caja — pestañas', () => {
  it('arranca en Ingresos', () => {
    const { cmp } = montar();
    expect(cmp.esTab('ingresos')).toBe(true);
    expect(cmp.esTab('empleados')).toBe(false);
    expect(cmp.esTab('gastos')).toBe(false);
  });

  // El orden y los NOMBRES los pidio el usuario: Ingresos | Empleados | Gastos.
  // Antes era Ingresos | Compras | Pagos a Empleados, que mezclaba "quien paga"
  // con "que se compra". El ABM de proveedores se mudo a Personas, asi que la
  // pestana que antes se llamaba "Proveedores" hoy muestra las compras y se
  // llama "Gastos".
  it('la barra ofrece Ingresos, Empleados y Gastos, en ese orden', () => {
    const { cmp, fixture } = montar();
    fixture.detectChanges();
    // El cast a HTMLButtonElement es por `click()` y `classList`: sin el,
    // TypeScript los ve como `Element` y no encuentra ninguno de los dos.
    const botones = Array.from(
      fixture.nativeElement.querySelectorAll('.tabs button')
    ) as HTMLButtonElement[];
    const textos = botones.map((b) => b.textContent!.trim());
    expect(textos.length).toBe(3);
    expect(textos[0]).toContain('Ingresos');
    expect(textos[1]).toContain('Empleados');
    expect(textos[2]).toContain('Gastos');
    // Y cada boton enciende su propia pestana.
    //
    // El orden de las claves va ACOMPANANDO al de los botones a proposito: si
    // alguien cambia uno y no el otro, este test lo muestra en el `esTab` que
    // falla, en vez de dejar una pestana que no abre nada.
    const claves = ['ingresos', 'empleados', 'gastos'];
    for (let i = 0; i < botones.length; i++) {
      botones[i].click();
      fixture.detectChanges();
      expect(botones[i].classList.contains('activo')).toBe(true);
      expect(cmp.esTab(claves[i])).toBe(true);
      // Las otras dos quedan apagadas: un `cambiarTab` que no limpia el estado
      // anterior deja dos pestanas visibles a la vez.
      for (let j = 0; j < claves.length; j++) {
        if (j !== i) expect(cmp.esTab(claves[j])).toBe(false);
      }
    }
  });

  it('cada pestaña enciende SU propio cuerpo: ninguna queda vacía', () => {
    // El modo de falla feo, y el que motivo este test: si el botón dice
    // `cambiarTab('gastos')` pero el cuerpo dice `esTab('compras')`, la pestaña
    // se enciende y aparece VACIA. No tira ningún error, no hay ningún
    // warning, solo una pantalla en blanco donde debería haber información.
    //
    // Por eso no alcanza con mirar que el botón tenga la clase `activo`: hay que
    // mirar que el CONTENIDO de esa pestaña esté en el DOM.
    const { fixture } = montar();
    const botones = Array.from(
      fixture.nativeElement.querySelectorAll('.tabs button')
    ) as HTMLButtonElement[];

    // Un texto distintivo por pestaña, y se afirma que los otros dos NO están.
    //
    // Los tres tienen que ser ÚNICOS de su pestaña, no solo estar presentes: el
    // test_affirma que los otros dos no aparecen, así que una marca repetida
    // haría fallar la aserción por la pestaña equivocada. Por eso "Pagos que le
    // hiciste" (que existe en Empleados Y en Gastos) no sirve como marca.
    const marcas = [
      'Servicio más vendido',   // Ingresos
      'Turnos que atendió',     // Empleados
      'Compras del período',    // Gastos
    ];

    for (let i = 0; i < botones.length; i++) {
      botones[i].click();
      fixture.detectChanges();
      const texto = fixture.nativeElement.textContent;
      expect(texto.includes(marcas[i])).toBe(true);
      for (let j = 0; j < marcas.length; j++) {
        if (j !== i) expect(texto.includes(marcas[j])).toBe(false);
      }
    }
  });

  it('cambiarTab cambia y limpia los mensajes de las dos secciones', () => {
    // Los mensajes se comparten por sección: si no se limpian, el "Pago
    // registrado" de la pestaña anterior aparece arriba de la otra.
    const { cmp } = montar();
    cmp.mensajePagos = '✅ Pago registrado.';
    cmp.mensaje = '✅ Proveedor agregado.';

    cmp.cambiarTab('gastos');

    expect(cmp.esTab('gastos')).toBe(true);
    expect(cmp.mensajePagos).toBe('');
    expect(cmp.mensaje).toBe('');
  });

  // El resumen de caja está ARRIBA de las pestañas y el balance se calcula con
  // las tres pestañas cargadas. Por eso `cargarDatos` no mira `this.tab`.
  it('cargarDatos trae las TRES pestañas, esté cual esté la activa', async () => {
    const { cmp, mock } = montar();
    cmp.cambiarTab('empleados');
    await cmp.cargarDatos();
    expect(mock.llamadas).toContain('getPagosEmpleado');
    expect(mock.llamadas).toContain('getComisionesPeriodo');
    expect(mock.llamadas).toContain('getCompras');
  });
});

describe('Caja — balance', () => {
  it('es ingresos menos pagos menos compras', async () => {
    const { cmp } = montar({
      getGanancias: () => Promise.resolve([ganancia({ precio: 100000 })]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(30000)]),
      getCompras: () => Promise.resolve([COMPRA(1, 1, 'Químicas', 20000)]),
    });
    await cmp.cargarDatos();
    expect(cmp.totalIngresos).toBe(100000);
    expect(cmp.totalPagadoEmpleados).toBe(30000);
    expect(cmp.totalCompras).toBe(20000);
    expect(cmp.totalSalidas).toBe(50000);
    expect(cmp.balance).toBe(50000);
  });

  it('da NEGATIVO cuando se pagó más de lo que entró, y lo muestra', async () => {
    // Caso real: se paga la quincena del mes anterior este mes. El negativo es
    // información, no un error a tapar.
    const { cmp } = montar({
      getGanancias: () => Promise.resolve([ganancia({ precio: 50000 })]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(80000)]),
      getCompras: () => Promise.resolve([]),
    });
    await cmp.cargarDatos();
    expect(cmp.balance).toBe(-30000);
  });

  it('sin datos da 0 y no NaN', async () => {
    const { cmp } = montar();
    await cmp.cargarDatos();
    expect(cmp.balance).toBe(0);
    expect(cmp.totalSalidas).toBe(0);
  });

  it('un pago sin sugerencia igual cuenta como salida', async () => {
    // Quincena atrasada: el empleado no tiene turnos ESTE mes pero hay que
    // pagarle igual. Si se calculara solo sobre las comisiones, no contaría.
    const { cmp } = montar({
      getGanancias: () => Promise.resolve([ganancia({ precio: 100000 })]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(40000)]),
      getComisionesPeriodo: () => Promise.resolve([]),
      getCompras: () => Promise.resolve([]),
    });
    await cmp.cargarDatos();
    expect(cmp.totalPagadoEmpleados).toBe(40000);
    expect(cmp.balance).toBe(60000);
  });
});

describe('Caja - el resumen de arriba', () => {
  // EL RESUMEN SON TRES TARJETAS, NO UNA LISTA.
  //
  // Antes eran cuatro renglones de texto en `.caja-fila`, con "Queda en caja" al
  // final. El usuario lo pidió así: la lista se leía como una planilla pegada
  // arriba y no se parecía a nada de lo demás de la app.
  //
  // "Queda en caja" SE SACÓ, y esto no es un detalle de estilo: no hay caja chica,
  // el dinero entra y sale por transferencia, así que el saldo siempre daba
  // negativo y el cartel de "Da negativo..." aparecía casi siempre. Eso es
  // exactamente como se ve una alarma que en realidad no dice nada.
  // Se queda SOLO con los dígitos. No alcanza con sacar `.` y `,`: el signo de las
  // salidas es el U+2212 (menos tipográfico), que en la consola se ve igual que
  // un guion y en el `expect` no es el mismo caracter.
  const norm = (t: string) => (t.match(/\d+/g) || []).join('');

  /** Las tarjetas del resumen, ya renderizadas. */
  async function resumen(over: Record<string, any> = {}) {
    const r = montar({
      getGanancias: () => Promise.resolve([ganancia({ precio: 20000 })]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(50000)]),
      getCompras: () => Promise.resolve([COMPRA(1, 1, 'Quimicas', 12000)]),
      getComisionesPeriodo: () => Promise.resolve([]),
      ...over,
    });
    await r.cmp.cargarDatos();
    r.fixture.detectChanges();
    const cards: HTMLElement[] = Array.from(
      r.fixture.nativeElement.querySelectorAll('.stats-resumen .stat-card')
    );
    return {
      cmp: r.cmp,
      pagina: (r.fixture.nativeElement.textContent || ''),
      tarjetas: cards.map((c) => ({
        label: ((c.querySelector('.stat-label') as HTMLElement)?.textContent || '').trim(),
        valor: ((c.querySelector('.stat-value') as HTMLElement)?.textContent || '').trim(),
        icono: !!c.querySelector('.stat-icon'),
        valorNorm: norm(((c.querySelector('.stat-value') as HTMLElement)?.textContent || '').trim()),
      })),
    };
  }

  it('son tres tarjetas con ícono, etiqueta y valor', async () => {
    const { tarjetas } = await resumen();

    expect(tarjetas.length).toBe(3);
    for (const t of tarjetas) {
      expect(t.icono).toBe(true);
      expect(t.label).not.toBe('');
      expect(t.valor).not.toBe('');
    }
  });

  it('las tres cantidades: ingresos, pagos y gastos', async () => {
    const { cmp, tarjetas } = await resumen({
      // Se compraron 12.000 pero se pagaron 7.000: la tarjeta tiene que mostrar
      // lo que SALIO de la cuenta (7.000), no lo comprado.
      getPagosProveedor: () => Promise.resolve([
        { id: 1, proveedor_id: 1, fecha: '2026-03-15', monto: 7000, metodo: 'transferencia', proveedores: { nombre: 'P', activo: true } },
      ]),
    });

    expect(tarjetas[0].label).toContain('Ingresos');
    expect(tarjetas[0].valorNorm).toBe('20000');

    expect(tarjetas[1].label).toContain('Pagos a empleados');
    expect(tarjetas[1].valorNorm).toBe('50000');

    expect(tarjetas[2].label).toContain('Gastos');
    expect(tarjetas[2].valorNorm).toBe('7000');

    // Y que los números de las tarjetas sean los getters, no textos sueltos: si
    // alguien cambia la cuenta, la tarjeta tiene que moverse con ella.
    expect(cmp.totalIngresos).toBe(20000);
    expect(cmp.totalPagadoEmpleados).toBe(50000);
    expect(cmp.totalPagadoProveedores).toBe(7000);
    // Y lo comprado sigue siendo 12.000: son dos números distintos a propósito.
    expect(cmp.totalCompras).toBe(12000);
  });

  it('comprar NO es pagar: sin abonos, la tarjeta de Gastos va en 0', async () => {
    // El bug reportado: compraste 12.000 y la tarjeta decía "−$12.000", que se
    // leía como una deuda. Si no se abonó nada, no salió nada de la cuenta.
    const { cmp, tarjetas } = await resumen();
    expect(cmp.totalCompras).toBe(12000);
    expect(cmp.totalPagadoProveedores).toBe(0);
    expect(tarjetas[2].valorNorm).toBe('0');
  });

  it('"Queda en caja" NO aparece en ninguna parte', async () => {
    // El pedido fue explícito y el motivo concreto. Este test evita que alguien
    // lo vuelva a agregar "porque era informativo".
    const { pagina, cmp } = await resumen();

    expect(pagina).not.toContain('Queda en caja');
    expect(pagina).not.toContain('Da negativo');

    // El getter sigue existiendo (lo cubren otros tests de aritmética) pero ya
    // no se muestra: se afirma que la cuenta es correcta igual.
    expect(cmp.balance).toBe(-42000);
  });

  it('el resumen se ve en las TRES pestañas, no solo en Ingresos', async () => {
    // El bloque quedó arriba de las pestañas a propósito: los tres números son
    // los que se usan para decidir, y tienen que estar a la vista esté donde
    // esté. Por eso NO va dentro de ningún `*ngIf="esTab(...)"`.
    const { cmp, fixture } = montar({
      getGanancias: () => Promise.resolve([ganancia({ precio: 20000 })]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(50000)]),
      getCompras: () => Promise.resolve([]),
      getComisionesPeriodo: () => Promise.resolve([]),
    });
    await cmp.cargarDatos();

    for (const t of ['ingresos', 'empleados', 'gastos']) {
      cmp.cambiarTab(t);
      fixture.detectChanges();
      const n = fixture.nativeElement.querySelectorAll('.stats-resumen .stat-card').length;
      expect(n).toBe(3);
    }
  });

  it('las salidas van con el signo adelante, no el $ adelante', async () => {
    // El bug reportado una vez: los renglones decían `-$50.000` y el saldo
    // `$-42.000`. Con las tarjetas el signo es fijo en el template, pero el
    // criterio se deja fijado igual.
    const { tarjetas } = await resumen();
    for (const t of [tarjetas[1], tarjetas[2]]) {
      expect(t.valor.indexOf('-')).toBeLessThan(t.valor.indexOf('$'));
    }
    // Ingresos no lleva menos.
    expect(tarjetas[0].valor.includes('-')).toBe(false);
  });
});
describe('Caja — totales a pagar', () => {
  it('cruza por empleado y calcula la diferencia', async () => {
    const { cmp } = montar({
      getComisionesPeriodo: () => Promise.resolve([SUGERIDO(1, 'Juan Pérez', 25000)]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(30000)]),
    });
    await cmp.cargarDatos();
    const juan = cmp.pagosPorEmpleado.find((f: any) => f.empleado_id === 1);
    expect(juan.sugerido).toBe(25000);
    expect(juan.pagado).toBe(30000);
    expect(juan.faltaPagar).toBe(-5000);   // se le pagó de más: no falta nada
  });

  it('da positivo cuando se pagó menos de lo sugerido', async () => {
    const { cmp } = montar({
      getComisionesPeriodo: () => Promise.resolve([SUGERIDO(1, 'Juan Pérez', 25000)]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(20000)]),
    });
    await cmp.cargarDatos();
    expect(cmp.pagosPorEmpleado[0].faltaPagar).toBe(5000);
  });

  it('un empleado con sugerencia y NINGÚN pago igual aparece (hay que pagarle)', async () => {
    // Si la tabla se armara solo desde los pagos, el que falta pagar
    // desaparecería justo de la pantalla que sirve para detectarlo.
    const { cmp } = montar({
      getComisionesPeriodo: () => Promise.resolve([SUGERIDO(1, 'Juan Pérez', 25000)]),
      getPagosEmpleado: () => Promise.resolve([]),
    });
    await cmp.cargarDatos();
    expect(cmp.pagosPorEmpleado.length).toBe(1);
    expect(cmp.pagosPorEmpleado[0].pagado).toBe(0);
    expect(cmp.pagosPorEmpleado[0].faltaPagar).toBe(25000);
  });

  it('un pago cuyo empleado fue borrado no rompe la tabla', async () => {
    // El select viene con `empleados: null` cuando el empleado ya no está.
    const { cmp } = montar({
      getPagosEmpleado: () => Promise.resolve([
        { id: 1, empleado_id: 99, fecha: '2026-10-05', monto: 10000, metodo: 'efectivo', empleados: null },
      ]),
      getComisionesPeriodo: () => Promise.resolve([]),
    });
    await cmp.cargarDatos();
    expect(cmp.pagosPorEmpleado.length).toBe(1);
    expect(cmp.pagosPorEmpleado[0].nombre).toBe('Empleado #99');
    expect(cmp.totalPagadoEmpleados).toBe(10000);
  });

  it('ordena por sugerido, de mayor a menor', async () => {
    const { cmp } = montar({
      getComisionesPeriodo: () => Promise.resolve([
        SUGERIDO(1, 'Juan', 10000),
        SUGERIDO(2, 'Esteban', 40000),
        SUGERIDO(3, 'Pedro', 20000),
      ]),
    });
    await cmp.cargarDatos();
    expect(cmp.pagosPorEmpleado.map((f: any) => f.nombre)).toEqual(['Esteban', 'Pedro', 'Juan']);
  });

  it('totalSugerido es la suma de todos los sugeridos', async () => {
    const { cmp } = montar({
      getComisionesPeriodo: () => Promise.resolve([
        SUGERIDO(1, 'Juan', 10000),
        SUGERIDO(2, 'Esteban', 25000),
      ]),
    });
    await cmp.cargarDatos();
    expect(cmp.totalSugerido).toBe(35000);
  });

  // Un empleado sin turnos ESTE mes puede necesitar un pago igual (quincena
  // atrasada). Filtrar el combo por "tiene comisión" lo haría desaparecer.
  it('el combo de pago ofrece a los empleados sin comisión en el período', async () => {
    const { cmp } = montar({
      getEmpleados: () => Promise.resolve([
        { id: 1, nombre: 'Juan', activo: true },
        { id: 2, nombre: 'Esteban', activo: true },
        { id: 3, nombre: 'Pedro', activo: false },
      ]),
      getComisionesPeriodo: () => Promise.resolve([SUGERIDO(1, 'Juan', 10000)]),
    });
    await cmp.cargarDatos();
    expect(cmp.empleadosParaPago.map((e: any) => e.id)).toEqual([1, 2]);
  });
});

describe('Caja — cómo se muestra la diferencia', () => {
  // `diferencia = pagado - sugerido`. La columna se lee de un vistazo:
  // verde = se pagó de más, rojo = se pagó de menos. Y NUNCA lleva `+`.
  //
  // El `+$19.000` de antes era peor que un detalle de formato: se leía como
  // "ganó 19 mil" cuando en realidad es "se le pagó 19 mil más de lo que le
  // correspondía", que es justo el número que hay que mirar para saber si el
  // porcentaje de comisión está mal.
  //
  // Estos tests assertan el TEXTO RENDERIZADO, no un método: el signo y el color
  // se arman en el template y un método que los devuelva probaría una función
  //helper que nadie usa.

  /** Suggestions + pagos para ver las tres filas: +, -, 0. */
  const ARMADO = {
    getComisionesPeriodo: () => Promise.resolve([
      SUGERIDO(1, 'Se pagó de más', 6000),
      SUGERIDO(2, 'Se pagó de menos', 40000),
      SUGERIDO(3, 'Cuadrado exacto', 15000),
    ]),
    getPagosEmpleado: () => Promise.resolve([
      PAGO_JUAN(25000),                                                    // +19.000
      { id: 2, empleado_id: 2, fecha: '2026-10-05', monto: 10000, metodo: 'efectivo', empleados: null },  // -30.000
      { id: 3, empleado_id: 3, fecha: '2026-10-05', monto: 15000, metodo: 'efectivo', empleados: null },  // 0
    ]),
  };


  /**
   * Para comparar sin ruido de runtime.
   *
   * Normaliza el separador de miles, porque el pipe `number` usa el locale:
   * **jsdom corre en `en-US` y escribe `19,000`, el browser en `es-AR` y escribe
   * `19.000`**. Un test que afirme el separador pasa en un lado y falla en el
   * otro.
   *
   * NO baja ningún signo: en esta pantalla no hay ninguno. Ese es justamente el
   * punto de estos tests, y normalizar los signos acá escondería justo lo que se
   * quiere verificar.
   */
  const norm = (t: string) => t.replace(/[.,]/g, '');

  async function renderizado() {
    const r = montar(ARMADO);
    await r.cmp.cargarDatos();
    // La tabla vive dentro de la pestaña "empleados": sin esto no hay ni una celda.
    r.cmp.cambiarTab('empleados');
    r.fixture.detectChanges();
    // Solo las filas de empleados: el `tfoot` también tiene celdas de debe y
    // haber, y sus valores no son los de ninguna fila.
    const celdas: HTMLElement[] = Array.from(
      r.fixture.nativeElement.querySelectorAll('tbody .celda-diferencia')
    );
    return {
      cmp: r.cmp,
      crudos: celdas.map((c) => (c.textContent || '').trim()),
      // Orden por sugerido de mayor a menor: 40.000, 15.000, 6.000. Y por fila
      // van DOS celdas: primero "Debe", después "Haber".
      textos: celdas.map((c) => norm((c.textContent || '').trim())),
      clases: celdas.map((c) => (c.classList.contains('verde') ? 'verde'
        : c.classList.contains('rojo') ? 'rojo' : 'sin-clase')),
    };
  }

  it('son DOS celdas por empleado: "Debe" y "Haber"', async () => {
    // Antes era una columna con signo y había que mirar el `−` para saber de qué
    // lado estaba. Ahora cada celda dice sola de qué lado es.
    const { textos } = await renderizado();
    expect(textos.length).toBe(6);
  });

  // OJO CON EL ORDEN: `armarPagosPorEmpleado` ordena por sugerido de MAYOR a
  // menor (40.000, 15.000, 6.000) y dentro de cada fila va "Debe" y después
  // "Haber". O sea que las celdas salen en este orden:
  //
  //   [0] Debe del que falta 30.000   [1] Haber del que falta 30.000
  //   [2] Debe del cuadrado           [3] Haber del cuadrado
  //   [4] Debe del que sobra 19.000   [5] Haber del que sobra 19.000

  it('DEBE: en ROJO, en positivo, sin signo', async () => {
    // 40.000 sugeridos, 10.000 pagados: le debo 30.000.
    const { textos, clases } = await renderizado();
    expect(textos[0]).toBe('$30000');
    expect(textos.some((t) => t.includes('-'))).toBe(false);
    expect(clases[0]).toBe('rojo');
  });

  it('HABER: en VERDE, en positivo, sin signo', async () => {
    // 6.000 sugeridos, 25.000 pagados: me deben 19.000.
    const { textos, clases } = await renderizado();
    expect(textos[5]).toBe('$19000');
    expect(textos.some((t) => t.includes('-'))).toBe(false);
    expect(clases[5]).toBe('verde');
  });

  it('el cuadrado exacto deja las DOS columnas en $0', async () => {
    // Ni raya ni hueco: `$0` en las dos, que es lo que hace legible la fila. Con
    // una raya parece que falta un dato, y con un hueco la tabla rota.
    const { textos, clases } = await renderizado();
    expect(textos[2]).toBe('$0');
    expect(textos[3]).toBe('$0');
    // Ni rojo ni verde: el `$0` de una columna que no aplica es gris. Pintarlo
    // del color de su columna haría que la mitad de la tabla pareciera "debo" o
    // "me deben" cuando no hay nada de ninguno de los dos lados.
    expect(clases[2]).toBe('sin-clase');
    expect(clases[3]).toBe('sin-clase');
  });

  it('NINGUNA celda de la tabla tiene signo', async () => {
    // Este es el test que cubre el pedido literal: ni `−` tipográfico (U+2212)
    // ni guion ASCII. Si alguien reintroduce el signo, esto falla.
    const { crudos } = await renderizado();
    for (const t of crudos) {
      expect(t.includes(String.fromCharCode(0x2212))).toBe(false);
      expect(t.includes('-')).toBe(false);
    }
  });

  it('una fila nunca tiene las dos columnas con plata', async () => {
    // "Debe 30.000" y "Haber 30.000" al mismo tiempo sería una contradicción
    // visible. Son la misma diferencia partida, así que solo una puede tener.
    const { textos } = await renderizado();
    for (let i = 0; i < textos.length; i += 2) {
      const debe = textos[i] !== '$0';
      const haber = textos[i + 1] !== '$0';
      expect(debe && haber).toBe(false);
    }
  });

  it('la fila de Total tiene las dos columnas con número', async () => {
    const { cmp, fixture } = montar(ARMADO);
    await cmp.cargarDatos();
    cmp.cambiarTab('empleados');
    fixture.detectChanges();

    const celdas = fixture.nativeElement.querySelectorAll('tfoot .celda-diferencia');
    expect(celdas.length).toBe(2);
    // Total: 40.000 + 15.000 + 6.000 sugeridos = 61.000, y 25.000 + 10.000 +
    // 15.000 pagados = 50.000. Debe = 11.000.
    expect(norm((celdas[0].textContent || '').trim())).toBe('$11000');
    expect(celdas[0].classList.contains('rojo')).toBe(true);
    expect(norm((celdas[1].textContent || '').trim())).toBe('$0');
  });

  it('la celda va en negrita: es la columna que hay que mirar', async () => {
    // `getComputedStyle` no lee SCSS en jsdom, así que el grosor no se puede
    // verificar acá. Lo que sí se verifica es que la celda tiene la clase que
    // lo lleva; si alguien la saca del template, este test falla.
    const r = montar(ARMADO);
    await r.cmp.cargarDatos();
    r.cmp.cambiarTab('empleados');
    r.fixture.detectChanges();
    // Dos por fila, tres filas.
    expect(r.fixture.nativeElement.querySelectorAll('tbody .celda-diferencia').length).toBe(6);
  });


  /** Solo las clases de color de las celdas, para no repetir el `montar`. */
  async function renderizadoClasses() {
    const r = montar(ARMADO);
    await r.cmp.cargarDatos();
    r.cmp.cambiarTab('empleados');
    r.fixture.detectChanges();
    const celdas: HTMLElement[] = Array.from(
      r.fixture.nativeElement.querySelectorAll('tbody .celda-diferencia')
    );
    return {
      clases: celdas.map((c) => (c.classList.contains('verde') ? 'verde'
        : c.classList.contains('rojo') ? 'rojo' : 'sin-clase')),
    };
  }

  it('ya NO hay signo en ninguna celda: la tabla es toda en positivo', async () => {
    // Antes acá se testeaban `signoDiferencia` y `absDiferencia`, que armaban el
    // `-30.000`. Los dos helpers están BORRADOS del componente, no sola vez
    // dejando de usarse: no queda ningún camino por el que un signo aparezca
    // en una celda. La columna "Debe" y la "Haber" parten la diferencia en dos
    // positivos.
    //
    // Lo que se verifica acá es el resultado visible: ni `-` ni guion ASCII en
    // ninguna celda, y el `$` siempre adelante del número.
    const { crudos } = await renderizado();
    expect(crudos.length).toBe(6);
    for (const t of crudos) {
      expect(t.includes('-')).toBe(false);
      expect(t.includes(String.fromCharCode(0x2212))).toBe(false);
      expect(t.indexOf('$')).toBe(0);
    }
  });

  it('el color va con la COLUMNA, no con el signo crudo', async () => {
    // La columna "Debe" es roja y la "Haber" verde, por posición y no por el
    // valor: así cada celda dice sola de qué lado está el dinero y no hace falta
    // interpretar nada.
    //
    // Y hay un TERCER color para el `$0`: gris. No es un detalle, es lo que hace
    // que la tabla se pueda leer de un tirón. Con dos columnas, la mitad de las
    // celdas de cada fila son `$0`; si esas tomaran el color de su columna, la
    // tabla sería una lista de rojos y verdes donde el color ya no dice nada.
    const { clases } = await renderizadoClasses();

    // El cuadrado exacto: las dos en gris, porque no debe nada a nadie y nadie le
    // debe nada.
    expect(clases[2]).toBe('sin-clase');
    expect(clases[3]).toBe('sin-clase');
  });
  it('el color de cada celda va con SU PROPIA cantidad, no con el signo de la fila', () => {
    // Este es el bug que los getters arreglan. Con el color atado al signo de la
    // fila, un saldo a favor pintaba la celda "Debe" (que vale $0) en VERDE, y
    // la tabla quedaba con las dos columnas en verde sin que el color dijera
    // nada. Cada celda tiene que pintar por lo que VALE.
    const { cmp } = montar();

    // Un saldo a favor: la celda "Debe" vale 0 (gris) y la "Haber" vale 25.000.
    expect(cmp.claseDebe(-25000)).toBe('cero');
    expect(cmp.claseHaber(-25000)).toBe('verde');

    // Un saldo a deber: al revés.
    expect(cmp.claseDebe(15000)).toBe('rojo');
    expect(cmp.claseHaber(15000)).toBe('cero');

    // Cuadrado exacto: las dos celdas valen 0, las dos grises.
    expect(cmp.claseDebe(0)).toBe('cero');
    expect(cmp.claseHaber(0)).toBe('cero');
  });

  it('una celda en $0 NUNCA sale roja ni verde', () => {
    // Ninguna de las dos columnas puede "aparecer" con plata donde no la hay.
    // Por eso el gris existe: es el único color del $0.
    const { cmp } = montar();
    for (const v of [0, -0, null, undefined, NaN]) {
      expect(cmp.claseDebe(v as any)).toBe('cero');
      expect(cmp.claseHaber(v as any)).toBe('cero');
    }
  });

  it('en la tabla real el $0 de la columna que no aplica sale gris', async () => {
    // El test de getters de arriba más el de celdas reales: los dos juntos. Los
    // getters pueden estar bien y el template seguir conectandolo mal.
    const { clases, textos } = await renderizado();
    // Fila del que le sobran 19.000 (índice 4 y 5): debe $0 gris, haber verde.
    expect(textos[4]).toBe('$0');
    expect(clases[4]).toBe('sin-clase');
    expect(textos[5]).toBe('$19000');
    expect(clases[5]).toBe('verde');

    // Fila del que le faltan 30.000 (índice 0 y 1): debe rojo, haber $0 gris.
    expect(clases[0]).toBe('rojo');
    expect(textos[1]).toBe('$0');
    expect(clases[1]).toBe('sin-clase');
  });
});

describe('Caja — registrar pago', () => {
  const listo = async (over: Record<string, any> = {}) => {
    const r = montar(over);
    await r.cmp.cargarDatos();
    return r;
  };

  it('exige empleado, fecha y monto', async () => {
    const { cmp, mock } = await listo();
    cmp.nuevoPago = { empleado_id: null, fecha: '', monto: null, metodo: 'efectivo', notas: '' };
    await cmp.guardarPago();
    expect(cmp.mensajeErrorPagos).toMatch(/empleado/i);
    expect(mock.llamadas).not.toContain('crearPagoEmpleado');
  });

  // `monto > 0` es un CHECK en la base. Sin esta validación el usuario ve un
  // error de Postgres en vez de algo que entienda.
  it('rechaza monto 0, negativo o no numérico', async () => {
    const { cmp, mock } = await listo();
    for (const monto of [0, -100, null, 'abc']) {
      cmp.nuevoPago = { empleado_id: 1, fecha: '2026-10-05', monto, metodo: 'efectivo', notas: '' };
      await cmp.guardarPago();
      expect(cmp.mensajeErrorPagos).toMatch(/mayor a 0/i);
    }
    expect(mock.llamadas).not.toContain('crearPagoEmpleado');
  });

  it('un pago válido se guarda y recarga', async () => {
    const guardados: any[] = [];
    const { cmp, mock } = await listo({
      crearPagoEmpleado: (p: any) => { guardados.push(p); return Promise.resolve({ id: 1, ...p }); },
    });
    cmp.nuevoPago = { empleado_id: 1, fecha: '2026-10-05', monto: '25000.50', metodo: 'transferencia', notas: 'quincena' };

    await cmp.guardarPago();

    expect(guardados.length).toBe(1);
    // El monto va como número, no como el string del <input type="number">.
    expect(guardados[0].monto).toBe(25000.5);
    expect(guardados[0].empleado_id).toBe(1);
    expect(guardados[0].metodo).toBe('transferencia');
    // Guarda y recarga para que el balance se actualice sin recargar la página.
    expect(mock.llamadas.filter((c: string) => c === 'getPagosEmpleado').length).toBeGreaterThan(1);
  });

  it('si la base lo rechaza, avisa y no limpia el formulario', async () => {
    const { cmp } = await listo({ crearPagoEmpleado: () => Promise.reject(new Error('boom')) });
    cmp.nuevoPago = { empleado_id: 1, fecha: '2026-10-05', monto: 1000, metodo: 'efectivo', notas: '' };

    await cmp.guardarPago();

    expect(cmp.mensajeErrorPagos).toMatch(/no se pudo/i);
    expect(cmp.nuevoPago.monto).toBe(1000);   // sigue ahí para corregir
    expect(cmp.guardandoPago).toBe(false);
  });

  it('eliminarPago cancelado no toca la base', async () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { cmp, mock } = await listo();
    await cmp.eliminarPago(PAGO_JUAN(1000));
    expect(mock.llamadas).not.toContain('eliminarPagoEmpleado');
    spy.mockRestore();
  });
});

// El error tiene que DESAPARECER apenas el usuario toca un campo. Si queda, la
// pantalla dice "Elegí el empleado" con el empleado ya elegido al lado, y parece
// que la app no se entera de nada.
//
// Estos tests TOCAN los campos de verdad y no buscan el `(ngModelChange)` en el
// DOM: eso es un listener de Angular, no un atributo, así que no se puede
// consultar con un selector. Y aunque se pudiera, verificar que el atributo
// existe no dice que el error se borre.
describe('Caja — el error se va cuando tocás un campo', () => {
  const listo = async (over: Record<string, any> = {}) => {
    const r = montar(over);
    await r.cmp.cargarDatos();
    return r;
  };

  /**
   * Escribe en un input/select como lo haría la persona: setea el valor y
   * dispara los eventos. Angular escucha `input` en los inputs y `change` en
   * los selects.
   *
   * En los selects hay que usar el `value` REAL de una opción. Con `[ngValue]`
   * Angular no escribe el número crudo sino su forma serializada ("0: 7"), así
   * que poner `.value = '7'` no matchea ninguna opción y no dispara nada.
   */
  const tocar = (campo: any, valor?: string) => {
    const el = campo as HTMLInputElement | HTMLSelectElement;
    if (el.tagName === 'SELECT') {
      const opciones = Array.from((el as HTMLSelectElement).options) as HTMLOptionElement[];
      const conValor = opciones.find((o) => o.value !== '');
      if (!conValor) return false;
      el.value = conValor.value;
    } else {
      el.value = valor ?? 'x';
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  // Un test por popup: `TestBed.configureTestingModule` no se puede volver a
  // llamar dentro del mismo test, así que un loop con varios `listo()` revienta.
  const POPUPS = [
    { abrir: 'abrirFormPago', cerrar: 'cerrarFormPago', campo: 'mensajeErrorPagos' },
    { abrir: 'abrirFormCompra', cerrar: 'cerrarFormCompra', campo: 'mensajeError' },
  ] as const;

  for (const p of POPUPS) {
    it(`${p.abrir} borra el error del intento anterior`, async () => {
      const { cmp } = await listo();
      (cmp as any)[p.campo] = '❌ de antes';
      (cmp as any)[p.abrir]();
      expect((cmp as any)[p.campo]).toBe('');
      (cmp as any)[p.cerrar]();
    });
  }

  // El usuario lo pidió explícitamente: cerrar ALSO limpia el error. Antes yo lo
  // dejaba a propósito para "no perder la pista de qué faltaba", y fue una mala
  // decisión: si abría, corregía a medias, cerraba y volvía a abrir, veía el
  // reclamo viejo y la app parecía no enterarse de nada.
  //
  // Un test por popup: `listo()` llama a `TestBed.configureTestingModule`, y en
  // un mismo test no se puede volver a llamar.
  for (const p of POPUPS) {
    it(`${p.cerrar} también borra el error`, async () => {
      const { cmp } = await listo();
      cmp.mensajeErrorPagos = '❌ de antes';
      cmp.mensajeError = '❌ de antes';
      (cmp as any)[p.abrir]();
      (cmp as any)[p.cerrar]();
      expect((cmp as any)[p.campo]).toBe('');
    });
  }

  it('cerrar tambien descarta el modo edicion', async () => {
    // Si cerrar solo tapara el popup y dejara compraEditando puesto, el
    // 'Registrar compra' de despues abriria en modo edicion.
    const { cmp } = await listo();
    cmp.abrirFormCompra({ id: 1, proveedor_id: 1, fecha: '2026-03-01', concepto: 'x', cantidad: 1, monto: 100 });
    cmp.cerrarFormCompra();
    expect(cmp.compraEditando).toBeNull();
    expect(cmp.editandoCompra).toBe(false);
  });

  // Un test por campo, y no un loop dentro de un test: mutar el mismo componente
  // varias veces en un test tira NG0100 (Angular compara el valor anterior con
  // el nuevo en modo dev y se queja). Además un test que falla dice QUÉ campo
  // falló, en vez de "falló el campo número 3".
  const CAMPOS_PAGO = ['empleado', 'fecha', 'monto', 'metodo', 'notas'];

  it('el popup de pago tiene 5 campos', async () => {
    const { cmp, fixture } = await listo();
    cmp.mostrarFormPago = true;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.popup-overlay select, .popup-overlay input').length)
      .toBe(CAMPOS_PAGO.length);
  });

  for (const nombre of CAMPOS_PAGO) {
    it(`tocar "${nombre}" borra el error del popup de pago`, async () => {
      const { cmp, fixture } = await listo();
      // El error se setea ANTES del primer detectChanges, en una sola pasada.
      // Si se abre el popup, se detectChanges, y después se setea el error, el
      // dev-check de Angular tira NG0100: leyó '' en una pasada y el valor nuevo
      // en la de verificación. El orden importa en los tests, no en la app.
      cmp.mostrarFormPago = true;
      cmp.mensajeErrorPagos = '❌ Elegí el empleado.';
      fixture.detectChanges();

      const campos = fixture.nativeElement.querySelectorAll('.popup-overlay select, .popup-overlay input');
      const indice = CAMPOS_PAGO.indexOf(nombre);

      expect(tocar(campos[indice])).toBe(true);
      fixture.detectChanges();

      expect(cmp.mensajeErrorPagos).toBe('');
    });
  }

  it('elegir el proveedor borra el error del popup de compra', async () => {
    // El proveedor ya no es un <select>: se escribe y se hace click en el
    // resultado. El error se borra al escribir Y al elegir.
    const { cmp, fixture } = await listo({
      getProveedores: () => Promise.resolve([{ id: 7, nombre: 'Quimicas', activo: true }]),
    });
    cmp.mostrarFormCompra = true;
    cmp.mensajeError = '❌ Elegí el proveedor.';
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('.popup-overlay input[placeholder*="Buscar proveedor"]');
    tocar(input, 'quim');
    fixture.detectChanges();
    // Escribir ya lo borra.
    expect(cmp.mensajeError).toBe('');

    // Y elegir de la lista también.
    cmp.mensajeError = '❌ Elegí el proveedor.';
    const item = fixture.nativeElement.querySelector('.dropdown-busqueda .dropdown-item');
    item.click();
    fixture.detectChanges();
    expect(cmp.mensajeError).toBe('');
    expect(cmp.proveedorSeleccionado.id).toBe(7);
  });

  it('escribir el concepto borra el error del popup de compra', async () => {
    const { cmp, fixture } = await listo({
      getProveedores: () => Promise.resolve([{ id: 7, nombre: 'Químicas', activo: true }]),
    });
    cmp.mostrarFormCompra = true;
    cmp.mensajeError = '❌ Escribí el concepto.';
    fixture.detectChanges();

    const concepto = fixture.nativeElement.querySelector('.popup-overlay input[placeholder*="bidones"]');
    tocar(concepto, '12 bidones de shampoo');
    fixture.detectChanges();

    expect(cmp.mensajeError).toBe('');
  });

  it('el error NO aparece duplicado en la pestaña', async () => {
    // El error vive dentro del popup. Si también estuviera en la pestaña, con
    // el overlay puesto se vería el mismo texto dos veces.
    const { cmp, fixture } = await listo();
    cmp.cambiarTab('empleados');
    cmp.mensajeErrorPagos = '❌ Elegí el empleado.';
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.tab-body .alerta.error').length).toBe(0);
    expect(fixture.nativeElement.querySelectorAll('.tab-body .error-msg').length).toBe(0);
  });

  it('el mensaje de exito SÍ queda en la pestaña', async () => {
    const { cmp, fixture } = await listo();
    cmp.cambiarTab('empleados');
    cmp.mensajePagos = '✅ Pago registrado.';
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.tab-body .alerta.exito').length).toBe(1);
  });
});

describe('Caja — botones del popup iguales a los de Nuevo turno', () => {
  const listo = async (over: Record<string, any> = {}) => {
    const r = montar(over);
    await r.cmp.cargarDatos();
    return r;
  };

  it('el pie usa btn-atendido / btn-cancelado, no btn-primary / btn-secundario', async () => {
    // Los nombres de clase del popup del Dashboard. Si un día divergen, este
    // test dice cuál de los dos archivos se apartó del original.
    const { cmp, fixture } = await listo();
    cmp.mostrarFormPago = true;
    fixture.detectChanges();
    const pie = fixture.nativeElement.querySelector('.popup-acciones');
    expect(pie).toBeTruthy();
    expect(pie.querySelector('.btn-atendido')).toBeTruthy();
    expect(pie.querySelector('.btn-cancelado')).toBeTruthy();
    expect(pie.querySelector('.btn-primary')).toBeNull();
    // Las dos grafias: .btn-secondary es la que existe hoy y
    // .btn-secundario la que se escribio sin querer una vez.
    expect(pie.querySelector('.btn-secondary')).toBeNull();
    expect(pie.querySelector('.btn-secundario')).toBeNull();
  });

  // Un test por popup: en un solo test con un loop, TestBed deja los fixtures
  // anteriores en el document y los selectores cuentan los tres a la vez.
  for (const abrir of ['abrirFormPago', 'abrirFormCompra'] as const) {
    it(`${abrir}: mismo pie de botones`, async () => {
      const { cmp, fixture } = await listo();
      (cmp as any)[abrir]();
      fixture.detectChanges();
      const pie = fixture.nativeElement.querySelector('.popup-acciones');
      expect(pie.querySelectorAll('.btn-atendido').length).toBe(1);
      expect(pie.querySelectorAll('.btn-cancelado').length).toBe(1);
      expect(pie.querySelector('.btn-cancelado').textContent).toContain('Cancelar');
    });
  }

  it('el error se muestra con error-msg, no con alerta', async () => {
    const { cmp, fixture } = await listo();
    cmp.mostrarFormPago = true;
    cmp.mensajeErrorPagos = '❌ Elegí el empleado.';
    fixture.detectChanges();
    const body = fixture.nativeElement.querySelector('.popup-body');
    expect(body.querySelectorAll('.error-msg').length).toBe(1);
    expect(body.querySelectorAll('.alerta').length).toBe(0);
  });
});

describe('Caja — editar proveedores y compras', () => {
  const listo = async (over: Record<string, any> = {}) => {
    const r = montar(over);
    await r.cmp.cargarDatos();
    return r;
  };

  const PROV = { id: 1, nombre: 'Quimicas', contacto: 'Ana', telefono: '123', notas: null, activo: true };
  const COMPRA = { id: 5, proveedor_id: 1, fecha: '2026-03-15', concepto: 'Shampoo', cantidad: 2, monto: 48000, notas: null };

  // ── COMPRA ──

  it('abrir sin argumento es un ALTA de compra', async () => {
    const { cmp } = await listo();
    cmp.abrirFormCompra();
    expect(cmp.editandoCompra).toBe(false);
    expect(cmp.compraEditando).toBeNull();
    expect(cmp.nuevaCompra.concepto).toBe('');
    expect(cmp.nuevaCompra.cantidad).toBe(1);
  });

  it('abrir con una compra carga sus datos', async () => {
    const { cmp } = await listo();
    cmp.abrirFormCompra(COMPRA);
    expect(cmp.editandoCompra).toBe(true);
    expect(cmp.nuevaCompra.proveedor_id).toBe(1);
    expect(cmp.nuevaCompra.concepto).toBe('Shampoo');
    expect(cmp.nuevaCompra.monto).toBe(48000);
  });

  it('el monto llega como número, no como string de la base', async () => {
    // Postgres devuelve los numeric como string. Si queda string, la validación
    // `Number(monto) > 0` igual funciona pero el input number muestra basura.
    const { cmp } = await listo();
    cmp.abrirFormCompra({ ...COMPRA, monto: '48000.55' });
    expect(cmp.nuevaCompra.monto).toBe(48000.55);
  });

  it('guardar en modo edición llama a actualizarCompra, NO a crearCompra', async () => {
    const actualizadas: any[] = [];
    const creadas: any[] = [];
    const { cmp } = await listo({
      actualizarCompra: (id: number, d: any) => { actualizadas.push({ id, ...d }); return Promise.resolve(); },
      crearCompra: (d: any) => { creadas.push(d); return Promise.resolve(); },
    });
    cmp.abrirFormCompra(COMPRA);
    cmp.nuevaCompra.monto = 50000;

    await cmp.guardarCompra();

    expect(actualizadas.length).toBe(1);
    expect(actualizadas[0].id).toBe(5);
    expect(actualizadas[0].monto).toBe(50000);
    expect(creadas).toEqual([]);
  });

  it('editar una compra recalcula el total y el balance', async () => {
    // El motivo de que exista el botón de editar: corregir un monto mal cargado
    // tiene que mover el balance sin borrar y recargar la compra.
    //
    // El mock es STATEFUL a propósito: uno que devuelve siempre la misma lista
    // haría pasar el test sin probar nada, porque el `actualizarCompra` no
    // cambiaría nada de lo que se lee después.
    const compraEnBase: any = { ...COMPRA, proveedores: { nombre: 'Quimicas', activo: true } };
    const { cmp } = await listo({
      getGanancias: () => Promise.resolve([ganancia({ precio: 100000 })]),
      getCompras: () => Promise.resolve([compraEnBase]),
      actualizarCompra: (_id: number, d: any) => { Object.assign(compraEnBase, d); return Promise.resolve(); },
    });
    await cmp.cargarDatos();
    expect(cmp.totalCompras).toBe(48000);
    expect(cmp.balance).toBe(52000);

    cmp.abrirFormCompra(compraEnBase);
    cmp.nuevaCompra.monto = 30000;
    await cmp.guardarCompra();
    await cmp.cargarDatos();

    expect(cmp.totalCompras).toBe(30000);
    expect(cmp.balance).toBe(70000);
  });

  it('si actualizar falla, el popup sigue abierto con los datos', async () => {
    const { cmp } = await listo({ actualizarCompra: () => Promise.reject(new Error('boom')) });
    cmp.abrirFormCompra(COMPRA);
    await cmp.guardarCompra();
    expect(cmp.mensajeError).toMatch(/no se pudo/i);
    expect(cmp.mostrarFormCompra).toBe(true);
    expect(cmp.nuevaCompra.concepto).toBe('Shampoo');   // no se pierde lo tipeado
  });
});

describe('Caja - las tablas tienen el estilo del Dashboard', () => {
  const listo = async (over: Record<string, any> = {}) => {
    const r = montar(over);
    await r.cmp.cargarDatos();
    return r;
  };

  it('las tablas son <table> reales, no la grilla de <div>', async () => {
    // Se cambiaron al estilo del Dashboard por coherencia visual. La razón de
    // este test es otra: la grilla de `<div>`/`<span>` obliga a que el número de
    // columnas esté duplicado en el SCSS (`grid-template-columns`) y en el
    // template, y cuando no coinciden el botón se cae a una segunda línea. Un
    // `<table>` no puede desincronizarse consigo mismo.
    const { cmp, fixture } = await listo({
      getCompras: () => Promise.resolve([{
        id: 1, proveedor_id: 1, fecha: '2026-03-15', concepto: 'X', cantidad: 1,
        monto: 100, notas: null, proveedores: { nombre: 'P', activo: true },
      }]),
    });
    cmp.cambiarTab('gastos');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.tabla-caja').length).toBe(0);
    expect(fixture.nativeElement.querySelectorAll('table.tabla').length).toBeGreaterThan(0);
  });

  it('la fila de compras tiene sus 6 celdas y las dos acciones juntas', async () => {
    const { cmp, fixture } = await listo({
      getCompras: () => Promise.resolve([{
        id: 1, proveedor_id: 1, fecha: '2026-03-15', concepto: 'Shampoo',
        cantidad: 2, monto: 48000, notas: null, proveedores: { nombre: 'Quimicas', activo: true },
      }]),
    });
    cmp.cambiarTab('gastos');
    fixture.detectChanges();

    // Se busca la fila POR SUS BOTONES y no por posición: en la pestaña hay
    // varias tablas (saldo, pagos, compras) y tomar "la primera" o "la última"
    // depende del orden en que se rendericen.
    const filas = Array.from(
      fixture.nativeElement.querySelectorAll('table.tabla tbody tr')
    ) as HTMLElement[];
    const conDosBotones = filas.filter(
      (f) => (f.querySelector('.celda-acciones')?.querySelectorAll('button').length || 0) === 2
    );
    expect(conDosBotones.length).toBe(1);

    // Editar y borrar van JUNTOS en una celda, no sueltos como celdas.
    //
    // Son 6 columnas: Proveedor, Fecha, Concepto, Cant., Monto y Acciones. La
    // del proveedor SOLO aparece cuando el selector está en "Todos" (que es el
    // estado en que arranca): ahí la tabla muestra compras de varios proveedores
    // al mismo tiempo y sin el nombre la fila no se sabe de quién es. Con un
    // proveedor elegido desaparece, porque el nombre ya está arriba.
    expect(conDosBotones[0].children.length).toBe(6);
  });

  it('la celda de acciones esta en la MISMA celda, no suelta', async () => {
    // El bug que motivaba esto: la grilla se elegía con
    // `:has(> span:nth-child(6))`, que nunca matcheaba porque la sexta celda es
    // un botón, y el botón se caía a una segunda línea. Con `<table>` es
    // imposible: cada hijo de la fila es una celda de la tabla.
    const { cmp, fixture } = await listo({
      getPagosEmpleado: () => Promise.resolve([{
        id: 1, empleado_id: 1, fecha: '2026-10-05', monto: 100,
        metodo: 'efectivo', empleados: { nombre: 'E', activo: true },
      }]),
    });
    cmp.cambiarTab('empleados');
    fixture.detectChanges();

    const filas = Array.from(
      fixture.nativeElement.querySelectorAll('table.tabla tbody tr')
    ) as HTMLElement[];
    const conAcciones = filas.filter((f) => f.querySelector('.celda-acciones'));
    expect(conAcciones.length).toBe(1);

    // UNA sola celda de acciones, y es una celda de la fila (no un botón
    // suelto al lado): por eso `children.length` son las 6 columnas.
    expect(conAcciones[0].querySelectorAll('.celda-acciones').length).toBe(1);
    expect(conAcciones[0].children.length).toBe(6);
  });

  it('eliminar una compra pide confirmación antes de tocar la base', async () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { cmp, mock } = await listo();
    await cmp.eliminarCompra({
      id: 1, proveedor_id: 1, fecha: '2026-03-15', concepto: 'Shampoo', cantidad: 2, monto: 48000,
    });
    expect(spy).toHaveBeenCalled();
    expect(mock.llamadas).not.toContain('eliminarCompra');
    spy.mockRestore();
  });
});

describe('Caja — buscador de proveedor del popup', () => {
  const listo = async (over: Record<string, any> = {}) => {
    const r = montar(over);
    await r.cmp.cargarDatos();
    return r;
  };

  const PROVEEDORES = [
    { id: 1, nombre: 'Quimicas del Sur', contacto: 'Ana', telefono: '111', activo: true },
    { id: 2, nombre: 'Ledesma SA', contacto: 'Beto', telefono: '222', activo: true },
    { id: 3, nombre: 'Quimicas del Norte', contacto: 'Caro', telefono: '333', activo: true },
    { id: 4, nombre: 'Proveedor Inactivo', contacto: null, telefono: null, activo: false },
  ];

  const conTodos = (over: Record<string, any> = {}) =>
    listo({ getProveedores: () => Promise.resolve(PROVEEDORES), ...over });

  it('sin texto escrito no hay resultados', async () => {
    const { cmp } = await conTodos();
    cmp.busquedaProveedorPopup = '';
    expect(cmp.resultadosBusquedaProveedor).toEqual([]);
  });

  it('filtra por fragmento del nombre', async () => {
    const { cmp } = await conTodos();
    cmp.busquedaProveedorPopup = 'ledes';
    expect(cmp.resultadosBusquedaProveedor.map(p => p.id)).toEqual([2]);
  });

  // El de Dashboard usa `.ilike()` en Postgres, que NO ignora acentos. Este
  // filtra en memoria con `contiene`, así que "quimicas" encuentra "Químicas".
  it('ignora acentos, a diferencia del .ilike() del Dashboard', async () => {
    const { cmp } = await conTodos();
    for (const q of ['quimicas', 'QUIMICAS', 'Químicas', 'del norte']) {
      cmp.busquedaProveedorPopup = q;
      expect(cmp.resultadosBusquedaProveedor.length).toBeGreaterThan(0);
    }
    cmp.busquedaProveedorPopup = 'del norte';
    expect(cmp.resultadosBusquedaProveedor.map(p => p.id)).toEqual([3]);
  });

  it('NO ofrece proveedores inactivos', async () => {
    const { cmp } = await conTodos();
    cmp.busquedaProveedorPopup = 'inactivo';
    expect(cmp.resultadosBusquedaProveedor).toEqual([]);
  });

  it('no consulta la base: filtra la lista que ya está en memoria', async () => {
    // El de Dashboard hace `buscarClientes()` en cada tecla. Este no debe.
    const { cmp, mock } = await conTodos();
    const antes = mock.llamadas.filter((c: string) => c === 'getProveedores').length;
    cmp.busquedaProveedorPopup = 'qui';
    cmp.resultadosBusquedaProveedor;
    cmp.busquedaProveedorPopup = 'quim';
    cmp.resultadosBusquedaProveedor;
    expect(mock.llamadas.filter((c: string) => c === 'getProveedores').length).toBe(antes);
  });

  it('el resultado se limita a 8 para no alargar el popup', async () => {
    const muchos = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1, nombre: 'Quimica ' + i, activo: true,
    }));
    const { cmp } = await conTodos({ getProveedores: () => Promise.resolve(muchos) });
    cmp.busquedaProveedorPopup = 'quimica';
    expect(cmp.resultadosBusquedaProveedor.length).toBe(8);
  });

  it('elegir uno lo selecciona, llena el id y limpia la búsqueda', async () => {
    const { cmp } = await conTodos();
    cmp.busquedaProveedorPopup = 'ledes';
    cmp.seleccionarProveedorPopup(cmp.resultadosBusquedaProveedor[0]);
    expect(cmp.proveedorSeleccionado.nombre).toBe('Ledesma SA');
    expect(cmp.nuevaCompra.proveedor_id).toBe(2);
    expect(cmp.busquedaProveedorPopup).toBe('');
  });

  it('la búsqueda y el id NO se desincronizan', async () => {
    // Si se desincronizan, el popup muestra un proveedor y se guarda otro.
    const { cmp } = await conTodos();
    cmp.seleccionarProveedorPopup({ id: 2, nombre: 'Ledesma SA' });
    expect(cmp.proveedorSeleccionado.id).toBe(cmp.nuevaCompra.proveedor_id);
    cmp.quitarProveedorPopup();
    expect(cmp.proveedorSeleccionado).toBeNull();
    expect(cmp.nuevaCompra.proveedor_id).toBeNull();
  });

  it('con texto y sin resultados, ofrece crear', async () => {
    const { cmp } = await conTodos();
    cmp.busquedaProveedorPopup = 'Uno Que No Existe';
    expect(cmp.puedeCrearProveedorDesdePopup).toBe(true);
  });

  it('con resultados, NO ofrece crear', async () => {
    const { cmp } = await conTodos();
    cmp.busquedaProveedorPopup = 'ledes';
    expect(cmp.puedeCrearProveedorDesdePopup).toBe(false);
  });

  it('con algo YA elegido, no ofrece crear aunque el texto matchee', async () => {
    const { cmp } = await conTodos();
    cmp.seleccionarProveedorPopup({ id: 2, nombre: 'Ledesma SA' });
    cmp.busquedaProveedorPopup = 'otro';
    expect(cmp.puedeCrearProveedorDesdePopup).toBe(false);
  });

  it('crear desde el popup lo deja ELEGIDO y listo para cargar la compra', async () => {
    const creados: any[] = [];
    const nuevos = [...PROVEEDORES];
    const { cmp } = await conTodos({
      getProveedores: () => Promise.resolve(nuevos),
      crearProveedor: (d: any) => {
        const nuevo = { id: 99, nombre: d.nombre, contacto: null, telefono: null, activo: true };
        nuevos.push(nuevo);
        creados.push(d);
        return Promise.resolve(nuevo);
      },
    });
    cmp.busquedaProveedorPopup = 'Quimicas del Este';
    cmp.nombreNuevoProveedor = 'Quimicas del Este';

    await cmp.crearYSeleccionarProveedor();

    expect(creados.length).toBe(1);
    expect(creados[0].nombre).toBe('Quimicas del Este');
    // Queda elegido: el usuario no tiene que volver a buscarlo.
    expect(cmp.proveedorSeleccionado.nombre).toBe('Quimicas del Este');
    expect(cmp.nuevaCompra.proveedor_id).toBe(99);
    expect(cmp.busquedaProveedorPopup).toBe('');
    expect(cmp.mostrarFormNuevoProveedor).toBe(false);
  });

  it('crear uno que YA existe avisa y no llama a la base', async () => {
    let creados = 0;
    const { cmp } = await conTodos({
      crearProveedor: () => { creados++; return Promise.resolve({}); },
    });
    cmp.busquedaProveedorPopup = ' ledesma sa ';
    await cmp.crearYSeleccionarProveedor();
    expect(creados).toBe(0);
    expect(cmp.mensajeError).toMatch(/ya existe/i);
  });

  it('crear sin nombre avisa', async () => {
    const { cmp } = await conTodos();
    cmp.busquedaProveedorPopup = '   ';
    await cmp.crearYSeleccionarProveedor();
    expect(cmp.mensajeError).toMatch(/nombre/i);
  });

  it('EDITAR una compra deja preseleccionado su proveedor', async () => {
    // Sin esto se abre con el id cargado en el modelo y el buscador vacío:
    // "no hay proveedor elegido" con uno ya asignado.
    const { cmp } = await conTodos();
    cmp.abrirFormCompra({
      id: 5, proveedor_id: 2, fecha: '2026-03-15', concepto: 'X', cantidad: 1, monto: 100,
      proveedores: { nombre: 'Ledesma SA', activo: true },
    });
    expect(cmp.proveedorSeleccionado.nombre).toBe('Ledesma SA');
    expect(cmp.nuevaCompra.proveedor_id).toBe(2);
    expect(cmp.busquedaProveedorPopup).toBe('');
  });

  it('abrir un ALTA arranca sin proveedor elegido', async () => {
    const { cmp } = await conTodos();
    cmp.abrirFormCompra();
    expect(cmp.proveedorSeleccionado).toBeNull();
    expect(cmp.nuevaCompra.proveedor_id).toBeNull();
  });

  it('cerrar el popup limpia el buscador y la selección', async () => {
    const { cmp } = await conTodos();
    cmp.abrirFormCompra();
    cmp.seleccionarProveedorPopup({ id: 2, nombre: 'Ledesma SA' });
    cmp.mostrarFormNuevoProveedor = true;
    cmp.nombreNuevoProveedor = 'algo';

    cmp.cerrarFormCompra();

    expect(cmp.busquedaProveedorPopup).toBe('');
    expect(cmp.proveedorSeleccionado).toBeNull();
    expect(cmp.mostrarFormNuevoProveedor).toBe(false);
    expect(cmp.nombreNuevoProveedor).toBe('');
  });

  it('el popup usa el buscador, no un <select>', async () => {
    const { cmp, fixture } = await conTodos();
    cmp.abrirFormCompra();
    fixture.detectChanges();
    const popup = fixture.nativeElement.querySelector('.popup-overlay');
    expect(popup.querySelectorAll('select').length).toBe(0);
    expect(popup.querySelector('input[placeholder*="Buscar proveedor"]')).toBeTruthy();
  });

  it('con resultados, el popup los lista y NO muestra "crear"', async () => {
    const { cmp, fixture } = await conTodos();
    cmp.abrirFormCompra();
    cmp.busquedaProveedorPopup = 'quimicas';
    fixture.detectChanges();
    const popup = fixture.nativeElement.querySelector('.popup-overlay');
    expect(popup.querySelectorAll('.dropdown-busqueda .dropdown-item').length).toBe(2);
    expect(popup.querySelectorAll('.crear-inline').length).toBe(0);
  });

  it('sin resultados, el popup muestra "crear"', async () => {
    const { cmp, fixture } = await conTodos();
    cmp.abrirFormCompra();
    cmp.busquedaProveedorPopup = 'nada de esto';
    fixture.detectChanges();
    const popup = fixture.nativeElement.querySelector('.popup-overlay');
    expect(popup.querySelectorAll('.dropdown-busqueda').length).toBe(0);
    expect(popup.querySelectorAll('.crear-inline').length).toBe(1);
  });
});

describe('Caja — proveedores y compras', () => {
  const listo = async (over: Record<string, any> = {}) => {
    const r = montar(over);
    await r.cmp.cargarDatos();
    return r;
  };

  it('el combo de compra solo ofrece proveedores activos', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([
        { id: 1, nombre: 'Activo', activo: true },
        { id: 2, nombre: 'Inactivo', activo: false },
      ]),
    });
    expect(cmp.proveedoresActivos.map((p: any) => p.id)).toEqual([1]);
  });

  it('compra: exige proveedor, fecha, concepto y monto > 0', async () => {
    const { cmp, mock } = await listo();
    const base = { proveedor_id: 1, fecha: '2026-10-08', concepto: 'Shampoo', cantidad: 1, monto: 5000 };
    const casos: any[] = [
      { ...base, proveedor_id: null, esperado: /proveedor/i },
      { ...base, fecha: '', esperado: /fecha/i },
      { ...base, concepto: '  ', esperado: /concepto/i },
      { ...base, monto: 0, esperado: /mayor a 0/i },
    ];
    for (const c of casos) {
      cmp.nuevaCompra = { ...c };
      await cmp.guardarCompra();
      expect(cmp.mensajeError).toMatch(c.esperado);
    }
    expect(mock.llamadas).not.toContain('crearCompra');
  });

  it('compra válida: guarda y recarga', async () => {
    const guardadas: any[] = [];
    const { cmp } = await listo({
      crearCompra: (c: any) => { guardadas.push(c); return Promise.resolve({ id: 1, ...c }); },
    });
    cmp.nuevaCompra = { proveedor_id: 1, fecha: '2026-10-08', concepto: '  12 bidones  ', cantidad: '12', monto: '48000', notas: '' };
    await cmp.guardarCompra();
    expect(guardadas.length).toBe(1);
    expect(guardadas[0].concepto).toBe('12 bidones');
    expect(guardadas[0].cantidad).toBe(12);
    expect(guardadas[0].monto).toBe(48000);
  });

  it('comprasPorProveedor agrupa y ordena de mayor a menor', async () => {
    const { cmp } = await listo({
      getCompras: () => Promise.resolve([
        COMPRA(1, 1, 'Ledesma', 10000),
        COMPRA(2, 2, 'Químicas', 50000),
        COMPRA(3, 1, 'Ledesma', 20000),
      ]),
    });
    await cmp.cargarDatos();
    const r = cmp.comprasPorProveedor;
    expect(r[0].nombre).toBe('Químicas');
    expect(r[0].total).toBe(50000);
    expect(r[1].nombre).toBe('Ledesma');
    expect(r[1].total).toBe(30000);
    expect(r[1].cantidad).toBe(2);
  });

  it('una compra cuyo proveedor fue borrado no rompe el resumen', async () => {
    const { cmp } = await listo({
      getCompras: () => Promise.resolve([
        { id: 1, proveedor_id: 99, fecha: '2026-10-08', concepto: 'Algo', cantidad: 1, monto: 1000, proveedores: null },
      ]),
    });
    await cmp.cargarDatos();
    expect(cmp.comprasPorProveedor[0].nombre).toBe('Proveedor #99');
    expect(cmp.totalCompras).toBe(1000);
  });
});

describe('Caja — carga', () => {
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

describe('Caja — totales', () => {
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

describe('Caja — rangos de fecha', () => {
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

describe('Caja — grafico', () => {
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

describe('Caja — navegacion', () => {
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

describe('Caja — titulo', () => {
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

describe('Caja — los tres montos del empleado y del proveedor elegidos', () => {
  // ══════════════════════════════════════════════════════════════
  // POR QUÉ ESTOS TESTS EXISTEN
  //
  // La pantalla promete que con los tres cuadros de arriba alcanza: cuánto le
  // debo, cuánto le pagué y cuánto falta. Eso es un COMPROMISO con el usuario,
  // y un compromiso así solo se verifica con números, no mirando la pantalla.
  //
  // El riesgo concreto es que los tres se calculen por separado y uno quede
  // viejo: si `pague` se leyera de `pagos` y `debo` de `pagosPorEmpleado`, un
  // cambio en uno no se propagaría al otro y la resta de abajo mentiría.
  // ══════════════════════════════════════════════════════════════

  const listo = async (over: Record<string, any> = {}) => {
    const r = montar(over);
    await r.cmp.cargarDatos();
    return r;
  };

  // ── EMPLEADO ──────────────────────────────────────────────

  it('los tres montos salen de la misma fila y la resta cierra', async () => {
    const { cmp } = await listo({
      getComisionesPeriodo: () => Promise.resolve([SUGERIDO(1, 'Juan Pérez', 25000, 3)]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(10000)]),
    });

    expect(cmp.deboEmpleado).toBe(25000);
    expect(cmp.pagueEmpleado).toBe(10000);
    // 25.000 - 10.000: todavía hay 15.000 por dar.
    cmp.elegirEmpleado(1);
    expect(cmp.debeEmpleadoTotal).toBe(15000);
  });

  it('"Falta pagar" da NEGATIVO cuando se le pagó de más', async () => {
    // Es el caso que el usuario reportó: se le pagaron 25.000 y no atendió nada.
    // Decirle "debe 25.000" está mal; lo correcto es que NO le debe nada.
    const { cmp } = await listo({
      getComisionesPeriodo: () => Promise.resolve([SUGERIDO(1, 'Juan Pérez', 0, 0)]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(25000)]),
    });

    expect(cmp.deboEmpleado).toBe(0);
    expect(cmp.pagueEmpleado).toBe(25000);
    // NEGATIVO ya no existe en pantalla: se parte en dos cantidades.
    cmp.elegirEmpleado(1);
    expect(cmp.haberEmpleadoTotal).toBe(25000);
    expect(cmp.textoSaldoEmpleado).toBe('A favor');
  });

  it('el cuadro de "Debe / Haber" es el mismo número que la fila de la tabla', async () => {
    // Si el cuadro y la fila se calcularan por dos caminos distintos, el cuadro
    // de arriba y la fila de abajo podrían mostrar números distintos.
    const { cmp } = await listo({
      getComisionesPeriodo: () => Promise.resolve([
        SUGERIDO(1, 'Juan Pérez', 25000, 3),
        SUGERIDO(2, 'Esteban', 12000, 2),
      ]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(10000)]),
    });

    // Elegir PRIMERO y buscar la fila DESPUÉS, al revés de como estaba. Buscar
    // la fila antes comparaba el empleado 1 (el que venía por defecto) contra
    // los montos del 2 que se elegía después: dos empleados distintos, dos
    // números distintos, y el test pasaba/fallaba sin que nada estuviera roto.
    cmp.elegirEmpleado(2);
    const fila = cmp.filaEmpleadoActual;
    expect(fila).toBeTruthy();
    expect(fila.empleado_id).toBe(2);

    // El cuadro es la misma diferencia, partida en dos positivos.
    expect(cmp.debeEmpleadoTotal + cmp.haberEmpleadoTotal).toBe(Math.abs(fila.faltaPagar));
    expect(cmp.deboEmpleado).toBe(fila.sugerido);
    expect(cmp.pagueEmpleado).toBe(fila.pagado);
  });

  it('cambiar de empleado cambia los tres montos', async () => {
    // El selector tiene que mover los tres cuadros, no solo el detalle de abajo.
    const { cmp } = await listo({
      getComisionesPeriodo: () => Promise.resolve([
        SUGERIDO(1, 'Juan Pérez', 25000, 3),
        SUGERIDO(2, 'Esteban', 12000, 2),
      ]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(10000)]),
    });

    cmp.elegirEmpleado(1);
    expect(cmp.deboEmpleado).toBe(25000);

    cmp.elegirEmpleado(2);
    expect(cmp.deboEmpleado).toBe(12000);
    // Esteban no tiene pagos registrados.
    expect(cmp.pagueEmpleado).toBe(0);
    cmp.elegirEmpleado(2);
    expect(cmp.debeEmpleadoTotal).toBe(12000);
  });

  it('elegir un empleado NO vuelve a consultar la base', async () => {
    // Un `(click)` que llamara a `cargarDatos()` haría una ida entera a la base
    // para mostrar un dato que ya está en memoria.
    const { cmp, mock } = await listo({
      getComisionesPeriodo: () => Promise.resolve([SUGERIDO(1, 'Juan Pérez', 25000, 3)]),
    });
    const antes = mock.llamadas.length;
    cmp.elegirEmpleado(1);
    expect(mock.llamadas.length).toBe(antes);
  });

  it('sin empleados cargados los tres montos dan 0, no NaN', async () => {
    // Un `undefined`restado termina en `NaN` y la pantalla muestra "NaN" o "--".
    const { cmp } = await listo({ getEmpleados: () => Promise.resolve([]) });
    expect(cmp.empleadoActual).toBe(null);
    expect(cmp.deboEmpleado).toBe(0);
    expect(cmp.pagueEmpleado).toBe(0);
    cmp.elegirEmpleado(2);
    expect(cmp.debeEmpleadoTotal).toBe(0);
    expect(cmp.haberEmpleadoTotal).toBe(0);
  });

  it('la frase del cuadro es SIEMPRE Debe, A favor, o vacia', async () => {
    const { cmp } = await listo({
      getComisionesPeriodo: () => Promise.resolve([
        SUGERIDO(1, 'A', 30000, 3),   // sugerido 30.000, pagado 10.000 -> debe 20.000
        SUGERIDO(2, 'B', 20000, 2),   // sugerido 20.000, pagado 10.000 -> debe 10.000
        SUGERIDO(3, 'C', 10000, 1),   // sugerido 10.000, pagado 20.000 -> A favor 10.000
      ]),
      getPagosEmpleado: () => Promise.resolve([
        PAGO_JUAN(10000),
        { id: 2, empleado_id: 2, fecha: '2026-10-05', monto: 10000, metodo: 'efectivo', empleados: null },
        { id: 3, empleado_id: 3, fecha: '2026-10-05', monto: 20000, metodo: 'efectivo', empleados: null },
      ]),
    });

    cmp.elegirEmpleado(1);
    expect(cmp.textoSaldoEmpleado).toBe('Debo');
    cmp.elegirEmpleado(2);
    expect(cmp.textoSaldoEmpleado).toBe('Debo');
    cmp.elegirEmpleado(3);
    expect(cmp.textoSaldoEmpleado).toBe('A favor');
  });

  it('la frase del lado del empleado dice Debo cuando hay que pagarle', async () => {
    // Aparte del test anterior porque NO se puede montar dos veces en el mismo
    // `it`: el TestBed queda instanciado y la segunda montagem tira.
    const { cmp } = await listo({
      getComisionesPeriodo: () => Promise.resolve([SUGERIDO(1, 'A', 30000, 3)]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(10000)]),
    });
    // 30.000 sugeridos, 10.000 pagados: faltan 20.000.
    cmp.elegirEmpleado(1);
    expect(cmp.debeEmpleadoTotal).toBe(20000);
    expect(cmp.textoSaldoEmpleado).toBe('Debo');
  });

  // ── PROVEEDOR ─────────────────────────────────────────────

  it('comprar NO es pagar: sin abonos, "Le debo" es lo comprado', async () => {
    // El bug reportado: se compraron 12.000 y la tarjeta decía "−$12.000", que se
    // leía como una deuda. Comprado es un gasto; la deuda es lo comprado menos
    // lo pagado, y con nada pagado la deuda es exactamente lo comprado.
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ id: 1, nombre: 'Quimicas del Sur', activo: true }]),
      getCompras: () => Promise.resolve([COMPRA(1, 1, 'Quimicas del Sur', 12000)]),
    });

    expect(cmp.compreProveedor).toBe(12000);
    expect(cmp.pagueProveedor).toBe(0);
    cmp.elegirProveedor(1);
    expect(cmp.debeProveedorTotal).toBe(12000);
    expect(cmp.textoSaldoProveedorTotal).toBe('Debo');
  });

  it('con un abono parcial, "Le debo" es la diferencia', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ id: 1, nombre: 'Quimicas del Sur', activo: true }]),
      getCompras: () => Promise.resolve([COMPRA(1, 1, 'Quimicas del Sur', 12000)]),
      getPagosProveedor: () => Promise.resolve([
        { id: 1, proveedor_id: 1, fecha: '2026-10-08', monto: 7000, metodo: 'transferencia', proveedores: { nombre: 'Quimicas del Sur', activo: true } },
      ]),
    });

    expect(cmp.compreProveedor).toBe(12000);
    expect(cmp.pagueProveedor).toBe(7000);
    cmp.elegirProveedor(1);
    expect(cmp.debeProveedorTotal).toBe(5000);
  });

  it('si se pagó todo, "Le debo" da 0 y no un número negativo', async () => {
    // Un saldo en negativo con un cartel que dice "le debés" se lee al revés.
    // Con cero, la pantalla dice cero y la frase dice que no debe nada.
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ id: 1, nombre: 'Quimicas del Sur', activo: true }]),
      getCompras: () => Promise.resolve([COMPRA(1, 1, 'Quimicas del Sur', 12000)]),
      getPagosProveedor: () => Promise.resolve([
        { id: 1, proveedor_id: 1, fecha: '2026-10-08', monto: 12000, metodo: 'transferencia', proveedores: { nombre: 'Quimicas del Sur', activo: true } },
      ]),
    });

    cmp.elegirProveedor(1);
    expect(cmp.debeProveedorTotal).toBe(0);
    expect(cmp.haberProveedorTotal).toBe(0);
    expect(cmp.textoSaldoProveedorTotal).toBe('');
  });

  it('cambiar de proveedor cambia los tres montos', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([
        { id: 1, nombre: 'Quimicas del Sur', activo: true },
        { id: 2, nombre: 'Otro', activo: true },
      ]),
      getCompras: () => Promise.resolve([
        COMPRA(1, 1, 'Quimicas del Sur', 12000),
        COMPRA(2, 2, 'Otro', 3000),
      ]),
    });

    cmp.elegirProveedor(1);
    expect(cmp.compreProveedor).toBe(12000);
    cmp.elegirProveedor(2);
    expect(cmp.compreProveedor).toBe(3000);
  });

  it('el detalle de compras y de abonos es del proveedor elegido', async () => {
    // Si el detalle no se filtrara, la tabla de abajo mostraría las compras de
    // OTRO proveedor y el cuadro de arriba no cerraría con lo que hay debajo.
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([
        { id: 1, nombre: 'Quimicas del Sur', activo: true },
        { id: 2, nombre: 'Otro', activo: true },
      ]),
      getCompras: () => Promise.resolve([
        COMPRA(1, 1, 'Quimicas del Sur', 12000),
        COMPRA(2, 2, 'Otro', 3000),
        COMPRA(3, 1, 'Quimicas del Sur', 2000),
      ]),
      getPagosProveedor: () => Promise.resolve([
        { id: 1, proveedor_id: 1, fecha: '2026-10-08', monto: 5000, metodo: 'transferencia', proveedores: { nombre: 'Quimicas del Sur', activo: true } },
        { id: 2, proveedor_id: 2, fecha: '2026-10-08', monto: 1000, metodo: 'transferencia', proveedores: { nombre: 'Otro', activo: true } },
      ]),
    });
    // El primero: 2 compras y 1 abono.
    cmp.elegirProveedor(1);
    expect(cmp.comprasProveedorActual.length).toBe(2);
    expect(cmp.pagosProveedorActual.length).toBe(1);
    // 12.000 + 2.000 comprados, 5.000 pagados.
    expect(cmp.compreProveedor).toBe(14000);
    expect(cmp.pagueProveedor).toBe(5000);
    expect(cmp.debeProveedorTotal).toBe(9000);

    // El segundo: 1 compra y 1 abono.
    cmp.elegirProveedor(2);
    expect(cmp.comprasProveedorActual.length).toBe(1);
    expect(cmp.pagosProveedorActual.length).toBe(1);
    // 3.000 comprados, 1.000 pagados.
    expect(cmp.compreProveedor).toBe(3000);
    expect(cmp.pagueProveedor).toBe(1000);
    expect(cmp.debeProveedorTotal).toBe(2000);
  });


  it('un id de empleado que no es un número cae al primero, no a NaN', async () => {
    // `NaN !== null`, así que una comparación suelta lo deja pasar y los tres
    // montos dan 0 sin que nada en pantalla explique por qué. Es un caso que no
    // se llega a tocar desde el dropdown, pero deja la pantalla en un estado
    // imposible de explicar, así que el getter lo cubre.
    const { cmp } = await listo({
      getComisionesPeriodo: () => Promise.resolve([SUGERIDO(1, 'A', 25000, 3)]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(10000)]),
    });

    cmp.elegirEmpleadoDelCombo('no-es-un-numero');
    expect(cmp.empleadoActual).not.toBeNaN();
    expect(Number.isFinite(cmp.empleadoActual as number)).toBe(true);

    // Y los montos no quedan todos en cero sin motivo.
    expect(cmp.deboEmpleado).toBeGreaterThan(0);
  });

  it('sin proveedores cargados los tres montos dan 0, no NaN', async () => {
    const { cmp } = await listo({ getProveedores: () => Promise.resolve([]) });
    expect(cmp.proveedorActual).toBe(null);
    expect(cmp.compreProveedor).toBe(0);
    expect(cmp.pagueProveedor).toBe(0);
    // Sale del modo "Todos" para afirmar sobre UN proveedor y no sobre el total.
    expect(cmp.debeProveedorTotal).toBe(0);
    expect(cmp.haberProveedorTotal).toBe(0);
  });

  it('si la tabla pagos_proveedor no existe, la pantalla igual carga', async () => {
    // La migración 013 puede no estar aplicada en el proyecto. `cargarDatos` lo
    // captura para que no se caiga TODA la pantalla por una tabla que falta.
    const { cmp } = await listo({
      getPagosProveedor: () => Promise.reject(new Error('relation "pagos_proveedor" does not exist')),
      getCompras: () => Promise.resolve([COMPRA(1, 1, 'Quimicas del Sur', 12000)]),
    });

    expect(cmp.pagosProveedor).toEqual([]);
    // Y los otros datos siguen intactos: el total de compras no se pierde.
    expect(cmp.totalCompras).toBe(12000);
  });
});

describe('Caja — los cuadros no muestran el signo negativo', () => {
  // ══════════════════════════════════════════════════════════════
  // LO QUE PIDIO EL USUARIO, EXPRESO
  //
  //   · "no le pongas signos negativo"
  //   · "en la frase pon A su favor"
  //   · "que no sean frases largas"
  //   · "con rojo y verde ya estaria, de ultima pone A su favor, si no nada"
  //
  // O sea: el numero va SIEMPRE en positivo, la frase solo aparece cuando el
  // saldo es A SU FAVOR, y en los otros dos casos no dice nada porque el color
  // ya lo dice.
  //
  // Estos tests miran el TEXTO RENDERIZADO, no el getter del numero: el getter
  // sigue siendo negativo (es la cuenta correcta) y lo que cambia es que en
  // pantalla no aparece el `−`. Un test del getter no_notaria_ nada de esto.
  // ══════════════════════════════════════════════════════════════

  const listo = async (over: Record<string, any> = {}) => {
    const r = montar(over);
    await r.cmp.cargarDatos();
    return r;
  };

  const norm = (t: string) => t.replace(/[.,]/g, '').trim();

  it('un saldo a favor se muestra POSITIVO, con "A su favor" y sin guion', async () => {
    // Se le pagaron 25.000 y no atendio nada: el caso del "debo 25 mil".
    const { cmp, fixture } = await listo({
      getComisionesPeriodo: () => Promise.resolve([SUGERIDO(1, 'Esteban', 0, 0)]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(25000)]),
    });
    cmp.cambiarTab('empleados');
    fixture.detectChanges();

    const tarjetas = fixture.nativeElement.querySelectorAll('.stats-trio .stat-card');
    const tercera = tarjetas[tarjetas.length - 1];
    const valor = norm((tercera.querySelector('.stat-value').textContent || ''));
    const nota = norm((tercera.querySelector('.stat-nota').textContent || ''));

    // POSITIVO: sin el `−` (U+2212) ni el guion ASCII.
    expect(valor).toBe('$25000');
    expect(valor.includes('-')).toBe(false);
    expect(valor.includes(String.fromCharCode(0x2212))).toBe(false);
    expect(nota).toBe('A favor');
  });

  it('una deuda se muestra positiva, en rojo, y dice "Debo"', async () => {
    const { cmp, fixture } = await listo({
      getComisionesPeriodo: () => Promise.resolve([SUGERIDO(1, 'Esteban', 30000, 3)]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(10000)]),
    });
    cmp.cambiarTab('empleados');
    fixture.detectChanges();

    const tarjetas = fixture.nativeElement.querySelectorAll('.stats-trio .stat-card');
    const tercera = tarjetas[tarjetas.length - 1];
    const valor = norm((tercera.querySelector('.stat-value').textContent || ''));
    const nota = norm((tercera.querySelector('.stat-nota').textContent || ''));

    expect(valor).toBe('$20000');
    // La palabra NO es decorativa: el título del cuadro es "Debe / Haber", que
    // no dice de qué lado está. Sin el "Debo" de abajo, un $20.000 en rojo al lado
    // de un $25.000 en verde no sabría explicar de quién es cada uno.
    expect(nota).toBe('Debo');
    // Y el color también lo avisa: rojo.
    expect(tercera.classList.contains('rojo')).toBe(true);
  });

  it('cuadra exacto: $0, sin frase, en verde', async () => {
    const { cmp, fixture } = await listo({
      getComisionesPeriodo: () => Promise.resolve([SUGERIDO(1, 'Esteban', 10000, 1)]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(10000)]),
    });
    cmp.cambiarTab('empleados');
    fixture.detectChanges();

    const tarjetas = fixture.nativeElement.querySelectorAll('.stats-trio .stat-card');
    const tercera = tarjetas[tarjetas.length - 1];
    expect(norm((tercera.querySelector('.stat-nota').textContent || ''))).toBe('');
    expect(tercera.classList.contains('verde')).toBe(true);
    // El cero es `$0` y NO una raya. Con la raya, esta tarjeta se veía distinta
    // de las dos de al lado que sí muestran `$0`, y un número que no aparece
    // parece un dato que falta.
    expect(norm((tercera.querySelector('.stat-value').textContent || ''))).toBe('$0');
  });

  it('en Gastos pasa lo mismo: "A favor" y sin signo', async () => {
    const { cmp, fixture } = await listo({
      getProveedores: () => Promise.resolve([{ id: 1, nombre: 'Quimicas del Sur', activo: true }]),
      getCompras: () => Promise.resolve([COMPRA(1, 1, 'Quimicas del Sur', 5000)]),
      getPagosProveedor: () => Promise.resolve([
        { id: 1, proveedor_id: 1, fecha: '2026-10-08', monto: 12000, metodo: 'transferencia', proveedores: { nombre: 'Quimicas del Sur', activo: true } },
      ]),
    });
    cmp.cambiarTab('gastos');
    fixture.detectChanges();

    const tarjetas = fixture.nativeElement.querySelectorAll('.stats-trio .stat-card');
    const tercera = tarjetas[tarjetas.length - 1];
    const valor = norm((tercera.querySelector('.stat-value').textContent || ''));

    // Se le pagaron 12.000 sobre 5.000 comprados: 7.000 a su favor.
    expect(valor).toBe('$7000');
    expect(valor.includes(String.fromCharCode(0x2212))).toBe(false);
    expect(norm((tercera.querySelector('.stat-nota').textContent || ''))).toBe('A favor');
    expect(tercera.classList.contains('verde')).toBe(true);
  });

  it('la frase es SIEMPRE una de las TRES, nunca un parrafo', async () => {
    // Un `.toContain` sobre la lista cerrada. Es lo que frena que vuelva la frase
    // larga del principio: "Se le pago de mas, no le debes nada". El pedido fue
    // una o dos palabras, y esta lista es de tres valores con dos palabras cada
    // uno (o vacío).
    const { cmp } = await listo({
      getComisionesPeriodo: () => Promise.resolve([
        SUGERIDO(1, 'A', 30000, 3),
        SUGERIDO(2, 'B', 20000, 2),
        SUGERIDO(3, 'C', 10000, 1),
      ]),
      getPagosEmpleado: () => Promise.resolve([
        PAGO_JUAN(10000),
        { id: 2, empleado_id: 2, fecha: '2026-10-05', monto: 10000, metodo: 'efectivo', empleados: null },
        { id: 3, empleado_id: 3, fecha: '2026-10-05', monto: 20000, metodo: 'efectivo', empleados: null },
      ]),
    });

    // Las tres, y solo tres: "Debo", "A favor", y vacío en el cuadrado exacto.
    const permitidas = ['', 'Debo', 'A favor'];
    for (const id of [1, 2, 3]) {
      cmp.elegirEmpleado(id);
      expect(permitidas).toContain(cmp.textoSaldoEmpleado);
    }

    // Y que ninguna sea larga. Dos palabras es el techo.
    for (const id of [1, 2, 3]) {
      cmp.elegirEmpleado(id);
      expect(cmp.textoSaldoEmpleado.split(' ').filter(Boolean).length).toBeLessThanOrEqual(2);
    }
  });
});

describe('Caja - los popups y la coherencia entre las dos pestanas', () => {
  const listo = async (over: Record<string, any> = {}) => {
    const r = montar(over);
    await r.cmp.cargarDatos();
    return r;
  };


  it('los dos primeros acordeones arrancan ABIEERTOS en las DOS pestañas', () => {
    // Coherencia entre Empleados y Gastos. Antes Gastos abría los tres cerrados
    // y Empleados los dos primeros abiertos: dos pantallas que se leen igual
    // arrancaban distinto, y hadia que abrir a mano lo mismo en una de las dos.
    const { cmp } = montar();
    cmp.cambiarTab('empleados');
    expect(cmp.acordeonDetalle).toBe(true);
    expect(cmp.acordeonPagos).toBe(true);
    expect(cmp.acordeonTotales).toBe(false);

    cmp.cambiarTab('gastos');
    expect(cmp.acordeonPagosProv).toBe(true);
    expect(cmp.acordeonCompras).toBe(true);
    expect(cmp.acordeonSaldo).toBe(false);
  });

  it('el popup de pago a empleado abre con el del selector, no vacío', async () => {
    // El botón está DENTRO del detalle de ese empleado: si abrís el popup tiene
    // que ser de él. Antes venía "Elegí..." con el empleado ya elegido arriba.
    const { cmp } = await listo({
      getComisionesPeriodo: () => Promise.resolve([
        SUGERIDO(1, 'Juan Pérez', 25000, 3),
        SUGERIDO(2, 'Esteban', 12000, 2),
      ]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(10000)]),
    });

    cmp.elegirEmpleado(2);
    cmp.abrirFormPago();
    expect(cmp.nuevoPago.empleado_id).toBe(2);

    // Y cambia con el selector: no queda pegado el primero.
    cmp.cerrarFormPago();
    cmp.elegirEmpleado(1);
    cmp.abrirFormPago();
    expect(cmp.nuevoPago.empleado_id).toBe(1);
  });

  it('con el combo en "Todos" el popup igual queda con alguien puesto', async () => {
    // Nadie está elegido, así que va el primero que pueda recibir un pago. Un
    // popup que abre con "Elegí..." y no se puede guardar es peor que uno que
    // abre con un default y se ve cuál es.
    const { cmp } = await listo({
      getComisionesPeriodo: () => Promise.resolve([
        SUGERIDO(1, 'Juan Pérez', 25000, 3),
        SUGERIDO(2, 'Esteban', 12000, 2),
      ]),
    });
    expect(cmp.mostrarTodos).toBe(true);
    cmp.abrirFormPago();
    expect(cmp.nuevoPago.empleado_id).not.toBeNull();
  });

  it('el popup de pago a proveedor abre con el proveedor del selector', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([
        { id: 1, nombre: 'Quimicas del Sur', activo: true },
        { id: 2, nombre: 'Otro', activo: true },
      ]),
      getCompras: () => Promise.resolve([
        COMPRA(1, 1, 'Quimicas del Sur', 12000),
        COMPRA(2, 2, 'Otro', 3000),
      ]),
      getPagosProveedor: () => Promise.resolve([
        { id: 1, proveedor_id: 2, fecha: '2026-10-08', monto: 1000, metodo: 'transferencia', proveedores: { nombre: 'Otro', activo: true } },
      ]),
    });

    cmp.elegirProveedor(1);
    cmp.abrirFormPagoProveedor();
    expect(cmp.nuevoPagoProveedor.proveedor_id).toBe(1);

    cmp.cerrarFormPagoProveedor();
    cmp.elegirProveedor(2);
    cmp.abrirFormPagoProveedor();
    expect(cmp.nuevoPagoProveedor.proveedor_id).toBe(2);
  });

  it('el popup de COMPRA abre con el proveedor del selector puesto', async () => {
    // El buscador muestra `proveedorSeleccionado.nombre`, no un id: si solo
    // pasara el id, la pantalla diría "no hay proveedor elegido" con uno ya
    // asignado, que es el bug que el comentario de `abrirFormCompra` describe.
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([
        { id: 1, nombre: 'Quimicas del Sur', activo: true },
        { id: 2, nombre: 'Otro', activo: true },
      ]),
      getCompras: () => Promise.resolve([
        COMPRA(1, 1, 'Quimicas del Sur', 12000),
        COMPRA(2, 2, 'Otro', 3000),
      ]),
    });

    cmp.elegirProveedor(1);
    cmp.abrirFormCompra();
    expect(cmp.proveedorSeleccionado).toBeTruthy();
    expect(cmp.proveedorSeleccionado.nombre).toBe('Quimicas del Sur');
    expect(cmp.busquedaProveedorPopup).toBe('');

    cmp.cerrarFormCompra();
    cmp.elegirProveedor(2);
    cmp.abrirFormCompra();
    expect(cmp.proveedorSeleccionado.nombre).toBe('Otro');
  });

  it('editar una compra manda el proveedor DE ESA compra, no el del selector', async () => {
    // El default es para el alta. Si se está editando una compra concreta, lo
    // que manda es la de esa fila, aunque el selector apunte a otro proveedor.
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([
        { id: 1, nombre: 'Quimicas del Sur', activo: true },
        { id: 2, nombre: 'Otro', activo: true },
      ]),
      getCompras: () => Promise.resolve([
        COMPRA(1, 1, 'Quimicas del Sur', 12000),
        COMPRA(2, 2, 'Otro', 3000),
      ]),
    });

    cmp.elegirProveedor(1);
    cmp.abrirFormCompra({
      id: 2, proveedor_id: 2, fecha: '2026-10-08',
      concepto: 'Shampoo', cantidad: 2, monto: 3000, notas: null,
      proveedores: { nombre: 'Otro', activo: true },
    });
    expect(cmp.proveedorSeleccionado.nombre).toBe('Otro');
  });

  it('los popups abren con la fecha de HOY, no con la del período', async () => {
    // Un pago es un movimiento de hoy. Si el popup abriera con la fecha de un mes
    // viejo, el pago caería en el mes viejo y la tarjeta del período que estás
    // mirando no se movería, que es justo lo que se vino a hacer.
    const { cmp } = await listo({
      getComisionesPeriodo: () => Promise.resolve([SUGERIDO(1, 'A', 10000, 1)]),
      getProveedores: () => Promise.resolve([{ id: 1, nombre: 'Quimicas del Sur', activo: true }]),
      getCompras: () => Promise.resolve([COMPRA(1, 1, 'Quimicas del Sur', 12000)]),
    });
    const hoy = new Date().toLocaleDateString('en-CA');

    cmp.elegirEmpleado(1);
    cmp.abrirFormPago();
    expect(cmp.nuevoPago.fecha).toBe(hoy);

    cmp.elegirProveedor(1);
    cmp.abrirFormPagoProveedor();
    expect(cmp.nuevoPagoProveedor.fecha).toBe(hoy);
  });

  it('las fechas de las tablas van SIN año, igual que en Dashboard', () => {
    // El Dashboard muestra "07/10" con su `formatearFechaSinAnio`. Caja
    // mostraba "07/10/2026" y quedaban dos formatos para la misma columna en dos
    // pantallas de la misma app. El año ya está arriba: dice "Octubre 2026".
    const { cmp } = montar();
    expect(cmp.formatearFechaCorta('2026-10-07')).toBe('07/10');
    expect(cmp.formatearFechaCorta('2026-01-01')).toBe('01/01');
    expect(cmp.formatearFechaCorta('2025-12-31')).toBe('31/12');
  });

  it('un formato que no es fecha se devuelve tal cual, sin romper la tabla', () => {
    // Si la base devolviera otra cosa, la celda tiene que mostrar lo que vino en
    // vez de "undefined/undefined": un texto feo es menos grave que una celda
    // que muestra NaN.
    const { cmp } = montar();
    expect(cmp.formatearFechaCorta('')).toBe('');
    expect(cmp.formatearFechaCorta('no-es-fecha')).toBe('no-es-fecha');
    expect(cmp.formatearFechaCorta('2026-10')).toBe('2026-10');
    // El caso que motiva el regex: con `split('-')` un texto con guiones se
    // desarmaba en tres partes y la celda llegaba a mostrar `fecha/es`.
    expect(cmp.formatearFechaCorta('2026-10-07T08:00')).toBe('07/10');
  });
});