import { TestBed } from '@angular/core/testing';
import { ProveedoresComponent } from './proveedores';
import { SupabaseService } from '../../services/supabase';
import { crearSupabaseMock } from '../../testing/supabase-mock';

/**
 * Tests del ABM de Proveedores.
 *
 * El bloque original venía de `caja.spec.ts` y se mudó con la pantalla.
 *
 * Lo que cambió después: la EDICIÓN dejó de ser un popup y pasó a ser el panel
 * de detalle de la derecha, igual que Clientes y Empleados. El popup quedó solo
 * para el alta. Así que hay dos caminos distintos y cada uno tiene su grupo:
 *
 *   · ALTA      -> `abrirFormProveedor()` / `guardarProveedor()` (popup)
 *   · EDICIÓN   -> `seleccionarProveedor()` / `guardarCampo()` (panel)
 *
 * Mezclarlos era el error más probable: si `guardarCampo` cayera en el popup,
 * los tests pasarían igual y la pantalla haría otra cosa.
 */

function montar(over: Record<string, any> = {}) {
  const mock = crearSupabaseMock(over);
  TestBed.configureTestingModule({
    providers: [{ provide: SupabaseService, useValue: mock }],
  });
  const fixture = TestBed.createComponent(ProveedoresComponent);
  return { cmp: fixture.componentInstance, mock, fixture };
}

const listo = async (over: Record<string, any> = {}) => {
  const r = montar(over);
  await r.cmp.cargarDatos();
  return r;
};

const PROV = { id: 1, nombre: 'Quimicas', contacto: 'Ana', telefono: '123', notas: null, activo: true };
const OTRO = { id: 2, nombre: 'Ledesma', contacto: null, telefono: null, notas: null, activo: true };

describe('Personas > Proveedores — carga', () => {
  it('trae los proveedores al iniciar', async () => {
    const { cmp } = montar({
      getProveedores: () => Promise.resolve([{ ...PROV }, { ...OTRO }]),
    });
    await cmp.ngOnInit();
    expect(cmp.proveedores.length).toBe(2);
    expect(cmp.cargando).toBe(false);
  });

  it('si la carga falla, avisa y no queda cargando', async () => {
    // Si reventara, la pantalla quedaría en blanco sin explicación.
    const { cmp } = montar({ getProveedores: () => Promise.reject(new Error('red')) });
    await cmp.cargarDatos();
    expect(cmp.proveedores).toEqual([]);
    expect(cmp.cargando).toBe(false);
    expect(cmp.mensajeError).toMatch(/no se pudieron cargar/i);
  });

  // Si solo trajera los activos, un proveedor dado de baja desaparecería y no
  // habría forma de saber que existe ni de reactivarlo.
  it('trae también los INACTIVOS: la lista los muestra tachados', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }, { id: 3, nombre: 'Viejo', activo: false }]),
    });
    expect(cmp.proveedores.length).toBe(2);
  });
});

describe('Personas > Proveedores — buscador', () => {
  // Un buscador tiene que ignorar acentos: el usuario escribe "quimicas" sin
  // tilde y tiene que encontrar a "Quimicas del Sur".
  it('ignora acentos y mayusculas', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([
        { id: 1, nombre: 'Ledesma SA', activo: true },
        { id: 2, nombre: 'Quimicas del Sur', activo: true },
      ]),
    });
    for (const q of ['quimicas', 'QUIMICAS', 'del sur', 'sur']) {
      cmp.busquedaProveedor = q;
      expect(cmp.proveedoresFiltrados.map((p: any) => p.id)).toEqual([2]);
    }
  });

  it('sin texto devuelve todos', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }, { ...OTRO }]),
    });
    cmp.busquedaProveedor = '   ';
    expect(cmp.proveedoresFiltrados.length).toBe(2);
  });

  it('busca tambien en los inactivos', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([
        { id: 1, nombre: 'Ledesma', activo: true },
        { id: 2, nombre: 'Ledesma Viejo', activo: false },
      ]),
    });
    cmp.busquedaProveedor = 'viejo';
    expect(cmp.proveedoresFiltrados.map((p: any) => p.id)).toEqual([2]);
  });
});

// ═══════════════════════════════════════════════════════════════
// ALTA — el popup
// ═══════════════════════════════════════════════════════════════

