import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService } from '../../services/supabase';
import { AuthService, ROLES, Rol } from '../../services/auth';
import { paraComparar } from '../../utils/texto';

const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

@Component({
  selector: 'app-configuracion',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './configuracion.html',
  styleUrls: ['./configuracion.scss']
})
export class ConfiguracionComponent implements OnInit {

  // Acordeones
  // (acordeonPuestos se fue con la tabla `puestos`, migracion 011)
  acordeonDatos = true;
  acordeonHorarios = false;
  acordeonServicios = false;
  acordeonPassword = false;

  // ── PUESTOS DE TRABAJO: RETIRADO ────────────────────────────
  //
  // La agenda ya no usa puestos: cada columna es un EMPLEADO. La tabla
  // `puestos` se borra en la migracion 011, junto con esta seccion.
  //
  // Todo lo de abajo quedo comentado para poder consultarlo si hace falta.
  // Nota: dentro de los bloques comentados NO puede haber `*/` (cierra antes de
  // tiempo), por eso los JSDoc internos se pasaron a comentarios `//`.

  // Los 7 campos de la seccion de Puestos (puestos, empleadosActivos,
  // mensajePuestos, mensajeErrorPuestos, guardandoPuestos, mostrarFormPuesto,
  // nuevoPuesto) se eliminaron: el HTML los dejo de referenciar. Los metodos
  // quedaron comentados mas abajo, entre bloques /* */.

  // Puestos activos que tienen un empleado activo y por lo tanto se pueden agendar.
  // (RETIRADO con los puestos)
  /*
  get puestosAgendables(): number {
    return this.puestos.filter((p: any) => this.puestoAgendable(p)).length;
  }
  */

  /* RETIRADO con los puestos (ver bloque de metodos al final del archivo).
  puestoAgendable(p: any): boolean {
    if (!p?.activo) return false;
    if (!p.empleado_id) return false;
    if (p.empleado && p.empleado.activo === false) return false;
    return true;
  }

  // Empleados ya asignados a otro puesto (para no ofrecerlos dos veces).
  empleadoEnOtroPuesto(empleadoId: number, excluirPuestoId?: number): boolean {
    return this.puestos.some(
      (p: any) => p.empleado_id === empleadoId && p.activo && p.id !== excluirPuestoId
    );
  }

  // Nombre del empleado asignado al puesto (columna de solo lectura).
  nombreEmpleadoDePuesto(puesto: any): string {
    return puesto?.empleado?.nombre || '— Sin asignar —';
  }

  // Normaliza nombres para comparar: sin mayusculas, sin espacios de sobra.
  private normNombre(nombre: string): string {
    return (nombre || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  // Ya existe otro puesto con ese nombre? La base tambien lo bloquea (indice unico).
  nombrePuestoDuplicado(nombre: string, excluirPuestoId?: number): boolean {
    const n = this.normNombre(nombre);
    if (!n) return false;
    return this.puestos.some(
      (p: any) => p.id !== excluirPuestoId && this.normNombre(p.nombre) === n
    );
  }

  // Traduce errores de la base a algo entendible.
  private errorPuesto(e: any): string {
    const code = e?.code || '';
    const msg = String(e?.message || '');
    if (code === '23505' || /duplicate key|unique/i.test(msg)) {
      return '❌ Ya existe un puesto con ese nombre. Usá otro nombre.';
    }
    if (/row-level security/i.test(msg)) {
      return '❌ No tenés permiso para modificar los puestos.';
    }
    return `❌ ${msg || 'No se pudo guardar el puesto'}`;
  }

  get avisosPuestos(): string[] {
    const out: string[] = [];
    const sinGente = this.puestos.filter((p: any) => p.activo && !this.puestoAgendable(p));
    if (sinGente.length) {
      out.push(`${sinGente.length} de ${this.puestos.filter((p: any) => p.activo).length} puestos activos sin empleado: no se pueden agendar.`);
    }
    if (this.puestosAgendables === 0 && this.puestos.some((p: any) => p.activo)) {
      out.push('Ningún puesto tiene empleado asignado: no se pueden recibir turnos.');
    }
    return out;
  }
  */

  // Datos del negocio
  nombreNegocio = '';
  descripcion = '';
  editandoDatos = false;
  guardando = false;
  mensajeDatos = '';
  mensajeErrorDatos = '';
  horasLimiteCancelacion = 12;
  recordatorioCuando = 'dia_anterior';
  recordatorioHora = '08:00';

  // Días cerrados
  acordeonDiasCerrados = false;
  diasCerrados: any[] = [];
  nuevoDiaCerrado = { fecha: '', fecha_hasta: '', motivo: '' };
  mostrarFormDiaCerrado = false;
  mensajeDiasCerrados = '';
  mensajeErrorDiasCerrados = '';

  // Horarios
  horarios: any[] = [];
  diasSemana = DIAS_SEMANA;
  nuevoHorario = { dia_semana: 1, hora_inicio: '08:00', hora_fin: '12:00', activo: true };
  mostrarFormHorario = false;
  mensajeHorarios = '';
  mensajeErrorHorarios = '';

  // Servicios
  servicios: any[] = [];
  mostrarFormServicio = false;
  nuevoServicio: any = { nombre: '', precio: null, duracion_minutos: null, activo: true };
  mensajeServicios = '';
  mensajeErrorServicios = '';

  // Métodos de pago
  acordeonMetodosPago = false;
  metodosPago: any[] = [];
  mostrarFormMetodoPago = false;
  nuevoMetodoPago = { nombre: '', emoji: '' };
  mensajeMetodosPago = '';
  mensajeErrorMetodosPago = '';

