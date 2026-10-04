import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService } from '../../services/supabase';
import { nombreMes } from '../../utils/fechas';
import { contiene } from '../../utils/texto';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './dashboard.html',
  styleUrls: ['./dashboard.scss']
})
export class DashboardComponent implements OnInit, OnDestroy {
  private subscription: any;
  turnosHoy: any[] = [];
  todosTurnos: any[] = [];
  totalIngresos = 0;
  totalClientes = 0;
  turnosPendientes = 0;
  vistasTurnos: 'semana' | 'mes' = 'semana';
  mostrarIngresos = JSON.parse(sessionStorage.getItem('mostrarIngresos') ?? 'true');
  fechaTurnos: Date = new Date();
  metodosPago: any[] = [];
  modoAtendido = false;
  atendidoServicioId: any = null;
  atendidoPrecio: number = 0;
  atendidoMetodoPago = 'efectivo';
  atendidoObservaciones = '';
  guardandoAtendido = false;
  errorAtendido = '';
  
  // Popup
  turnoSeleccionado: any = null;
  mostrarPopup = false;
  horarios: any[] = [];
  servicios: any[] = [];
  empleados: any[] = [];
  // Puestos de trabajo: RETIRADO. Las columnas de la agenda son empleados.
  ausencias: any[] = [];
  /** Telefono ACTUAL por cliente. El del turno es un snapshot y puede estar viejo. */
  telefonosPorCliente: Record<number, string> = {};

  /** Telefono vigente del cliente de un turno. */
  telefonoDe(turno: any): string | null {
    if (!turno) return null;
    const actual = turno.cliente_id ? this.telefonosPorCliente[turno.cliente_id] : null;
    return actual || turno.cliente_telefono || null;
  }
  /** Lista filtrada para el form de reprogramar (no pisa this.empleados). */
  empleadosReprogramar: any[] = [];
  /** El empleado elegido NO puede trabajar esa fecha/hora (se muestra con aviso). */
  empleadoReprogramarNoPuede = false;
  mostrarPopupCancelacion = false;
  motivoCancelacion = '';
  enviandoMensaje = false;
  nombreNegocio = localStorage.getItem('nombre_negocio') || '';
  atendidoEmpleadoId: number | null = null;

  // Editar/Postergar
  modoEditarTurno = false;
  editandoTurno = false;
  errorEditarTurno = '';
  nuevaFecha = '';
  nuevaHora = '';
  nuevoServicioId: number | null = null;
  nuevoEmpleadoId: number | null = null;
  esperandoConfirmacion = false;
  mostrarPopupPostergacion = false;
  motivoPostergacion = '';
  enviandoMensajePostergacion = false;
  _nuevaFechaPostergacion = '';
  _nuevaHoraPostergacion = '';
  _nuevoServicioPostergacion = '';

  // Nuevo turno
  mostrarModalNuevoTurno = false;
  /** Lista completa para filtrar en memoria. La carga `cargarClientesBusqueda`. */
  todosLosClientes: any[] = [];
  cargandoClientesBusqueda = false;
  clienteSeleccionadoNuevo: any = null;
  busquedaCliente = '';
  nuevoTurnoFecha = '';
  nuevoTurnoHora = '';
  nuevoTurnoServicioId: number | null = null;
  nuevoTurnoEmpleadoId: number | null = null;
  empleadosLibres: any[] = [];
  comisionesPorServicio: any[] = [];
  guardandoNuevoTurno = false;
  errorNuevoTurno = '';
  mostrarFormNuevoCliente = false;
  nombreNuevoCliente = '';

  get nuevoServicio(): any {
    return this.servicios.find(s => s.id == Number(this.nuevoServicioId)) || null;
  }

  /** Nombre del empleado del turno. */
  nombreEmpleadoDeTurno(turno: any): string {
    const id = this.empleadoDeTurno(turno);
    if (!id) return 'Sin empleado';
    return this.empleados.find((e: any) => e.id === id)?.nombre || 'Sin empleado';
  }

  /**
   * ID del empleado del turno. Es OBLIGATORIO: define la columna de la agenda
   * y es quien cobra la comisión. Ya no se deriva del puesto.
   */
  empleadoDeTurno(turno: any): number | null {
    return turno?.empleado_id ?? null;
  }

  constructor(private supabase: SupabaseService, private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    await this.cargarTurnos();
    this.metodosPago = await this.supabase.getMetodosPago();
    this.empleados = await this.supabase.getEmpleados();
    this.ausencias = await this.supabase.getAusencias();
    this.telefonosPorCliente = await this.supabase.getTelefonosPorCliente();
    this.subscription = this.supabase.suscribirTurnos(() => {
      this.cargarTurnos();
    });
    this.cdr.detectChanges();
  }

  ngOnDestroy() {
    this.subscription?.unsubscribe();
  }

