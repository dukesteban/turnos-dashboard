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
    this.horarios = await this.supabase.getHorarios();
    this.servicios = await this.supabase.getServicios();
    this.cdr.detectChanges();
  }

  // ── DATOS DEL NEGOCIO ──────────────────────────────────────

  async guardarConfiguracion() {
    this.mensajeDatos = '';
    if (this.puestosXTurno < 1 || this.puestosXTurno > 3 || !Number.isInteger(this.puestosXTurno)) {
      this.mensajeErrorDatos = '❌ Los puestos por turno deben ser un número entre 1 y 3.';
      return;
    }
    this.guardando = true;
    try {
      await this.supabase.upsertConfiguracion('nombre_negocio', this.nombreNegocio);
      await this.supabase.upsertConfiguracion('descripcion', this.descripcion);
      await this.supabase.upsertConfiguracion('puestos_por_turno', String(this.puestosXTurno));
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

  // ── HORARIOS ───────────────────────────────────────────────

  async toggleHorario(horario: any) {
    horario.activo = !horario.activo;
    await this.supabase.updateHorario(horario.id, { activo: horario.activo });
  }

  async guardarHorario(horario: any) {
    if (!this.validarHorario(horario.hora_inicio, horario.hora_fin)) {
      this.mensajeErrorHorarios = '❌ La hora de inicio debe ser menor que la hora de fin.';
      return;
    }
    await this.supabase.updateHorario(horario.id, {
      hora_inicio: horario.hora_inicio,
      hora_fin: horario.hora_fin,
      activo: horario.activo
    });
    horario.editando = false;
    this.mostrarMensaje('✅ Horario actualizado.', 'horarios');
  }

  async eliminarHorario(id: number) {
    if (!confirm('¿Eliminar este horario?')) return;
    await this.supabase.deleteHorario(id);
    this.horarios = this.horarios.filter(h => h.id !== id);
  }

  async agregarHorario() {
    if (!this.validarHorario(this.nuevoHorario.hora_inicio, this.nuevoHorario.hora_fin)) {
      this.mensajeErrorHorarios = '❌ La hora de inicio debe ser menor que la hora de fin.';
      return;
    }
    const nuevo = await this.supabase.createHorario(this.nuevoHorario);
    this.horarios.push(nuevo);
    this.mostrarFormHorario = false;
    this.nuevoHorario = { dia_semana: 1, hora_inicio: '08:00', hora_fin: '12:00', activo: true };
    this.mostrarMensaje('✅ Horario agregado.', 'horarios');
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

  // ── SERVICIOS ──────────────────────────────────────────────

  async guardarServicio(servicio: any) {
    try {
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
    }
  }

  async toggleServicio(servicio: any) {
    servicio.activo = !servicio.activo;
    await this.supabase.updateServicio(servicio.id, { activo: servicio.activo });
    this.cdr.detectChanges();
  }

  async agregarServicio() {
    if (!this.nuevoServicio.nombre || !this.nuevoServicio.precio || !this.nuevoServicio.duracion_minutos) {
      this.mensajeErrorServicios = '❌ Completá todos los campos.';
      return;
    }
    try {
      const nuevo = await this.supabase.createServicio(this.nuevoServicio);
      this.servicios.push(nuevo);
      this.mostrarFormServicio = false;
      this.nuevoServicio = { nombre: '', precio: null, duracion_minutos: null, activo: true };
      this.mostrarMensaje('✅ Servicio agregado.', 'servicios');
    } catch (e) {
      this.mensajeErrorServicios = '❌ Error al agregar el servicio.';
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
      return;
    }
    if (!this.passwordActual || !this.passwordNueva || !this.passwordRepetir) {
      this.mensajeErrorPassword = '❌ Completá todos los campos.';
      return;
    }
    if (this.passwordNueva !== this.passwordRepetir) {
      this.mensajeErrorPassword = '❌ La nueva contraseña no coincide.';
      return;
    }
    if (this.passwordNueva.length < 6) {
      this.mensajeErrorPassword = '❌ La contraseña debe tener al menos 6 caracteres.';
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

  mostrarMensaje(msg: string, seccion: 'datos' | 'horarios' | 'servicios') {
    if (seccion === 'datos') { this.mensajeDatos = msg; this.mensajeErrorDatos = ''; }
    else if (seccion === 'horarios') { this.mensajeHorarios = msg; this.mensajeErrorHorarios = ''; }
    else { this.mensajeServicios = msg; this.mensajeErrorServicios = ''; }
    this.cdr.detectChanges();
    setTimeout(() => {
      if (seccion === 'datos') this.mensajeDatos = '';
      else if (seccion === 'horarios') this.mensajeHorarios = '';
      else this.mensajeServicios = '';
      this.cdr.detectChanges();
    }, 3000);
  }
}
