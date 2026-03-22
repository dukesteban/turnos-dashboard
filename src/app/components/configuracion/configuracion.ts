import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService } from '../../services/supabase';
import { AuthService } from '../../services/auth';

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
  acordeonDatos = true;
  acordeonHorarios = false;
  acordeonServicios = false;
  acordeonPassword = false;

  // Datos del negocio
  nombreNegocio = '';
  descripcion = '';
  puestosXTurno = 1;
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
  mensajeErrorServicios = ''

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
  }

  async cargarDatos() {
    const config = await this.supabase.getConfiguracion();
    this.nombreNegocio = config.find((c: any) => c.clave === 'nombre_negocio')?.valor || '';
    this.descripcion = config.find((c: any) => c.clave === 'descripcion')?.valor || '';
    this.puestosXTurno = parseInt(config.find((c: any) => c.clave === 'puestos_por_turno')?.valor) || 1;
    this.horasLimiteCancelacion = parseInt(config.find((c: any) => c.clave === 'horas_limite_cancelacion')?.valor) || 12;
    this.recordatorioCuando = config.find((c: any) => c.clave === 'recordatorio_cuando')?.valor || 'dia_anterior';
    this.recordatorioHora = config.find((c: any) => c.clave === 'recordatorio_hora')?.valor || '08:00';
    this.diasCerrados = await this.supabase.getDiasCerrados();
    this.horarios = await this.supabase.getHorarios();
    this.servicios = await this.supabase.getServicios();
    this.cdr.detectChanges();
  }

  // ── DATOS DEL NEGOCIO ──────────────────────────────────────

  async guardarConfiguracion() {
    this.mensajeDatos = '';
    if (this.puestosXTurno < 1 || this.puestosXTurno > 3 || !Number.isInteger(this.puestosXTurno)) {
      this.mensajeErrorDatos = '❌ Los puestos por turno deben ser un número entre 1 y 3.';
      this.cdr.detectChanges();
      return;
    }
    if (this.horasLimiteCancelacion < 1 || this.horasLimiteCancelacion > 48 || !Number.isInteger(this.horasLimiteCancelacion)) {
      this.mensajeErrorDatos = '❌ El límite de cancelación debe ser entre 1 y 48 horas.';
      this.cdr.detectChanges();
      return;
    }
    this.guardando = true;
    try {
      await this.supabase.upsertConfiguracion('nombre_negocio', this.nombreNegocio);
      await this.supabase.upsertConfiguracion('descripcion', this.descripcion);
      await this.supabase.upsertConfiguracion('puestos_por_turno', String(this.puestosXTurno));
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
      this.mostrarMensaje('✅ Día/período de cierre agregado.', 'diasCerrados' as any);
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
    try {
      await this.supabase.updateDiasCerrados(dia.id, dia.fecha, dia.fecha_hasta || null, dia.motivo);
      dia.editando = false;
      this.mostrarMensaje('✅ Día/período actualizado.', 'diasCerrados' as any);
    } catch (e) {
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

  async toggleHorario(horario: any) {
    this.mensajeErrorHorarios = '';
    horario.activo = !horario.activo;
    await this.supabase.updateHorario(horario.id, { activo: horario.activo });
  }

  toggleFormHorario() {
    this.mostrarFormHorario = !this.mostrarFormHorario;
    this.mensajeErrorHorarios = '';
    if (!this.mostrarFormHorario) {
      this.nuevoHorario = { dia_semana: 1, hora_inicio: '08:00', hora_fin: '12:00', activo: true };
    }
  }

  async guardarHorario(horario: any) {
    this.mensajeErrorHorarios = '';
    if (!this.validarHorario(horario.hora_inicio, horario.hora_fin)) {
      this.mensajeErrorHorarios = '❌ La hora de inicio debe ser menor que la hora de fin.';
      this.cdr.detectChanges();
      return;
    }
    try {
      const horarios = await this.supabase.getHorarios();
      if (this.seSuperpone(horario, horarios)) {
        this.mensajeErrorHorarios = '⚠️ El rango horario se superpone con otro existente.';
        this.cdr.detectChanges();
        return;
      }

      await this.supabase.updateHorario(horario.id, {
        hora_inicio: horario.hora_inicio,
        hora_fin: horario.hora_fin,
        activo: horario.activo
      });
      horario.editando = false;
      this.mostrarMensaje('✅ Horario actualizado.', 'horarios');
    } catch (e) {
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
      const horarios = await this.supabase.getHorarios();
      if (this.seSuperpone(this.nuevoHorario, horarios)) {
        this.mensajeErrorHorarios = '⚠️ El rango horario se superpone con otro existente.';
        this.cdr.detectChanges();
        return;
      }

      const nuevo = await this.supabase.createHorario(this.nuevoHorario);
      this.horarios.push(nuevo);
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
    return inicio < fin;
  }

  cancelarHorario(horario: any) {
    horario.hora_inicio = horario._hora_inicio_orig;
    horario.hora_fin = horario._hora_fin_orig;
    horario.editando = false;
    this.mensajeErrorHorarios = '';
  }

  seSuperpone(horario: any, otros: any[]): boolean {
    return otros.some(h =>
      Number(h.dia_semana) === Number(horario.dia_semana) &&
      h.id !== horario.id &&
      horario.hora_inicio < h.hora_fin &&
      horario.hora_fin > h.hora_inicio
    );
  }

  // ── SERVICIOS ──────────────────────────────────────────────

  async guardarServicio(servicio: any) {
    this.mensajeErrorServicios = '';
    try {
      const servicios = await this.supabase.getServicios();
      const exist = servicios.some(
        (s: any) =>
          s.nombre.trim().toLowerCase() === servicio.nombre.trim().toLowerCase() &&
          s.id !== servicio.id
      );

      if (exist) {
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
      this.mostrarMensaje('✅ Servicio actualizado.', 'servicios');
    } catch (e) {
      this.mensajeErrorServicios = '❌ Error al actualizar el servicio.';
      this.cdr.detectChanges();
    }
  }

  async toggleServicio(servicio: any) {
    servicio.activo = !servicio.activo;
    await this.supabase.updateServicio(servicio.id, { activo: servicio.activo });
    this.cdr.detectChanges();
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
          s.nombre.trim().toLowerCase() === this.nuevoServicio.nombre.trim().toLowerCase() &&
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
      this.mensajePassword = `✅ Contraseña cambiada. Te quedan ${2 - this.cambiosHoy} cambio(s) hoy.`;
      setTimeout(() => { this.mensajePassword = ''; this.cdr.detectChanges(); }, 3000);
    } catch (e) {
      this.mensajeErrorPassword = '❌ Error al cambiar la contraseña.';
    }
    this.guardandoPassword = false;
    this.cdr.detectChanges();
  }

  // ── UTILS ──────────────────────────────────────────────────

  mostrarMensaje(msg: string, seccion: 'datos' | 'horarios' | 'servicios' | 'diasCerrados') {
    if (seccion === 'datos') { this.mensajeDatos = msg; this.mensajeErrorDatos = ''; }
    else if (seccion === 'horarios') { this.mensajeHorarios = msg; this.mensajeErrorHorarios = ''; }
    else if (seccion === 'servicios') { this.mensajeServicios = msg; this.mensajeErrorServicios = ''; }
    else { this.mensajeDiasCerrados = msg; this.mensajeErrorDiasCerrados = ''; }
    this.cdr.detectChanges();
    setTimeout(() => {
      if (seccion === 'datos') this.mensajeDatos = '';
      else if (seccion === 'horarios') this.mensajeHorarios = '';
      else if (seccion === 'servicios') this.mensajeServicios = '';
      else this.mensajeDiasCerrados = '';
      this.cdr.detectChanges();
    }, 3000);
  }
}