  async cargarTurnos() {
    this.turnosHoy = await this.supabase.getTurnosHoy();
    this.todosTurnos = await this.supabase.getTurnos();

    this.totalIngresos = this.turnosHoy
      .filter((t: any) => t.estado === 'atendido')
      .reduce((sum: number, t: any) => sum + (Number(t.precio_final || t.precio) || 0), 0);

    this.totalClientes = this.turnosHoy
      .filter((t: any) => t.estado === 'atendido').length;

    this.turnosPendientes = this.turnosHoy
      .filter((t: any) => t.estado === 'pendiente' && !this.esVencido(t)).length;

    this.cdr.detectChanges();
  }

  get turnosFiltrados(): any[] {
    const base = this.fechaTurnos;
    const formatLocal = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    if (this.vistasTurnos === 'semana') {
      const lunes = new Date(base);
      lunes.setDate(base.getDate() - (base.getDay() === 0 ? 6 : base.getDay() - 1));
      const domingo = new Date(lunes);
      domingo.setDate(lunes.getDate() + 6);
      return this.todosTurnos.filter(t => t.fecha >= formatLocal(lunes) && t.fecha <= formatLocal(domingo));
    } else {
      const y = base.getFullYear();
      const m = String(base.getMonth() + 1).padStart(2, '0');
      return this.todosTurnos.filter(t => t.fecha.startsWith(`${y}-${m}`));
    }
  }

  cambiarVistaTurnos(v: 'semana' | 'mes') {
    this.vistasTurnos = v;
    this.fechaTurnos = new Date(); // resetea al mes/semana actual
  }
  
  navegarTurnos(dir: number) {
    const d = new Date(this.fechaTurnos);
    if (this.vistasTurnos === 'semana') {
      d.setDate(d.getDate() + dir * 7);
    } else {
      d.setMonth(d.getMonth() + dir);
    }
    this.fechaTurnos = d;
  }
  
  irHoyTurnos() {
    this.fechaTurnos = new Date();
  }

  toggleIngresos() {
    this.mostrarIngresos = !this.mostrarIngresos;
    sessionStorage.setItem('mostrarIngresos', String(this.mostrarIngresos));
  }

  async cambiarEstado(id: number, estado: string) {
    await this.supabase.updateEstadoTurno(id, estado);
    await this.cargarTurnos();
  }

  esVencido(turno: any): boolean {
    if (turno.estado !== 'pendiente') return false;
    const fechaHora = new Date(`${turno.fecha}T${turno.hora_inicio || turno.hora}`);
    return fechaHora < new Date();
  }

  async abrirPopup(turno: any) {
    this.turnoSeleccionado = turno;
    this.mostrarPopup = true;
    this.modoEditarTurno = false;
    this.errorEditarTurno = '';
    if (!this.servicios.length) this.servicios = await this.supabase.getServicios();
    if (!this.horarios.length) this.horarios = await this.supabase.getHorarios();
    this.cdr.detectChanges();
  }

  cerrarPopup() {
    this.mostrarPopup = false;
    this.turnoSeleccionado = null;
    this.modoEditarTurno = false;
    this.modoAtendido = false;
    // Limpiar tambien los carteles del form de reprogramar: si no, reaparecen
    // al abrir el siguiente turno.
    this.editandoTurno = false;
    this.errorEditarTurno = '';
    this.empleadoReprogramarNoPuede = false;
    this.empleadosReprogramar = this.empleados;
    this.cdr.detectChanges();
  }

  async cambiarEstadoPopup(estado: string) {
    if (!this.turnoSeleccionado) return;
    if (estado === 'atendido') {
      this.modoAtendido = true;
      this.atendidoServicioId = this.turnoSeleccionado.servicio_id;
      this.atendidoMetodoPago = this.metodosPago[0]?.nombre || '';
      this.atendidoPrecio = this.turnoSeleccionado.precio;
      this.atendidoObservaciones = '';
      this.atendidoEmpleadoId = this.empleadoDeTurno(this.turnoSeleccionado);
      this.errorAtendido = '';
      await this.cargarComisionesPorServicio();
      this.cdr.detectChanges();
      return;
    }
    if (estado === 'pendiente') {
      const id = this.turnoSeleccionado.id;
      await this.supabase.volverAPendiente(id);
      await this.cargarTurnos(); // cargarDatos() en dashboard
      this.cerrarPopup();
      return;
    }
    const id = this.turnoSeleccionado.id;
    await this.supabase.updateEstadoTurno(id, estado);
    await this.cargarTurnos();
    this.cerrarPopup();
  }

  get atendidoServicio(): any {
    return this.servicios.find(s => s.id == this.atendidoServicioId) || null;
  }