describe('Personas > Proveedores — alta (popup)', () => {
  it('abrir el popup SIEMPRE arranca limpio', async () => {
    // Aunque se haya abierto, cerrado sin guardar y vuelto a abrir: tiene que
    // venir vacio, no con el intento anterior a medias.
    const { cmp } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    cmp.nuevoProveedor.nombre = 'A medias';
    cmp.abrirFormProveedor();
    expect(cmp.mostrarFormProveedor).toBe(true);
    expect(cmp.nuevoProveedor.nombre).toBe('');
  });

  it('exige nombre', async () => {
    const { cmp, mock } = await listo();
    cmp.nuevoProveedor = { nombre: '   ', contacto: '', telefono: '', notas: '' };
    await cmp.guardarProveedor();
    expect(cmp.mensajeError).toMatch(/nombre es obligatorio/i);
    expect(mock.llamadas).not.toContain('crearProveedor');
  });

  it('guarda con trim y manda null en los opcionales vacios', async () => {
    const guardados: any[] = [];
    const { cmp } = await listo({
      crearProveedor: (d: any) => { guardados.push(d); return Promise.resolve({ id: 9, ...d }); },
    });
    cmp.nuevoProveedor = { nombre: '  Quimicas del Sur ', contacto: ' Ana ', telefono: ' 123 ', notas: '' };
    await cmp.guardarProveedor();
    expect(guardados.length).toBe(1);
    expect(guardados[0].nombre).toBe('Quimicas del Sur');
    expect(guardados[0].contacto).toBe('Ana');
    expect(guardados[0].telefono).toBe('123');
    // Vacio -> null, no cadena vacia: en la base la columna es nullable y una
    // cadena vacia es un valor distinto de "no lleno".
    expect(guardados[0].notas).toBeNull();
  });

  it('un proveedor valido se guarda, se cierra el popup y avisa', async () => {
    const { cmp } = await listo({
      crearProveedor: () => Promise.resolve({ id: 9, nombre: 'Ledesma', activo: true }),
    });
    cmp.nuevoProveedor = { nombre: 'Ledesma', contacto: '', telefono: '', notas: '' };
    await cmp.guardarProveedor();
    expect(cmp.mostrarFormProveedor).toBe(false);
    expect(cmp.mensaje).toMatch(/agregado/i);
  });

  // Recién dar de alta a alguien, lo primero que querés ver es su ficha.
  it('despues de dar de alta, abre el detalle del recien creado', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([]),
      crearProveedor: () => Promise.resolve({ id: 9, nombre: 'Ledesma', activo: true }),
    });
    cmp.nuevoProveedor = { nombre: 'Ledesma', contacto: '', telefono: '', notas: '' };
    await cmp.guardarProveedor();
    expect(cmp.proveedorSeleccionado).toBeNull();
  });

  it('rechaza el mismo nombre ignorando mayusculas y espacios', async () => {
    const { cmp, mock } = await listo({
      getProveedores: () => Promise.resolve([{ id: 1, nombre: 'Ledesma', activo: true }]),
    });
    cmp.nuevoProveedor = { nombre: '  ledesma ', contacto: '', telefono: '', notas: '' };
    await cmp.guardarProveedor();
    expect(cmp.mensajeError).toMatch(/ya existe/i);
    expect(mock.llamadas).not.toContain('crearProveedor');
  });

  // El chequeo de DUPLICADOS tiene que distinguir acentos, porque en la base
  // "Canada" y "Cañada" son dos proveedores distintos. Por eso usa
  // `paraComparar` y no `contiene` (que es el del buscador).
  it('el chequeo de duplicados NO ignora acentos', async () => {
    const { cmp, mock } = await listo({
      getProveedores: () => Promise.resolve([{ id: 1, nombre: 'Cañada', activo: true }]),
    });
    cmp.nuevoProveedor = { nombre: 'Canada', contacto: '', telefono: '', notas: '' };
    await cmp.guardarProveedor();
    expect(cmp.mensajeError).toBe('');
    expect(mock.llamadas).toContain('crearProveedor');
  });

  it('el popup tiene 4 campos', async () => {
    const { cmp, fixture } = await listo();
    cmp.mostrarFormProveedor = true;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.popup-body input').length).toBe(4);
  });

  // Los mismos nombres de clase que el popup de Nuevo Turno. Si un dia
  // divergen, este test dice cual de los dos archivos se aparto.
  it('el pie usa btn-atendido / btn-cancelado, no btn-primary / btn-secundario', async () => {
    const { cmp, fixture } = await listo();
    cmp.mostrarFormProveedor = true;
    fixture.detectChanges();
    const pie = fixture.nativeElement.querySelector('.popup-acciones');
    expect(pie).toBeTruthy();
    expect(pie.querySelector('.btn-atendido')).toBeTruthy();
    expect(pie.querySelector('.btn-cancelado')).toBeTruthy();
    expect(pie.querySelector('.btn-primary')).toBeNull();
    expect(pie.querySelector('.btn-secundario')).toBeNull();
  });

  it('el error se muestra con error-msg, no con alerta', async () => {
    const { cmp, fixture } = await listo();
    cmp.mostrarFormProveedor = true;
    cmp.mensajeError = 'El nombre es obligatorio.';
    fixture.detectChanges();
    const body = fixture.nativeElement.querySelector('.popup-body');
    expect(body.querySelectorAll('.error-msg').length).toBe(1);
    expect(body.querySelectorAll('.alerta').length).toBe(0);
  });

  // Un `it` por campo y con fixture nuevo en cada uno. Reusar el mismo fixture