  // Contraseña
  passwordActual = '';
  passwordNueva = '';
  passwordRepetir = '';
  guardandoPassword = false;
  mensajePassword = '';
  mensajeErrorPassword = '';

  constructor(
    private supabase: SupabaseService,
    private auth: AuthService,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    await this.cargarDatos();
    // La lista de usuarios se pide solo si esta pantalla la va a mostrar. El `*ngIf`
    // del template ya la esconde al secretario, pero `cargarDatos` corre siempre, y
    // pedirla igual seria una consulta que no se usa.
    if (this.puedeAdministrarUsuarios) await this.cargarUsuarios();
    this.cdr.detectChanges();
  }

  async cargarDatos() {
    const config = await this.supabase.getConfiguracion();
    this.nombreNegocio = config.find((c: any) => c.clave === 'nombre_negocio')?.valor || '';
    this.descripcion = config.find((c: any) => c.clave === 'descripcion')?.valor || '';

    this.horasLimiteCancelacion = parseInt(config.find((c: any) => c.clave === 'horas_limite_cancelacion')?.valor) || 12;
    this.recordatorioCuando = config.find((c: any) => c.clave === 'recordatorio_cuando')?.valor || 'dia_anterior';
    this.recordatorioHora = config.find((c: any) => c.clave === 'recordatorio_hora')?.valor || '08:00';
    this.diasCerrados = await this.supabase.getDiasCerrados();
    const horariosDB = await this.supabase.getHorarios();
    this.horarios = (horariosDB || []).map((h: any) => ({
      ...h,
      hora_inicio: h.hora_inicio?.slice(0, 5) || '',
      hora_fin: h.hora_fin?.slice(0, 5) || ''
    }));
    this.servicios = await this.supabase.getServicios();
    this.metodosPago = await this.supabase.getMetodosPago();
    this.cdr.detectChanges();
  }

  // ── PUESTOS DE TRABAJO: RETIRADO ────────────────────────────
  //
  // Seccion completa comentada. La agenda ya no usa puestos: cada columna es
  // un EMPLEADO. Los empleados se administran en la pantalla Empleados y los
  // servicios/metodos/horarios/dias cerrados siguen abajo sin cambios.
  //
  // La tabla `puestos` se borra en la migracion 011.
  //
  /*
  async cargarPuestos() {
    this.puestos = await this.supabase.getPuestos();
    this.empleadosActivos = await this.supabase.getEmpleados();
    this.cdr.detectChanges();
  }

  async agregarPuesto() {
    if (this.guardandoPuestos) return;
    this.mensajeErrorPuestos = '';
    this.mensajePuestos = '';
    const nombre = (this.nuevoPuesto.nombre || '').trim();
    if (!nombre) {
      this.mensajeErrorPuestos = '❌ Ingresá un nombre.';
      this.cdr.detectChanges();
      return;
    }
    if (this.nombrePuestoDuplicado(nombre)) {
      this.mensajeErrorPuestos = `❌ Ya existe un puesto llamado "${nombre}".`;
      this.cdr.detectChanges();
      return;
    }
    const empId = this.nuevoPuesto.empleado_id ? Number(this.nuevoPuesto.empleado_id) : null;
    if (empId && this.empleadoEnOtroPuesto(empId)) {
      this.mensajeErrorPuestos = '❌ Ese empleado ya está asignado a otro puesto.';
      this.cdr.detectChanges();
      return;
    }
    this.guardandoPuestos = true;
    this.cdr.detectChanges();
    try {
      await this.supabase.crearPuesto({
        nombre,
        empleado_id: empId,
        orden: this.puestos.length,
      });
      this.nuevoPuesto = { nombre: '', empleado_id: null };
      this.mostrarFormPuesto = false;
      await this.cargarPuestos();
      this.mostrarMensaje(`✅ "${nombre}" agregado.`, 'puestos');
    } catch (e: any) {
      this.mensajeErrorPuestos = this.errorPuesto(e);
    } finally {
      this.guardandoPuestos = false;
      this.cdr.detectChanges();
    }
  }

  async togglePuesto(puesto: any) {
    if (puesto.guardando) return;
    this.mensajeErrorPuestos = '';
    try {
      const nuevoActivo = !puesto.activo;
      // Al activar sin empleado sigue visible pero no agendable.
      await this.supabase.actualizarPuesto(puesto.id, {
        activo: nuevoActivo,
        empleado_id: nuevoActivo ? puesto.empleado_id : null,
      });
      await this.cargarPuestos();
      this.mostrarMensaje(nuevoActivo ? '✅ Puesto activado.' : '✅ Puesto desactivado.', 'puestos');
    } catch (e: any) {
      this.mensajeErrorPuestos = `❌ ${e.message || 'Error'}`;
    }
  }

  cancelarPuesto(puesto: any) {
    puesto.nombre = puesto._nombreOrig ?? puesto.nombre;
    puesto.empleado_id = puesto._empleadoOrig ?? puesto.empleado_id;
    puesto.editando = false;
    this.mensajeErrorPuestos = '';
  }

  // Baja logica: el puesto se desactiva, no se borra (preserva el historico).
  async eliminarPuesto(puesto: any) {
    if (!confirm(
      `¿Desactivar "${puesto.nombre}"?\n\nNo se borra: los turnos que ya lo usaron siguen guardados. ` +
      `Lo podés volver a activar cuando quieras.`
    )) return;
    this.mensajeErrorPuestos = '';
    try {
      await this.supabase.desactivarPuesto(puesto.id);
      await this.cargarPuestos();
      this.mostrarMensaje('✅ Puesto desactivado.', 'puestos');
    } catch (e: any) {
      this.mensajeErrorPuestos = `❌ ${e.message || 'Error'}`;
    }
  }

  async guardarPuesto(puesto: any) {
    if (puesto.guardando) return;   // evita el doble envio del mismo click
    this.mensajeErrorPuestos = '';
    this.mensajePuestos = '';

    const nombre = (puesto.nombre || '').trim();
    if (!nombre) {
      this.mensajeErrorPuestos = '❌ El puesto necesita un nombre.';
      this.cdr.detectChanges();
      return;
    }
    if (this.nombrePuestoDuplicado(nombre, puesto.id)) {
      this.mensajeErrorPuestos = `❌ Ya existe un puesto llamado "${nombre}".`;
      this.cdr.detectChanges();
      return;
    }
    if (puesto.empleado_id && this.empleadoEnOtroPuesto(puesto.empleado_id, puesto.id)) {
      this.mensajeErrorPuestos = '❌ Ese empleado ya está asignado a otro puesto.';
      this.cdr.detectChanges();
      return;
    }

    puesto.guardando = true;
    this.cdr.detectChanges();
    try {
      await this.supabase.actualizarPuesto(puesto.id, {
        nombre,
        empleado_id: puesto.empleado_id ? Number(puesto.empleado_id) : null,
      });
      puesto.editando = false;
      puesto.guardando = false;
      // El guardado ya esta: si falla la recarga no se pierde el cambio.
      try { await this.cargarPuestos(); } catch { }   // si falla la recarga, no se pierde el cambio
      this.mostrarMensaje(`✅ "${nombre}" guardado.`, 'puestos');
    } catch (e: any) {
      puesto.guardando = false;
      this.mensajeErrorPuestos = this.errorPuesto(e);
      this.cdr.detectChanges();
    }
  }
  */