  async confirmarAtendido() {
    this.errorAtendido = '';
    if (!this.atendidoServicioId || !this.atendidoPrecio || !this.atendidoMetodoPago) {
      this.errorAtendido = 'Completá los campos requeridos.';
      this.cdr.detectChanges();
      return;
    }
    const servicio = this.atendidoServicio;

    // Sin empleado no se puede guardar: se perderia la comision y el turno
    // no tendria columna en la agenda.
    if (!this.atendidoEmpleadoId) {
      this.errorAtendido = '❌ Elegí el empleado que atendió.';
      this.cdr.detectChanges();
      return;
    }

    // Jornada semanal + ausencias del empleado que se esta anotando
    const puede = await this.supabase.empleadoPuedeAtender(
      this.atendidoEmpleadoId,
      this.turnoSeleccionado.fecha,
      (this.turnoSeleccionado.hora_inicio || this.turnoSeleccionado.hora || '00:00').slice(0, 5),
      servicio?.duracion_minutos || this.turnoSeleccionado.duracion_minutos || 45,
      this.ausencias
    );
    if (!puede.ok) {
      const nombreEmp = this.empleados.find((e: any) => e.id === this.atendidoEmpleadoId)?.nombre;
      this.errorAtendido = `❌ ${nombreEmp || 'Ese empleado'}: ${puede.motivo}.`;
      this.cdr.detectChanges();
      return;
    }

    // No puede pisar otro turno suyo en ese rango
    const dur = servicio?.duracion_minutos || this.turnoSeleccionado.duracion_minutos || 45;
    const ocupado = await this.supabase.empleadoEstaOcupado(
      this.atendidoEmpleadoId,
      this.turnoSeleccionado.fecha,
      this.turnoSeleccionado.hora_inicio?.slice(0, 5) || this.turnoSeleccionado.hora?.slice(0, 5),
      dur,
      this.turnoSeleccionado.id
    );
    if (ocupado) {
      const nombreEmp = this.empleados.find((e: any) => e.id === this.atendidoEmpleadoId)?.nombre;
      this.errorAtendido = `❌ ${nombreEmp || 'Ese empleado'} ya tiene otro turno en ese horario.`;
      this.cdr.detectChanges();
      return;
    }

    this.guardandoAtendido = true;
    try {
      await this.supabase.marcarAtendido(this.turnoSeleccionado.id, {
        servicio_nombre_final: servicio?.nombre || this.turnoSeleccionado.servicio_nombre,
        servicio_id_final: servicio?.id ?? null,
        precio_final: this.atendidoPrecio,
        metodo_pago: this.atendidoMetodoPago,
        observaciones: this.atendidoObservaciones,
        empleado_id: this.atendidoEmpleadoId
      });
      await this.cargarTurnos();
      await this.cargarComisionesPorServicio();
      this.cerrarPopup();
    } catch (e) {
      this.errorAtendido = '❌ Error al guardar.';
      this.cdr.detectChanges();
    }
    this.guardandoAtendido = false;
  }

  activarEditarTurno() {
    this.modoEditarTurno = true;
    this.nuevaFecha = this.turnoSeleccionado.fecha;
    this.nuevaHora = this.turnoSeleccionado.hora_inicio?.slice(0,5) || this.turnoSeleccionado.hora?.slice(0,5) || '';
    this.nuevoServicioId = this.turnoSeleccionado.servicio_id;
    this.nuevoEmpleadoId = this.empleadoDeTurno(this.turnoSeleccionado);
    this.errorEditarTurno = '';
    this.actualizarEmpleadosReprogramar();
    this.cdr.detectChanges();
  }

  toMinutos(horaStr: string): number {
    if (!horaStr) return 0;
    const parts = horaStr.split(':');
    return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
  }