// para los cuatro tira NG0100: el `*ngIf` del error ya quedo evaluado en la
// vuelta anterior y cambiar `mensajeError` a mano se ve como un cambio que
// Angular no autobustho.
for (const campo of ['nombre', 'contacto', 'telefono', 'notas']) {
  it(`tocar "${campo}" borra el error del popup`, async () => {
    const { cmp, fixture } = await listo();
    cmp.mostrarFormProveedor = true;
    cmp.mensajeError = '❌ El nombre es obligatorio.';
    fixture.detectChanges();

    const inputs = fixture.nativeElement.querySelectorAll('.popup-body input');
    const indice = ['nombre', 'contacto', 'telefono', 'notas'].indexOf(campo);
    const input = inputs[indice] as HTMLInputElement;
    input.value = 'Quimicas del Sur';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(cmp.mensajeError).toBe('');
  });
}
});

// ═══════════════════════════════════════════════════════════════
// EDICIÓN — el panel de detalle
// ═══════════════════════════════════════════════════════════════

describe('Personas > Proveedores — editar (panel de detalle)', () => {
  it('click en la fila abre el detalle de ESE proveedor', async () => {
    const { cmp, fixture } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }, { ...OTRO }]),
    });
    fixture.detectChanges();
    (fixture.nativeElement.querySelectorAll('.lista .item')[1] as HTMLElement).click();
    fixture.detectChanges();
    expect(cmp.proveedorSeleccionado.id).toBe(2);
    expect(cmp.proveedorSeleccionado.nombre).toBe('Ledesma');
    // Y el panel aparece al costado: es lo que hace `.con-detalle`.
    const layout = fixture.nativeElement.querySelector('.layout');
    expect(layout.classList.contains('con-detalle')).toBe(true);
    expect(fixture.nativeElement.querySelector('.detalle-seccion')).toBeTruthy();
  });

  // Sin esto, escribir en el panel cambiaría el nombre de la fila de la lista
  // antes de guardar, y con un guardado fallido quedaría mentido.
  it('el panel es una COPIA: escribir no toca la fila hasta guardar', async () => {
    const { cmp } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    cmp.proveedorSeleccionado.nombre = 'Cambiado en el aire';
    expect(cmp.proveedores[0].nombre).toBe('Quimicas');
  });

  it('los null del panel llegan como cadena vacia, no como "null"', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV, contacto: null, telefono: null, notas: null }]),
    });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    expect(cmp.proveedorSeleccionado.contacto).toBe('');
    expect(cmp.proveedorSeleccionado.telefono).toBe('');
    expect(cmp.proveedorSeleccionado.notas).toBe('');
  });

  it('cerrar el detalle lo cierra y no borra nada de la lista', async () => {
    const { cmp, fixture } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.detalle-seccion .btn-cerrar') as HTMLElement).click();
    fixture.detectChanges();
    expect(cmp.proveedorSeleccionado).toBeNull();
    expect(cmp.proveedores.length).toBe(1);
    expect(fixture.nativeElement.querySelector('.detalle-seccion')).toBeNull();
  });

  it('cada campo arranca en modo lectura y con su propio lapiz', async () => {
    const { cmp, fixture } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    fixture.detectChanges();
    const campos = fixture.nativeElement.querySelectorAll('.detalle-seccion .campo-editable');
    expect(campos.length).toBe(4);
    for (const c of Array.from(campos) as HTMLElement[]) {
      const input = c.querySelector('input') as HTMLInputElement;
      // `readonly` es lo que hace que en reposo se vea como un dato y no como
      // un formulario esperando que lo escriban.
      expect(input.hasAttribute('readonly')).toBe(true);
      expect(c.querySelectorAll('.btn-icon').length).toBe(1);
    }
  });

  it('el lapiz pone SOLO ese campo en edicion', async () => {
    const { cmp, fixture } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    fixture.detectChanges();
    const campos = fixture.nativeElement.querySelectorAll('.detalle-seccion .campo-editable');
    (campos[0].querySelector('.btn-icon') as HTMLElement).click();
    fixture.detectChanges();
    const inputs = fixture.nativeElement.querySelectorAll('.detalle-seccion input');
    expect((inputs[0] as HTMLInputElement).hasAttribute('readonly')).toBe(false);
    expect((inputs[1] as HTMLInputElement).hasAttribute('readonly')).toBe(true);
    // Y el campo en edicion muestra guardar + cancelar.
    expect(campos[0].querySelectorAll('.btn-icon').length).toBe(2);
  });

  it('guardar manda SOLO el campo editado y refresca la fila', async () => {
    const enviados: any[] = [];
    const { cmp, fixture } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }]),
      actualizarProveedor: (id: number, d: any) => { enviados.push({ id, ...d }); return Promise.resolve(); },
    });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    cmp.proveedorSeleccionado.telefono = '  456  ';
    await cmp.guardarCampo('telefono');
    expect(enviados.length).toBe(1);
    expect(enviados[0].id).toBe(1);
    // Un update por campo, no los cuatro: si mandara todos, cada guardado
    // pisaria con null los opcionales que el usuario no toco.
    expect(Object.keys(enviados[0])).toEqual(['id', 'telefono']);
    expect(enviados[0].telefono).toBe('456');
    // Y la lista se entera.
    expect(cmp.proveedores[0].telefono).toBe('456');
  });

  it('un campo vacio se guarda como null, no como cadena vacia', async () => {
    const enviados: any[] = [];
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }]),
      actualizarProveedor: (id: number, d: any) => { enviados.push(d); return Promise.resolve(); },
    });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    cmp.proveedorSeleccionado.notas = '   ';
    await cmp.guardarCampo('notas');
    expect(enviados[0].notas).toBeNull();
  });

  it('el nombre no se puede dejar vacio', async () => {
    const { cmp, mock } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    cmp.proveedorSeleccionado.nombre = '  ';
    await cmp.guardarCampo('nombre');
    expect(cmp.mensajeError).toMatch(/nombre es obligatorio/i);
    expect(mock.llamadas).not.toContain('actualizarProveedor');
  });

  // El chequeo tiene que excluirse a uno mismo. Sin el `p.id !== id`, guardar
  // el mismo nombre daria "ya existe" siempre y no se podria editar NUNCA.
  it('editar SIN cambiar el nombre NO da "ya existe"', async () => {
    const { cmp, mock } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }]),
      actualizarProveedor: () => Promise.resolve(),
    });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    cmp.proveedorSeleccionado.contacto = 'Otro contacto';
    await cmp.guardarCampo('contacto');
    expect(cmp.mensajeError).toBe('');
    expect(mock.llamadas).toContain('actualizarProveedor');
  });

  it('poner el nombre de OTRO proveedor si avisa', async () => {
    const { cmp, mock } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }, { ...OTRO }]),
      actualizarProveedor: () => Promise.resolve(),
    });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    cmp.proveedorSeleccionado.nombre = 'Ledesma';
    await cmp.guardarCampo('nombre');
    expect(cmp.mensajeError).toMatch(/ya existe/i);
    expect(mock.llamadas).not.toContain('actualizarProveedor');
  });

  // Cancelar tiene que devolver el valor GUARDADO. Si dejara lo tipeado, al
  // volver a editar el campo el usuario veria lo que escribio la vez anterior
  // sin saber que nunca se guardo.
  it('cancelar devuelve el valor guardado, no lo tipeado', async () => {
    const { cmp } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    cmp.proveedorSeleccionado.nombre = 'Basura';
    cmp.cancelarCampo('nombre');
    expect(cmp.proveedorSeleccionado.nombre).toBe('Quimicas');
    expect(cmp.proveedorSeleccionado.editando['nombre']).toBe(false);
  });

  // El `guardandoCampo` compartido es lo que impide el doble clic: dos updates
  // del mismo campo.
  it('no se puede guardar dos veces el mismo campo seguido', async () => {
    let guardadas = 0;
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }]),
      actualizarProveedor: () => {guardadas++; return Promise.resolve(); },
    });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    const p1 = cmp.guardarCampo('telefono');
    const p2 = cmp.guardarCampo('telefono');
    await Promise.all([p1, p2]);
    expect(guardadas).toBe(1);
  });

  it('si el guardado falla, avisa y deja el campo en edicion', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }]),
      actualizarProveedor: () => Promise.reject(new Error('boom')),
    });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    cmp.editarCampo('contacto');
    await cmp.guardarCampo('contacto');
    expect(cmp.mensajeError).toMatch(/no se pudo guardar/i);
    // Sigue editable para corregir y reintentar, y lo tipeado no se pierde.
    expect(cmp.proveedorSeleccionado.editando['contacto']).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// LA LISTA — el estilo compartido con Empleados