  // ── DATOS DEL NEGOCIO ──────────────────────────────────────

  async guardarConfiguracion() {
    this.mensajeDatos = '';
    if (this.horasLimiteCancelacion < 1 || this.horasLimiteCancelacion > 48 || !Number.isInteger(this.horasLimiteCancelacion)) {
      this.mensajeErrorDatos = '❌ El límite de cancelación debe ser entre 1 y 48 horas.';
      this.cdr.detectChanges();
      return;
    }
    this.guardando = true;
    try {
      await this.supabase.upsertConfiguracion('nombre_negocio', this.nombreNegocio);
      await this.supabase.upsertConfiguracion('descripcion', this.descripcion);
      await this.supabase.upsertConfiguracion('horas_limite_cancelacion', String(this.horasLimiteCancelacion));
      await this.supabase.upsertConfiguracion('recordatorio_cuando', this.recordatorioCuando);
      await this.supabase.upsertConfiguracion('recordatorio_hora', this.recordatorioHora);
      this.editandoDatos = false;
      this.mostrarMensaje('✅ Configuración guardada.', 'datos');
    } catch (e) {
      this.mensajeErrorDatos = '❌ Error al guardar.';
    }
    this.guardando = false;
    this.cdr.detectChanges();
  }

  async cancelarConfiguracion() {
    await this.cargarDatos();
    this.editandoDatos = false;
    this.mensajeErrorDatos = '';
  }

  // ── DIAS CERRADOS ──────────────────────────────────────

  async agregarDiaCerrado() {
    this.mensajeErrorDiasCerrados = '';
    if (!this.nuevoDiaCerrado.fecha) {
      this.mensajeErrorDiasCerrados = '❌ Seleccioná una fecha.';
      this.cdr.detectChanges();
      return;
    }
    if (this.nuevoDiaCerrado.fecha_hasta && this.nuevoDiaCerrado.fecha_hasta < this.nuevoDiaCerrado.fecha) {
      this.mensajeErrorDiasCerrados = '❌ La fecha hasta debe ser mayor que la fecha desde.';
      this.cdr.detectChanges();
      return;
    }
    try {
      const nuevo = await this.supabase.createDiasCerrados(
        this.nuevoDiaCerrado.fecha,
        this.nuevoDiaCerrado.fecha_hasta || null,
        this.nuevoDiaCerrado.motivo
      );
      this.diasCerrados.push(nuevo);
      this.diasCerrados.sort((a, b) => a.fecha.localeCompare(b.fecha));
      this.mostrarFormDiaCerrado = false;
      this.nuevoDiaCerrado = { fecha: '', fecha_hasta: '', motivo: '' };
      this.mostrarMensaje('✅ Día/período de cierre agregado.', 'diasCerrados');
    } catch (e) {
      this.mensajeErrorDiasCerrados = '❌ Error al agregar.';
      this.cdr.detectChanges();
    }
  }

  async eliminarDiaCerrado(id: number) {
    if (!confirm('¿Eliminar este día/período de cierre?')) return;
    try {
      await this.supabase.deleteDiasCerrados(id);
      this.diasCerrados = this.diasCerrados.filter(d => d.id !== id);
      this.cdr.detectChanges();
    } catch (e) {
      this.mensajeErrorDiasCerrados = '❌ Error al eliminar.';
      this.cdr.detectChanges();
    }
  }