  async confirmarEditarTurno() {
    this.errorEditarTurno = '';
    if (!this.nuevaFecha || !this.nuevaHora || !this.nuevoServicioId) {
      this.errorEditarTurno = 'Completá todos los campos.';
      this.cdr.detectChanges();
      return;
    }
    const servicio = this.nuevoServicio;
    if (!servicio) return;

    // Verificar si hubo cambios
    /*
    const sinCambios = 
      this.nuevaFecha === this.turnoSeleccionado.fecha &&
      this.nuevaHora === (this.turnoSeleccionado.hora_inicio || this.turnoSeleccionado.hora)?.slice(0, 5) &&
      Number(this.nuevoServicioId) === this.turnoSeleccionado.servicio_id;

    if (sinCambios) {
      this.errorEditarTurno = 'No realizaste ningún cambio.';
      this.cdr.detectChanges();
      return;
    }
    */

    this.editandoTurno = true;

    try {
      // Validar que no sea en el pasado — solo si el turno original es futuro
      const fechaHora = new Date(`${this.nuevaFecha}T${this.nuevaHora}`);
      /*
      const turnoOriginalFecha = new Date(`${this.turnoSeleccionado.fecha}T${this.turnoSeleccionado.hora_inicio || this.turnoSeleccionado.hora}`);
      if (turnoOriginalFecha > new Date()) {
        if (fechaHora <= new Date()) {
          this.errorEditarTurno = 'La nueva fecha y hora deben ser en el futuro.';
          this.cdr.detectChanges();
          return;
        }
      }
      */

      // Calcular hora fin
      const fin = new Date(fechaHora);
      fin.setMinutes(fin.getMinutes() + servicio.duracion_minutos);
      const horaFin = `${String(fin.getHours()).padStart(2,'0')}:${String(fin.getMinutes()).padStart(2,'0')}`;

      // Validar que el empleado pueda trabajar ese dia (jornada + ausencias)
      if (this.nuevoEmpleadoId) {
        const puede = await this.supabase.empleadoPuedeAtender(
          this.nuevoEmpleadoId, this.nuevaFecha, this.nuevaHora,
          servicio.duracion_minutos, this.ausencias
        );
        if (!puede.ok) {
          const nombreEmp = this.empleados.find((e: any) => e.id === this.nuevoEmpleadoId)?.nombre;
          this.errorEditarTurno = `❌ ${nombreEmp || 'Ese empleado'}: ${puede.motivo}.`;
          return;
        }
      }

      // Validar que el puesto elegido no este ocupado en ese rango
      // El empleado es obligatorio: define la columna de la agenda y la comision.
      if (!this.nuevoEmpleadoId) {
        this.errorEditarTurno = '❌ Elegí el empleado que atiende.';
        return;
      }
      const ocupado = await this.supabase.empleadoEstaOcupado(
        this.nuevoEmpleadoId, this.nuevaFecha, this.nuevaHora,
        servicio.duracion_minutos, this.turnoSeleccionado.id
      );
      if (ocupado) {
        const nombreEmp = this.empleados.find((e: any) => e.id === this.nuevoEmpleadoId)?.nombre;
        this.errorEditarTurno = `❌ ${nombreEmp || 'Ese empleado'} ya tiene un turno en ese horario.`;
        return;
      }

      // Validar horario de atención
      const diaISO = new Date(this.nuevaFecha + 'T12:00:00').getDay();
      const horariosDia = this.horarios.filter((hor: any) => hor.dia_semana === diaISO && hor.activo);
      const dentroHorario = horariosDia.some((hor: any) => {
        const horIni = this.toMinutos(hor.hora_inicio);
        const horFin = this.toMinutos(hor.hora_fin);
        return this.toMinutos(this.nuevaHora) >= horIni && this.toMinutos(horaFin) <= horFin;
      });
      if (!dentroHorario) {
        this.errorEditarTurno = 'El horario está fuera del horario de atención.';
        return;
      }

      await this.supabase.editarTurno(this.turnoSeleccionado.id, {
        fecha: this.nuevaFecha,
        hora: this.nuevaHora,
        horaFin,
        servicio_id: servicio.id,
        servicio_nombre: servicio.nombre,
        precio: servicio.precio,
        duracion_minutos: servicio.duracion_minutos,
        empleado_id: this.nuevoEmpleadoId
      });
      await this.cargarTurnos();
      await this.cargarComisionesPorServicio();
      await this.iniciarNotificacionPostergacion(this.nuevaFecha, this.nuevaHora, servicio.nombre);
    } catch (e) {
      console.error('Error en confirmarEditarTurno:', e);
      this.errorEditarTurno = '❌ Error al guardar. Intentá de nuevo.';
    } finally {
      // El reset va en finally y no en cada return: con 4 caminos de salida
      // es facil olvidarse y el boton queda en "Guardando..." para siempre.
      this.editandoTurno = false;
      this.cdr.detectChanges();
    }
  }

  private formatearFechaCorta(fecha: Date): string {
    const d = String(fecha.getDate()).padStart(2, '0');
    const m = String(fecha.getMonth() + 1).padStart(2, '0');
    return `${d}/${m}`;
  }

  get rangoSemanaTurnos(): string {
    const base = this.fechaTurnos;
    const lunes = new Date(base);
    lunes.setDate(base.getDate() - (base.getDay() === 0 ? 6 : base.getDay() - 1));
    const domingo = new Date(lunes);
    domingo.setDate(lunes.getDate() + 6);
    return `${this.formatearFechaCorta(lunes)} — ${this.formatearFechaCorta(domingo)}`;
  }

  get tituloMesTurnos(): string {
    return nombreMes(this.fechaTurnos.getMonth(), this.fechaTurnos.getFullYear());
  }

  formatearHora(hora: string): string {
    return hora ? hora.slice(0, 5) : '';
  }

  formatearFecha(fecha: string): string {
    if (!fecha) return '';
    const [y, m, d] = fecha.split('-');
    return `${d}/${m}/${y}`;
  }

  formatearFechaSinAnio(fecha: string): string {
    if (!fecha) return '';
    const [y, m, d] = fecha.split('-');
    return `${d}/${m}`;
  }
  
  get nuevoTurnoServicio(): any {
    return this.servicios.find(s => s.id == this.nuevoTurnoServicioId) || null;
  }