// ═══════════════════════════════════════════════════════════════

describe('Personas > Proveedores — la lista', () => {
  // La lista tiene que verse igual que la de Empleados: es lo unico que hace
  // que las tres pestañas de Personas parezcan la misma pantalla.
  it('es la misma lista que la de Empleados: avatar, nombre, sub y badge', async () => {
    const { cmp, fixture } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    fixture.detectChanges();
    const item = fixture.nativeElement.querySelector('.lista .item');
    expect(item).toBeTruthy();
    expect(item.querySelector('.avatar').textContent.trim()).toBe('Q');
    expect(item.querySelector('.nombre').textContent).toContain('Quimicas');
    expect(item.querySelector('.sub').textContent).toContain('Ana');
    expect(item.querySelector('.estado-badge').textContent.trim()).toBe('Activo');
  });

  it('marca el badge y la fila del proveedor inactivo', async () => {
    const { cmp, fixture } = await listo({
      getProveedores: () => Promise.resolve([{ id: 2, nombre: 'Ledesma', activo: false }]),
    });
    fixture.detectChanges();
    const item = fixture.nativeElement.querySelector('.lista .item');
    expect(item.classList.contains('inactivo')).toBe(true);
    const badge = item.querySelector('.estado-badge');
    expect(badge.textContent.trim()).toBe('Inactivo');
    expect(badge.classList.contains('inactivo')).toBe(true);
  });

  it('el contacto y el telefono van juntos; si no hay ninguno, lo dice', async () => {
    const { cmp, fixture } = await listo({
      getProveedores: () => Promise.resolve([
        { id: 1, nombre: 'Con datos', contacto: 'Ana', telefono: '123', activo: true },
        { id: 2, nombre: 'Sin datos', contacto: null, telefono: null, activo: true },
      ]),
    });
    fixture.detectChanges();
    const subs = fixture.nativeElement.querySelectorAll('.lista .sub');
    expect(subs[0].textContent).toContain('Ana');
    expect(subs[0].textContent).toContain('123');
    // La linea vacia es mas clara que un rengon en blanco.
    expect(subs[1].textContent).toContain('Sin datos de contacto');
  });

  // Sin esto el item es un div con click: no se puede llegar con el teclado ni
  // lo anuncia un lector de pantalla.
  it('cada fila es alcanzable con el teclado', async () => {
    const { cmp, fixture } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    fixture.detectChanges();
    const item = fixture.nativeElement.querySelector('.lista .item') as HTMLElement;
    expect(item.getAttribute('role')).toBe('button');
    expect(item.getAttribute('tabindex')).toBe('0');
  });

  it('el lapiz de la fila abre el detalle (y no el popup)', async () => {
    const { cmp, fixture } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.item-acciones .btn-icon') as HTMLElement).click();
    fixture.detectChanges();
    expect(cmp.proveedorSeleccionado.id).toBe(1);
    // La prueba de que NO es el popup: este solo queda para el alta.
    expect(cmp.mostrarFormProveedor).toBe(false);
  });

  it('solo los activos muestran el boton de inactivar', async () => {
    const { cmp, fixture } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }, { id: 2, nombre: 'Ledesma', activo: false }]),
    });
    fixture.detectChanges();
    const filas = fixture.nativeElement.querySelectorAll('.lista .item') as NodeListOf<HTMLElement>;
    expect(filas.length).toBe(2);
    // Activo: editar + inactivar. Inactivo: solo editar (el reactivar esta en
    // el detalle, porque el 🚫 desaparece de la fila).
    expect(filas[0].querySelectorAll('.item-acciones .btn-icon').length).toBe(2);
    expect(filas[1].querySelectorAll('.item-acciones .btn-icon').length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// INACTIVAR / REACTIVAR
// ═══════════════════════════════════════════════════════════════

describe('Personas > Proveedores — inactivar y reactivar', () => {
  it('pide confirmacion antes de inactivar', async () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { cmp, mock } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }]),
      inactivarProveedor: () => Promise.resolve(),
    });
    await cmp.inactivarProveedor(PROV);
    expect(spy).toHaveBeenCalled();
    // Con el confirm en "no", no se toca la base.
    expect(mock.llamadas).not.toContain('inactivarProveedor');
    spy.mockRestore();
  });

  // Inactivar y no borrar: las compras viejas tienen que seguir apuntando a
  // alguien. Si se borrara, cada compra historica quedaria con un "#12" sin
  // nombre en el historial de Caja.
  it('inactivar lo marca inactivo y NO lo borra', async () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const inactivos: number[] = [];
    const { cmp, mock } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }]),
      inactivarProveedor: (id: number) => { inactivos.push(id); return Promise.resolve(); },
    });
    await cmp.inactivarProveedor(PROV);
    expect(inactivos).toEqual([1]);
    expect(mock.llamadas).not.toContain('eliminarProveedor');
    expect(cmp.mensaje).toMatch(/inactivado/i);
    spy.mockRestore();
  });

  // Si el 🚫 desaparece de la fila cuando el proveedor esta inactivo, el unico
  // lugar desde donde volverlo atras es el detalle. Por eso este metodo.
  it('reactivar lo vuelve a activo y NO pide confirmacion', async () => {
    const spy = vi.spyOn(window, 'confirm');
    const activos: number[] = [];
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ id: 2, nombre: 'Viejo', activo: false }]),
      activarProveedor: (id: number) => { activos.push(id); return Promise.resolve(); },
    });
    await cmp.reactivarProveedor(cmp.proveedores[0]);
    expect(activos).toEqual([2]);
    // No se borra nada: confirmar cada reactivacion pone un "si" en el medio
    // de deshacer algo que el propio usuario acaba de hacer.
    expect(spy).not.toHaveBeenCalled();
    expect(cmp.mensaje).toMatch(/reactivado/i);
    spy.mockRestore();
  });

  // Un `it` por estado, con fixture propio: cambiar `activo` a mano sobre el
// objeto del panel tira NG0100, porque el `[class.inactivo]` ya se evaluo con
// el valor viejo.
it('con el proveedor activo, el detalle ofrece "Inactivar"', async () => {
    const { cmp, fixture } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    fixture.detectChanges();
    const botones = Array.from(
      fixture.nativeElement.querySelectorAll('.proveedor-acciones button')
    ) as HTMLElement[];
    expect(botones.length).toBe(1);
    expect(botones[0].textContent).toContain('Inactivar');
  });

  it('con el proveedor inactivo, el detalle ofrece "Reactivar"', async () => {
    // El 🚫 desaparece de la fila cuando el proveedor esta inactivo, asi que el
    // detalle es el UNICO lugar desde donde volverlo a activar.
    const { cmp, fixture } = await listo({
      getProveedores: () => Promise.resolve([{ id: 2, nombre: 'Viejo', activo: false }]),
    });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    fixture.detectChanges();
    const botones = Array.from(
      fixture.nativeElement.querySelectorAll('.proveedor-acciones button')
    ) as HTMLElement[];
    expect(botones.length).toBe(1);
    expect(botones[0].textContent).toContain('Reactivar');
  });
});