  async guardarDiaCerrado(dia: any) {
    if (dia.guardando) return;
    this.mensajeErrorDiasCerrados = '';
    if (!dia.fecha) {
      this.mensajeErrorDiasCerrados = '❌ La fecha es obligatoria.';
      this.cdr.detectChanges();
      return;
    }
    if (dia.fecha_hasta && dia.fecha_hasta < dia.fecha) {
      this.mensajeErrorDiasCerrados = '❌ La fecha hasta debe ser mayor que la fecha desde.';
      this.cdr.detectChanges();
      return;
    }
    dia.guardando = true;
    this.cdr.detectChanges();
    try {
      await this.supabase.updateDiasCerrados(dia.id, dia.fecha, dia.fecha_hasta || null, dia.motivo);
      dia.editando = false;
      dia.guardando = false;
      this.mostrarMensaje('✅ Día/período actualizado.', 'diasCerrados');
    } catch (e) {
      dia.guardando = false;
      this.mensajeErrorDiasCerrados = '❌ Error al actualizar.';
      this.cdr.detectChanges();
    }
  }

  cancelarDiaCerrado(dia: any) {
    dia.fecha = dia._fecha_orig;
    dia.fecha_hasta = dia._fecha_hasta_orig;
    dia.motivo = dia._motivo_orig;
    dia.editando = false;
    this.mensajeErrorDiasCerrados = '';
  }

  esDiaVencido(dia: any): boolean {
    const hoy = new Date().toLocaleDateString('en-CA');
    const fechaFin = dia.fecha_hasta || dia.fecha;
    return fechaFin < hoy;
  }

  formatearFechaStr(fecha: string): string {
    if (!fecha) return '';
    const [y, m, d] = fecha.split('-');
    return `${d}/${m}/${y}`;
  }

  // ── HORARIOS ───────────────────────────────────────────────

  private aMinutos(horaStr: string): number {
    if (!horaStr) return 0;
    const parts = horaStr.split(':');
    return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
  }

  async toggleHorario(horario: any) {
    if (horario.guardando) return;   // dos clicks rapidos = el ! se aplicaba dos veces
    this.mensajeErrorHorarios = '';
    const nuevoEstado = !horario.activo;
    if (nuevoEstado) {
      if (this.seSuperpone({ ...horario, activo: true }, this.horarios)) {
        this.mensajeErrorHorarios = '⚠️ No se puede activar porque se superpone con otro horario activo.';
        this.cdr.detectChanges();
        return;
      }
    }
    horario.guardando = true;
    horario.activo = nuevoEstado;
    this.cdr.detectChanges();
    try {
      await this.supabase.updateHorario(horario.id, { activo: horario.activo });
    } catch (e) {
      horario.activo = !nuevoEstado;   // revertir para no mentirle al usuario
      this.mensajeErrorHorarios = '❌ No se pudo actualizar.';
    } finally {
      horario.guardando = false;
      this.cdr.detectChanges();
    }
  }

  toggleFormHorario() {
    this.mostrarFormHorario = !this.mostrarFormHorario;
    this.mensajeErrorHorarios = '';
    if (!this.mostrarFormHorario) {
      this.nuevoHorario = { dia_semana: 1, hora_inicio: '08:00', hora_fin: '12:00', activo: true };
    }
  }

  async guardarHorario(horario: any) {
    if (horario.guardando) return;
    this.mensajeErrorHorarios = '';
    if (!this.validarHorario(horario.hora_inicio, horario.hora_fin)) {
      this.mensajeErrorHorarios = '❌ La hora de inicio debe ser menor que la hora de fin.';
      this.cdr.detectChanges();
      return;
    }
    horario.guardando = true;
    this.cdr.detectChanges();
    try {
      const horariosDB = await this.supabase.getHorarios();
      if (this.seSuperpone(horario, horariosDB)) {
        horario.guardando = false;
        this.mensajeErrorHorarios = '⚠️ El rango horario se superpone con otro activo existente.';
        this.cdr.detectChanges();
        return;
      }

      const horaInicioNorm = horario.hora_inicio.slice(0, 5);
      const horaFinNorm = horario.hora_fin.slice(0, 5);

      await this.supabase.updateHorario(horario.id, {
        hora_inicio: horaInicioNorm,
        hora_fin: horaFinNorm,
        activo: horario.activo
      });
      horario.hora_inicio = horaInicioNorm;
      horario.hora_fin = horaFinNorm;
      horario.editando = false;
      horario.guardando = false;
      this.mostrarMensaje('✅ Horario actualizado.', 'horarios');
    } catch (e) {
      horario.guardando = false;
      this.mensajeErrorHorarios = '❌ Error al actualizar el horario.';
      this.cdr.detectChanges();
    }
  }

  async eliminarHorario(id: number) {
    if (!confirm('¿Eliminar este horario?')) return;
    await this.supabase.deleteHorario(id);
    this.horarios = this.horarios.filter(h => h.id !== id);
    this.cdr.detectChanges();
  }

