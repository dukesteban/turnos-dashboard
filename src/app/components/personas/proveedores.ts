import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService } from '../../services/supabase';
import { paraComparar, contiene } from '../../utils/texto';

/**
 * ABM de PROVEEDORES.
 *
 * Vive dentro de "Personas" y no en Caja, pero el ABM se mudó, no se inventó:
 * venia entero en la pestaña "Proveedores" de Caja (alta, edicion, inactivar y
 * buscador). Lo que se quedo en Caja es lo que es PLATA: la lista de compras,
 * el total por proveedor y el popup de "Registrar compra".
 *
 * La division es esa: **Personas = con quien se trabaja, Caja = por cuanto**.
 * Un proveedor es una persona con la que se trabaja; una compra es una salida de
 * dinero.
 *
 * Caja sigue cargando los proveedores por su cuenta (`getProveedores`) porque
 * los necesita para elegir a quien le compras. Son dos lecturas de la misma
 * tabla: una elige a quién le comprás y la otra edita la ficha.
 *
 * OJO con `contiene` vs `paraComparar`:
 *   · el BUSCADOR usa `contiene` (sin acentos): el usuario escribe "quimicas" y
 *     tiene que encontrar "Químicas del Sur".
 *   · el CHEQUEO de duplicados usa `paraComparar` (con acentos): "Cañada" y
 *     "Canada" son proveedores distintos y la base los guarda distintos.
 *   Usar una en la otra rompe una de las dos cosas.
 */
@Component({
  selector: 'app-proveedores',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './proveedores.html',
  styleUrls: ['./proveedores.scss'],
})
export class ProveedoresComponent implements OnInit {
  proveedores: any[] = [];
  busquedaProveedor = '';

  // Alta y edicion comparten el mismo popup: `proveedorEditando` null = alta.
  mostrarFormProveedor = false;
  proveedorEditando: any = null;
  nuevoProveedor: any = { nombre: '', contacto: '', telefono: '', notas: '' };

  mensaje = '';
  mensajeError = '';
  guardando = false;
  cargando = true;

  constructor(private supabase: SupabaseService, private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    await this.cargarDatos();
  }

  async cargarDatos() {
    this.cargando = true;
    try {
      this.proveedores = await this.supabase.getProveedores();
    } catch (e) {
      this.mensajeError = '❌ No se pudieron cargar los proveedores.';
    }
    this.cargando = false;
    this.cdr.detectChanges();
  }

  /** Ver "OJO con contiene vs paraComparar" en el doc de la clase. */
  get proveedoresFiltrados(): any[] {
    if (!this.busquedaProveedor.trim()) return this.proveedores;
    return this.proveedores.filter((p: any) => contiene(p.nombre, this.busquedaProveedor));
  }

  get editandoProveedor(): boolean {
    return this.proveedorEditando !== null;
  }

  /** Sin argumento = alta nueva. Con un proveedor = editar ese. */
  abrirFormProveedor(p: any = null) {
    this.mensajeError = '';
    this.proveedorEditando = p;
    this.nuevoProveedor = p
      ? {
          nombre: p.nombre || '',
          contacto: p.contacto || '',
          telefono: p.telefono || '',
          notas: p.notas || '',
        }
      : { nombre: '', contacto: '', telefono: '', notas: '' };
    this.mostrarFormProveedor = true;
    this.cdr.detectChanges();
  }

  cerrarFormProveedor() {
    this.mostrarFormProveedor = false;
    this.proveedorEditando = null;
    this.mensajeError = '';
    this.cdr.detectChanges();
  }

  /**
   * Editar un proveedor.
   *
   * Es un alias de `abrirFormProveedor(p)` y no un metodo con cuerpo: existe
   * para que el template diga lo que hace. El click en la fila y el ✏️ del item
   * abren el MISMO popup, y si cada uno llamara a `abrirFormProveedor` con un
   * argumento distinto (o uno de los dos se olvidara del argumento) aparece un
   * "Nuevo proveedor" en el lugar donde el usuario pidio editar.
   */
  editar(p: any) {
    this.abrirFormProveedor(p);
  }

  async guardarProveedor() {
    this.mensajeError = '';
    this.mensaje = '';
    if (!this.nuevoProveedor.nombre.trim()) {
      this.mensajeError = '❌ El nombre es obligatorio.';
      return;
    }

    // El índice único de la base es `lower(btrim(nombre))`. Se avisa acá para
    // que el mensaje sea "ya existe" y no un error de Postgres.
    //
    // Al EDITAR hay que excluirse a uno mismo: sin el `p.id !== idEnEdicion`,
    // guardar el mismo proveedor sin tocarle el nombre daría "ya existe" siempre.
    const idEnEdicion = this.proveedorEditando?.id;
    if (this.proveedores.some(
      (p: any) => paraComparar(p.nombre) === paraComparar(this.nuevoProveedor.nombre)
        && p.id !== idEnEdicion
    )) {
      this.mensajeError = '⚠️ Ya existe un proveedor con ese nombre.';
      return;
    }

    this.guardando = true;
    const datos = {
      nombre: this.nuevoProveedor.nombre.trim(),
      contacto: this.nuevoProveedor.contacto.trim() || null,
      telefono: this.nuevoProveedor.telefono.trim() || null,
      notas: this.nuevoProveedor.notas.trim() || null,
    };
    try {
      if (this.editandoProveedor) {
        await this.supabase.actualizarProveedor(idEnEdicion, datos);
      } else {
        await this.supabase.crearProveedor(datos);
      }
      const eraEdicion = this.editandoProveedor;
      this.cerrarFormProveedor();
      this.nuevoProveedor = { nombre: '', contacto: '', telefono: '', notas: '' };
      await this.cargarDatos();
      this.mostrarMensaje(eraEdicion ? '✅ Proveedor actualizado.' : '✅ Proveedor agregado.');
    } catch (e) {
      this.mensajeError = '❌ No se pudo guardar el proveedor.';
    }
    this.guardando = false;
    this.cdr.detectChanges();
  }

  /**
   * Inactivar, no borrar: las compras viejas tienen que seguir apuntando a
   * alguien. Si se borrara el proveedor, cada compra histórica quedaría con un
   * `#12` sin nombre en el historial de Caja.
   */
  async inactivarProveedor(p: any) {
    if (!confirm(`¿Inactivar "${p.nombre}"? Las compras ya registradas se mantienen.`)) return;
    try {
      await this.supabase.inactivarProveedor(p.id);
      await this.cargarDatos();
      this.mostrarMensaje('✅ Proveedor inactivado.');
    } catch (e) {
      this.mensajeError = '❌ No se pudo inactivar.';
    }
    this.cdr.detectChanges();
  }

  private mostrarMensaje(m: string) {
    this.mensaje = m;
    this.mensajeError = '';
    this.cdr.detectChanges();
    setTimeout(() => { this.mensaje = ''; this.cdr.detectChanges(); }, 3000);
  }
}