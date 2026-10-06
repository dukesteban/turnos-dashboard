import { Component, OnInit, ChangeDetectorRef, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { SupabaseService } from '../../services/supabase';
import { nombreMes, fechaDesdeISO, fechaConAnio } from '../../utils/fechas';
import { paraComparar, contiene } from '../../utils/texto';

@Component({
  selector: 'app-caja',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './caja.html',
  styleUrls: ['./caja.scss']
})
export class CajaComponent implements OnInit {
  // ── PESTAÑAS ──
  // `ingresos` es la pantalla que antes se llamaba Ganancias, sin cambios de
  // lógica. Las otras dos son las salidas de dinero.
  //
  // La pestaña NO decide qué se recarga: los datos de las tres se cargan siempre
  // en `cargarDatos()`, porque el resumen del header (que está arriba de las
  // pestañas) necesita los tres números para cualquier pestaña.
  // `tab` es `string` y no una unión de literales a propósito. Con la unión
  // ('ingresos' | 'gastos' | 'empleados'), el type checker de templates de
  // Angular ESTRECHA el tipo después del primer `*ngIf="tab === 'ingresos'"` y
  // se queja con TS2367 de que comparar con 'empleados' no tiene sentido, aunque
  // el narrowing solo valga para ese bloque. Ampliar a string lo evita.
  //
  // El conjunto de pestañas válidas son los `esTab(...)` del template. Acá no
  // hay un `TABS`: si lo hubiera, un valor nuevo tendría que agregarse en dos
  // lugares y con el tiempo uno se olvida. La barra y el cuerpo comparten el
  // mismo valor por eso.
  tab: string = 'ingresos';

  /**
 * Granularidad del período de toda la pantalla.
 *
 * `semana` se agregó porque el bloque "total a pagar por empleado" necesita
 * ver una quincena: con solo Día y Mes no hay forma de mirar "cómo viene la
 * segunda quincena" sin caer a un día y sumar 15 a mano.
 */
  vista: 'dia' | 'semana' | 'mes' = 'mes';
  fechaActual = new Date();
  turnos: any[] = [];
  cargando = false;
  @ViewChild('graficoRef') graficoRef!: ElementRef;

  horaInicio = 8;
  horaFin = 20;

  // ── PAGOS A EMPLEADOS ──
  pagos: any[] = [];
  comisionesPeriodo: any[] = [];
  // Sugerido vs pagado, joined por `empleado_id`.
  pagosPorEmpleado: any[] = [];
  // Solo para el combo de "registrar pago". No se usan para calcular nada.
  todosLosEmpleados: any[] = [];
  /**
   * Porcentajes de comisión POR SERVICIO, que pisan al general del empleado.
   *
   * Va aparte de `comisionesPeriodo`: ese trae el total YA calculado por
   * empleado, y este trae los porcentajes crudos que hacen falta para el detalle
   * turno por turno de la pestaña Empleados.
   */
  comisionesServicio: any[] = [];

  /**
   * Abonos a proveedores del período. Requiere la migración 013.
   *
   * Va en `[]` si la migración no está aplicada: `cargarDatos()` lo captura para
   * que la pantalla no quede en blanco.
   */
  pagosProveedor: any[] = [];
  /** Comprado menos pagado, por proveedor. Ver `armarSaldoPorProveedor`. */
  saldoPorProveedor: any[] = [];
  mostrarFormPago = false;
  nuevoPago: any = { empleado_id: null, fecha: '', monto: null, metodo: 'efectivo', notas: '' };
  guardandoPago = false;
  mensajePagos = '';
  mensajeErrorPagos = '';

  // ── PROVEEDORES Y COMPRAS ──
  proveedores: any[] = [];
  compras: any[] = [];
  mostrarFormCompra = false;
  nuevaCompra: any = { proveedor_id: null, fecha: '', concepto: '', cantidad: 1, monto: null, notas: '' };
  compraEditando: any = null;
  // Buscador de proveedor del popup, igual que el de cliente de "Nuevo turno":
  // se escribe, sale la lista, y si no hay resultados se crea ahí mismo.
  //
  // `proveedorSeleccionado` es el objeto elegido (para mostrar el nombre);
  // `nuevaCompra.proveedor_id` es el id que se guarda. Van juntos: si se
  // desincronizan, el popup muestra un proveedor y se guarda otro.
  busquedaProveedorPopup = '';
  proveedorSeleccionado: any = null;
  mostrarFormNuevoProveedor = false;
  nombreNuevoProveedor = '';
  guardando = false;
  mensaje = '';
  mensajeError = '';

  constructor(
    private supabase: SupabaseService,
    private cdr: ChangeDetectorRef,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  /**
   * Formato de la columna "Falta pagar".
   *
   * `faltaPagar = sugerido - pagado`, así que:
   *   · positiva = todavía se le debe      -> rojo,   `$19.000`
   *   · negativa = se le pagó de más       -> verde,  `−$19.000`
   *   · cero     = cuadró exacto            -> verde,  `—`
   *
   * ESTE SIGNO SE INVIYERTIÓ, y el nombre de la columna con él. Antes la
   * columna se llamaba "Diferencia" y era `pagado - sugerido`: un empleado al que
   * se le pagaron 25.000 y no atendió nada daba `+$25.000` en verde, que se leía
   * como "le debés 25 mil" diciendo justo lo contrario.
   *
   * Ahora la columna dice "Falta pagar", y un número que se llama así y da
   * NEGATIVO no se puede leer al revés: negativo es "no le debés nada".
   *
   * OJO: esto invierte la convención de color que se había fijado antes
   * (positivo verde, negativo rojo). Ahora es al revés, y es A PROPÓSITO: el
   * color acompaña al nombre de la columna, no al signo crudo.
   *
   * Dos decisiones más que parecen arbitrarias y no lo son:
   *
   * **El `+` no se muestra.** Acá todos los números son plata que salió de la
   * caja, no variaciones de la ganancia: un `+$19.000` se lee como "ganó 19 mil".
   *
   * **El menos va antes del `$`.** `−$19.000` y no `$-19.000`: es como se
   * escribe un saldo en negativo, y `$-` se lee como un signo de moneda.
   *
   * El signo y el color van en MÉTODOS y no en el `[class.x]` del template: son
   * la misma condición con dos resultados opuestos, y con dos `[class.x]`
   * Angular se queja (TS2367). El número en sí lo sigue poniendo el pipe
   * `number`, así que no quedan dos formas de escribir un monto en la app.
   *
   * NO se inyecta `DecimalPipe` para armar el string entero acá: los `imports` de
   * un componente standalone dan pipes a su TEMPLATE pero no a su inyector, y
   * `DecimalPipe` no es `providedIn: 'root'`. Inyectarlo tira NG0201.
   */


  // ── LOS SIGNOS, EL NÚMERO CON SIGNO Y EL COLOR: CÓMO SE HACÍA ANTES ──
  //
  // Ver la nota de arriba, en el `import`. Antes de esta ronda, las celdas de la
  // tabla usaban tres helpers (`signoDiferencia`, `absDiferencia`,
  // `claseDiferencia`) para armar `−$25.000` en rojo o verde.
  //
  // YA NO EXISTEN, y no por limpieza: están borrados a propósito porque el
  // pedido fue explícito ("no quiero positivo ni negativos"). La diferencia se
  // parte en dos columnas, "Debe" y "Haber", y cada celda muestra SU cantidad en
  // positivo con el color de SU columna. Un signo tipográfico en pantalla es
  // justo lo que se pidió sacar, así que no queda ni el helper ni el camino que
  // lo produciría.
  //
  // Lo que los reemplaza son `claseDebe` y `claseHaber`, más abajo.

  async ngOnInit() {
    await this.cargarHorarios();
    await this.cargarDatos();
    this.cdr.detectChanges();
    // DESPUES de `cargarDatos`, no antes: los tres popups arman sus valores por
    // defecto con las listas de empleados y proveedores (el que est� elegido en el
    // combo de arriba). Si se abriran con la pantalla todavia vacia, el popup
    // abriria con el id `null` y habria que elegir a mano.
    this.abrirAccionDeUrl();
  }

  /**
   * Abre el popup que pide la URL con `?accion=...`.
   *
   * Es el otro lado de los tres botones flotantes del Dashboard
   * (`DashboardComponent.irACaja`): los popups viven ACA, as�� que el boton de
   * afuera no abre nada, navega con el parametro y esta funcion lo cumple. Vive
   * en Caja y no en los popups porque los tres son de este componente.
   *
   * ANTES de abrir: cambia a la pestaña y abre el acordeón que contiene el boton.
   * Si el popup aparece sobre "Ingresos" y despues de cerrarlo el usuario ve la
   * lista de turnos, no la de pagos, queda con la sensaci�n de que se guardo en
   * alg�n lado equivocado.
   *
   * LIMPIA el parametro antes de abrir (y con `replaceUrl`, sin sumar una entrada
   * al historial): si se dejara, recargar la pagina con F5 volveria a abrir el
   * popup, y el usuario que recien guardo y quiere ver la lista tendria que cerrar
   * el popup otra vez. Con `replaceUrl` el boton "atras" del navegador tampoco
   * devuelve el estado con el parametro.
   *
   * Un valor desconocido se ignora en silencio en vez de tirar error: el parametro
   * puede venir escrito a mano o de un link guardado de una version anterior.
   */
  private abrirAccionDeUrl() {
    const accion = this.route.snapshot.queryParamMap.get('accion');
    if (!accion) return;

    // Limpiar primero: si `abrirForm...` llegara a fallar, igual la URL ya quedo
    // limpia y no queda un popup trabado en cada recarga.
    this.router.navigate([], { relativeTo: this.route, replaceUrl: true });

    if (accion === 'pago-empleado') {
      this.cambiarTab('empleados');
      this.acordeonPagos = true;
      this.abrirFormPago();
    } else if (accion === 'deuda') {
      this.cambiarTab('gastos');
      this.acordeonCompras = true;
      this.abrirFormCompra();
    } else if (accion === 'pago-proveedor') {
      this.cambiarTab('gastos');
      this.acordeonPagosProv = true;
      this.abrirFormPagoProveedor();
    }
    this.cdr.detectChanges();
  }

  /**
   * ¿Estamos en esta pestaña?
   *
   * Existe por un límite del type checker de Angular: los `*ngIf` se compilan
   * como ifs SECUENCIALES dentro de una sola función, así que después de
   * `*ngIf="tab === 'ingresos'"` TypeScript deja de considerar los otros
   * valores posibles y el segundo `*ngIf` falla con TS2367 ("no overlap").
   *
   * Una llamada a método no se estrecha, así que comparar por acá lo esquiva.
   * También deja el conjunto de pestañas válido en un solo lugar.
   */
  esTab(t: string): boolean {
    return this.tab === t;
  }

  cambiarTab(t: string) {
    this.tab = t;
    this.mensaje = '';
    this.mensajeError = '';
    this.mensajePagos = '';
    this.mensajeErrorPagos = '';
    this.cdr.detectChanges();
  }

  async cargarHorarios() {
    const horarios = await this.supabase.getHorarios();
    const activos = (horarios || []).filter((h: any) => h.activo);
    if (activos.length > 0) {
      const inicios = activos.map((h: any) => parseInt((h.hora_inicio || '08:00').split(':')[0], 10));
      const fines = activos.map((h: any) => {
        const parts = (h.hora_fin || '20:00').split(':');
        const hora = parseInt(parts[0], 10);
        const min = parseInt(parts[1] || '0', 10);
        return min > 0 ? hora + 1 : hora;
      });
      this.horaInicio = Math.min(...inicios);
      this.horaFin = Math.max(...fines);
    }
  }

  async cargarDatos() {
    this.cargando = true;
    const { desde, hasta } = this.getRango();
    // Las tres pestañas en paralelo: son independientes y van a la misma base.
    // Con `await` una detrás de otra el usuario esperaría 3x lo necesario.
    const [turnos, pagos, comisiones, compras, proveedores, empleados, comisionesServicio, pagosProveedor] = await Promise.all([
      this.supabase.getGanancias(desde, hasta),
      this.supabase.getPagosEmpleado(desde, hasta),
      this.supabase.getComisionesPeriodo(desde, hasta),
      this.supabase.getCompras(desde, hasta),
      this.supabase.getProveedores(),
      // Activos solamente: el combo de pago no debería ofrecer a alguien dado
      // de baja. `getEmpleados()` con `soloActivos` por defecto.
      this.supabase.getEmpleados(),
      // Los porcentajes POR SERVICIO, que pisan al general del empleado. Van
      // encadenados porque necesitan los ids de `getEmpleados()`, pero siguen
      // dentro del `Promise.all`: la pantalla no espera de más.
      //
      // Se necesitan para el detalle de comisiones de la pestaña Empleados, que
      // muestra el porcentaje de cada turno. Sin esto, un empleado con "40% en
      // lavado completo" vería todos sus turnos calculados con el general.
      this.supabase.getEmpleados()
        .then((emps: any[]) => this.supabase.getComisionesEmpleado(emps.map((e: any) => e.id))),

      // Los abonos a proveedores. ÚNICA llamada de la tanda con `catch`: la
      // tabla `pagos_proveedor` la crea la migración 013, y si esa migración no
      // está aplicada en el proyecto el POST devuelve 404 y el `Promise.all`
      // REVienta TODO: no se ven más ni los ingresos ni los pagos a empleados.
      //
      // Una lista vacía es mucho mejor que una pantalla en blanco por
      // una tabla que todavía no existe en la base.
      this.supabase.getPagosProveedor(desde, hasta).catch(() => []),
    ]);
    this.turnos = turnos;
    this.pagos = pagos;
    this.comisionesPeriodo = comisiones;
    this.compras = compras;
    this.proveedores = proveedores;
    this.todosLosEmpleados = empleados;
    this.comisionesServicio = comisionesServicio;
    this.pagosProveedor = pagosProveedor;
    this.armarPagosPorEmpleado();
    this.armarSaldoPorProveedor();
    this.cargando = false;
    this.cdr.detectChanges();
    this.scrollToHoy();
  }

  /**
   * Saldo por proveedor: comprado menos pagado.
   *
   * Es el número que responde "¿le debo plata a este proveedor?". Va por
   * proveedor y no por compra porque a los proveedores se les paga a cuenta:
   * el abono del lunes puede estar saldando la compra de la semana anterior.
   */
  armarSaldoPorProveedor() {
    const porId = new Map<number, any>();
    this.compras.forEach((c: any) => {
      const nombre = c.proveedores?.nombre || `Proveedor #${c.proveedor_id}`;
      // `if (!has)` y NO un `set` a secas: con dos compras del mismo proveedor, un
      // `set` sin condición RECREABA la fila en cada vuelta y el `+=` arrancaba
      // de cero. El resultado era que `comprado` valía solo el monto de la última
      // compra y `compras` tenía un solo elemento, aunque el proveedor tuviera
      // cinco. Solo se nota con más de una compra del mismo proveedor, que es el
      // caso normal de cualquier proveedor al que se le compra todas las semanas.
      if (!porId.has(c.proveedor_id)) {
        porId.set(c.proveedor_id, {
          proveedor_id: c.proveedor_id, nombre, comprado: 0, pagado: 0, saldo: 0, compras: [] as any[],
        });
      }
      const fila = porId.get(c.proveedor_id);
      fila.nombre = nombre;
      fila.comprado += Number(c.monto) || 0;
      fila.compras.push(c);
    });
    this.pagosProveedor.forEach((p: any) => {
      const nombre = p.proveedores?.nombre || `Proveedor #${p.proveedor_id}`;
      if (!porId.has(p.proveedor_id)) {
        porId.set(p.proveedor_id, {
          proveedor_id: p.proveedor_id, nombre, comprado: 0, pagado: 0, saldo: 0, compras: [] as any[],
        });
      }
      const fila = porId.get(p.proveedor_id);
      fila.nombre = nombre;
      fila.pagado += Number(p.monto) || 0;
    });
    this.saldoPorProveedor = [...porId.values()]
      .map((f: any) => ({ ...f, saldo: f.comprado - f.pagado }))
      .sort((a: any, b: any) => b.saldo - a.saldo || b.comprado - a.comprado);
  }

  // ── CAJA: EL NÚCLEO ────────────────────────────────────────
  //
  // El objetivo de la pantalla: saber cuánto QUEDÓ. Para eso hay que juntar
  // las tres pestañas en un solo número, y eso obliga a cargar las tres siempre
  // (por eso `cargarDatos` no mira `this.tab`).

  /** Lo que entró por turnos atendidos. */
  get totalIngresos(): number {
    return this.totalGanancias;
  }

  /** Lo que se le pagó DE VERDAD a los empleados en el período. */
  get totalPagadoEmpleados(): number {
    return this.pagos.reduce((sum, p) => sum + (Number(p.monto) || 0), 0);
  }

  /**
   * Lo que se COMPRÓ a los proveedores en el período. Ojo: comprar no es pagar.
   * Para lo que salió de la cuenta está `totalPagadoProveedores`.
   */
  get totalCompras(): number {
    return this.compras.reduce((sum, c) => sum + (Number(c.monto) || 0), 0);
  }

  /**
   * Lo que se le ABONÓ a los proveedores en el período.
   *
   * Es el número que va en la tarjeta "Gastos", y no `totalCompras`. Comprar
   * 12.000 no significa deber 12.000: si compraste y no pagaste, no debés nada.
   * El saldo por proveedor (`saldoPorProveedor`) es el que contesta eso.
   */
  get totalPagadoProveedores(): number {
    return this.pagosProveedor.reduce((sum, p) => sum + (Number(p.monto) || 0), 0);
  }

  /**
   * "DD/MM" a partir de un "AAAA-MM-DD" de la base. SIN el año.
   *
   * Igual que `formatearFechaSinAnio` del Dashboard, y a pedido del usuario. Dos
   * razones:
   *
   *   · Son las mismas tablas de la misma app: que en Turnos se vea "07/10" y en
   *     Caja "07/10/2026" hace que cada pantalla parezca de otra aplicación.
   *   · El año ya está a la vista. Arriba dice "Octubre 2026", y toda la tabla
   *     está dentro de ese período, así que el año no informa nada: solo ensancha
   *     la columna y empuja los números de la derecha.
   *
   * Se hace a mano y no con el pipe `date` porque el pipe usa la zona horaria del
   * navegador: con una fecha "2026-10-01" devuelve 30/09 en un timezone negativo.
   * El día corrido es el peor tipo de bug: no tira error, solo muestra mal.
   */
  formatearFechaCorta(iso: string): string {
    if (!iso) return '';
    // Regex y no `split('-')`: un texto que tenga guiones pero no sea una fecha
    // ("no-es-fecha") con `split` se desarma en tres partes y sale "fecha/es" en
    // la celda, que es peor que no mostrar nada. Acá, si no matchea el formato
    // exacto de `AAAA-MM-DD`, se devuelve lo que vino y la celda lo muestra tal
    // cual.
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso).trim());
    if (!m) return iso;
    return `${m[3]}/${m[2]}`;
  }

  // ── ACORDEONES ─────────────────────────────────────────────────
  //
  // Todas las tablas de la pantalla van en un acordeón, como en Personas. El
  // punto del acordeón es que la pantalla NO sea una lista interminable de
  // tablas: arriba están los tres cuadros, que son la respuesta, y abajo el
  // detalle se abre solo cuando se va a buscar.
  //
  // Los flags son `boolean` y no un objeto porque cada uno va atado a un solo
  // `*ngIf`: meterlos en un mapa por nombre agregaría una capa de indirección
  // para no ganar nada.
  //
  // LAS DOS PESTAÑAS ARRANCAN IGUAL, y es a propósito. Las dos tienen la misma
  // forma, y las tres cosas coinciden:
  //
  //   1. el detalle de lo que se elige arriba   CERRADO
  //   2. los pagos/abonos que le hiciste         CERRADO
  //   3. todos, para comparar                    CERRADO, y AL FINAL
  //
  // TODO cerrado, a pedido del usuario. La razón de fondo: al abrir la pestaña
  // hay que ver el número del empleado o del proveedor, y el detalle desplegado
  // compite con la vista y empuja todo hacia abajo.
  //
  // Antes Empleados abría los dos primeros y Gastos no abría ninguno, que es
  // peor que cualquier otra opción: dos pantallas que se leen igual arrancaban
  // distinto. La coherencia entre las dos importa más que qué estado exacto se
  // elige.
  //
  // Y que el tercero esté AL FINAL además de cerrado: si "Todos los empleados"
  // quedara arriba, el primer acordeón de la pantalla sería la vista larga de
  // comparar y no el detalle de quien se está mirando.
  //
  // OJO: cambiar estos flags NO reinicia la pantalla. Un acordeón que se abrió se
  // queda abierto al cambiar de período, así que el "arranca cerrado" es solo del
  // primer arranque.
  acordeonDetalle = false;
  acordeonPagos = false;
  acordeonTotales = false;
  acordeonSaldo = false;
  acordeonPagosProv = false;
  acordeonCompras = false;

  // ── "TODOS" EN EL COMBO ──────────────────────────────────────────
  //
  // La PRIMERA opción del selector, y el estado en el que arranca la pantalla.
  //
  // Por qué arranca en "Todos" y no en el primero de la lista: "Todos" es la
  // pregunta que uno se hace al abrir la caja ("¿cuánto debo en total?"), y el
  // nombre de un empleado es la segunda. Además, un selector que arranca en una
  // persona obliga a EVERYONE a confirmar que esa era la que quería ver.
  //
  // Un `boolean` aparte y no un id centinela (tipo 0 o -1): el id viene de la
  // base y no se sabe qué valores tiene. Con un `boolean` no hay colisión
  // posible y `empleadoActual` sigue significando exactamente lo mismo.
  mostrarTodos = true;

  // ── PAGO A PROVEEDOR ──────────────────────────────────────────
  mostrarFormPagoProveedor = false;
  guardandoPagoProveedor = false;
  mensajePagoProveedor = '';
  mensajeErrorPagoProveedor = '';
  nuevoPagoProveedor: any = {
    proveedor_id: null, fecha: '', monto: null, metodo: 'transferencia', notas: '',
  };

  /**
   * Abre el popup de pago a proveedor.
   *
   * Se pone la fecha de HOY y no la del período: un abono es un movimiento de
   * hoy. Si se abriera con la fecha de un mes viejo, el pago caería en el mes
   * viejo y la tarjeta "Gastos" del período que estás mirando no se movería, que
   * es justo lo que se viene a hacer.
   *
   * El proveedor preseleccionado sale del selector de ARRIBA, no del primero de la
   * lista. Mismo criterio que `abrirFormPago`: el botón está dentro del detalle
   * de ESE proveedor, así que el formulario es de ESE. Con el combo en "Todos"
   * no hay nadie elegido y entra el primero activo.
   */
  abrirFormPagoProveedor() {
    const elegido = this.proveedorParaPagoPorDefecto();
    this.nuevoPagoProveedor = {
      proveedor_id: elegido ? elegido.id : null,
      fecha: this.hoyISO(),
      monto: null,
      metodo: 'transferencia',
      notas: '',
    };
    this.mensajeErrorPagoProveedor = '';
    this.mostrarFormPagoProveedor = true;
    this.cdr.detectChanges();
  }

  cerrarFormPagoProveedor() {
    this.mostrarFormPagoProveedor = false;
    this.mensajeErrorPagoProveedor = '';
    this.cdr.detectChanges();
  }

  /** El saldo pendiente de un proveedor, para avisar si el abono se pasa. */
  saldoDeProveedor(proveedorId: number): number {
    const fila = this.saldoPorProveedor.find((p: any) => p.proveedor_id === proveedorId);
    return fila ? fila.saldo : 0;
  }

  /**
   * Si el abono del popup va a dejar al proveedor a favor.
   *
   * Es un método y no una expresión en el template a propósito: el `Number()` de
   * una cantidad que viene del `<input type="number">` no se puede escribir en el
   * template, porque Angular no expone `Number` ahí (es TS2339, no de runtime).
   *
   * Se permite a propósito: a veces se adelanta plata para quedar a deber, y en
   * ese caso el botón tiene que dejar pasar. Por eso esto avisa y no bloquea.
   */
  pagoProveedorLoDejaAFavor(): boolean {
    const p = this.nuevoPagoProveedor;
    if (!p.proveedor_id || !p.monto) return false;
    return Number(p.monto) > this.saldoDeProveedor(Number(p.proveedor_id));
  }

  async guardarPagoProveedor() {
    if (this.guardandoPagoProveedor) return;
    this.mensajeErrorPagoProveedor = '';
    const p = this.nuevoPagoProveedor;

    if (!p.proveedor_id) {
      this.mensajeErrorPagoProveedor = '❌ Elegí un proveedor.';
      return;
    }
    if (!p.fecha) {
      this.mensajeErrorPagoProveedor = '❌ Poné la fecha del pago.';
      return;
    }
    if (!p.monto || Number(p.monto) <= 0) {
      this.mensajeErrorPagoProveedor = '❌ El monto tiene que ser mayor a cero.';
      return;
    }

    // Pagar de más se PERMITE a propósito: a veces se adelanta plata para
    // quedar a deber, y en ese caso el botón tiene que dejar pasar. Por eso acá
    // no hay bloqueo, solo un texto informativo que el template muestra cuando
    // el abono supera el saldo pendiente.

    this.guardandoPagoProveedor = true;
    try {
      await this.supabase.crearPagoProveedor({
        proveedor_id: Number(p.proveedor_id),
        fecha: p.fecha,
        monto: Number(p.monto),
        metodo: p.metodo,
        notas: p.notas || null,
      });
      this.mensajePagoProveedor = '✅ Pago a proveedor registrado.';
      this.mostrarFormPagoProveedor = false;
      await this.cargarDatos();
    } catch (e: any) {
      // El mensaje mas común acá: la migración 013 no está aplicada en este
      // proyecto, y PostgREST devuelve 404.
      this.mensajeErrorPagoProveedor =
        '❌ No se pudo guardar: ' + (e?.message || 'error desconocido') +
        '. Si dice que la tabla no existe, falta aplicar la migración 013.';
    } finally {
      this.guardandoPagoProveedor = false;
      this.cdr.detectChanges();
    }
  }

  async eliminarPagoProveedor(p: any) {
    if (!confirm(`¿Borrar el pago de $${(Number(p.monto) || 0).toLocaleString('es-AR')} a ${p.proveedores?.nombre || 'este proveedor'}?`)) {
      return;
    }
    try {
      await this.supabase.eliminarPagoProveedor(p.id);
      this.mensajePagoProveedor = '🗑️ Pago borrado.';
      await this.cargarDatos();
    } catch (e: any) {
      this.mensajePagoProveedor = '❌ No se pudo borrar: ' + (e?.message || 'error desconocido');
    }
    this.cdr.detectChanges();
  }

  // ── DETALLE POR EMPLEADO ───────────────────────────────────────
  /**
   * Servicios que hizo UN empleado en el período, con su comisión.
   *
   * Esto venía en el detalle del empleado de Personas y se mudó acá: pagar a la
   * gente es un asunto de caja, no de la ficha del empleado. Antes se necesite
   * abrir la ficha de cada uno para ver cuánto se le generó; ahora es un
   * selector arriba de la propia pestaña.
   *
   * Es un `.get` y no un async para que no haya dos fuentes de verdad: se calcula
   * con los `turnos` que la caja YA tiene cargados para el período, así que no
   * hay llamada nueva a la base y no puede desincronizarse de "Sugerido vs
   * pagado", que usa los mismos turnos.
   *
   * `null` = no hay nadie elegido.
   */
  empleadoDetalle: number | null = null;

  /**
   * Turnos atendidos del período, con su comisión. Del empleado elegido, o
   * de TODOS si el selector está en esa opción.
   *
   * En "Todos" se agrega la columna `empleado` a cada fila, porque sin ella un
   * turno no se sabe de quién es. Viene de los MISMOS `turnos` que ya están
   * cargados: no hay llamada nueva y no puede desincronizarse de los cuadros.
   */
  get comisionesDetalle(): { fecha: string, hora: string, servicio: string, precio: number, comision: number, empleado: string }[] {
    const id = this.mostrarTodos ? null : this.empleadoActual;
    return this.turnos
      .filter((t) => t.estado === 'atendido' && (id === null || t.empleado_id === id))
      .map((t) => {
        const precio = Number(t.precio_final || t.precio) || 0;
        return {
          fecha: t.fecha,
          // `hora_inicio` viene como "HH:MM:SS" de Postgres. Sin el `slice` la
          // celda muestra "08:00:00" y la tabla parece un CSV.
          hora: (t.hora_inicio || t.hora || '').slice(0, 5),
          precio,
          // El servicio REALMENTE hecho, que puede diferir del reservado (pidio
          // completo y se hizo simple). Es sobre ese que se cobra la comisión.
          servicio: t.servicio_nombre_final || t.servicio_nombre || 'Sin especificar',
          comision: (precio * this.porcentajeComision(t)) / 100,
          empleado: this.nombreDeEmpleado(t.empleado_id),
        };
      })
      .sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));
  }

  get totalComisionesDetalle(): number {
    return this.comisionesDetalle.reduce((sum, c) => sum + c.comision, 0);
  }

  /**
   * Porcentaje que le corresponde a este turno: el de su servicio si hay uno
   * cargado, y si no el general del empleado.
   *
   * El orden importa y es el mismo que usa `getComisionesPeriodo` en el
   * servicio: el específico pisa al general.
   */
  private porcentajeComision(turno: any): number {
    const porServicio = this.comisionesServicio.find(
      (c: any) =>
        c.empleado_id === turno.empleado_id &&
        c.servicio_id !== null &&
        c.servicio_id === (turno.servicio_id_final ?? turno.servicio_id)
    );
    if (porServicio) return Number(porServicio.porcentaje) || 0;

    const emp = this.todosLosEmpleados.find((e: any) => e.id === turno.empleado_id);
    return Number(emp?.comision_porcentaje) || 0;
  }

  /** "el día" / "la semana" / "el mes", para los subtítulos. */
  get tituloPeriodoCorto(): string {
    return this.vista === 'dia' ? 'el día' : this.vista === 'semana' ? 'la semana' : 'el mes';
  }

  /**
   * El empleado cuyo detalle se está mostrando, o `null` si no hay ninguno.
   *
   * UN SOLO LUGAR que resuelve el "default", y todo lo demás lo lee de acá: el
   * `*ngIf` del bloque, el `[ngModel]` del select y el getter de las comisiones.
   *
   * Antes cada uno resoltaba por su cuenta contra `empleadoDetalle`, que arranca
   * en `null`. Con el período vacío, el `*ngIf` decía que había un empleado
   * (porque caía al primero de la lista) pero el getter devolvía lista vacía
   * porque `empleadoDetalle` seguía en `null`: se veía un empleado elegido con
   * cero servicios y ninguna fila. Dos fuentes de verdad para lo mismo.
   *
   * Si el usuario ya eligió, se respeta. Si no, va el primero que tenga algo
   * que cobrar en el período; y si el período está vacío, el primero de la
   * lista, para que el selector nunca quede en "-- Elegí --" sin motivo.
   */
  get empleadoActual(): number | null {
    // `Number.isFinite` y no `!== null`: un id no numérico (un `NaN` de un
    // `Number()` sobre algo raro) no es `null`, así que con la comparación sola
    // pasaba de largo y los tres montos daban 0 sin que nada explicara por qué.
    // Un id que no es un número es lo mismo que no haber elegido a nadie.
    if (this.empleadoDetalle !== null && Number.isFinite(this.empleadoDetalle)) {
      return this.empleadoDetalle;
    }
    const conTurnos = this.pagosPorEmpleado[0];
    if (conTurnos) return conTurnos.empleado_id;
    return this.todosLosEmpleados.length ? this.todosLosEmpleados[0].id : null;
  }

  // ── LOS TRES MONTOS DEL EMPLEADO ELEGIDO ────────────────────
  //
  // La fila de `pagosPorEmpleado` del empleado que está elegido en el selector.
  //
  // Por qué un getter y no un campo que se recalcula en `cargarDatos()`: los
  // tres montos salen TODOS de la misma fila, y si cada uno fuera un campo
  // aparte habría que acordarse de actualizarlos los tres juntos. Con un getter
  // no hay forma de que uno quede viejo: o los tres se mueven o no se mueve
  // ninguno. Y sale gratis, porque `pagosPorEmpleado` ya está en memoria.
  get filaEmpleadoActual(): any {
    if (this.empleadoActual === null) return null;
    return this.pagosPorEmpleado.find(
      (f: any) => f.empleado_id === this.empleadoActual
    ) || null;
  }

  /**
   * El nombre de un empleado por id, o el id si no se encuentra.
   *
   * Para la columna `empleado` de los detalles cuando el selector está en "Todos".
   * Usa `pagosPorEmpleado` porque ya tiene el nombre resuelto (con el fallback
   * para los empleados que fueron borrados); si el turno es de alguien que no
   * tiene fila, cae al id, que es mejor que una celda vacía.
   */
  nombreDeEmpleado(empleadoId: number | null): string {
    if (empleadoId === null || empleadoId === undefined) return 'Sin empleado';
    const f = this.pagosPorEmpleado.find((x: any) => x.empleado_id === empleadoId);
    if (f && f.nombre) return f.nombre;
    const e = this.todosLosEmpleados.find((x: any) => x.id === empleadoId);
    return e ? e.nombre : `Empleado #${empleadoId}`;
  }

  /** Lo que le corresponde por los turnos que atendió. De TODOS, el total. */
  get deboEmpleado(): number {
    if (this.mostrarTodos) return this.totalSugerido;
    const f = this.filaEmpleadoActual;
    return f ? Number(f.sugerido) || 0 : 0;
  }

  /** Lo que le efectivamente di. De TODOS, el total. */
  get pagueEmpleado(): number {
    if (this.mostrarTodos) return this.totalPagadoEmpleados;
    const f = this.filaEmpleadoActual;
    return f ? Number(f.pagado) || 0 : 0;
  }

  /** Lo que le compré. De TODOS, el total. */
  get compreProveedor(): number {
    if (this.mostrarTodos) return this.totalCompras;
    const f = this.filaProveedorActual;
    return f ? Number(f.comprado) || 0 : 0;
  }

  /** Lo que le aboné. De TODOS, el total. */
  get pagueProveedor(): number {
    if (this.mostrarTodos) return this.totalPagadoProveedores;
    const f = this.filaProveedorActual;
    return f ? Number(f.pagado) || 0 : 0;
  }

  /** Turnos atendidos. De TODOS, el total. */
  get turnosEmpleadoActual(): number {
    if (this.mostrarTodos) return this.totalAtendidos;
    const f = this.filaEmpleadoActual;
    return f ? Number(f.turnos) || 0 : 0;
  }

  /**
   * Los pagos registrados: del empleado elegido, o de TODOS.
   *
   * Sale de la fila (`pagosPorEmpleado`), que ya tiene el array `pagos` de cada
   * uno armado en `armarPagosPorEmpleado`. No se vuelve a filtrar `this.pagos`
   * en el template: dos lugares que devuelven lo mismo son dos lugares que
   * pueden dejar de devolverlo.
   */
  get pagosEmpleadoActual(): any[] {
    if (this.mostrarTodos) return this.pagos;
    const f = this.filaEmpleadoActual;
    return f ? f.pagos : [];
  }

  /**
   * Elegir un empleado tocando su fila de la tabla de todos.
   *
   * Solo cambia el selector: los tres cuadros de arriba y los acordeones de abajo
   * ya leen de `empleadoActual`, así que no hay que volver a cargar nada de la
   * base. Un `(click)` que llama a `cargarDatos()` sería peor: haría una ida
   * entera para mostrar el mismo dato.
   *
   * SALE DEL MODO "Todos", y no es un detalle: si no lo hiciera, tocar una fila
   * no cambiaría nada visible, porque los cuadros seguirían mostrando los
   * totales de todos. El usuario toca una fila justamente para ver ESE empleado.
   */
  elegirEmpleado(id: number) {
    this.mostrarTodos = false;
    this.empleadoDetalle = id;
  }

  /** Igual que `elegirEmpleado`, del lado de los proveedores. */
  elegirProveedor(id: number) {
    this.mostrarTodos = false;
    this.proveedorActualId = id;
  }

  /** Todos los segundos juntos. */

  // ══════════════════════════════════════════════════════════════
  // EL COMBO Y EL MODO "TODOS"
  // ══════════════════════════════════════════════════════════════

  /**
   * Lo que el combo muestra: `"todos"` o el id del empleado.
   *
   * El `<option>` de "Todos" es un `value="todos"` (string) y los empleados van
   * con `[ngValue]="e.id"` (número). Por eso este getter devuelve `string |
   * number` y alterna entre los dos: si devolviera siempre un número, el primer
   * `<option>` nunca coincidiría y el combo arrancaría mostrando al primer
   * empleado con "Todos" marcado.
   */
  get seleccionEmpleado(): string | number {
    return this.mostrarTodos ? 'todos' : (this.empleadoDetalle ?? 'todos');
  }

  /** Igual para el proveedor. Comparte el flag `mostrarTodos` a propósito. */
  get seleccionProveedor(): string | number {
    return this.mostrarTodos ? 'todos' : (this.proveedorActualId ?? 'todos');
  }

  /** `(ngModelChange)` del combo de empleados. */
  elegirEmpleadoDelCombo(valor: string | number) {
    if (valor === 'todos') {
      this.mostrarTodos = true;
      return;
    }
    this.mostrarTodos = false;
    this.empleadoDetalle = Number(valor);
  }

  /** `(ngModelChange)` del combo de proveedores. */
  elegirProveedorDelCombo(valor: string | number) {
    if (valor === 'todos') {
      this.mostrarTodos = true;
      return;
    }
    this.mostrarTodos = false;
    this.proveedorActualId = Number(valor);
  }

  /** Si hay al menos un empleado: si no, los cuadros no tienen nada que mostrar. */
  get hayEmpleados(): boolean {
    return this.todosLosEmpleados.length > 0;
  }

  /** Si hay al menos un proveedor. */
  get hayProveedores(): boolean {
    return this.proveedores.length > 0;
  }

  // ── FILA DEL PROVEEDOR ────────────────────────────────────────

  /** La fila de `saldoPorProveedor` del proveedor elegido, o `null`. */
  get filaProveedorActual(): any {
    if (this.proveedorActual === null) return null;
    return this.saldoPorProveedor.find(
      (p: any) => p.proveedor_id === this.proveedorActual
    ) || null;
  }

  /**
   * Compras del proveedor elegido, o de TODOS.
   *
   * En "Todos" se arma concatenando los `compras` de cada fila de
   * `saldoPorProveedor`, que ya vienen agrupadas. No se vuelve a filtrar
   * `this.compras` en el template: dos lugares que devuelven lo mismo son dos
   * lugares que pueden dejar de devolverlo.
   */
  get comprasProveedorActual(): any[] {
    if (this.mostrarTodos) {
      return this.saldoPorProveedor.flatMap((p: any) => p.compras || []);
    }
    const f = this.filaProveedorActual;
    return f ? f.compras : [];
  }

  /** Abonos del proveedor elegido, o de TODOS. */
  get pagosProveedorActual(): any[] {
    if (this.mostrarTodos) return this.pagosProveedor;
    if (this.proveedorActual === null) return [];
    return this.pagosProveedor.filter(
      (p: any) => p.proveedor_id === this.proveedorActual
    );
  }

  /** El nombre de un proveedor por id, para las columnas de "Todos". */
  nombreDeProveedor(proveedorId: number | null): string {
    if (proveedorId === null || proveedorId === undefined) return 'Sin proveedor';
    const f = this.saldoPorProveedor.find((x: any) => x.proveedor_id === proveedorId);
    if (f && f.nombre) return f.nombre;
    const p = this.proveedores.find((x: any) => x.id === proveedorId);
    return p ? p.nombre : `Proveedor #${proveedorId}`;
  }

  // ══════════════════════════════════════════════════════════════
  // DEBE / HABER: dos cantidades, nunca un número con signo
  // ══════════════════════════════════════════════════════════════
  //
  // Lo que se pidió explícitamente: nada de positivos ni negativos, rojo si es
  // "debe" y verde si es "haber". La cuenta de adentro sigue siendo UNA sola con
  // signo (`faltaPagar = sugerido - pagado`), pero a la pantalla se le parte en
  // dos:
  //
  //   · `debe`  = lo que le debo yo,   siempre en positivo. Si hay algo, ROJO.
  //   · `haber` = lo que me deben a mí, siempre en positivo. Si hay algo, VERDE.
  //
  // Nunca las dos a la vez: son la misma diferencia partida. Mostrar un
  // `-$25.000` obligaba a recordar si el signo era mío o del otro, y el título
  // "Falta pagar" al lado de "A favor" era directamente contradictorio.
  //
  // Cuando el selector está en "Todos", los dos son los totales del período.

  /** Lo que le debo, del empleado elegido o de todos. */
  get debeEmpleadoTotal(): number {
    if (this.mostrarTodos) return this.totalFaltaPagar > 0 ? this.totalFaltaPagar : 0;
    const f = this.filaEmpleadoActual;
    if (!f) return 0;
    const d = Number(f.faltaPagar) || 0;
    return d > 0 ? d : 0;
  }

  /** Lo que me deben a mí, del empleado elegido o de todos. */
  get haberEmpleadoTotal(): number {
    if (this.mostrarTodos) return this.totalFaltaPagar < 0 ? -this.totalFaltaPagar : 0;
    const f = this.filaEmpleadoActual;
    if (!f) return 0;
    const d = Number(f.faltaPagar) || 0;
    return d < 0 ? -d : 0;
  }

  /** El número del cuadro: el único de los dos que hay. Nunca negativo. */
  get saldoEmpleado(): number {
    return this.debeEmpleadoTotal + this.haberEmpleadoTotal;
  }

  /** "Debo", "A favor", o nada si está en cero. UNA O DOS PALABRAS. */
  get textoSaldoEmpleado(): string {
    if (this.debeEmpleadoTotal > 0) return 'Debo';
    if (this.haberEmpleadoTotal > 0) return 'A favor';
    return '';
  }

  /** Lo que le debo al proveedor elegido, o a todos. */
  get debeProveedorTotal(): number {
    if (this.mostrarTodos) {
      const d = this.totalCompras - this.totalPagadoProveedores;
      return d > 0 ? d : 0;
    }
    const f = this.filaProveedorActual;
    if (!f) return 0;
    const s = Number(f.saldo) || 0;
    return s > 0 ? s : 0;
  }

  /** Lo que me deben los proveedores, a mí. */
  get haberProveedorTotal(): number {
    if (this.mostrarTodos) {
      const d = this.totalCompras - this.totalPagadoProveedores;
      return d < 0 ? -d : 0;
    }
    const f = this.filaProveedorActual;
    if (!f) return 0;
    const s = Number(f.saldo) || 0;
    return s < 0 ? -s : 0;
  }

  /** El número del cuadro del proveedor. Nunca negativo. */
  get saldoProveedorTotal(): number {
    return this.debeProveedorTotal + this.haberProveedorTotal;
  }

  /** "Debo", "A favor", o nada. */
  get textoSaldoProveedorTotal(): string {
    if (this.debeProveedorTotal > 0) return 'Debo';
    if (this.haberProveedorTotal > 0) return 'A favor';
    return '';
  }

  // ===============================================================
  // EL COLOR DE UNA CELDA "DEBE" O "HABER"
  // ===============================================================
  // El color va con LA COLUMNA y con LA CANTIDAD DE ESA CELDA, nunca con el signo
  // de la fila. Parece lo mismo y no lo es: si el saldo de la fila esta a favor,
  // la celda "Debe" vale $0 y por eso tiene que salir GRIS, no verde. Con el
  // signo de la fila salía verde, y una tabla con las dos columnas en verde y
  // gris mezcladas no dice de qué lado está nada.
  //
  // Y hay TRES colores, no dos: el `$0` de la columna que no aplica es gris. Con
  // dos columnas la mitad de las celdas de cada fila son `$0`, y si tomaran el
  // color de su columna la tabla sería una lista de rojos y verdes donde el
  // color ya no comunica nada.

  /** La celda "Debe": roja si le debo plata a este, gris si no hay nada. */
  claseDebe(saldo: number): string {
    return Number(saldo) > 0 ? 'rojo' : 'cero';
  }

  /** La celda "Haber": verde si me deben plata, gris si no hay nada. */
  claseHaber(saldo: number): string {
    return Number(saldo) < 0 ? 'verde' : 'cero';
  }

  get totalSalidas(): number {
    return this.totalPagadoEmpleados + this.totalCompras;
  }

  /**
   * Ingresos menos salidas del período.
   *
   * YA NO SE MUESTRA en ninguna parte. El usuario lo sacó de la pantalla con un
   * motivo concreto: no hay caja chica, el dinero entra y sale por
   * transferencia, así que el saldo siempre daba negativo y el cartel de "Da
   * negativo..." aparecía casi siempre, que es exactamente como se ve una alarma
   * que en realidad no dice nada.
   *
   * El getter queda porque es una cuenta correcta y está cubierto por tests que
   * documentan la aritmética. Si algún día se necesita el saldo REAL (con
   * saldos iniciales por cuenta), este es el punto de partida.
   */
  get balance(): number {
    return this.totalIngresos - this.totalSalidas;
  }

  /**
   * Cruza el importe SUGERIDO (porcentaje sobre turnos) con el PAGADO (lo que
   * se registró), por empleado.
   *
   * Por qué los dos y no uno: el porcentaje dice lo que *debería* ser; el pago
   * dice lo que *se dio*. La diferencia es un adelanto, un extra o un error de
   * carga, y es justo lo que hay que revisar al cerrar el mes.
   *
   * Un empleado con pagos pero sin turnos en el período igual aparece: puede
   * habérsele pagado una quincena atrasada.
   */
  armarPagosPorEmpleado() {
    const porId = new Map<number, any>();
    this.comisionesPeriodo.forEach((c: any) => {
      porId.set(c.empleado_id, { ...c, pagado: 0, pagos: [] as any[] });
    });
    this.pagos.forEach((p: any) => {
      // El select viene como `empleados: { nombre }` o `empleados: null` si el
      // empleado fue borrado. Por eso el fallback.
      const nombre = p.empleados?.nombre || `Empleado #${p.empleado_id}`;
      if (!porId.has(p.empleado_id)) {
        porId.set(p.empleado_id, {
          empleado_id: p.empleado_id, nombre, sugerido: 0, turnos: 0, pagado: 0, pagos: [] as any[],
        });
      }
      const fila = porId.get(p.empleado_id);
      fila.nombre = nombre;
      fila.pagado += Number(p.monto) || 0;
      fila.pagos.push(p);
    });
    this.pagosPorEmpleado = [...porId.values()]
      // `faltaPagar = sugerido - pagado`, y NO al revés.
      //
      // Con `pagado - sugerido` un empleado al que se le pagaron 25.000 y no
      // atendió ningún turno daba `+$25.000` en verde, y eso se leía como "le
      // debés 25 mil" cuando en realidad dice lo contrario: le pagaste de más y
      // no le debés nada. Un número que se llama "falta pagar" y da NEGATIVO no
      // se puede malinterpretar, y por eso el signo se invirtió junto con el
      // nombre de la columna.
      .map((f: any) => ({ ...f, faltaPagar: f.sugerido - f.pagado }))
      .sort((a: any, b: any) => b.sugerido - a.sugerido || b.pagado - a.pagado);
  }

  /** Solo los activos: no tiene sentido cargar una compra a un proveedor dado de baja. */
  get proveedoresActivos(): any[] {
    return this.proveedores.filter((p: any) => p.activo);
  }

  /**
   * Proveedor elegido en el RESUMEN de la pestaña Gastos.
   *
   * Distinto de `proveedorSeleccionado`, que es el del formulario de "Registrar
   * compra". Son dos selectores porque son dos cosas distintas: uno es a quién le
   * estoy mirando la cuenta, el otro a quién le estoy cargando una compra. Si
   * fueran uno, registrar una compra cambiaría el resumen de arriba y sería
   * desconcertante.
   */
  proveedorActualId: number | null = null;

  /**
   * El proveedor del resumen, con un default para que nunca quede en "-- Elegí --".
   *
   * Primero el que tenga saldo (comprado o pagado) en el período, que es el que
   * está mirando algo; si el período está vacío, el primer proveedor activo.
   *
   * Es el mismo criterio que `empleadoActual`: un selector que arranca vacío
   * muestra tres cuadros en cero que dicen "no pasa nada" cuando en realidad no
   * se eligió a nadie.
   */
  get proveedorActual(): number | null {
    if (this.proveedorActualId !== null) return this.proveedorActualId;
    const conMovimiento = this.saldoPorProveedor[0];
    if (conMovimiento) return conMovimiento.proveedor_id;
    return this.proveedoresActivos.length ? this.proveedoresActivos[0].id : null;
  }

  /**
   * Empleados que aparecen en el combo de pago.
   *
   * Se ofrecen TODOS los activos, no solo los que tienen comisión sugerida: un
   * empleado sin turnos en el período igual puede needing un pago (una quincena
   * atrasada, un pago cargado en otro día del mes). Filtrar el combo por "tiene
   * comisión" hace desaparecer justo a quien hay que pagarle.
   */
  get empleadosParaPago(): any[] {
    return this.todosLosEmpleados.filter((e: any) => e.activo);
  }

  /** Total de lo sugerido. Aparece en la fila total de la tabla. */
  get totalSugerido(): number {
    return this.comisionesPeriodo.reduce((s: number, c: any) => s + (Number(c.sugerido) || 0), 0);
  }

  /**
   * Lo que falta pagarle a TODOS los empleados, para la fila de Total.
   *
   * `sugerido - pagado`, igual que las filas: si el detalle no cierra, el total
   * tampoco. Positivo = todavía hay plata que dar; negativo = se pagó de más.
   */
  get totalFaltaPagar(): number {
    return this.totalSugerido - this.totalPagadoEmpleados;
  }

  /** Compras agrupadas por proveedor, de mayor a menor. */
  get comprasPorProveedor(): { nombre: string; total: number; cantidad: number }[] {
    const mapa = new Map<number, { nombre: string; total: number; cantidad: number }>();
    this.compras.forEach((c: any) => {
      const nombre = c.proveedores?.nombre || `Proveedor #${c.proveedor_id}`;
      const fila = mapa.get(c.proveedor_id) || { nombre, total: 0, cantidad: 0 };
      fila.total += Number(c.monto) || 0;
      fila.cantidad += 1;
      mapa.set(c.proveedor_id, fila);
    });
    return [...mapa.values()].sort((a, b) => b.total - a.total);
  }

  // ── ABRIR / CERRAR LOS POPUPS ─────────────────────────────
  //
  // Los formularios son popups, no bloques inline. Antes cada "agregar" desplegaba
  // el form dentro de la tarjeta y empujaba la tabla hacia abajo; con el popup la
  // lista no se mueve y el ✕ queda siempre a mano.
  //
  // El mismo popup sirve para el alta y para la edición: la diferencia es
   // `compraEditando` (null = alta). Si fueran dos popups separados habria
  // que mantener dos veces el mismo form.
  //
  // Al abrir se limpian los mensajes de error, y también al CERRAR: si el usuario
  // abre, corrige a medias, cierra sin guardar y vuelve a abrir, tiene que ver
  // el formulario limpio y no el reclamo del intento anterior.


  /**
   * El día de hoy en formato `YYYY-MM-DD`, que es el que espera `<input type="date">`.
   *
   * Un método y no la expresión suelta en los dos popups: se va a necesitar en
   * todos los formularios de alta (pago, abono, compra) y copy-pastear
   * `toLocaleDateString('en-CA')` tres veces es la forma segura de que una de las
   * tres quede con un formato distinto.
   *
   * `en-CA` y no `es-AR` a propósito: el pipe de fecha de `es-AR` devuelve
   * `DD/MM/YYYY` y `<input type="date">` no lo acepta. Por eso el `fechaDesdeISO`
   * del Dashboard hace la operación inversa.
   */
  hoyISO(): string {
    return new Date().toLocaleDateString('en-CA');
  }

  /**
   * Abrir el popup de pago a EMPLEADO.
   *
   * Viene preseleccionado el empleado del selector de arriba, y no un "Elegí..."
   * vacío. La razón es que el botón "Registrar pago" está DENTRO del detalle de
   * ese empleado: si leés "Pagos que le hiciste — Juan Pérez" y tocás el botón,
   * el formulario que se abre es de Juan Pérez. Pedir de nuevo quién es es
   * trabajo para confirmar lo que ya se sabe, y lo peor: si elegís otro por error,
   * el pago queda cargado al que no era sin que nada avise.
   *
   * En "Todos" no hay nadie elegido, así que el combo arranca con el primero de
   * la lista. Es un default, no una decisión: el popup igual muestra el nombre.
   */
  abrirFormPago() {
    this.mensajeErrorPagos = '';
    this.nuevoPago = {
      empleado_id: this.empleadoParaPagoPorDefecto(),
      fecha: this.hoyISO(),
      monto: null,
      metodo: 'efectivo',
      notas: '',
    };
    this.mostrarFormPago = true;
    this.cdr.detectChanges();
  }

  /**
   * A quién va preseleccionado el combo del popup de pago a empleado.
   *
   * El empleado del selector de la pantalla si hay uno elegido; si el selector
   * está en "Todos" no hay nadie elegido, y entonces el primero que pueda recibir
   * un pago. Nunca `null` si hay empleados, para que el popup no abra con un
   * "Elegí..." que ya se sabe cuál es.
   */
  private empleadoParaPagoPorDefecto(): number | null {
    if (!this.mostrarTodos) {
      const fila = this.filaEmpleadoActual;
      if (fila) return fila.empleado_id;
      if (this.empleadoActual !== null) return this.empleadoActual;
    }
    return this.empleadosParaPago[0]?.id ?? null;
  }

  /**
   * A quién va preseleccionado el buscador del popup de COMPRA.
   *
   * El mismo criterio que en el pago: si arriba hay un proveedor elegido, el
   * formulario de "Registrar compra" lo trae puesto.
   *
   * Devuelve el objeto completo y no el id porque el buscador muestra
   * `.seleccionado-ok` con `proveedorSeleccionado.nombre` y no con el id: si solo
   * pasara el id, la pantalla "no hay proveedor elegido" con uno ya asignado,
   * que es exactamente el bug que el comentario de `abrirFormCompra` describe.
   */
  private proveedorParaCompraPorDefecto(): any {
    if (!this.mostrarTodos) {
      const fila = this.filaProveedorActual;
      if (fila) {
        return this.proveedores.find((p: any) => p.id === fila.proveedor_id)
          || { id: fila.proveedor_id, nombre: fila.nombre, activo: true };
      }
      if (this.proveedorActual !== null) {
        const p = this.proveedores.find((x: any) => x.id === this.proveedorActual);
        if (p) return p;
      }
    }
    return null;
  }

  /**
   * El proveedor del popup de ABONO, con el mismo criterio que el de compra.
   *
   * Se reusa `proveedorParaCompraPorDefecto` y no se escribe un segundo criterio:
   * los dos popups abren dentro del detalle del proveedor elegido arriba, así que
   * si un día uno se cambia y el otro no, los dos formularios de la misma pantalla
   * empiezan a discrepar sin que nadie lo note.
   *
   * Solo se diferencia en el fallback cuando NO hay nadie elegido (combo en
   * "Todos"): el de compra deja el buscador vacío para no imponer un proveedor,
   * y el de abono pone el primero activo, porque sin proveedor no se puede
   * guardar y el popup debe quedar listo para usar.
   */
  private proveedorParaPagoPorDefecto(): any {
    return this.proveedorParaCompraPorDefecto()
      || this.proveedoresActivos[0]
      || null;
  }

  cerrarFormPago() {
    this.mostrarFormPago = false;
    this.mensajeErrorPagos = '';
    this.cdr.detectChanges();
  }


  /** Sin argumento = alta nueva. Con una compra = editar esa. */
  abrirFormCompra(c: any = null) {
    this.mensajeError = '';
    this.compraEditando = c;
    this.nuevaCompra = c
      ? {
          proveedor_id: c.proveedor_id,
          fecha: c.fecha,
          concepto: c.concepto,
          cantidad: c.cantidad,
          monto: Number(c.monto),
          notas: c.notas || '',
        }
      : { proveedor_id: null, fecha: '', concepto: '', cantidad: 1, monto: null, notas: '' };
    // El buscador arranca limpio siempre, y al editar queda preseleccionado el
    // proveedor de la compra. Sin esto se abría con un id en el modelo y el
    // campo de búsqueda vacío: "no hay proveedor elegido" con uno ya asignado.
    this.busquedaProveedorPopup = '';
    this.mostrarFormNuevoProveedor = false;
    this.nombreNuevoProveedor = '';
    this.proveedorSeleccionado = c
      ? this.proveedores.find((p: any) => p.id === c.proveedor_id)
        || { id: c.proveedor_id, nombre: c.proveedores?.nombre || `#${c.proveedor_id}`, activo: true }
      // Sin compra en edición entra el proveedor del selector de arriba, si hay uno
      // elegido. Es el mismo criterio que el popup de pago: el botón está dentro
      // del detalle de ESE proveedor, así que el formulario es de ESE.
      : this.proveedorParaCompraPorDefecto();
    this.mostrarFormCompra = true;
    this.cdr.detectChanges();
  }

  cerrarFormCompra() {
    this.mostrarFormCompra = false;
    this.compraEditando = null;
    this.mensajeError = '';
    this.busquedaProveedorPopup = '';
    this.proveedorSeleccionado = null;
    this.mostrarFormNuevoProveedor = false;
    this.nombreNuevoProveedor = '';
    this.cdr.detectChanges();
  }

  get editandoCompra(): boolean {
    return this.compraEditando !== null;
  }

  // ── BUSCADOR DE PROVEEDOR DEL POPUP ───────────────────────
  //
  // A diferencia del de clientes de "Nuevo turno", este NO consulta la base en
  // cada tecla: filtra la lista que ya está en memoria con `contiene`. Dos
  // razones:
  //   · sin una ida a la base por tecla
  //   · `contiene` ignora acentos, y el `.ilike()` de Postgres no
  //
  // Solo busca entre los ACTIVOS: cargar una compra a un proveedor dado de baja
  // no tiene sentido.

  /** Resultados del buscador del popup. Vacío si no hay nada escrito. */
  get resultadosBusquedaProveedor(): any[] {
    const q = this.busquedaProveedorPopup.trim();
    if (!q) return [];
    return this.proveedoresActivos
      .filter((p: any) => contiene(p.nombre, q))
      .slice(0, 8);
  }

  /** No se encontró nada y hay texto: se puede crear. */
  get puedeCrearProveedorDesdePopup(): boolean {
    const q = this.busquedaProveedorPopup.trim();
    return !!q
      && !this.proveedorSeleccionado
      && this.resultadosBusquedaProveedor.length === 0;
  }

  /** Elegir uno de la lista. */
  seleccionarProveedorPopup(p: any) {
    this.proveedorSeleccionado = p;
    this.nuevaCompra.proveedor_id = p.id;
    this.busquedaProveedorPopup = '';
    this.mostrarFormNuevoProveedor = false;
    this.mensajeError = '';
    this.cdr.detectChanges();
  }

  /** Deseleccionar, para elegir otro. */
  quitarProveedorPopup() {
    this.proveedorSeleccionado = null;
    this.nuevaCompra.proveedor_id = null;
    this.busquedaProveedorPopup = '';
    this.cdr.detectChanges();
  }

  /** Crear el proveedor desde el popup y dejarlo elegido. */
  async crearYSeleccionarProveedor() {
    const nombre = (this.nombreNuevoProveedor || this.busquedaProveedorPopup).trim();
    if (!nombre) {
      this.mensajeError = '❌ Escribí el nombre del proveedor.';
      return;
    }
    // Mismo chequeo que el alta desde la lista: el índice único de la base es
    // `lower(btrim(nombre))` y conviene avisar acá y no con un error de Postgres.
    if (this.proveedores.some((p: any) => paraComparar(p.nombre) === paraComparar(nombre))) {
      this.mensajeError = '⚠️ Ya existe un proveedor con ese nombre.';
      return;
    }
    this.guardando = true;
    try {
      const nuevo = await this.supabase.crearProveedor({ nombre });
      await this.cargarDatos();
      // `cargarDatos` reemplaza `this.proveedores`: se busca el recién creado en
      // la lista nueva, no se usa el objeto devuelto (que viene sin `activo`).
      const creado = this.proveedores.find((p: any) => p.id === nuevo.id) || { ...nuevo, activo: true };
      this.seleccionarProveedorPopup(creado);
      this.nombreNuevoProveedor = '';
      this.mostrarFormNuevoProveedor = false;
      this.mensaje = '✅ Proveedor creado.';
    } catch (e) {
      this.mensajeError = '❌ No se pudo crear el proveedor.';
    }
    this.guardando = false;
    this.cdr.detectChanges();
  }

  // ── PAGOS A EMPLEADOS: alta y borrado ──────────────────────

  async guardarPago() {
    this.mensajeErrorPagos = '';
    this.mensajePagos = '';
    if (!this.nuevoPago.empleado_id) {
      this.mensajeErrorPagos = '❌ Elegí el empleado.';
      return;
    }
    if (!this.nuevoPago.fecha) {
      this.mensajeErrorPagos = '❌ Elegí la fecha del pago.';
      return;
    }
    // `monto > 0` es un CHECK en la base. Validarlo acá evita un error de
    // Postgres que el usuario no entendería ("violates check constraint").
    if (!(Number(this.nuevoPago.monto) > 0)) {
      this.mensajeErrorPagos = '❌ El monto tiene que ser mayor a 0.';
      return;
    }
    this.guardandoPago = true;
    try {
      await this.supabase.crearPagoEmpleado({
        empleado_id: Number(this.nuevoPago.empleado_id),
        fecha: this.nuevoPago.fecha,
        monto: Number(this.nuevoPago.monto),
        metodo: this.nuevoPago.metodo || 'efectivo',
        notas: this.nuevoPago.notas || null,
      });
      this.nuevoPago = { empleado_id: null, fecha: '', monto: null, metodo: 'efectivo', notas: '' };
      this.cerrarFormPago();
      await this.cargarDatos();
      this.mostrarMensajePagos('✅ Pago registrado.');
    } catch (e) {
      this.mensajeErrorPagos = '❌ No se pudo guardar el pago.';
    }
    this.guardandoPago = false;
    this.cdr.detectChanges();
  }

  async eliminarPago(pago: any) {
    if (!confirm(`¿Borrar el pago de $${Number(pago.monto).toLocaleString('es-AR')} del ${fechaConAnio(pago.fecha)}?`)) return;
    try {
      await this.supabase.eliminarPagoEmpleado(pago.id);
      await this.cargarDatos();
      this.mostrarMensajePagos('✅ Pago eliminado.');
    } catch (e) {
      this.mensajeErrorPagos = '❌ No se pudo eliminar.';
    }
    this.cdr.detectChanges();
  }

  // ── PROVEEDORES: alta / inactivar ─────────────────────────

  /** Inactivar, no borrar: las compras viejas tienen que seguir apuntando a alguien. */
  // ── COMPRAS: alta / borrado ────────────────────────────────

  async guardarCompra() {
    this.mensajeError = '';
    this.mensaje = '';
    if (!this.nuevaCompra.proveedor_id) {
      this.mensajeError = '❌ Elegí el proveedor.';
      return;
    }
    if (!this.nuevaCompra.fecha) {
      this.mensajeError = '❌ Elegí la fecha.';
      return;
    }
    if (!this.nuevaCompra.concepto.trim()) {
      this.mensajeError = '❌ Escribí el concepto.';
      return;
    }
    if (!(Number(this.nuevaCompra.monto) > 0)) {
      this.mensajeError = '❌ El monto tiene que ser mayor a 0.';
      return;
    }
    this.guardando = true;
    const datos = {
      proveedor_id: Number(this.nuevaCompra.proveedor_id),
      fecha: this.nuevaCompra.fecha,
      concepto: this.nuevaCompra.concepto.trim(),
      cantidad: Number(this.nuevaCompra.cantidad) || 1,
      monto: Number(this.nuevaCompra.monto),
      notas: this.nuevaCompra.notas || null,
    };
    try {
      if (this.editandoCompra) {
        await this.supabase.actualizarCompra(this.compraEditando.id, datos);
      } else {
        await this.supabase.crearCompra(datos);
      }
      const eraEdicion = this.editandoCompra;
      this.cerrarFormCompra();
      this.nuevaCompra = { proveedor_id: null, fecha: '', concepto: '', cantidad: 1, monto: null, notas: '' };
      await this.cargarDatos();
      this.mostrarMensaje(eraEdicion ? '✅ Deuda actualizada.' : '✅ Deuda registrada.');
    } catch (e) {
      this.mensajeError = '❌ No se pudo guardar la deuda.';
    }
    this.guardando = false;
    this.cdr.detectChanges();
  }

  async eliminarCompra(c: any) {
    if (!confirm(`¿Borrar la deuda "${c.concepto}"?`)) return;
    try {
      await this.supabase.eliminarCompra(c.id);
      await this.cargarDatos();
      this.mostrarMensaje('✅ Deuda eliminada.');
    } catch (e) {
      this.mensajeError = '❌ No se pudo eliminar.';
    }
    this.cdr.detectChanges();
  }

  private mostrarMensaje(m: string) {
    this.mensaje = m;
    this.mensajeError = '';
    this.cdr.detectChanges();
    setTimeout(() => { this.mensaje = ''; this.cdr.detectChanges(); }, 3000);
  }

  private mostrarMensajePagos(m: string) {
    this.mensajePagos = m;
    this.mensajeErrorPagos = '';
    this.cdr.detectChanges();
    setTimeout(() => { this.mensajePagos = ''; this.cdr.detectChanges(); }, 3000);
  }

  get totalPorMetodoPago(): { metodo: string, cantidad: number, total: number }[] {
    const mapa: { [key: string]: { cantidad: number, total: number } } = {};
    this.turnos.forEach(t => {
      const metodo = t.metodo_pago || 'Sin registrar';
      if (!mapa[metodo]) mapa[metodo] = { cantidad: 0, total: 0 };
      mapa[metodo].cantidad++;
      mapa[metodo].total += Number(t.precio_final || t.precio) || 0;
    });
    return Object.entries(mapa)
      .map(([metodo, v]) => ({ metodo, ...v }))
      .sort((a, b) => b.total - a.total);
  }

  getRango(): { desde: string, hasta: string } {
    const formatLocal = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    if (this.vista === 'dia') {
      const d = formatLocal(this.fechaActual);
      return { desde: d, hasta: d };
    }

    if (this.vista === 'semana') {
      // Lunes a domingo, como el `getComisionesPeriodo` y el bloque de pagos de
      // Personas, que usan la misma convencion. El `getDay()` de un domingo es
      // 0: sin el caso especial, la semana arrancaria en el lunes SIGUIENTE y
      // un domingo solo quedaria fuera del período.
      const lunes = new Date(this.fechaActual);
      const dow = lunes.getDay();
      lunes.setDate(lunes.getDate() - (dow === 0 ? 6 : dow - 1));
      const domingo = new Date(lunes);
      domingo.setDate(lunes.getDate() + 6);
      return { desde: formatLocal(lunes), hasta: formatLocal(domingo) };
    }

    const y = this.fechaActual.getFullYear();
    const m = this.fechaActual.getMonth();
    const desde = formatLocal(new Date(y, m, 1));
    const hasta = formatLocal(new Date(y, m + 1, 0));
    return { desde, hasta };
  }

  // STATS
  get totalGanancias(): number {
    return this.turnos.reduce((sum, t) => sum + (Number(t.precio_final || t.precio) || 0), 0);
  }

  get totalAtendidos(): number {
    return this.turnos.length;
  }

  //get ticketPromedio(): number {
    //return this.totalAtendidos > 0 ? Math.round(this.totalGanancias / this.totalAtendidos) : 0;
  //}

  get metodoPagoMasUsado(): string {
    if (!this.turnos.length) return '-';
    const conteo: { [key: string]: number } = {};
    this.turnos.forEach(t => {
      // Sin `|| 'Sin registrar'` la clave del objeto era la string "null" y la
      // tarjeta mostraba literalmente la palabra null. `totalPorMetodoPago` ya
      // lo hacia bien; este getters se habia quedado atras.
      const metodo = t.metodo_pago || 'Sin registrar';
      conteo[metodo] = (conteo[metodo] || 0) + 1;
    });
    return Object.entries(conteo).sort((a, b) => b[1] - a[1])[0][0];
  }

  get servicioMasVendido(): string {
    if (!this.turnos.length) return '-';
    const conteo: { [key: string]: number } = {};
    this.turnos.forEach(t => {
      const nombre = t.servicio_nombre_final || t.servicio_nombre || 'Sin especificar';
      conteo[nombre] = (conteo[nombre] || 0) + 1;
    });
    return Object.entries(conteo).sort((a, b) => b[1] - a[1])[0][0];
  }

  // GRAFICO
  get datosGrafico(): { label: string, total: number, cantidad: number }[] {
    if (this.vista === 'dia') {
      const horas: { [key: string]: { total: number, cantidad: number } } = {};
      let minH = this.horaInicio;
      let maxH = this.horaFin;
      this.turnos.forEach(t => {
        const h = parseInt(t.hora_inicio?.slice(0, 2) || t.hora?.slice(0, 2) || '0', 10);
        if (h && h < minH) minH = h;
        if (h && h > maxH) maxH = h;
      });
      for (let h = minH; h <= maxH; h++) {
        horas[`${h}:00`] = { total: 0, cantidad: 0 };
      }
      this.turnos.forEach(t => {
        const h = parseInt(t.hora_inicio?.slice(0, 2) || t.hora?.slice(0, 2) || '0', 10);
        const key = `${h}:00`;
        if (horas[key]) {
          horas[key].total += (t.estado === 'atendido' && t.precio_final ? t.precio_final : t.precio) || 0;
          horas[key].cantidad++;
        }
      });
      return Object.entries(horas).map(([label, v]) => ({ label, ...v }));
    } else if (this.vista === 'semana') {
      // 7 barras, una por día, ETIQUETADAS CON LA FECHA COMPLETA.
      //
      // El label no puede ser "LUN": la barra tiene que ser clickeable para
      // saltar a ese día, y `irADia` reconstruye la fecha desde el label. Con
      // el nombre del día no hay de qué sacar el día del mes.
      const etiquetas = ['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB', 'DOM'];
      const dias: { label: string, total: number, cantidad: number }[] =
        this.diasDeLaSemana().map((d, i) => ({
          label: `${etiquetas[i]} ${String(d.getDate()).padStart(2, '0')}`,
          total: 0,
          cantidad: 0,
        }));

      this.turnos.forEach((t) => {
        const idx = dias.findIndex((b) => b.label.endsWith(` ${t.fecha?.slice(8, 10)}`));
        if (idx >= 0) {
          dias[idx].total += (t.estado === 'atendido' && t.precio_final ? t.precio_final : t.precio) || 0;
          dias[idx].cantidad++;
        }
      });

      return dias;
    } else {
      const y = this.fechaActual.getFullYear();
      const m = this.fechaActual.getMonth();
      const diasEnMes = new Date(y, m + 1, 0).getDate();
      
      const dias: { label: string, total: number, cantidad: number }[] = [];
      for (let d = 1; d <= diasEnMes; d++) {
        dias.push({ label: String(d).padStart(2, '0'), total: 0, cantidad: 0 });
      }
      
      this.turnos.forEach(t => {
        const d = parseInt(t.fecha?.slice(8, 10));
        const idx = d - 1;
        if (dias[idx]) {
          dias[idx].total += (t.estado === 'atendido' && t.precio_final ? t.precio_final : t.precio) || 0;
          dias[idx].cantidad++;
        }
      });
      
      return dias;
    }
  }

  get maxGrafico(): number {
    return Math.max(...this.datosGrafico.map(d => d.total), 1);
  }

  get totalPorServicio(): { nombre: string, cantidad: number, total: number }[] {
    const mapa: { [key: string]: { cantidad: number, total: number } } = {};
    this.turnos.filter(t => t.estado === 'atendido').forEach(t => {
      const nombre = t.servicio_nombre_final || t.servicio_nombre;
      const precio = t.precio_final || t.precio;
      if (!mapa[nombre]) mapa[nombre] = { cantidad: 0, total: 0 };
      mapa[nombre].cantidad++;
      mapa[nombre].total += Number(precio) || 0;
    });
    return Object.entries(mapa)
      .map(([nombre, v]) => ({ nombre, ...v }))
      .sort((a, b) => b.total - a.total);
  }

  // NAVEGACION
  navegar(dir: number) {
    if (this.vista === 'dia') {
      const d = new Date(this.fechaActual);
      d.setDate(d.getDate() + dir);
      this.fechaActual = d;
    } else if (this.vista === 'semana') {
      const d = new Date(this.fechaActual);
      d.setDate(d.getDate() + dir * 7);
      this.fechaActual = d;
    } else {
      // `setMonth` con overflow salta de mes: 31 de enero + 1 mes es "31 de
      // febrero", que Date normaliza a 3 de marzo. El usuario ve un salto de
      // enero a marzo. Se clampea al ultimo dia del mes destino.
      const y = this.fechaActual.getFullYear();
      const m = this.fechaActual.getMonth() + dir;
      const ultimoDestino = new Date(y, m + 1, 0).getDate();
      const dia = Math.min(this.fechaActual.getDate(), ultimoDestino);
      this.fechaActual = new Date(y, m, dia);
    }
    this.cargarDatos();
  }

  irHoy() {
    this.fechaActual = new Date();
    this.cargarDatos();
  }

  /**
   * Ir a una fecha elegida del calendario.
   *
   * Mismo criterio que `irAFechaTurnos` del Dashboard: no hay que recalcular nada
   * a mano, porque `tituloFecha`, `getRango()` y todas las consultas salen de
   * `fechaActual`. Con mover esa variable se reacomodan el título, el período y
   * las tres pestañas juntas.
   *
   * El `change` dispara con el `value` del input, que es `AAAA-MM-DD`.
   * `fechaDesdeISO` es la función que lo descompone a MEDIANOIE LOCAL, y no un
   * `new Date(iso)` a secas: el spec de `Date` parsea "2026-08-15" como medianoche
   * UTC, que en Argentina (UTC-3) cae el día ANTERIOR a las 21:00 local. El día
   * corrido es el peor tipo de bug, porque no tira error: solo muestra mal.
   *
   * Si el usuario borra el input a mano el `change` dispara con un string vacío,
   * y en ese caso no se toca la fecha: `fechaDesdeISO` devuelve `null` y el `if`
   * lo filtra.
   */
  irAFecha(iso: string) {
    const d = fechaDesdeISO(iso);
    if (!d) return;
    this.fechaActual = d;
    this.cargarDatos();
  }

  cambiarVista(v: 'dia' | 'semana' | 'mes') {
    this.vista = v;
    this.fechaActual = new Date();
    this.cargarDatos();
  }

  /** Días de la semana actual (lunes a domingo), para el gráfico y el título. */
  private diasDeLaSemana(): Date[] {
    const { desde } = this.getRango();
    const [y, m, d] = desde.split('-').map((n) => parseInt(n, 10));
    return Array.from({ length: 7 }, (_, i) => new Date(y, m - 1, d + i));
  }

  get tituloFecha(): string {
    if (this.vista === 'dia') {
      const dias = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
      const d = String(this.fechaActual.getDate()).padStart(2,'0');
      const m = String(this.fechaActual.getMonth()+1).padStart(2,'0');
      return `${dias[this.fechaActual.getDay()]} ${d}/${m}`;
    }
    if (this.vista === 'semana') {
      // Rango, no el nombre del mes: una semana casi nunca cae entera en un mes.
      const { desde, hasta } = this.getRango();
      const [, m1, d1] = desde.split('-');
      const [, m2, d2] = hasta.split('-');
      return `${d1}/${m1} - ${d2}/${m2}`;
    }
    return nombreMes(this.fechaActual.getMonth(), this.fechaActual.getFullYear());
  }

  scrollToHoy() {
    if (this.vista !== 'mes') return;
    setTimeout(() => {
      const grafico = this.graficoRef?.nativeElement;
      if (!grafico) return;
      const hoy = new Date().getDate();
      const inner = grafico.querySelector('.grafico-inner') as HTMLElement;
      if (!inner) return;
      const barras = inner.querySelectorAll('.barra-col');
      const idx = hoy - 1;
      if (barras[idx]) {
        const el = barras[idx] as HTMLElement;
        grafico.scrollLeft = el.offsetLeft - grafico.clientWidth / 2 + el.clientWidth / 2;
      }
    }, 800);
  }

  irADia(label: string) {
    if (this.vista === 'semana') {
      // El label es "LUN 05": el prefijo da el día de la semana.
      const idx = ['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB', 'DOM'].indexOf(label.slice(0, 3));
      if (idx < 0) return;
      // Se parte del LUNES del rango y se suma el índice. Armar la fecha con el
      // "día del mes" del label (el "05") se corre de mes en una semana que
      // cruza el ejemplo: LUN 29/01 + "SÁB 01" daría 1 de enero, no el 1 de
      // febrero que le corresponde.
      const [y, m, d] = this.getRango().desde.split('-').map((n) => parseInt(n, 10));
      this.fechaActual = new Date(y, m - 1, d + idx);
      this.vista = 'dia';
      this.cargarDatos();
      return;
    }
    if (this.vista !== 'mes') return;
    const dia = parseInt(label);
    const nueva = new Date(this.fechaActual.getFullYear(), this.fechaActual.getMonth(), dia);
    this.fechaActual = nueva;
    this.vista = 'dia';
    this.cargarDatos();
  }
}