  async agregarHorario() {
    this.mensajeErrorHorarios = '';
    if (!this.validarHorario(this.nuevoHorario.hora_inicio, this.nuevoHorario.hora_fin)) {
      this.mensajeErrorHorarios = '❌ La hora de inicio debe ser menor que la hora de fin.';
      this.cdr.detectChanges();
      return;
    }
    try {
      const horariosDB = await this.supabase.getHorarios();
      if (this.seSuperpone(this.nuevoHorario, horariosDB)) {
        this.mensajeErrorHorarios = '⚠️ El rango horario se superpone con otro activo existente.';
        this.cdr.detectChanges();
        return;
      }

      const nuevo = await this.supabase.createHorario({
        ...this.nuevoHorario,
        hora_inicio: this.nuevoHorario.hora_inicio.slice(0, 5),
        hora_fin: this.nuevoHorario.hora_fin.slice(0, 5)
      });
      this.horarios.push({
        ...nuevo,
        hora_inicio: nuevo.hora_inicio?.slice(0, 5) || this.nuevoHorario.hora_inicio.slice(0, 5),
        hora_fin: nuevo.hora_fin?.slice(0, 5) || this.nuevoHorario.hora_fin.slice(0, 5)
      });
      this.mostrarFormHorario = false;
      this.nuevoHorario = { dia_semana: 1, hora_inicio: '08:00', hora_fin: '12:00', activo: true };
      this.mostrarMensaje('✅ Horario agregado.', 'horarios');
    } catch (e) {
      this.mensajeErrorHorarios = '❌ Error al agregar el horario.';
      this.cdr.detectChanges();
    }
  }

  getNombreDia(num: number): string {
    return DIAS_SEMANA[num] || '';
  }

  validarHorario(inicio: string, fin: string): boolean {
    if (!inicio || !fin) return false;
    return this.aMinutos(inicio) < this.aMinutos(fin);
  }

  cancelarHorario(horario: any) {
    horario.hora_inicio = horario._hora_inicio_orig;
    horario.hora_fin = horario._hora_fin_orig;
    horario.editando = false;
    this.mensajeErrorHorarios = '';
  }

  seSuperpone(horario: any, otros: any[]): boolean {
    if (!horario.activo) return false;
    const ini = this.aMinutos(horario.hora_inicio);
    const fin = this.aMinutos(horario.hora_fin);
    return otros.some(h =>
      Number(h.dia_semana) === Number(horario.dia_semana) &&
      h.id !== horario.id &&
      Boolean(h.activo) &&
      ini < this.aMinutos(h.hora_fin) &&
      fin > this.aMinutos(h.hora_inicio)
    );
  }

  // ── SERVICIOS ──────────────────────────────────────────────

  async guardarServicio(servicio: any) {
    if (servicio.guardando) return;
    this.mensajeErrorServicios = '';
    servicio.guardando = true;
    this.cdr.detectChanges();
    try {
      const servicios = await this.supabase.getServicios();
      // `paraComparar` y no `trim().toLowerCase()`: con trim solo, "Lavado
      //  Simple" (doble espacio) pasaba como un servicio NUEVO y quedaban dos
      // filas que en pantalla se ven idénticas.
      const exist = servicios.some(
        (s: any) =>
          paraComparar(s.nombre) === paraComparar(servicio.nombre) &&
          s.id !== servicio.id
      );

      if (exist) {
        servicio.guardando = false;
        this.mensajeErrorServicios = '⚠️ Ya existe un servicio con ese nombre.';
        this.cdr.detectChanges();
        return;
      }

      await this.supabase.updateServicio(servicio.id, {
        nombre: servicio.nombre,
        precio: servicio.precio,
        duracion_minutos: servicio.duracion_minutos,
        activo: servicio.activo
      });
      servicio.editando = false;
      servicio.guardando = false;
      this.mostrarMensaje('✅ Servicio actualizado.', 'servicios');
    } catch (e) {
      servicio.guardando = false;
      this.mensajeErrorServicios = '❌ Error al actualizar el servicio.';
      this.cdr.detectChanges();
    }
  }

  async toggleServicio(servicio: any) {
    if (servicio.guardando) return;
    const nuevoEstado = !servicio.activo;
    servicio.guardando = true;
    servicio.activo = nuevoEstado;
    this.cdr.detectChanges();
    try {
      await this.supabase.updateServicio(servicio.id, { activo: nuevoEstado });
    } catch (e) {
      servicio.activo = !nuevoEstado;
      this.mensajeErrorServicios = '❌ No se pudo actualizar.';
    } finally {
      servicio.guardando = false;
      this.cdr.detectChanges();
    }
  }

  toggleFormServicio() {
    this.mostrarFormServicio = !this.mostrarFormServicio;
    this.mensajeErrorServicios = '';
    if (!this.mostrarFormServicio) {
      this.nuevoServicio = { nombre: '', precio: null, duracion_minutos: null, activo: true };
    }
  }

  async agregarServicio() {
    this.mensajeErrorServicios = '';
    if (!this.nuevoServicio.nombre || !this.nuevoServicio.precio || !this.nuevoServicio.duracion_minutos) {
      this.mensajeErrorServicios = '❌ Completá todos los campos.';
      this.cdr.detectChanges();
      return;
    }
    try {
      const servicios = await this.supabase.getServicios();
      const exist = servicios.some(
        (s: any) =>
          paraComparar(s.nombre) === paraComparar(this.nuevoServicio.nombre) &&
          s.id !== this.nuevoServicio.id
      );

      if (exist) {
        this.mensajeErrorServicios = '⚠️ Ya existe un servicio con ese nombre.';
        this.cdr.detectChanges();
        return;
      }
      const nuevo = await this.supabase.createServicio(this.nuevoServicio);
      this.servicios.push(nuevo);
      this.mostrarFormServicio = false;
      this.nuevoServicio = { nombre: '', precio: null, duracion_minutos: null, activo: true };
      this.mostrarMensaje('✅ Servicio agregado.', 'servicios');
    } catch (e) {
      this.mensajeErrorServicios = '❌ Error al agregar el servicio.';
      this.cdr.detectChanges();
    }
  }

