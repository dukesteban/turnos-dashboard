import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService } from '../../services/supabase';

@Component({
  selector: 'app-clientes',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './clientes.html',
  styleUrls: ['./clientes.scss']
})
export class ClientesComponent implements OnInit {
  clientes: any[] = [];
  clienteSeleccionado: any = null;
  turnosCliente: any[] = [];
  mensaje = '';
  mensajeError = '';
  nuevoTelefono = '';
  cargandoTurnos = false;
  busqueda = '';
  mostrandoFusionar = false;
  busquedaFusionar = '';
  clienteParaFusionar: any = null;

  diasSemana = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  constructor(private supabase: SupabaseService, private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    await this.cargarClientes();
    this.cdr.detectChanges();
  }

  async cargarClientes() {
    this.clientes = await this.supabase.getClientes();
    this.cdr.detectChanges();
  }

  get clientesFiltrados(): any[] {
    if (!this.busqueda) return this.clientes;
    const q = this.busqueda.toLowerCase();
    return this.clientes.filter(c =>
      c.nombre?.toLowerCase().includes(q) ||
      c.telefonos?.some((t: any) => t.telefono?.includes(q))
    );
  }

  async seleccionarCliente(cliente: any) {
    this.clienteSeleccionado = { ...cliente, editando: false, nombreOriginal: cliente.nombre };
    this.nuevoTelefono = '';
    this.cargandoTurnos = true;
    this.turnosCliente = await this.supabase.getTurnosCliente(cliente.id);
    this.cargandoTurnos = false;
    this.cdr.detectChanges();
  }

  cerrarDetalle() {
    this.clienteSeleccionado = null;
    this.turnosCliente = [];
    this.cdr.detectChanges();
  }

  cancelarEdicionNombre() {
    if (!this.clienteSeleccionado) return;
    this.clienteSeleccionado.nombre = this.clienteSeleccionado.nombreOriginal ?? this.clienteSeleccionado.nombre;
    this.clienteSeleccionado.editando = false;
    this.cdr.detectChanges();
  }

  async guardarNombre() {
    const nombreNorm = this.supabase.normalizarNombre(this.clienteSeleccionado.nombre);
    this.clienteSeleccionado.nombre = nombreNorm;

    const duplicado = await this.supabase.verificarNombreDuplicado(nombreNorm, this.clienteSeleccionado.id);
    if (duplicado) {
      this.mostrarError('❌ Ya existe un cliente con ese nombre.');
      return;
    }

    try {
      await this.supabase.updateCliente(this.clienteSeleccionado.id, nombreNorm);
      const idx = this.clientes.findIndex(c => c.id === this.clienteSeleccionado.id);
      if (idx >= 0) this.clientes[idx].nombre = nombreNorm;
      this.clienteSeleccionado.editando = false;
      this.mostrarMensaje('✅ Nombre actualizado.');
    } catch (e) {
      this.mostrarError('❌ Error al actualizar el nombre.');
    }
  }

  async agregarTelefono() {
    if (!this.nuevoTelefono.trim()) return;
    try {
      const tel = await this.supabase.agregarTelefono(this.clienteSeleccionado.id, this.nuevoTelefono.trim());
      this.clienteSeleccionado.telefonos = [...(this.clienteSeleccionado.telefonos || []), tel];
      // Si es el único teléfono, actualizarlo en turnos
      if (this.clienteSeleccionado.telefonos.length === 1) {
        await this.supabase.actualizarTelefonoEnTurnos(this.clienteSeleccionado.id, this.nuevoTelefono.trim());
      }
      this.nuevoTelefono = '';
      this.mostrarMensaje('✅ Teléfono agregado.');
    } catch (e) {
      this.mostrarError('❌ Error al agregar el teléfono. Puede que ya exista.');
    }
  }