  /**
   * Resultados de la búsqueda de cliente del modal de Nuevo turno.
   *
   * Es un GETTER y no un campo: filtra contra `todosLosClientes` cada vez que se
   * lee. Con un campo había que acordarse de recalcularlo, y si la lista se
   * cargaba tarde el dropdown quedaba vacío aunque el cliente estuviera.
   *
   * Filtra por NOMBRE y por TELÉFONO, sin acentos. Antes-usaba
   * `supabase.buscarClientes()`, que era una consulta a la base **por cada tecla**
   * con `.ilike()`, que además no ignora acentos: buscar "maria" no encontraba a
   * "María Gómez".
   */
  get clientesBuscados(): any[] {
    const q = this.busquedaCliente.trim();
    if (!q) return [];
    return this.todosLosClientes
      .filter((c: any) =>
        contiene(c.nombre, q) ||
        c.telefonos?.some((t: any) => contiene(t.telefono, q))
      )
      .slice(0, 8);
  }

  /**
   * Carga la lista completa de clientes UNA vez, para poder filtrar en memoria.
   *
   * Solo trae los activos: el alta de un turno para un cliente dado de baja no
   * tiene sentido. Es la misma lista que usa la pantalla de Clientes.
   */
  async cargarClientesBusqueda(forzar = false) {
    if (this.todosLosClientes.length && !forzar) return;
    this.cargandoClientesBusqueda = true;
    this.cdr.detectChanges();
    try {
      this.todosLosClientes = (await this.supabase.getClientes())
        .filter((c: any) => c.activo !== false);
    } catch (e) {
      // Si falla, el buscador queda sin resultados y se puede crear el cliente.
      this.todosLosClientes = [];
    }
    this.cargandoClientesBusqueda = false;
    this.cdr.detectChanges();
  }

  seleccionarClienteNuevo(cliente: any) {
    this.clienteSeleccionadoNuevo = cliente;
    this.busquedaCliente = cliente.nombre;
    this.cdr.detectChanges();
  }

  /** Deseleccionar, para elegir o crear otro cliente. */
  quitarClienteNuevo() {
    this.clienteSeleccionadoNuevo = null;
    this.busquedaCliente = '';
    this.errorNuevoTurno = '';
    this.mostrarFormNuevoCliente = false;
    this.nombreNuevoCliente = '';
    this.cdr.detectChanges();
  }

  abrirModalNuevoTurno() {
    this.mostrarModalNuevoTurno = true;
    this.clienteSeleccionadoNuevo = null;
    this.busquedaCliente = '';
    // El formulario de "crear cliente" también se limpia al ABRIR, no solo al
    // guardar o al cancelar.
    //
    // Sin esto: se abre el modal, se busca un nombre que no existe, se toca
    // "Crear", se escribe el nombre y se cierra el modal sin guardar. Al
    // volver a abrir, `mostrarFormNuevoCliente` seguía en true, así que la
    // cajita de crear aparecía YA ABIERTA al primer error de búsqueda, con el
    // texto del intento anterior adentro. Para usarla había que apretar
    // "Cancelar" primero.
    //
    // Ojo: `busquedaCliente = ''` la tapaba, y por eso el bug pasaba
    // desapercibido: se veía solo al volver a escribir algo que no matchea.
    this.mostrarFormNuevoCliente = false;
    this.nombreNuevoCliente = '';
    this.nuevoTurnoFecha = '';
    this.nuevoTurnoHora = '';
    this.nuevoTurnoServicioId = null;
    this.nuevoTurnoEmpleadoId = null;
    this.empleadosLibres = [];
    this.comisionesPorServicio = [];
    this.errorNuevoTurno = '';
    if (!this.servicios.length) this.supabase.getServicios().then(s => { this.servicios = s; this.cdr.detectChanges(); });
    if (!this.horarios.length) this.supabase.getHorarios().then(h => { this.horarios = h; this.cdr.detectChanges(); });
    if (!this.empleados.length) this.supabase.getEmpleados().then(e => { this.empleados = e; this.cdr.detectChanges(); });
    // Los clientes se cargan una vez y después se filtra en memoria. La segunda
    // vez que se abre el modal no vuelve a pedir la lista.
    this.cargarClientesBusqueda();
    this.cargarComisionesPorServicio();
    this.cdr.detectChanges();
  }

  async cargarComisionesPorServicio() {
    this.comisionesPorServicio = await this.supabase.getComisionesEmpleado(this.empleados.map((e: any) => e.id));
    this.cdr.detectChanges();
  }