  async eliminarServicio(id: number) {
    if (!confirm('¿Eliminar este servicio? Esta acción no se puede deshacer.')) return;
    try {
      await this.supabase.deleteServicio(id);
      this.servicios = this.servicios.filter(s => s.id !== id);
      this.mostrarMensaje('✅ Servicio eliminado.', 'servicios');
    } catch (e) {
      this.mensajeErrorServicios = '❌ Error al eliminar. Puede tener turnos asociados.';
      this.cdr.detectChanges();
    }
  }

  cancelarServicio(servicio: any) {
    servicio.nombre = servicio._nombre_orig;
    servicio.precio = servicio._precio_orig;
    servicio.duracion_minutos = servicio._duracion_orig;
    servicio.editando = false;
    this.mensajeErrorServicios = '';
  }

  // ── METODOS DE PAGO ───────────────────────────────────────

  async agregarMetodoPago() {
    this.mensajeErrorMetodosPago = '';
    if (!this.nuevoMetodoPago.nombre.trim()) {
      this.mensajeErrorMetodosPago = '❌ El nombre es obligatorio.';
      this.cdr.detectChanges();
      return;
    }
    try {
      const nuevo = await this.supabase.createMetodoPago(
        this.nuevoMetodoPago.nombre.trim(),
        this.nuevoMetodoPago.emoji.trim()
      );
      this.metodosPago.push(nuevo);
      this.mostrarFormMetodoPago = false;
      this.nuevoMetodoPago = { nombre: '', emoji: '' };
      this.mostrarMensaje('✅ Método de pago agregado.', 'metodosPago');
    } catch (e) {
      this.mensajeErrorMetodosPago = '❌ Error al agregar.';
      this.cdr.detectChanges();
    }
  }

  async guardarMetodoPago(metodo: any) {
    if (metodo.guardando) return;
    metodo.guardando = true;
    this.cdr.detectChanges();
    try {
      await this.supabase.updateMetodoPago(metodo.id, {
        nombre: metodo.nombre,
        emoji: metodo.emoji,
        activo: metodo.activo
      });
      metodo.editando = false;
      metodo.guardando = false;
      this.mostrarMensaje('✅ Método actualizado.', 'metodosPago');
    } catch (e) {
      metodo.guardando = false;
      this.mensajeErrorMetodosPago = '❌ Error al actualizar.';
      this.cdr.detectChanges();
    }
  }

  cancelarMetodoPago(metodo: any) {
    metodo.nombre = metodo._nombre_orig;
    metodo.emoji = metodo._emoji_orig;
    metodo.editando = false;
    this.mensajeErrorMetodosPago = '';
  }

  async toggleMetodoPago(metodo: any) {
    if (metodo.guardando) return;
    const nuevoEstado = !metodo.activo;
    metodo.guardando = true;
    metodo.activo = nuevoEstado;
    this.cdr.detectChanges();
    try {
      await this.supabase.updateMetodoPago(metodo.id, { activo: nuevoEstado });
    } catch (e) {
      metodo.activo = !nuevoEstado;
      this.mensajeErrorMetodosPago = '❌ No se pudo actualizar.';
    } finally {
      metodo.guardando = false;
      this.cdr.detectChanges();
    }
  }

  async eliminarMetodoPago(id: number) {
    if (!confirm('¿Eliminar este método de pago?')) return;
    try {
      await this.supabase.deleteMetodoPago(id);
      this.metodosPago = this.metodosPago.filter(m => m.id !== id);
      this.cdr.detectChanges();
    } catch (e) {
      this.mensajeErrorMetodosPago = '❌ Error al eliminar.';
      this.cdr.detectChanges();
    }
  }

  // ── CONTRASEÑA ─────────────────────────────────────────────

  get cambiosHoy(): number {
    const hoy = new Date().toLocaleDateString('en-CA');
    const stored = localStorage.getItem('pwd_cambios');
    if (!stored) return 0;
    const parsed = JSON.parse(stored);
    return parsed.fecha === hoy ? parsed.count : 0;
  }

  registrarCambioPassword() {
    const hoy = new Date().toLocaleDateString('en-CA');
    const count = this.cambiosHoy + 1;
    localStorage.setItem('pwd_cambios', JSON.stringify({ fecha: hoy, count }));
  }

  async cambiarPassword() {
    this.mensajePassword = '';
    this.mensajeErrorPassword = '';

    if (this.cambiosHoy >= 2) {
      this.mensajeErrorPassword = '❌ Ya cambiaste la contraseña 2 veces hoy. Intentá mañana.';
      this.cdr.detectChanges();
      return;
    }
    if (!this.passwordActual || !this.passwordNueva || !this.passwordRepetir) {
      this.mensajeErrorPassword = '❌ Completá todos los campos.';
      this.cdr.detectChanges();
      return;
    }
    if (this.passwordNueva !== this.passwordRepetir) {
      this.mensajeErrorPassword = '❌ La nueva contraseña no coincide.';
      this.cdr.detectChanges();
      return;
    }
    if (this.passwordNueva.length < 6) {
      this.mensajeErrorPassword = '❌ La contraseña debe tener al menos 6 caracteres.';
      this.cdr.detectChanges();
      return;
    }

    this.guardandoPassword = true;
    try {
      const hashActual = await this.auth.sha256(this.passwordActual);
      const usuario = this.auth.getUsuario();
      const ok = await this.supabase.verificarUsuario(usuario, hashActual);
      if (!ok) {
        this.mensajeErrorPassword = '❌ La contraseña actual es incorrecta.';
        this.guardandoPassword = false;
        this.cdr.detectChanges();
        return;
      }
      const hashNueva = await this.auth.sha256(this.passwordNueva);
      await this.supabase.cambiarPassword(usuario, hashNueva);
      this.registrarCambioPassword();
      this.passwordActual = '';
      this.passwordNueva = '';
      this.passwordRepetir = '';
      // Siempre queda 1: esta linea solo se alcanza cuando `cambiosHoy` es 0 o
      // 1 (con 2 ya se bloquea arriba). El mensaje era "Te quedan 1 cambio(s)",
      // a medio hacer. No hay rama plural porque no hay caso que la alcance.
      this.mensajePassword = '✅ Contraseña cambiada. Te queda 1 cambio hoy.';
      setTimeout(() => { this.mensajePassword = ''; this.cdr.detectChanges(); }, 3000);
    } catch (e) {
      this.mensajeErrorPassword = '❌ Error al cambiar la contraseña.';
    }
    this.guardandoPassword = false;
    this.cdr.detectChanges();
  }

