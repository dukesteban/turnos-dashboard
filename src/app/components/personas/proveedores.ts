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

  // ALTA: es un popup, como el de Empleados y Clientes.
  mostrarFormProveedor = false;
  nuevoProveedor: any = { nombre: '', contacto: '', telefono: '', notas: '' };

  // EDICION: NO es un popup. Es el panel de detalle de la derecha, el mismo
  // que usan Clientes y Empleados. Por eso el estado vive en el objeto
  // seleccionado y no en un formulario aparte.
  //
  // `proveedorSeleccionado` es una COPIA del de la lista (con spread), no el
  // mismo objeto: si fuera el mismo, `[(ngModel)]` escribiendo en el input
  // modificaria la fila de la lista mientras se tipea y el nombre de la fila
  // cambiaria antes de guardar. Con la copia se escribe en el panel y la fila
  // recien cambia cuando el guardado sale bien.
  proveedorSeleccionado: any = null;

  mensaje = '';
  mensajeError = '';
  guardando = false;
  cargando = true;

  /** Los cuatro campos del panel, en el orden en que se muestran. */
  readonly CAMPOS: { clave: string; label: string; placeholder: string }[] = [
    { clave: 'nombre', label: 'Nombre', placeholder: 'Ej: Químicas del Sur' },
    { clave: 'contacto', label: 'Contacto', placeholder: 'Quién atiende' },
    { clave: 'telefono', label: 'Teléfono', placeholder: '' },
    { clave: 'notas', label: 'Notas', placeholder: '' },
  ];

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
    // Si el panel estaba abierto mostrando un proveedor, se lo vuelve a armar con
    // los datos frescos para que no quede mostrando datos viejos.
    if (this.proveedorSeleccionado) {
      const fresco = this.proveedores.find((p: any) => p.id === this.proveedorSeleccionado.id);
      this.proveedorSeleccionado = fresco ? this.crearSeleccion(fresco) : null;
    }
    this.cdr.detectChanges();
  }

  /**
   * Arma el objeto del panel: la ficha mas un flag `editando` por campo.
   *
   * Los flags van DENTRO del objeto (y no en un diccionario aparte) porque el
   * template los muestra con `*ngIf` al lado del campo, y asi cada campo sabe
   * si se esta editando sin tener que consultar una clave dinamica.
   */
  private crearSeleccion(p: any): any {
    return {
      ...p,
      contacto: p.contacto || '',
      telefono: p.telefono || '',
      notas: p.notas || '',
      editando: {} as Record<string, boolean>,
      guardandoCampo: false,
    };
  }

  /** Click en la fila: abre el detalle. Es lo mismo que hace Clientes y Empleados. */
  seleccionarProveedor(p: any) {
    this.mensajeError = '';
    this.proveedorSeleccionado = this.crearSeleccion(p);
    this.cdr.detectChanges();
  }

  cerrarDetalle() {
    this.proveedorSeleccionado = null;
    this.cdr.detectChanges();
  }

  editarCampo(clave: string) {
    this.proveedorSeleccionado.editando[clave] = true;
    this.mensajeError = '';
    this.cdr.detectChanges();
  }

  /**
   * Cancelar un campo.
   *
   * No borra lo tipeado: vuelve a copiar el valor guardado. Si se dejara el
   * texto, al volver a editar el campo el usuario veria lo que escribio la
   * vez anterior sin saber que nunca se guardo.
   */
  cancelarCampo(clave: string) {
    const sel = this.proveedorSeleccionado;
    const original = this.proveedores.find((p: any) => p.id === sel.id);
    if (original) sel[clave] = original[clave] || '';
    sel.editando[clave] = false;
    this.cdr.detectChanges();
  }

  /**
   * Guardar UN campo.
   *
   * Un `updateProveedor` por campo y no uno con los cuatro: si el usuario
   * edita el nombre y despues el telefono, son dos guardados y dos mensajes.
   * Mandar los cuatro juntos cada vez pisaria con `null` los campos que no
   * toco (los opcionales vienen en `null` desde la base).
   */
  async guardarCampo(clave: string) {
    const sel = this.proveedorSeleccionado;
    if (!sel || sel.guardandoCampo) return;
    this.mensajeError = '';

    const valor = (sel[clave] ?? '').trim();

    if (clave === 'nombre' && !valor) {
      this.mensajeError = '❌ El nombre es obligatorio.';
      this.cdr.detectChanges();
      return;
    }

    // El indice unico de la base es `lower(btrim(nombre))`. Se avisa aca para
    // que el mensaje sea "ya existe" y no un error de Postgres. Al editar hay
    // que excluirse a uno mismo: sin el `p.id !== idEnEdicion`, guardar el
    // mismo nombre daria "ya existe" siempre y no se podria editar nunca.
    if (clave === 'nombre') {
      const idEnEdicion = sel.id;
      if (this.proveedores.some(
        (p: any) => paraComparar(p.nombre) === paraComparar(valor) && p.id !== idEnEdicion
      )) {
        this.mensajeError = '⚠️ Ya existe un proveedor con ese nombre.';
        this.cdr.detectChanges();
        return;
      }
    }

    sel.guardandoCampo = true;
    this.cdr.detectChanges();
    try {
      const datos: any = { [clave]: valor || null };
      // El nombre nunca se manda en null: es NOT NULL.
      if (clave === 'nombre') datos.nombre = valor;
      await this.supabase.actualizarProveedor(sel.id, datos);

      const idx = this.proveedores.findIndex((p: any) => p.id === sel.id);
      if (idx >= 0) this.proveedores[idx][clave] = datos[clave];
      sel[clave] = datos[clave] || '';
      sel.editando[clave] = false;
      this.mostrarMensaje('✅ Proveedor actualizado.');
    } catch (e) {
      this.mensajeError = '❌ No se pudo guardar.';
    } finally {
      sel.guardandoCampo = false;
      this.cdr.detectChanges();
    }
  }

  /** Ver "OJO con contiene vs paraComparar" en el doc de la clase. */
  get proveedoresFiltrados(): any[] {
    if (!this.busquedaProveedor.trim()) return this.proveedores;
    return this.proveedores.filter((p: any) => contiene(p.nombre, this.busquedaProveedor));
  }

  /**
   * Abrir el popup de ALTA.
   *
   * No acepta un proveedor: la edicion no pasa por aca, se edita en el panel de
   * detalle (`seleccionarProveedor`). Dejar el parametro opcional "por si
   * acaso" es lo que hacia que el mismo metodo sirviera para las dos cosas y
   * terminara con un `if` de edicion que ya no existe.
   */
  abrirFormProveedor() {
    this.mensajeError = '';
    // Siempre arranca limpio: si se abrio, se cerro sin guardar y se volvio a
    // abrir, tiene que venir vacio y no con el intento anterior a medias.
    this.nuevoProveedor = { nombre: '', contacto: '', telefono: '', notas: '' };
    this.mostrarFormProveedor = true;
    this.cdr.detectChanges();
  }

  cerrarFormProveedor() {
    this.mostrarFormProveedor = false;
    this.mensajeError = '';
    this.cdr.detectChanges();
  }

  async guardarProveedor() {
    this.mensajeError = '';
    this.mensaje = '';
    if (!this.nuevoProveedor.nombre.trim()) {
      this.mensajeError = '❌ El nombre es obligatorio.';
      return;
    }

    // El índice único de la base es `lower(btrim(nombre))`. Se avisa acá para
    // que el mensaje sea "ya existe" y no un error de Postgres. Este es un
    // ALTA, así que no hay que excluirse a uno mismo del chequeo.
    if (this.proveedores.some(
      (p: any) => paraComparar(p.nombre) === paraComparar(this.nuevoProveedor.nombre)
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
      const creado = await this.supabase.crearProveedor(datos);
      this.cerrarFormProveedor();
      await this.cargarDatos();
      this.mostrarMensaje('✅ Proveedor agregado.');
      // Se abre el detalle del recién creado: es lo que el usuario quiere ver
      // después de dar de alta, y le ahorra el click de buscarlo en la lista.
      if (creado?.id) {
        const nuevo = this.proveedores.find((p: any) => p.id === creado.id);
        if (nuevo) this.seleccionarProveedor(nuevo);
      }
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

  /**
   * Reactivar un proveedor dado de baja.
   *
   * Sin esto, un proveedor inactivo se queda de adorno para siempre: el 🚫 de
   * la lista desaparece cuando `activo` es false, así que no hay ningún otro
   * lugar desde donde volverlo atrás. Es la contrapartida de "inactivar en vez
   * de borrar".
   *
   * No pide confirmación: acá no se borra nada. Confirmar cada
   * reactivación obliga a apretar "sí para deshacer una desactivación que el
   * propio usuario acaba de hacer, y ahí el confirm deja de ser una protección
   * y pasa a ser un obstáculo.
   */
  async reactivarProveedor(p: any) {
    try {
      await this.supabase.activarProveedor(p.id);
      await this.cargarDatos();
      this.mostrarMensaje('✅ Proveedor reactivado.');
    } catch (e) {
      this.mensajeError = '❌ No se pudo reactivar.';
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