  async actualizarEmpleadosLibres() {
    if (!this.nuevoTurnoFecha || !this.nuevoTurnoHora || !this.nuevoTurnoServicioId) {
      this.empleadosLibres = [];
      this.cdr.detectChanges();
      return;
    }
    const servicio = this.servicios.find(s => s.id == this.nuevoTurnoServicioId);
    if (!servicio) return;

    // Disponibilidad real por empleado. getEmpleadosDisponibles ya aplica jornada
    // semanal y ausencias, asi que alcanza con mirar `puede_atender` + `libre`.
    // El combo muestra SOLO estos: es lo que pediste (elegir de los que pueden).
    const disponibles = await this.supabase.getEmpleadosDisponibles(
      this.nuevoTurnoFecha, this.nuevoTurnoHora, servicio.duracion_minutos, this.ausencias
    );

    this.empleadosLibres = disponibles
      .filter((d: any) => d.puede_atender && d.libre)
      .map((d: any) => this.empleados.find((e: any) => e.id === d.empleado_id))
      .filter(Boolean);

    // Si el empleado elegido quedo fuera de la lista, se limpia la seleccion
    if (this.nuevoTurnoEmpleadoId && !this.empleadosLibres.some((e: any) => e.id === this.nuevoTurnoEmpleadoId)) {
      this.nuevoTurnoEmpleadoId = null;
    }
    this.cdr.detectChanges();
  }

  async onServicioChange() {
    this.errorNuevoTurno = '';
    await this.actualizarEmpleadosLibres();
    this.cdr.detectChanges();
  }

  onAtendidoServicioChange() {
    this.errorAtendido = '';
    if (this.comisionesPorServicio.length === 0) {
      this.cargarComisionesPorServicio();
    }
    this.cdr.detectChanges();
  }

  actualizarVista() {
    this.cdr.detectChanges();
  }

  getComisionEmpleadoAtendido(empleadoId: number): number {
    if (!this.atendidoServicioId) return 0;
    const comision = this.comisionesPorServicio.find(
      (c: any) => c.empleado_id === empleadoId && c.servicio_id === this.atendidoServicioId
    );
    if (comision) return comision.porcentaje;
    const empleado = this.empleados.find((e: any) => e.id === empleadoId);
    return empleado?.comision_porcentaje || 0;
  }

  async actualizarEmpleadosReprogramar() {
    if (!this.nuevaFecha) {
      this.empleadosReprogramar = this.empleados;
      this.empleadoReprogramarNoPuede = false;
      return;
    }
    const servicio = this.servicios.find((s: any) => s.id == this.nuevoServicioId);
    const dur = servicio?.duracion_minutos || 45;

    // Lista APARTE: antes se reasignaba this.empleados con un filter y la
    // lista original se perdia para siempre.
    const disponibles = await this.supabase.getEmpleadosDisponibles(
      this.nuevaFecha, this.nuevaHora || '00:00', dur, this.ausencias
    );
    const puede = (e: any) =>
      !!disponibles.some((d: any) => d.empleado_id === e.id && d.puede_atender);

    // Se incluye igual al que ya esta asignado: si no, al guardar un turno que
    // no se toco se perderia el empleado.
    this.empleadosReprogramar = this.empleados.filter(
      (e: any) => puede(e) || e.id === this.nuevoEmpleadoId
    );
    const elegido = this.empleados.find((e: any) => e.id === this.nuevoEmpleadoId);
    this.empleadoReprogramarNoPuede = !!elegido && !puede(elegido);
    this.cdr.detectChanges();
  }

  /** Sale del form de reprogramar limpiando todos los carteles. */
  salirDeEditarTurno() {
    this.modoEditarTurno = false;
    this.editandoTurno = false;
    this.errorEditarTurno = '';
    this.empleadoReprogramarNoPuede = false;
    this.empleadosReprogramar = this.empleados;
    this.cdr.detectChanges();
  }

  onFechaReprogramarChange() {
    this.errorEditarTurno = '';
    this.actualizarEmpleadosReprogramar();
  }

  getComisionEmpleadoServicio(empleadoId: number): number {
    if (!this.nuevoTurnoServicioId) return 0;
    const comision = this.comisionesPorServicio.find(
      (c: any) => c.empleado_id === empleadoId && c.servicio_id === this.nuevoTurnoServicioId
    );
    if (comision) return comision.porcentaje;
    const empleado = this.empleados.find((e: any) => e.id === empleadoId);
    return empleado?.comision_porcentaje || 0;
  }

  getComisionEmpleadoServicioReprogramar(empleadoId: number): number {
    if (!this.nuevoServicioId) return 0;
    const comision = this.comisionesPorServicio.find(
      (c: any) => c.empleado_id === empleadoId && c.servicio_id === this.nuevoServicioId
    );
    if (comision) return comision.porcentaje;
    const empleado = this.empleados.find((e: any) => e.id === empleadoId);
    return empleado?.comision_porcentaje || 0;
  }

  cerrarModalNuevoTurno() {
    this.mostrarModalNuevoTurno = false;
    this.cdr.detectChanges();
  }