  // ── UTILS ──────────────────────────────────────────────────

  // La rama 'puestos' se elimino junto con la seccion (migracion 011). Si alguna
  // vez vuelve a hacer falta, hay que reponer tambien mensajePuestos y
  // mensajeErrorPuestos, que se fueron con ella.
  mostrarMensaje(msg: string, seccion: 'datos' | 'horarios' | 'servicios' | 'diasCerrados' | 'metodosPago') {
    if (seccion === 'datos') { this.mensajeDatos = msg; this.mensajeErrorDatos = ''; }
    else if (seccion === 'horarios') { this.mensajeHorarios = msg; this.mensajeErrorHorarios = ''; }
    else if (seccion === 'servicios') { this.mensajeServicios = msg; this.mensajeErrorServicios = ''; }
    else if (seccion === 'diasCerrados') { this.mensajeDiasCerrados = msg; this.mensajeErrorDiasCerrados = ''; }
    else { this.mensajeMetodosPago = msg; this.mensajeErrorMetodosPago = ''; }
    this.cdr.detectChanges();
    setTimeout(() => {
      if (seccion === 'datos') this.mensajeDatos = '';
      else if (seccion === 'horarios') this.mensajeHorarios = '';
      else if (seccion === 'servicios') this.mensajeServicios = '';
      else if (seccion === 'diasCerrados') this.mensajeDiasCerrados = '';
      else this.mensajeMetodosPago = '';
      this.cdr.detectChanges();
    }, 3000);
  }

// ═══════════════════════════════════════════════════════════════════════════
  // USUARIOS
  //
  // Lo unico de toda la pantalla que NO es del secretario. Aca se cambia el rol de
  // una persona, asi que si el secretario pudiera entrar, se pasaria a admin a si
  // mismo: dejaria de ser un permiso y pasaria a ser una puerta.
  // ═══════════════════════════════════════════════════════════════════════════

  acordeonUsuarios = false;
  usuarios: any[] = [];
  rolesDisponibles = ROLES;
  empleadosDisponibles: any[] = [];

  mostrarFormUsuario = false;
  nuevoUsuario = { usuario: '', password: '', rol: 'secretario' as Rol, empleado_id: null as number | null };
  mensajeUsuarios = '';
  mensajeErrorUsuarios = '';

  // El popup de contraseña.
  usuarioEditandoPassword: any = null;
  passwordDeOtroNueva = '';
  passwordDeOtroRepetir = '';

  /** El usuario con el que se entro. Para no dejar que se borre a si mismo. */
  get miUsuario(): string {
    return this.auth.getUsuario();
  }

  get puedeAdministrarUsuarios(): boolean {
    return this.auth.puedeAdministrarUsuarios();
  }

  /** Que puede hacer el rol, en una linea, para el formulario de alta. */
  descripcionDeRol(rol: string): string {
    return ROLES.find((r) => r.clave === rol)?.quePuede || '';
  }

  async cargarUsuarios() {
    // Los empleados se piden acá y no una vez sola en `ngOnInit`: la pantalla de
    // empleados puede cambiar de una sesion a otra (el admin da de alta a alguien y
    // recarga), y la lista de "empleado vinculado" quedaria con un nombre viejo.
    this.empleadosDisponibles = await this.supabase.getEmpleados();
    this.usuarios = await this.supabase.getUsuarios();
  }

  abrirFormUsuario() {
    this.mostrarFormUsuario = !this.mostrarFormUsuario;
    this.mensajeUsuarios = '';
    this.mensajeErrorUsuarios = '';
    if (this.mostrarFormUsuario) {
      this.nuevoUsuario = { usuario: '', password: '', rol: 'secretario', empleado_id: null };
    }
  }

