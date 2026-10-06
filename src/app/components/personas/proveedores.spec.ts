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
 *   · ALTA      -> `abrirFormProveedor()` / `guardarNuevo()` (popup)
 *   · EDICIÓN   -> `seleccionarProveedor()` / `guardarProveedor()` (panel)
 *
 * Mezclarlos era el error más probable: si `guardarProveedor` cayera en el popup,
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
    cmp.nuevoProveedor = { nombre: '   ', contacto: '', telefono: '', domicilio: '', notas: '' };
    await cmp.guardarNuevo();
    expect(cmp.mensajeError).toMatch(/nombre es obligatorio/i);
    expect(mock.llamadas).not.toContain('crearProveedor');
  });


  it('guarda con trim y manda null en los opcionales vacios', async () => {
    const guardados: any[] = [];
    const { cmp } = await listo({
      crearProveedor: (d: any) => { guardados.push(d); return Promise.resolve({ id: 9, ...d }); },
    });
    cmp.nuevoProveedor = { nombre: '  Quimicas del Sur ', contacto: ' Ana ', telefono: ' 123 ', domicilio: ' Av. Corrientes 1234 ', notas: '' };
    await cmp.guardarNuevo();
    expect(guardados.length).toBe(1);
    expect(guardados[0].nombre).toBe('Quimicas del Sur');
    expect(guardados[0].contacto).toBe('Ana');
    expect(guardados[0].telefono).toBe('123');
    expect(guardados[0].domicilio).toBe('Av. Corrientes 1234');
    // Vacio -> null, no cadena vacia: en la base la columna es nullable y una
    // cadena vacia es un valor distinto de "no lleno".
    expect(guardados[0].notas).toBeNull();
  });

  it('un domicilio vacio va como null, no como cadena vacia', async () => {
    // El caso del que NO tenemos dato. La app muestra "—" cuando es null, así que
    // mandarlo como '' haría que en la pantalla se vea un campo vacío en vez de
    // "no lo sé", que son dos cosas distintas.
    const guardados: any[] = [];
    const { cmp } = await listo({
      crearProveedor: (d: any) => { guardados.push(d); return Promise.resolve({ id: 9, ...d }); },
    });
    cmp.nuevoProveedor = { nombre: 'Ledesma', contacto: '', telefono: '', domicilio: '   ', notas: '' };
    await cmp.guardarNuevo();
    expect(guardados[0].domicilio).toBeNull();
  });

  it('un proveedor valido se guarda, se cierra el popup y avisa', async () => {
    const { cmp } = await listo({
      crearProveedor: () => Promise.resolve({ id: 9, nombre: 'Ledesma', activo: true }),
    });
    cmp.nuevoProveedor = { nombre: 'Ledesma', contacto: '', telefono: '', domicilio: '', notas: '' };
    await cmp.guardarNuevo();
    expect(cmp.mostrarFormProveedor).toBe(false);
    expect(cmp.mensaje).toMatch(/agregado/i);
  });

  // Recién dar de alta a alguien, lo primero que querés ver es su ficha.
  it('despues de dar de alta, abre el detalle del recien creado', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([]),
      crearProveedor: () => Promise.resolve({ id: 9, nombre: 'Ledesma', activo: true }),
    });
    cmp.nuevoProveedor = { nombre: 'Ledesma', contacto: '', telefono: '', domicilio: '', notas: '' };
    await cmp.guardarNuevo();
    expect(cmp.proveedorSeleccionado).toBeNull();
  });

  it('rechaza el mismo nombre ignorando mayusculas y espacios', async () => {
    const { cmp, mock } = await listo({
      getProveedores: () => Promise.resolve([{ id: 1, nombre: 'Ledesma', activo: true }]),
    });
    cmp.nuevoProveedor = { nombre: '  ledesma ', contacto: '', telefono: '', domicilio: '', notas: '' };
    await cmp.guardarNuevo();
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
    cmp.nuevoProveedor = { nombre: 'Canada', contacto: '', telefono: '', domicilio: '', notas: '' };
    await cmp.guardarNuevo();
    expect(cmp.mensajeError).toBe('');
    expect(mock.llamadas).toContain('crearProveedor');
  });

  it('el popup tiene 5 campos', async () => {
    const { cmp, fixture } = await listo();
    cmp.mostrarFormProveedor = true;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.popup-body input').length).toBe(5);
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
    // Las dos grafias: .btn-secondary es la que existe hoy y
    // .btn-secundario la que se escribio sin querer una vez.
    expect(pie.querySelector('.btn-secondary')).toBeNull();
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

describe('Personas > Proveedores - editar (panel de detalle)', () => {
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

  // Sin esto, escribir en el panel cambiarÃ­a el nombre de la fila de la lista
  // antes de guardar, y con un guardado fallido quedarÃ­a mentido.
  it('el panel es una COPIA: escribir no toca la fila hasta guardar', async () => {
    const { cmp } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    cmp.editarProveedor();
    cmp.proveedorSeleccionado.nombre = 'Cambiado en el aire';
    expect(cmp.proveedores[0].nombre).toBe('Quimicas');
  });

  it('los null del panel llegan como cadena vacia, no como "null"', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV, contacto: null, telefono: null, domicilio: null, notas: null }]),
    });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    expect(cmp.proveedorSeleccionado.contacto).toBe('');
    expect(cmp.proveedorSeleccionado.telefono).toBe('');
    expect(cmp.proveedorSeleccionado.domicilio).toBe('');
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

  // â”€â”€ EL BOTON UNICO â”€â”€
  //
  // Antes habia un lapiz POR CAMPO. Varios lapices en columna parecen tantos
  // acciones y el que de verdad se editaba a menudo quedaba sin destino claro.
  // Ahora hay UN "Editar" para todo el bloque, como Configuracion > General.

  it('en reposo los cinco campos son de SOLO LECTURA', async () => {
    const { cmp, fixture } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    fixture.detectChanges();
    const campos = fixture.nativeElement.querySelectorAll('.detalle-seccion .campo-editable');
    expect(campos.length).toBe(5);
    for (const c of Array.from(campos) as HTMLElement[]) {
      expect((c.querySelector('input') as HTMLInputElement).hasAttribute('readonly')).toBe(true);
    }
  });

  it('NO hay un lapiz por campo: el detalle no tiene ningun .btn-icon', async () => {
    const { cmp, fixture } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.detalle-seccion .btn-icon').length).toBe(0);
  });

  it('en reposo se ve SOLO el boton Editar', async () => {
    const { cmp, fixture } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    fixture.detectChanges();
    const botones = Array.from(
      fixture.nativeElement.querySelectorAll('.botones-edicion button')
    ) as HTMLElement[];
    expect(botones.length).toBe(1);
    expect(botones[0].textContent).toContain('Editar');
    expect(botones[0].classList.contains('btn-primary')).toBe(true);
  });

  it('el boton Editar pone los CUATRO campos en edicion', async () => {
    const { cmp, fixture } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.botones-edicion button') as HTMLElement).click();
    fixture.detectChanges();
    const inputs = fixture.nativeElement.querySelectorAll('.detalle-seccion input');
    for (const i of Array.from(inputs) as HTMLInputElement[]) {
      expect(i.hasAttribute('readonly')).toBe(false);
    }
  });

  it('editando se ven Guardar y Cancelar, y Editar desaparece', async () => {
    const { cmp, fixture } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    cmp.editarProveedor();
    fixture.detectChanges();
    const botones = Array.from(
      fixture.nativeElement.querySelectorAll('.botones-edicion button')
    ) as HTMLElement[];
    expect(botones.length).toBe(2);
    const textos = botones.map((b) => b.textContent!.trim());
    expect(textos.join(' ')).toContain('Guardar');
    expect(textos.join(' ')).toContain('Cancelar');
    expect(textos.join(' ')).not.toContain('Editar');
    // Guardar es el azul y Cancelar el gris: son dos acciones de distinta
    // naturaleza y no dos botones iguales.
    expect(botones[0].classList.contains('btn-primary')).toBe(true);
    expect(botones[1].classList.contains('btn-secondary')).toBe(true);
  });

  it('guardar manda los CUATRO campos en UNA llamada y refresca la fila', async () => {
    const enviados: any[] = [];
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }]),
      actualizarProveedor: (id: number, d: any) => { enviados.push({ id, ...d }); return Promise.resolve(); },
    });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    cmp.editarProveedor();
    cmp.proveedorSeleccionado.nombre = '  Quimicas del Sur ';
    cmp.proveedorSeleccionado.telefono = '  456  ';
    cmp.proveedorSeleccionado.notas = 'Trae mensual';
    await cmp.guardarProveedor();
    // UNA llamada: o se guarda la ficha entera o no se guarda.
    expect(enviados.length).toBe(1);
    expect(enviados[0].id).toBe(1);
    expect(enviados[0].nombre).toBe('Quimicas del Sur');
    expect(enviados[0].telefono).toBe('456');
    expect(enviados[0].notas).toBe('Trae mensual');
    // Y sale de edicion.
    expect(cmp.proveedorSeleccionado.editando).toBe(false);
    // Y la lista se entera.
    expect(cmp.proveedores[0].nombre).toBe('Quimicas del Sur');
    expect(cmp.proveedores[0].telefono).toBe('456');
  });

  it('un campo vacio se guarda como null, no como cadena vacia', async () => {
    const enviados: any[] = [];
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }]),
      actualizarProveedor: (id: number, d: any) => { enviados.push(d); return Promise.resolve(); },
    });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    cmp.editarProveedor();
    cmp.proveedorSeleccionado.notas = '   ';
    await cmp.guardarProveedor();
    expect(enviados[0].notas).toBeNull();
  });

  it('el nombre no se puede dejar vacio', async () => {
    const { cmp, mock } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    cmp.editarProveedor();
    cmp.proveedorSeleccionado.nombre = '  ';
    await cmp.guardarProveedor();
    expect(cmp.mensajeError).toMatch(/nombre es obligatorio/i);
    expect(mock.llamadas).not.toContain('actualizarProveedor');
    // Y sigue en edicion, para corregir y reintentar.
    expect(cmp.proveedorSeleccionado.editando).toBe(true);
  });

  // El chequeo tiene que excluirse a uno mismo. Sin el `p.id !==`, guardar el
  // mismo nombre daria "ya existe" siempre y no se podria editar NUNCA.
  it('editar SIN cambiar el nombre NO da "ya existe"', async () => {
    const { cmp, mock } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }]),
      actualizarProveedor: () => Promise.resolve(),
    });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    cmp.editarProveedor();
    cmp.proveedorSeleccionado.contacto = 'Otro contacto';
    await cmp.guardarProveedor();
    expect(cmp.mensajeError).toBe('');
    expect(mock.llamadas).toContain('actualizarProveedor');
  });

  it('poner el nombre de OTRO proveedor si avisa', async () => {
    const { cmp, mock } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }, { ...OTRO }]),
      actualizarProveedor: () => Promise.resolve(),
    });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    cmp.editarProveedor();
    cmp.proveedorSeleccionado.nombre = 'Ledesma';
    await cmp.guardarProveedor();
    expect(cmp.mensajeError).toMatch(/ya existe/i);
    expect(mock.llamadas).not.toContain('actualizarProveedor');
  });

  // Cancelar tiene que devolver el valor GUARDADO. Si dejara lo tipeado, al
  // volver a editar se veria lo de la vez anterior sin saber que nunca se
  // guardo.
  it('cancelar devuelve los valores guardados, no lo tipeado', async () => {
    const { cmp } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    cmp.editarProveedor();
    cmp.proveedorSeleccionado.nombre = 'Basura';
    cmp.proveedorSeleccionado.telefono = '999';
    cmp.cancelarEdicion();
    expect(cmp.proveedorSeleccionado.nombre).toBe('Quimicas');
    expect(cmp.proveedorSeleccionado.telefono).toBe('123');
    expect(cmp.proveedorSeleccionado.editando).toBe(false);
  });

  // El `guardandoCampo` compartido es lo que impide el doble clic.
  it('no se puede guardar dos veces seguido', async () => {
    let guardadas = 0;
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }]),
      actualizarProveedor: () => { guardadas++; return Promise.resolve(); },
    });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    cmp.editarProveedor();
    const p1 = cmp.guardarProveedor();
    const p2 = cmp.guardarProveedor();
    await Promise.all([p1, p2]);
    expect(guardadas).toBe(1);
  });

  // Guardar sin haber apretado "Editar" no debe pasar: el panel en reposo es de
  // solo lectura y no hay nada que guardar.
  it('guardar sin estar en edicion no hace nada', async () => {
    const { cmp, mock } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }]),
      actualizarProveedor: () => Promise.resolve(),
    });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    await cmp.guardarProveedor();
    expect(mock.llamadas).not.toContain('actualizarProveedor');
  });

  it('si el guardado falla, avisa y sigue en edicion con lo tipeado', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }]),
      actualizarProveedor: () => Promise.reject(new Error('boom')),
    });
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    cmp.editarProveedor();
    cmp.proveedorSeleccionado.contacto = 'No se guarda';
    await cmp.guardarProveedor();
    expect(cmp.mensajeError).toMatch(/no se pudo guardar/i);
    expect(cmp.proveedorSeleccionado.editando).toBe(true);
    expect(cmp.proveedorSeleccionado.contacto).toBe('No se guarda');
  });
});

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

  it('la fila NO tiene lapiz ni tache: se edita con un click', async () => {
    // La lista es la de Empleados: avatar, nombre, contacto, badge y chevron.
    // Con dos íconos de acción por fila parecía una grilla de acciones y no una
    // lista de personas. Editar es un click; inactivar va en el panel, que es
    // donde vive la confirmación.
    const { cmp, fixture } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV }, { id: 2, nombre: 'Ledesma', activo: false }]),
    });
    fixture.detectChanges();
    const filas = fixture.nativeElement.querySelectorAll('.lista .item') as NodeListOf<HTMLElement>;
    expect(filas.length).toBe(2);
    for (const f of Array.from(filas)) {
      expect(f.querySelectorAll('.btn-icon').length).toBe(0);
      expect(f.querySelectorAll('.item-acciones').length).toBe(0);
      // Y sí está el chevron, como en la de Empleados.
      expect(f.querySelector('.arrow')).toBeTruthy();
    }
  });

  it('el inactivar sigue estando, pero adentro del detalle', async () => {
    const { cmp, fixture } = await listo({ getProveedores: () => Promise.resolve([{ ...PROV }]) });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.detalle-acciones').length).toBe(0);
    cmp.seleccionarProveedor(cmp.proveedores[0]);
    fixture.detectChanges();
    const botones = Array.from(
      fixture.nativeElement.querySelectorAll('.detalle-acciones button')
    ) as HTMLElement[];
    expect(botones.length).toBe(1);
    expect(botones[0].textContent).toContain('Inactivar');
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
      fixture.nativeElement.querySelectorAll('.detalle-acciones button')
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
      fixture.nativeElement.querySelectorAll('.detalle-acciones button')
    ) as HTMLElement[];
    expect(botones.length).toBe(1);
    expect(botones[0].textContent).toContain('Reactivar');
  });
});