  async eliminarTelefono(tel: any) {
    if (!confirm('¿Eliminar este teléfono?')) return;
    try {
      await this.supabase.eliminarTelefono(tel.id);
      this.clienteSeleccionado.telefonos = this.clienteSeleccionado.telefonos.filter((t: any) => t.id !== tel.id);
      // Actualizar con el nuevo teléfono principal si queda alguno
      const telPrincipal = this.clienteSeleccionado.telefonos?.[0]?.telefono || '';
      await this.supabase.actualizarTelefonoEnTurnos(this.clienteSeleccionado.id, telPrincipal);
      this.mostrarMensaje('✅ Teléfono eliminado.');
    } catch (e) {
      this.mostrarError('❌ Error al eliminar el teléfono.');
    }
  }

  async marcarPrincipal(tel: any) {
    if (!confirm(`¿Marcar ${tel.telefono} como principal? Se actualizará en todos los turnos.`)) return;
    try {
      await this.supabase.marcarTelefonoPrincipal(this.clienteSeleccionado.id, tel.id);
      // Actualizar localmente
      this.clienteSeleccionado.telefonos.forEach((t: any) => t.principal = t.id === tel.id);
      // Actualizar teléfono en turnos
      await this.supabase.actualizarTelefonoEnTurnos(this.clienteSeleccionado.id, tel.telefono);
      this.mostrarMensaje('✅ Teléfono principal actualizado.');
    } catch (e) {
      this.mostrarError('❌ Error al cambiar el teléfono principal.');
    }
  }

  async guardarTelefono(tel: any) {
    if (!tel._telEditando?.trim()) return;
    try {
      await this.supabase.editarTelefono(tel.id, tel._telEditando.trim());
      tel.telefono = tel._telEditando.trim();
      tel.editandoTel = false;
      if (tel.principal) {
        await this.supabase.actualizarTelefonoEnTurnos(this.clienteSeleccionado.id, tel.telefono);
      }
      this.mostrarMensaje('✅ Teléfono actualizado.');
    } catch (e) {
      this.mostrarError('❌ Error al actualizar. Puede que ya exista ese número.');
    }
  }

  get clientesParaFusionar(): any[] {
    if (!this.busquedaFusionar) return [];
    const q = this.busquedaFusionar.toLowerCase();
    return this.clientes.filter(c =>
      c.id !== this.clienteSeleccionado?.id &&
      (c.nombre?.toLowerCase().includes(q) ||
      c.telefonos?.some((t: any) => t.telefono?.includes(q)))
    );
  }

  async confirmarFusion() {
    if (!this.clienteParaFusionar) return;
    const confirmado = confirm(
      `¿Fusionar "${this.clienteParaFusionar.nombre}" dentro de "${this.clienteSeleccionado.nombre}"?\n\nLos turnos y teléfonos de "${this.clienteParaFusionar.nombre}" pasarán al principal y el duplicado se eliminará.`
    );
    if (!confirmado) return;

    try {
      await this.supabase.fusionarClientes(
        this.clienteSeleccionado.id,
        this.clienteParaFusionar.id
      );
      // Eliminar duplicado de la lista local
      this.clientes = this.clientes.filter(c => c.id !== this.clienteParaFusionar.id);
      // Recargar teléfonos y turnos del principal
      await this.seleccionarCliente(this.clienteSeleccionado);
      this.mostrandoFusionar = false;
      this.busquedaFusionar = '';
      this.clienteParaFusionar = null;
      this.mostrarMensaje('✅ Clientes fusionados correctamente.');
    } catch (e) {
      this.mostrarError('❌ Error al fusionar los clientes.');
    }
  }

  formatearFecha(fecha: string): string {
    if (!fecha) return '';
    const f = new Date(fecha + 'T12:00:00');
    const dia = this.diasSemana[f.getUTCDay()];
    const d = String(f.getUTCDate()).padStart(2, '0');
    const m = String(f.getUTCMonth() + 1).padStart(2, '0');
    return `${dia} ${d}/${m}`;
  }

  mostrarMensaje(msg: string) {
    this.mensaje = msg;
    this.mensajeError = '';
    this.cdr.detectChanges();
    setTimeout(() => { this.mensaje = ''; this.cdr.detectChanges(); }, 3000);
  }

  mostrarError(msg: string) {
    this.mensajeError = msg;
    this.mensaje = '';
    this.cdr.detectChanges();
    setTimeout(() => { this.mensajeError = ''; this.cdr.detectChanges(); }, 3000);
  }
}