  async guardarUsuario() {
    this.mensajeUsuarios = '';
    this.mensajeErrorUsuarios = '';

    const nombre = (this.nuevoUsuario.usuario || '').trim();
    const clave = this.nuevoUsuario.password || '';

    if (!nombre) { this.mensajeErrorUsuarios = '❌ Escribí el nombre de usuario.'; return; }
    if (nombre.length < 3) {
      this.mensajeErrorUsuarios = '❌ El usuario necesita al menos 3 caracteres.';
      return;
    }
    if (clave.length < 6) { this.mensajeErrorUsuarios = '❌ La contraseña necesita al menos 6 caracteres.'; return; }

    // El nombre se compara sin mayusculas y sin espacios, igual que el indice unico de
    // otras tablas. Si no, "Pamela" y "pamela" se guardan como dos cuentas y la que
    // entra primero es la que gana.
    if (this.usuarios.some((u: any) => paraComparar(u.usuario) === paraComparar(nombre))) {
      this.mensajeErrorUsuarios = '❌ Ya existe un usuario con ese nombre.';
      return;
    }

    // El vinculo con un empleado es de uno a uno. El indice unico de la base lo
    // rechaza igual, pero avisar aca es mejor que un error de Postgres.
    const empId = this.nuevoUsuario.empleado_id;
    if (empId !== null && this.usuarios.some((u: any) => u.empleado_id !== null && Number(u.empleado_id) === Number(empId))) {
      this.mensajeErrorUsuarios = '❌ Ese empleado ya está vinculado a otro usuario.';
      return;
    }

    try {
      await this.supabase.crearUsuario({
        usuario: nombre,
        password_hash: await this.auth.sha256(clave),
        rol: this.nuevoUsuario.rol,
        empleado_id: empId,
      });
      await this.cargarUsuarios();
      this.mostrarFormUsuario = false;
      this.mensajeUsuarios = `✅ Usuario "${nombre}" creado.`;
    } catch (e: any) {
      this.mensajeErrorUsuarios = '❌ ' + (e?.message || 'No se pudo crear el usuario.');
    }
    this.cdr.detectChanges();
  }

  editarUsuario(u: any) {
    this.mensajeUsuarios = '';
    this.mensajeErrorUsuarios = '';
    u._orig = { usuario: u.usuario, rol: u.rol, empleado_id: u.empleado_id };
    u.editando = true;
  }

  cancelarEdicionUsuario(u: any) {
    if (u._orig) Object.assign(u, u._orig);
    u.editando = false;
    this.mensajeErrorUsuarios = '';
  }

  async guardarEdicionUsuario(u: any) {
    this.mensajeUsuarios = '';
    this.mensajeErrorUsuarios = '';

    const nombre = (u.usuario || '').trim();
    if (!nombre) { this.mensajeErrorUsuarios = '❌ El nombre de usuario no puede quedar vacío.'; return; }
    if (nombre.length < 3) { this.mensajeErrorUsuarios = '❌ El usuario necesita al menos 3 caracteres.'; return; }

    if (this.usuarios.some((x: any) => x.id !== u.id && paraComparar(x.usuario) === paraComparar(nombre))) {
      this.mensajeErrorUsuarios = '❌ Ya existe otro usuario con ese nombre.';
      return;
    }

    if (u.empleado_id !== null && this.usuarios.some((x: any) => x.id !== u.id && x.empleado_id !== null && Number(x.empleado_id) === Number(u.empleado_id))) {
      this.mensajeErrorUsuarios = '❌ Ese empleado ya está vinculado a otro usuario.';
      return;
    }

    u.guardando = true;
    try {
      await this.supabase.actualizarUsuario(u.id, {
        usuario: nombre,
        rol: u.rol,
        empleado_id: u.empleado_id,
      });
      await this.cargarUsuarios();
      this.mensajeUsuarios = `✅ Usuario "${nombre}" actualizado.`;
    } catch (e: any) {
      this.mensajeErrorUsuarios = '❌ ' + (e?.message || 'No se pudo guardar.');
      u.guardando = false;
    }
    this.cdr.detectChanges();
  }

  pedirNuevaPassword(u: any) {
    this.usuarioEditandoPassword = u;
    this.passwordDeOtroNueva = '';
    this.passwordDeOtroRepetir = '';
    this.mensajeErrorUsuarios = '';
  }

  cerrarPassword() {
    this.usuarioEditandoPassword = null;
    this.passwordDeOtroNueva = '';
    this.passwordDeOtroRepetir = '';
    this.mensajeErrorUsuarios = '';
  }

  async guardarPassword() {
    this.mensajeErrorUsuarios = '';
    if (this.passwordDeOtroNueva.length < 6) {
      this.mensajeErrorUsuarios = '❌ La contraseña necesita al menos 6 caracteres.';
      return;
    }
    if (this.passwordDeOtroNueva !== this.passwordDeOtroRepetir) {
      this.mensajeErrorUsuarios = '❌ Las dos contraseñas no coinciden.';
      return;
    }
    const u = this.usuarioEditandoPassword;
    if (!u) return;
    try {
      await this.supabase.actualizarUsuario(u.id, { password_hash: await this.auth.sha256(this.passwordDeOtroNueva) });
      const nombre = u.usuario;
      this.cerrarPassword();
      this.mensajeUsuarios = `✅ Contraseña de "${nombre}" cambiada. Avisale a la persona.`;
    } catch (e: any) {
      this.mensajeErrorUsuarios = '❌ ' + (e?.message || 'No se pudo cambiar la contraseña.');
    }
    this.cdr.detectChanges();
  }

  async eliminarUsuario(u: any) {
    // `confirm()` nativo, como el resto de la app.
    if (!confirm(`¿Borrar el usuario "${u.usuario}"? La persona no va a poder entrar más.`)) return;
    this.mensajeUsuarios = '';
    this.mensajeErrorUsuarios = '';
    try {
      await this.supabase.eliminarUsuario(u.id);
      await this.cargarUsuarios();
      this.mensajeUsuarios = `✅ Usuario "${u.usuario}" borrado.`;
    } catch (e: any) {
      this.mensajeErrorUsuarios = '❌ ' + (e?.message || 'No se pudo borrar.');
    }
    this.cdr.detectChanges();
  }
}