  async guardarNuevoTurno() {
    this.errorNuevoTurno = '';
    if (!this.clienteSeleccionadoNuevo) {
      this.errorNuevoTurno = '❌ Seleccioná un cliente.';
      this.cdr.detectChanges();
      return;
    }
    if (!this.nuevoTurnoFecha) {
      this.errorNuevoTurno = '❌ Ingresá una fecha.';
      this.cdr.detectChanges();
      return;
    }
    if (!this.nuevoTurnoHora) {
      this.errorNuevoTurno = '❌ Ingresá una hora.';
      this.cdr.detectChanges();
      return;
    }
    if (!this.nuevoTurnoServicioId) {
      this.errorNuevoTurno = '❌ Seleccioná un servicio.';
      this.cdr.detectChanges();
      return;
    }

    const servicio = this.nuevoTurnoServicio;
    if (!servicio) return;

    this.guardandoNuevoTurno = true;

    try {
      // Calcular hora fin
      const fechaHora = new Date(`${this.nuevoTurnoFecha}T${this.nuevoTurnoHora}`);
      const fin = new Date(fechaHora);
      fin.setMinutes(fin.getMinutes() + servicio.duracion_minutos);
      const horaFin = `${String(fin.getHours()).padStart(2,'0')}:${String(fin.getMinutes()).padStart(2,'0')}`;

      // El empleado es OBLIGATORIO en la app. El modo "automático" (tomar el
      // primero libre) queda solo en el servicio, para el agente de WhatsApp.
      const empleadoId: number | null = this.nuevoTurnoEmpleadoId;
      if (!empleadoId) {
        this.errorNuevoTurno = '❌ Elegí el empleado que atiende.';
        this.guardandoNuevoTurno = false;
        this.cdr.detectChanges();
        return;
      }

      const nombreEmp = this.empleados.find((e: any) => e.id === empleadoId)?.nombre;

      // Jornada semanal + ausencias
      const puede = await this.supabase.empleadoPuedeAtender(
        empleadoId, this.nuevoTurnoFecha, this.nuevoTurnoHora,
        servicio.duracion_minutos, this.ausencias
      );
      if (!puede.ok) {
        this.errorNuevoTurno = `❌ ${nombreEmp || 'Ese empleado'}: ${puede.motivo}.`;
        this.guardandoNuevoTurno = false;
        this.cdr.detectChanges();
        return;
      }

      const ocupado = await this.supabase.empleadoEstaOcupado(
        empleadoId, this.nuevoTurnoFecha, this.nuevoTurnoHora, servicio.duracion_minutos, 0
      );
      if (ocupado) {
        this.errorNuevoTurno = `❌ ${nombreEmp || 'Ese empleado'} ya tiene un turno en ese horario.`;
        this.guardandoNuevoTurno = false;
        this.cdr.detectChanges();
        return;
      }

      // Validar horario de atención
      const diaISO = new Date(this.nuevoTurnoFecha + 'T12:00:00').getDay();
      const horariosDia = this.horarios.filter((hor: any) => hor.dia_semana === diaISO && hor.activo);
      const dentroHorario = horariosDia.some((hor: any) => {
        const horIni = this.toMinutos(hor.hora_inicio);
        const horFin = this.toMinutos(hor.hora_fin);
        return this.toMinutos(this.nuevoTurnoHora) >= horIni && this.toMinutos(horaFin) <= horFin;
      });
      if (!dentroHorario) {
        this.errorNuevoTurno = 'El horario está fuera del horario de atención.';
        this.guardandoNuevoTurno = false;
        this.cdr.detectChanges();
        return;
      }

      // Sin teléfono = NULL (la columna ya no es NOT NULL); '' sería un 3er estado.
      const telefono = this.clienteSeleccionadoNuevo.telefonos?.[0]?.telefono || null;

      await this.supabase.crearTurnoManual({
        cliente_id: this.clienteSeleccionadoNuevo.id,
        cliente_nombre: this.clienteSeleccionadoNuevo.nombre,
        cliente_telefono: telefono,
        fecha: this.nuevoTurnoFecha,
        hora: this.nuevoTurnoHora,
        hora_inicio: this.nuevoTurnoHora,
        hora_fin: horaFin,
        servicio_id: servicio.id,
        servicio_nombre: servicio.nombre,
        precio: servicio.precio,
        duracion_minutos: servicio.duracion_minutos,
        estado: 'pendiente',
        empleado_id: empleadoId
      });
      await this.cargarTurnos();
      await this.cargarComisionesPorServicio();
      this.cerrarModalNuevoTurno();
    } catch (e) {
      console.error('Error en guardarNuevoTurno:', e);
      this.errorNuevoTurno = '❌ Error al guardar. Intentá de nuevo.';
    }

    this.guardandoNuevoTurno = false;
  }

