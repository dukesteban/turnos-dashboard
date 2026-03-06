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

  diasSemana = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  constructor(private supabase: SupabaseService, private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    await this.cargarClientes();
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
    this.clienteSeleccionado = { ...cliente, editando: false };
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

  async guardarNombre() {
    try {
      await this.supabase.updateCliente(this.clienteSeleccionado.id, this.clienteSeleccionado.nombre);
      const idx = this.clientes.findIndex(c => c.id === this.clienteSeleccionado.id);
      if (idx >= 0) this.clientes[idx].nombre = this.clienteSeleccionado.nombre;
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
      this.mostrarMensaje('✅ Teléfono eliminado.');
    } catch (e) {
      this.mostrarError('❌ Error al eliminar el teléfono.');
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
