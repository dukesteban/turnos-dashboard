import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { skip } from 'rxjs';
import { SupabaseService } from '../../services/supabase';
import { problemaTelefono } from '../../utils/telefono';
import { contiene, coincideTelefono } from '../../utils/texto';

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

  // ─── Nuevo cliente ───
  // Los campos del alta usan prefijo `alta` porque `nuevoTelefono` ya existe: es el
  // del input "agregar teléfono" de un cliente YA guardado. Con un solo campo, abrir
  // el modal de alta borraba el teléfono que el usuario estaba por agregar.
  mostrarModalNuevo = false;
  guardandoNuevo = false;
  errorNuevo = '';
  altaNombre = '';
  altaTelefono = '';
  altaCuit = '';
  altaDireccion = '';

  diasSemana = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  constructor(private supabase: SupabaseService, private cdr: ChangeDetectorRef, private route: ActivatedRoute) {}

  async ngOnInit() {
    await this.cargarClientes();
    // `?cliente=ID` llega desde el popup del turno (Dashboard y Agenda): abre
    // directo la ficha de ese cliente en vez de dejar al usuario buscandolo.
    const idInicial = Number(this.route.snapshot.queryParamMap.get('cliente'));
    if (idInicial) await this.abrirClientePorId(idInicial);
    // La pestana queda montada: si ya estaba abierta, el parametro puede llegar
    // despues (skip(1) saltea el valor que ya leimos del snapshot).
    this.route.queryParamMap.pipe(skip(1)).subscribe((params) => {
      const id = Number(params.get('cliente'));
      if (id) this.abrirClientePorId(id);
    });
    this.cdr.detectChanges();
  }

  private async abrirClientePorId(id: number) {
    let c = this.clientes.find((x: any) => x.id === id);
    if (!c) {
      // La lista puede estar vieja (se abrio la app antes de que existiera la ficha).
      await this.cargarClientes();
      c = this.clientes.find((x: any) => x.id === id);
    }
    if (c) await this.seleccionarCliente(c);
  }

  // ─── Nuevo cliente ───
  // Mismo camino que "Nuevo empleado" y "Nuevo proveedor": un popup con la cajita
  // gris de los formularios. Se abre desde el encabezado de la lista.
  abrirModalNuevo() {
    this.mostrarModalNuevo = true;
    this.altaNombre = '';
    this.altaTelefono = '';
    this.altaCuit = '';
    this.altaDireccion = '';
    this.errorNuevo = '';
    this.cdr.detectChanges();
  }

  cerrarModalNuevo() {
    this.mostrarModalNuevo = false;
    this.cdr.detectChanges();
  }

  async agregarCliente() {
    if (!this.altaNombre.trim()) {
      this.errorNuevo = '❌ Ingresá un nombre.';
      this.cdr.detectChanges();
      return;
    }
    // El teléfono es opcional, pero si se escribe tiene que parecer un teléfono.
    if (this.altaTelefono.trim()) {
      const problema = problemaTelefono(this.altaTelefono);
      if (problema) {
        this.errorNuevo = problema;
        this.cdr.detectChanges();
        return;
      }
    }

    this.guardandoNuevo = true;
    this.errorNuevo = '';
    try {
      const nombre = this.supabase.normalizarNombre(this.altaNombre);
      const duplicado = await this.supabase.verificarNombreDuplicado(nombre);
      if (duplicado) {
        this.errorNuevo = '❌ Ya existe un cliente con ese nombre.';
        this.guardandoNuevo = false;
        this.cdr.detectChanges();
        return;
      }

      await this.supabase.crearCliente({
        nombre,
        telefono: this.altaTelefono.trim(),
        cuit_cuil: this.altaCuit,
        direccion: this.altaDireccion,
      });

      await this.cargarClientes();
      this.cerrarModalNuevo();
      this.mostrarMensaje('✅ Cliente agregado.');
    } catch (e) {
      console.error('Error al agregar cliente:', e);
      this.errorNuevo = '❌ Error al guardar el cliente. Puede que el teléfono ya exista.';
    }
    this.guardandoNuevo = false;
    this.cdr.detectChanges();
  }

  async cargarClientes() {
    this.clientes = await this.supabase.getClientes();
    this.cdr.detectChanges();
  }

  get clientesFiltrados(): any[] {
    // `contiene` y no `includes` a secas: con un `includes` normal, buscar
    // "maria" NO encontraba a "María Gómez" y el usuario veía lista vacia
    // teniendo al cliente cargado en la base.
    //
    // El telefono va por `coincideTelefono` porque se guardan con el formato que
    // escribio el usuario: buscar "115555" tiene que encontrar a "11 5555-1111".
    if (!this.busqueda) return this.clientes;
    return this.clientes.filter(c =>
      contiene(c.nombre, this.busqueda) ||
      c.telefonos?.some((t: any) => coincideTelefono(t.telefono, this.busqueda))
    );
  }

  async seleccionarCliente(cliente: any) {
    this.clienteSeleccionado = { ...cliente, editando: false, editandoFicha: false, nombreOriginal: cliente.nombre };
    this.nuevoTelefono = '';
    this.cargandoTurnos = true;
    this.turnosCliente = await this.supabase.getTurnosCliente(cliente.id);
    this.cargandoTurnos = false;
    this.cdr.detectChanges();
  }

  // ─── Datos fiscales ───
  // En readonly se muestra lo cargado o "Sin dato". Se edita inline, como el nombre.
  get cuitTexto(): string {
    return this.clienteSeleccionado?.cuit_cuil?.trim() || 'Sin CUIT/CUIL';
  }

  get direccionTexto(): string {
    return this.clienteSeleccionado?.direccion?.trim() || 'Sin dirección';
  }

  async guardarFicha() {
    if (!this.clienteSeleccionado) return this.mostrarError('❌ No hay ningún cliente seleccionado.');
    try {
      await this.supabase.updateClienteFicha(this.clienteSeleccionado.id, {
        cuit_cuil: this.clienteSeleccionado.cuit_cuil ?? '',
        direccion: this.clienteSeleccionado.direccion ?? '',
      });
      // Se guarda "" como null en la base: el getter lo vuelve a mostrar como "Sin dato".
      this.clienteSeleccionado.editandoFicha = false;
      this.mostrarMensaje('✅ Datos actualizados.');
    } catch (e) {
      this.mostrarError('❌ Error al actualizar los datos.');
    }
  }

  cancelarEdicionFicha() {
    if (!this.clienteSeleccionado) return;
    // Vuelve a lo que tenía: se recargan desde la lista, que es la fuente.
    const original = this.clientes.find(c => c.id === this.clienteSeleccionado.id);
    if (original) {
      this.clienteSeleccionado.cuit_cuil = original.cuit_cuil;
      this.clienteSeleccionado.direccion = original.direccion;
    }
    this.clienteSeleccionado.editandoFicha = false;
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
    // Sin el guard, un clic en "guardar" sin cliente seleccionado (o con el
    // detalle cerrado) rompe la pantalla con "no se puede leer editando de null".
    if (!this.clienteSeleccionado) return this.mostrarError('❌ No hay ningún cliente seleccionado.');
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
    const problema = problemaTelefono(this.nuevoTelefono);
    if (problema) return this.mostrarError(`❌ ${problema}`);
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
    const problema = problemaTelefono(tel._telEditando);
    if (problema) return this.mostrarError(`❌ ${problema}`);
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
    return this.clientes.filter(c =>
      c.id !== this.clienteSeleccionado?.id &&
      (contiene(c.nombre, this.busquedaFusionar) ||
      c.telefonos?.some((t: any) => coincideTelefono(t.telefono, this.busquedaFusionar)))
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
      this.cdr.detectChanges();
    } catch (e) {
      this.mostrarError('❌ Error al fusionar los clientes.');
    }
  }

  formatearFecha(fecha: string): string {
    if (!fecha) return '';
    // 'Z' + getUTC*: antes parseaba a hora LOCAL y leia UTC, asi que el dia
    // depended del offset del navegador. Funcionaba de -12 a +12, pero en +13 y
    // +14 (Tonga, Kiritimati, Chatham) corria un dia. Parsear y leer en la misma
    // zona lo hace independiente del timezone del cliente. Hay un test que
    // fuerza esas zonas para que el bug no pueda volver sin que se note.
    const f = new Date(fecha + 'T12:00:00Z');
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
