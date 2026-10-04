import { TestBed } from '@angular/core/testing';
import { ProveedoresComponent } from './proveedores';
import { SupabaseService } from '../../services/supabase';
import { crearSupabaseMock } from '../../testing/supabase-mock';

/**
 * Tests de COMPONENTE del ABM de Proveedores.
 *
 * Este bloque vivía entero en `caja.spec.ts` y se mudó con la pantalla. No es
 * una copia: los casos son los mismos que importan (el chequeo de duplicados
 * que distingue acentos, el `trim` antes de guardar, el `null` que se
 * convierte en cadena vacía) y ahora viven con el componente que los ejecuta.
 *
 * Un detalle que se pierde al mudarlo: el componente nuevo tiene su PROPIO
 * `cargarDatos`, no el de Caja con las cinco consultas. Eso es lo que permite
 * que Caja no tenga que seguir trayendo el ABM.
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

describe('Personas > Proveedores — carga', () => {
  it('trae los proveedores al iniciar', async () => {
    const { cmp } = montar({
      getProveedores: () => Promise.resolve([PROV, { id: 2, nombre: 'Ledesma', activo: false }]),
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

  it('trae también los INACTIVOS: la lista los muestra tachados', async () => {
    // Si solo trajera los activos, un proveedor dado de baja desaparecería y no
    // habría forma de saber que existe.
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([PROV, { id: 2, nombre: 'Ledesma', activo: false }]),
    });
    expect(cmp.proveedores.length).toBe(2);
  });
});

describe('Personas > Proveedores — buscador', () => {
  // Un buscador tiene que ignorar acentos: el usuario escribe "quimicas" sin
  // tilde y tiene que encontrar a "Quimicas del Sur". Misma razon que en
  // Clientes.
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
      getProveedores: () => Promise.resolve([PROV, { id: 2, nombre: 'Ledesma', activo: true }]),
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

describe('Personas > Proveedores — alta y edicion', () => {
  it('abrir sin argumento es un ALTA, no una edicion', async () => {
    const { cmp } = await listo({ getProveedores: () => Promise.resolve([PROV]) });
    cmp.abrirFormProveedor();
    expect(cmp.editandoProveedor).toBe(false);
    expect(cmp.proveedorEditando).toBeNull();
    expect(cmp.nuevoProveedor.nombre).toBe('');
  });

  it('abrir con un proveedor carga sus datos en el formulario', async () => {
    const { cmp } = await listo({ getProveedores: () => Promise.resolve([PROV]) });
    cmp.abrirFormProveedor(PROV);
    expect(cmp.editandoProveedor).toBe(true);
    expect(cmp.nuevoProveedor.nombre).toBe('Quimicas');
    expect(cmp.nuevoProveedor.contacto).toBe('Ana');
  });

  it('los null llegan como cadena vacia, no como "null"', async () => {
    // Si no, el input muestra literalmente la palabra "null".
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ ...PROV, contacto: null, telefono: null }]),
    });
    cmp.abrirFormProveedor({ ...PROV, contacto: null, telefono: null });
    expect(cmp.nuevoProveedor.contacto).toBe('');
    expect(cmp.nuevoProveedor.telefono).toBe('');
  });

  it('el boton Nuevo SIEMPRE abre limpio, aunque venga de editar', async () => {
    const { cmp } = await listo({ getProveedores: () => Promise.resolve([PROV]) });
    cmp.abrirFormProveedor(PROV);
    cmp.cerrarFormProveedor();
    cmp.abrirFormProveedor();
    expect(cmp.nuevoProveedor.nombre).toBe('');
    expect(cmp.editandoProveedor).toBe(false);
  });

  it('cerrar descarta el modo edicion', async () => {
    // Si cerrar solo tapara el popup y dejara `proveedorEditando` puesto, el
    // "Nuevo proveedor" de despues abriria en modo edicion.
    const { cmp } = await listo({ getProveedores: () => Promise.resolve([PROV]) });
    cmp.abrirFormProveedor(PROV);
    cmp.cerrarFormProveedor();
    expect(cmp.proveedorEditando).toBeNull();
    expect(cmp.editandoProveedor).toBe(false);
  });

  it('exige nombre', async () => {
    const { cmp, mock } = await listo();
    cmp.nuevoProveedor = { nombre: '   ', contacto: '', telefono: '', notas: '' };
    await cmp.guardarProveedor();
    expect(cmp.mensajeError).toMatch(/nombre es obligatorio/i);
    expect(mock.llamadas).not.toContain('crearProveedor');
  });

  it('guarda con trim: a la base no le mandamos espacios alrededor', async () => {
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

  it('guardar en modo edicion llama a actualizar, NO a crear', async () => {
    const actualizados: any[] = [];
    const creados: any[] = [];
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([PROV]),
      actualizarProveedor: (id: number, d: any) => { actualizados.push({ id, ...d }); return Promise.resolve(); },
      crearProveedor: (d: any) => { creados.push(d); return Promise.resolve(); },
    });
    cmp.abrirFormProveedor(PROV);
    cmp.nuevoProveedor.contacto = 'Ana Nueva';
    await cmp.guardarProveedor();
    expect(actualizados.length).toBe(1);
    expect(actualizados[0].id).toBe(1);
    expect(creados).toEqual([]);
  });

  it('si actualizar falla, el popup sigue abierto con lo tipeado', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([PROV]),
      actualizarProveedor: () => Promise.reject(new Error('boom')),
    });
    cmp.abrirFormProveedor(PROV);
    cmp.nuevoProveedor.contacto = 'No se guarda';
    await cmp.guardarProveedor();
    expect(cmp.mensajeError).toMatch(/no se pudo/i);
    expect(cmp.mostrarFormProveedor).toBe(true);
    expect(cmp.nuevoProveedor.contacto).toBe('No se guarda');
  });
});

describe('Personas > Proveedores — nombres repetidos', () => {
  // El indice unico de la base es lower(btrim(nombre)). Avisar aca evita el
  // error de Postgres.
  it('rechaza el mismo nombre ignorando mayusculas y espacios', async () => {
    const { cmp, mock } = await listo({
      getProveedores: () => Promise.resolve([
        { id: 1, nombre: 'Ledesma', contacto: null, telefono: null, activo: true },
      ]),
    });
    cmp.nuevoProveedor = { nombre: '  ledesma ', contacto: '', telefono: '', notas: '' };
    await cmp.guardarProveedor();
    expect(cmp.mensajeError).toMatch(/ya existe/i);
    expect(mock.llamadas).not.toContain('crearProveedor');
  });

  it('editar SIN cambiar el nombre NO da "ya existe"', async () => {
    // El chequeo tiene que excluirse a uno mismo. Sin el `p.id !== idEnEdicion`,
    // guardar el mismo proveedor sin tocarle el nombre daria "ya existe" siempre
    // y no se podria editar NUNCA.
    const { cmp, mock } = await listo({
      getProveedores: () => Promise.resolve([PROV]),
      actualizarProveedor: () => Promise.resolve(),
    });
    cmp.abrirFormProveedor(PROV);
    cmp.nuevoProveedor.contacto = 'Otro contacto';
    await cmp.guardarProveedor();
    expect(cmp.mensajeError).toBe('');
    expect(mock.llamadas).toContain('actualizarProveedor');
  });

  it('editar y poner el nombre de OTRO proveedor si avisa', async () => {
    const { cmp, mock } = await listo({
      getProveedores: () => Promise.resolve([
        PROV,
        { id: 2, nombre: 'Ledesma', activo: true },
      ]),
      actualizarProveedor: () => Promise.resolve(),
    });
    cmp.abrirFormProveedor(PROV);
    cmp.nuevoProveedor.nombre = 'Ledesma';
    await cmp.guardarProveedor();
    expect(cmp.mensajeError).toMatch(/ya existe/i);
    expect(mock.llamadas).not.toContain('actualizarProveedor');
  });

  // El chequeo de DUPLICADOS tiene que distinguir acentos, porque en la base
  // "Cañada" y "Canada" son dos proveedores distintos. Por eso usa
  // `paraComparar` y no `contiene` (que es el del buscador).
  it('el chequeo de duplicados NO ignora acentos', async () => {
    const { cmp } = await listo({
      getProveedores: () => Promise.resolve([{ id: 1, nombre: 'Cañada', activo: true }]),
    });
    cmp.nuevoProveedor = { nombre: 'Canada', contacto: '', telefono: '', notas: '' };
    await cmp.guardarProveedor();
    expect(cmp.mensajeError).toBe('');
  });
});

describe('Personas > Proveedores — inactivar', () => {
  it('pide confirmacion antes de inactivar', async () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { cmp, mock } = await listo({
      getProveedores: () => Promise.resolve([PROV]),
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
      getProveedores: () => Promise.resolve([PROV]),
      inactivarProveedor: (id: number) => { inactivos.push(id); return Promise.resolve(); },
    });
    await cmp.inactivarProveedor(PROV);
    expect(inactivos).toEqual([1]);
    expect(mock.llamadas).not.toContain('eliminarProveedor');
    expect(cmp.mensaje).toMatch(/inactivado/i);
    spy.mockRestore();
  });

  it('solo los activos muestran el boton de inactivar', async () => {
    const { cmp, fixture } = await listo({
      getProveedores: () => Promise.resolve([
        PROV,
        { id: 2, nombre: 'Ledesma', activo: false },
      ]),
    });
    fixture.detectChanges();
    const filas = fixture.nativeElement.querySelectorAll('.lista .item') as NodeListOf<HTMLElement>;
    expect(filas.length).toBe(2);
    // Editar siempre; inactivar solo en la activa.
    expect(filas[0].querySelectorAll('.item-acciones .btn-icon').length).toBe(2);
    expect(filas[1].querySelectorAll('.item-acciones .btn-icon').length).toBe(1);
  });
});

describe('Personas > Proveedores — la lista', () => {
  // La lista tiene que verse igual que la de Empleados: es lo unico que hace
  // que las tres pestañas de Personas parezcan la misma pantalla.
  it('es la misma lista que la de Empleados: avatar, nombre, sub y badge', async () => {
    const { cmp, fixture } = await listo({
      getProveedores: () => Promise.resolve([PROV]),
    });
    fixture.detectChanges();

    const item = fixture.nativeElement.querySelector('.lista .item');
    expect(item).toBeTruthy();
    // Avatar con la inicial del nombre.
    const avatar = item.querySelector('.avatar');
    expect(avatar.textContent.trim()).toBe('Q');
    // Nombre en `.nombre` y el dato de contacto en `.sub`: son las clases del
    // partial `_lista.scss`, no las de la tabla que usaba antes.
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
    const { cmp, fixture } = await listo({
      getProveedores: () => Promise.resolve([PROV]),
    });
    fixture.detectChanges();
    const item = fixture.nativeElement.querySelector('.lista .item') as HTMLElement;
    expect(item.getAttribute('role')).toBe('button');
    expect(item.getAttribute('tabindex')).toBe('0');
  });

  // El click en la fila es el atajo para editar. Si no existiera `editar(p)`,
  // el click abriria un "Nuevo proveedor" en el lugar donde se pidio editar.
  it('click en la fila abre la EDICION de ese proveedor', async () => {
    const { cmp, fixture } = await listo({
      getProveedores: () => Promise.resolve([PROV]),
    });
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.lista .item') as HTMLElement).click();
    fixture.detectChanges();
    expect(cmp.editandoProveedor).toBe(true);
    expect(cmp.proveedorEditando.id).toBe(1);
    expect(cmp.nuevoProveedor.nombre).toBe('Quimicas');
  });

  it('el boton de editar de la fila tambien abre la edicion', async () => {
    const { cmp, fixture } = await listo({
      getProveedores: () => Promise.resolve([PROV]),
    });
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.item-acciones .btn-icon') as HTMLElement).click();
    fixture.detectChanges();
    expect(cmp.editandoProveedor).toBe(true);
    expect(cmp.proveedorEditando.id).toBe(1);
  });
});

describe('Personas > Proveedores — el popup', () => {
  const CAMPOS = ['nombre', 'contacto', 'telefono', 'notas'];

  it('tiene 4 campos', async () => {
    const { cmp, fixture } = await listo();
    cmp.mostrarFormProveedor = true;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.popup-overlay input').length).toBe(CAMPOS.length);
  });

  it('el pie usa btn-atendido / btn-cancelado, no btn-primary / btn-secundario', async () => {
    // Los mismos nombres de clase que el popup de Nuevo Turno. Si un dia
    // divergen, este test dice cual de los dos archivos se aparto.
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

  it('el titulo dice si es alta o edicion', async () => {
    const { cmp, fixture } = await listo({ getProveedores: () => Promise.resolve([PROV]) });
    cmp.abrirFormProveedor();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Nuevo proveedor');
    cmp.abrirFormProveedor(PROV);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Editar proveedor');
  });
});