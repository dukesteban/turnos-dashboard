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
   * Arma el objeto del panel: la ficha, el flag `editando` de TODO el bloque y
   * una foto de los valores guardados.
   *
   * `_original` es lo que hace que "Cancelar" sirva: sin la foto, cancelar
   * tendría que volver a leer la lista, y si el guardado ya habia Actualizado la
   * fila, la foto seria lo recien guardado y no lo anterior. Guardandola en el
   * momento de seleccionar, "cancelar" siempre vuelve a donde estabas.
   */
  private crearSeleccion(p: any): any {
    const valores = {
      nombre: p.nombre || '',
      contacto: p.contacto || '',
      telefono: p.telefono || '',
      notas: p.notas || '',
    };
    return {
      ...p,
      ...valores,
      _original: { ...valores },
      editando: false,
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

  /**
   * Poner TODO el bloque en edicion.
   *
   * Un solo boton para los cuatro campos, como Configuración > General. Antes
   * habia un lapiz por campo: cuatro lapices en columna parecen cuatro acciones
   * y el que de verdad se editaba a menudo quedaba sin destino claro.
   */
  editarProveedor() {
    if (!this.proveedorSeleccionado) return;
    this.proveedorSeleccionado.editando = true;
    this.mensajeError = '';
    this.cdr.detectChanges();
  }

  /**
   * Cancelar la edicion: vuelve a los valores guardados.
   *
   * No borra lo tipeado a mano, sino que RESTAURA la foto `_original`. Si solo
   * se cerrara el modo edicion, al volver a entrar se veria lo que se escribio
   * la vez anterior sin saber que nunca se guardo.
   */
  cancelarEdicion() {
    const sel = this.proveedorSeleccionado;
    if (!sel) return;
    Object.assign(sel, sel._original);
    sel.editando = false;
    this.cdr.detectChanges();
  }

  /**
   * Guardar el bloque entero en UNA llamada.
   *
   * Con un solo boton, mandar los cuatro campos juntos es lo correcto y lo que
   * espera la gente: o se guarda la ficha o no se guarda. Antes (un lapiz por
   * campo) habia que mandar UN campo por vez, porque mandar todos en cada
   * guardado pisaba con `null` los opcionales que el usuario no habia tocado.
   * Ahora los cuatro salen del panel, cada uno con su `|| null`, asi que el
   * campo vacio se guarda como vacio y no como "no tocar".
   */
  async guardarProveedor() {
    const sel = this.proveedorSeleccionado;
    if (!sel || sel.guardandoCampo || !sel.editando) return;
    this.mensajeError = '';

    const nombre = (sel.nombre ?? '').trim();
    if (!nombre) {
      this.mensajeError = '❌ El nombre es obligatorio.';
      this.cdr.detectChanges();
      return;
    }

    // El indice unico de la base es `lower(btrim(nombre))`. Se avisa aca para
    // que el mensaje sea "ya existe" y no un error de Postgres. Hay que
    // excluirse a uno mismo: sin el `p.id !== sel.id`, guardar el mismo nombre
    // daria "ya existe" siempre y no se podria editar nunca.
    if (this.proveedores.some(
      (p: any) => paraComparar(p.nombre) === paraComparar(nombre) && p.id !== sel.id
    )) {
      this.mensajeError = '⚠️ Ya existe un proveedor con ese nombre.';
      this.cdr.detectChanges();
      return;
    }

    sel.guardandoCampo = true;
    this.cdr.detectChanges();
    try {
      const datos = {
        // El nombre nunca va en null: es NOT NULL.
        nombre,
        contacto: (sel.contacto ?? '').trim() || null,
        telefono: (sel.telefono ?? '').trim() || null,
        notas: (sel.notas ?? '').trim() || null,
      };
      await this.supabase.actualizarProveedor(sel.id, datos);

      const idx = this.proveedores.findIndex((p: any) => p.id === sel.id);
      if (idx >= 0) Object.assign(this.proveedores[idx], datos);
      Object.assign(sel, { ...datos, notas: datos.notas || '', contacto: datos.contacto || '', telefono: datos.telefono || '' });
      sel._original = { nombre, contacto: sel.contacto, telefono: sel.telefono, notas: sel.notas };
      sel.editando = false;
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

  async guardarNuevo() {
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