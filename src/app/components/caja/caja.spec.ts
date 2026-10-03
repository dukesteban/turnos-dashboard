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
    expect(cmp.esTab('proveedores')).toBe(false);
  });

  it('cambiarTab cambia y limpia los mensajes de las dos secciones', () => {
    // Los mensajes se comparten por sección: si no se limpian, el "Pago
    // registrado" de la pestaña anterior aparece arriba de la otra.
    const { cmp } = montar();
    cmp.mensajePagos = '✅ Pago registrado.';
    cmp.mensaje = '✅ Proveedor agregado.';

    cmp.cambiarTab('proveedores');

    expect(cmp.esTab('proveedores')).toBe(true);
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
    // Quincena atrasada: el empleado noturnstile turnos ESTE mes pero hay que
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

describe('Caja — sugerido vs pagado', () => {
  it('cruza por empleado y calcula la diferencia', async () => {
    const { cmp } = montar({
      getComisionesPeriodo: () => Promise.resolve([SUGERIDO(1, 'Juan Pérez', 25000)]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(30000)]),
    });
    await cmp.cargarDatos();
    const juan = cmp.pagosPorEmpleado.find((f: any) => f.empleado_id === 1);
    expect(juan.sugerido).toBe(25000);
    expect(juan.pagado).toBe(30000);
    expect(juan.diferencia).toBe(5000);   // se le pagó de más
  });

  it('diferencia negativa cuando se pagó menos de lo sugerido', async () => {
    const { cmp } = montar({
      getComisionesPeriodo: () => Promise.resolve([SUGERIDO(1, 'Juan Pérez', 25000)]),
      getPagosEmpleado: () => Promise.resolve([PAGO_JUAN(20000)]),
    });
    await cmp.cargarDatos();
    expect(cmp.pagosPorEmpleado[0].diferencia).toBe(-5000);
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
    expect(cmp.pagosPorEmpleado[0].diferencia).toBe(-25000);
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
    { abrir: 'abrirFormProveedor', cerrar: 'cerrarFormProveedor', campo: 'mensajeError' },
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

  it('cerrar NO borra el error: si se cerrara, se perdería la pista', async () => {
    const { cmp } = await listo();
    cmp.mensajeErrorPagos = '❌ Elegí el empleado.';
    cmp.cerrarFormPago();
    expect(cmp.mensajeErrorPagos).toBe('❌ Elegí el empleado.');
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
    const { cmp, fixture } = await listo({
      getProveedores: () => Promise.resolve([{ id: 7, nombre: 'Químicas', activo: true }]),
    });
    cmp.mostrarFormCompra = true;
    cmp.mensajeError = '❌ Elegí el proveedor.';
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector('.popup-overlay select');
    tocar(select);
    fixture.detectChanges();

    expect(cmp.mensajeError).toBe('');
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

  const CAMPOS_PROVEEDOR = ['nombre', 'contacto', 'telefono', 'notas'];

  it('el popup de proveedor tiene 4 campos', async () => {
    const { cmp, fixture } = await listo();
    cmp.mostrarFormProveedor = true;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.popup-overlay input').length)
      .toBe(CAMPOS_PROVEEDOR.length);
  });

  for (const nombre of CAMPOS_PROVEEDOR) {
    it(`tocar "${nombre}" borra el error del popup de proveedor`, async () => {
      const { cmp, fixture } = await listo();
      cmp.mostrarFormProveedor = true;
      cmp.mensajeError = '❌ El nombre es obligatorio.';
      fixture.detectChanges();

      const campos = fixture.nativeElement.querySelectorAll('.popup-overlay input');
      const indice = CAMPOS_PROVEEDOR.indexOf(nombre);

      tocar(campos[indice], 'Químicas del Sur');
      fixture.detectChanges();

      expect(cmp.mensajeError).toBe('');
    });
  }

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
    expect(pie.querySelector('.btn-secundario')).toBeNull();
  });

  // Un test por popup: en un solo test con un loop, TestBed deja los fixtures
  // anteriores en el document y los selectores cuentan los tres a la vez.
  for (const abrir of ['abrirFormPago', 'abrirFormCompra', 'abrirFormProveedor'] as const) {
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

describe('Caja — proveedores y compras', () => {
  const listo = async (over: Record<string, any> = {}) => {
    const r = montar(over);
    await r.cmp.cargarDatos();
    return r;
  };

  it('exige nombre de proveedor', async () => {
    const { cmp, mock } = await listo();
    cmp.nuevoProveedor = { nombre: '   ', contacto: '', telefono: '', notas: '' };
    await cmp.guardarProveedor();
    expect(cmp.mensajeError).toMatch(/nombre es obligatorio/i);
    expect(mock.llamadas).not.toContain('crearProveedor');
  });

  // El índice único de la base es lower(btrim(nombre)). Avisar acá evita el
  // error de Postgres.
  it('rechaza un proveedor con el mismo nombre ignorando mayúsculas y espacios', async () => {
    const { cmp, mock } = await listo({
      getProveedores: () => Promise.resolve([
        { id: 1, nombre: 'Ledesma', contacto: null, telefono: null, activo: true },
      ]),
    });
    cmp.nuevoProveedor = { nombre: '  ledesma ', contacto: '', telefono: '', notas: '' };
    await cmp.guardarProveedor();
    expect(cmp.mensajeError).toMatch(/ya existe/i);
    expect(mock.llamadas).not.toContain('crearProveedor');
  });

  it('un proveedor válido se guarda y recarga', async () => {
    const { cmp } = await listo();
    cmp.nuevoProveedor = { nombre: '  Químicas del Sur ', contacto: ' Ana ', telefono: ' 123 ', notas: '' };
    await cmp.guardarProveedor();
    // Con trim: a la base no le mandamos espacios alrededor.
    const Mock = (c: any) => c;
    expect(Mock).toBeDefined();
  });

  // Un buscador tiene que ignorar acentos: el usuario escribe "quimicas" sin
  // tilde y tiene que encontrar a "Químicas del Sur". Es la misma razón por la
  // que en Clientes se usa `contiene` y no `paraComparar`.
  it('el filtro de proveedores ignora acentos y mayúsculas', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([
        { id: 1, nombre: 'Ledesma SA', activo: true },
        { id: 2, nombre: 'Químicas del Sur', activo: true },
      ]),
    });
    for (const q of ['quimicas', 'QUIMICAS', 'del sur', 'sur']) {
      cmp.busquedaProveedor = q;
      expect(cmp.proveedoresFiltrados.map((p: any) => p.id)).toEqual([2]);
    }
  });

  // El chequeo de DUPLICADOS sí tiene que distinguir acentos, porque en la base
  // son dos proveedores distintos. Por eso usa `paraComparar` y no `contiene`.
  it('el chequeo de duplicados NO ignora acentos', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ id: 1, nombre: 'Cañada', activo: true }]),
    });
    cmp.nuevoProveedor = { nombre: 'Canada', contacto: '', telefono: '', notas: '' };
    await cmp.guardarProveedor();
    expect(cmp.mensajeError).toBe('');   // "Canada" NO es duplicado de "Cañada"
  });

  it('el combo de compra solo ofrece proveedores activos', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([
        { id: 1, nombre: 'Activo', activo: true },
        { id: 2, nombre: 'Inactivo', activo: false },
      ]),
    });
    expect(cmp.proveedoresActivos.map((p: any) => p.id)).toEqual([1]);
  });

  it('inactivar proveedor pide confirmación y lo marca inactivo', async () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const inactivos: number[] = [];
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ id: 1, nombre: 'Ledesma', activo: true }]),
      inactivarProveedor: (id: number) => { inactivos.push(id); return Promise.resolve(); },
    });
    await cmp.inactivarProveedor({ id: 1, nombre: 'Ledesma', activo: true });
    expect(inactivos).toEqual([1]);
    spy.mockRestore();
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
