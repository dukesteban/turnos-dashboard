import { Component, OnInit, ChangeDetectorRef, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService } from '../../services/supabase';
import { nombreMes } from '../../utils/fechas';
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
  // ('ingresos' | 'empleados' | 'proveedores'), el type checker de templates de
  // Angular ESTRECHA el tipo después del primer `*ngIf="tab === 'ingresos'"` y
  // se queja con TS2367 de que comparar con 'empleados' no tiene sentido, aunque
  // el narrowing solo valga para ese bloque. Ampliar a string lo evita.
  //
  // El conjunto de pestañas válidas está en `TABS`.
  tab: string = 'ingresos';

  vista: 'dia' | 'mes' = 'mes';
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

  constructor(private supabase: SupabaseService, private cdr: ChangeDetectorRef) {}

  /**
   * Columna "Diferencia" de "Sugerido vs pagado".
   *
   * `diferencia = pagado - sugerido`, así que:
   *   · positiva = se pagó MÁS de lo sugerido  -> verde, `$19.000`
   *   · negativa = se pagó MENOS de lo sugerido -> rojo, `-$19.000`
   *   · cero     = cuadró exacto                -> verde, `—`
   *
   * Dos decisiones que parecen arbitrarias y no lo son:
   *
   * **El `+` no se muestra.** Acá todos los números son plata que salió de la
   * caja, no variaciones de la ganancia: un `+$19.000` se lee como "ganó 19 mil"
   * cuando en realidad es "se le pagó 19 mil más de lo que le correspondía", que
   * es justo lo que hay que mirar para decidir si el porcentaje está mal.
   *
   * **El menos va antes del `$`.** `-$19.000` y no `$-19.000`: es como se
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

  /** El signo va adelante del `$`. Vacío en positivo. */
  signoDiferencia(d: number): string {
    // Signo tipográfico U+2212, el mismo que usan las filas del resumen. El
    // guion ASCII se vería casi igual pero es otro carácter: si someday se
    // busca el texto o se compara, no matchean.
    return d < 0 ? '−' : '';
  }

  /** Para que el pipe `number` no reciba el negativo y saque el menos solo. */
  absDiferencia(d: number): number {
    return Math.abs(d);
  }

  /** Verde si se pagó de más (o justo), rojo si se pagó de menos. */
  claseDiferencia(d: number): string {
    return d >= 0 ? 'verde' : 'rojo';
  }

  async ngOnInit() {
    await this.cargarHorarios();
    await this.cargarDatos();
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
    const [turnos, pagos, comisiones, compras, proveedores, empleados] = await Promise.all([
      this.supabase.getGanancias(desde, hasta),
      this.supabase.getPagosEmpleado(desde, hasta),
      this.supabase.getComisionesPeriodo(desde, hasta),
      this.supabase.getCompras(desde, hasta),
      this.supabase.getProveedores(),
      // Activos solamente: el combo de pago no debería ofrecer a alguien dado
      // de baja. `getEmpleados()` con `soloActivos` por defecto.
      this.supabase.getEmpleados(),
    ]);
    this.turnos = turnos;
    this.pagos = pagos;
    this.comisionesPeriodo = comisiones;
    this.compras = compras;
    this.proveedores = proveedores;
    this.todosLosEmpleados = empleados;
    this.armarPagosPorEmpleado();
    this.cargando = false;
    this.cdr.detectChanges();
    this.scrollToHoy();
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

  /** Lo que se le pagó a los proveedores. */
  get totalCompras(): number {
    return this.compras.reduce((sum, c) => sum + (Number(c.monto) || 0), 0);
  }

  /** Todos los salidas juntos. */
  get totalSalidas(): number {
    return this.totalPagadoEmpleados + this.totalCompras;
  }

  /**
   * El número que importa: lo que quedó.
   *
   * Puede dar NEGATIVO, y está bien que se muestre. Si se pagaron comisiones de
   * un mes anterior este mes, o se compró insumos por adelantado, la caja del
   * período da negativo y eso es información real, no un error a tapar.
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
      .map((f: any) => ({ ...f, diferencia: f.pagado - f.sugerido }))
      .sort((a: any, b: any) => b.sugerido - a.sugerido || b.pagado - a.pagado);
  }

  /**
  /** Solo los activos: no tiene sentido cargar una compra a un proveedor dado de baja. */
  get proveedoresActivos(): any[] {
    return this.proveedores.filter((p: any) => p.activo);
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
   * La diferencia de TODOS los empleados, para la fila de Total.
   *
   * Se arma con los mismos dos getters que ya summing las filas de arriba, así
   * que no puede desincronizarse de la tabla: si el detalle no cierra, el total
   * tampoco.
   */
  get totalDiferencia(): number {
    return this.totalPagadoEmpleados - this.totalSugerido;
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

  abrirFormPago() {
    this.mensajeErrorPagos = '';
    this.mostrarFormPago = true;
    this.cdr.detectChanges();
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
      : null;
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
    if (!confirm(`¿Borrar el pago de $${Number(pago.monto).toLocaleString('es-AR')} del ${pago.fecha}?`)) return;
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
      this.mostrarMensaje(eraEdicion ? '✅ Compra actualizada.' : '✅ Compra registrada.');
    } catch (e) {
      this.mensajeError = '❌ No se pudo guardar la compra.';
    }
    this.guardando = false;
    this.cdr.detectChanges();
  }

  async eliminarCompra(c: any) {
    if (!confirm(`¿Borrar la compra "${c.concepto}"?`)) return;
    try {
      await this.supabase.eliminarCompra(c.id);
      await this.cargarDatos();
      this.mostrarMensaje('✅ Compra eliminada.');
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
    } else {
      const y = this.fechaActual.getFullYear();
      const m = this.fechaActual.getMonth();
      const desde = formatLocal(new Date(y, m, 1));
      const hasta = formatLocal(new Date(y, m + 1, 0));
      return { desde, hasta };
    }
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

  cambiarVista(v: 'dia' | 'mes') {
    this.vista = v;
    this.fechaActual = new Date();
    this.cargarDatos();
  }

  get tituloFecha(): string {
    if (this.vista === 'dia') {
      const dias = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
      const d = String(this.fechaActual.getDate()).padStart(2,'0');
      const m = String(this.fechaActual.getMonth()+1).padStart(2,'0');
      return `${dias[this.fechaActual.getDay()]} ${d}/${m}`;
    } else {
      return nombreMes(this.fechaActual.getMonth(), this.fechaActual.getFullYear());
    }
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
    if (this.vista !== 'mes') return;
    const dia = parseInt(label);
    const nueva = new Date(this.fechaActual.getFullYear(), this.fechaActual.getMonth(), dia);
    this.fechaActual = nueva;
    this.vista = 'dia';
    this.cargarDatos();
  }
}