  async crearYSeleccionarCliente() {
    if (!this.nombreNuevoCliente.trim()) return;

    const nombreNorm = this.supabase.normalizarNombre(this.nombreNuevoCliente);

    const duplicado = await this.supabase.verificarNombreDuplicado(nombreNorm);
    if (duplicado) {
      this.errorNuevoTurno = '❌ Ya existe un cliente con ese nombre.';
      this.cdr.detectChanges();
      return;
    }

    try {
      const cliente = await this.supabase.crearCliente(nombreNorm);
      const nuevo = { ...cliente, telefonos: [], activo: true };
      // Se suma a la lista en memoria: como el buscador filtra contra ella, si no
      // el cliente recién creado no aparecería al buscarlo de nuevo hasta
      // recargar la página.
      this.todosLosClientes = [...this.todosLosClientes, nuevo]
        .sort((a: any, b: any) => a.nombre.localeCompare(b.nombre, 'es'));
      // El form inline se cierra ANTES de seleccionar. Al revés, `seleccionar`
      // dispara un detectChanges con el form todavía abierto y Angular lo
      // detecta como cambio en vivo (NG0100) en modo desarrollo.
      this.mostrarFormNuevoCliente = false;
      this.nombreNuevoCliente = '';
      this.seleccionarClienteNuevo(nuevo);
    } catch (e) {
      this.errorNuevoTurno = '❌ Error al crear el cliente.';
    }
  }

  async iniciarCancelacion() {
    if (this.turnoSeleccionado) {
      await this.supabase.updateEstadoTurno(this.turnoSeleccionado.id, 'cancelado');
      if (this.telefonoDe(this.turnoSeleccionado) &&
          confirm('¿Querés enviarle un mensaje de WhatsApp al cliente?')) {
        this.motivoCancelacion = '';
        this.mostrarPopupCancelacion = true;
      } else {
        this.cerrarPopupCancelacion();
        await this.cargarTurnos();
      }
    } else {
      this.cerrarPopupCancelacion();
      await this.cargarTurnos();
    }
    this.cdr.detectChanges();
  }

  async enviarMensajeCancelacion() {
    if (!this.telefonoDe(this.turnoSeleccionado)) return;
    this.enviandoMensaje = true;
    try {
      const fecha = this.formatearFecha(this.turnoSeleccionado.fecha);
      const hora = this.formatearHora(this.turnoSeleccionado.hora_inicio || this.turnoSeleccionado.hora);
      const mensaje = `Estimado cliente:\n\n📆 El turno del día *${fecha}* a las *${hora}* hs ha sido *cancelado* debido a ${this.motivoCancelacion}.\nLamentamos los inconvenientes causados.😔\n_(Si deseas reservar otro turno escribí *1* o *reservar*)_\n\nAtte. *${this.nombreNegocio}*`;
      await fetch('https://primary-production-4f919.up.railway.app/webhook/cancelacion-turno', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: this.telefonoDe(this.turnoSeleccionado),
          type: 'text',
          text: { body: mensaje }
        })
      });
    } catch (e) {
      console.error('Error enviando mensaje:', e);
    }
    this.enviandoMensaje = false;
    this.mostrarPopupCancelacion = false;
    this.cerrarPopup();
    await this.cargarTurnos();
    this.cdr.detectChanges();
  }

  cerrarPopupCancelacion() {
    this.mostrarPopupCancelacion = false;
    this.cerrarPopup();
  }

  async iniciarNotificacionPostergacion(nuevaFecha: string, nuevaHora: string, nuevoServicio: string) {
    const telefonoCliente = this.telefonoDe(this.turnoSeleccionado);
    if (!telefonoCliente) {
      this.cerrarPopup();
      await this.cargarTurnos();
    } else if (confirm('¿Querés enviarle un mensaje de WhatsApp al cliente?')) {
      this.motivoPostergacion = '';
      this._nuevaFechaPostergacion = nuevaFecha;
      this._nuevaHoraPostergacion = nuevaHora;
      this._nuevoServicioPostergacion = nuevoServicio;
      this.mostrarPopupPostergacion = true;
    } else {
      this.cerrarPopup();
      await this.cargarTurnos();
    }
    this.cdr.detectChanges();
  }

  async enviarMensajePostergacion() {
    this.enviandoMensajePostergacion = true;
    try {
      const fecha = this.formatearFecha(this._nuevaFechaPostergacion);
      const mensaje = `Estimado cliente:\n\n📆 Tu turno ha sido *reprogramado* para el día *${fecha}* a las *${this._nuevaHoraPostergacion}* hs (para un: *${this._nuevoServicioPostergacion}*).${this.motivoPostergacion ? this.motivoPostergacion + '.' : ''}\nLamentamos los inconvenientes causados.😔\n_(Si deseas consultar/cancelar tus turnos escribí *2* o *turnos*)_\n\nAtte. *${this.nombreNegocio}*`;
      await fetch('https://primary-production-4f919.up.railway.app/webhook/cancelacion-turno', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: this.telefonoDe(this.turnoSeleccionado),
          type: 'text',
          text: { body: mensaje }
        })
      });
    } catch (e) {
      console.error('Error enviando mensaje:', e);
    }
    this.enviandoMensajePostergacion = false;
    this.cerrarPopupPostergacion();
    await this.cargarTurnos();
    this.cdr.detectChanges();
  }

  cerrarPopupPostergacion() {
    this.mostrarPopupPostergacion = false;
    this.cerrarPopup();
  }
}