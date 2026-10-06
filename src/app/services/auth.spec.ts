import { TestBed } from '@angular/core/testing';
import { AuthService, Rol } from './auth';
import { SupabaseService } from './supabase';
import { crearSupabaseMock } from '../testing/supabase-mock';

// ═════════════════════════════════════════════════════════════════════
// LOS PERMISOS, EN UN SOLO LUGAR
//
// Estos tests fijan QUÉ puede ver cada rol, con la sesión que arma AuthService a partir
// del JWT de Supabase Auth. El rol sale de `app_metadata` de `auth.users`, no de
// localStorage: la sesión se guarda sola en el navegador y `AuthService` la rehidrata.
//
// OJO CON LO QUE ESTOS TESTS NO DICEN: que el sistema sea seguro. Los permisos
// viven acá, en el navegador, y las políticas de RLS son lo que de verdad cierra
// la base. Estos tests verifican orden de pantalla, no protección de datos.
// ═════════════════════════════════════════════════════════════════════

function sesionEn(auth: any, rol: Rol, empleado_id: number | null = null) {
  // El mock de SupabaseService devuelve una sesión armada. Como AuthService la leyó
  // en el constructor, hay que setearla ANTES de crear el servicio. Por eso este
  // helper se usa dentro de `montar`.
  return {
    client: {
      auth: {
        getSession: () => Promise.resolve({
          data: {
            session: {
              user: {
                email: 'prueba@carwash.local',
                user_metadata: { usuario: 'prueba' },
                app_metadata: { rol, ...(empleado_id ? { empleado_id } : {}) },
              },
            },
          },
          error: null,
        }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        signOut: () => Promise.resolve({ error: null }),
      },
    },
  };
}

function montar(over: Record<string, any> = {}) {
  const mock = crearSupabaseMock();
  if (over['client']) (mock as any).client = over['client'];
  for (const k of Object.keys(over)) {
    if (k !== 'client') (mock as any)[k] = over[k];
  }
  TestBed.configureTestingModule({
    providers: [
      { provide: SupabaseService, useValue: mock },
      AuthService,
    ],
  });
  const auth = TestBed.inject(AuthService);
  return { auth, mock };
}

describe('AuthService - permisos por rol', () => {
  beforeEach(() => TestBed.resetTestingModule());

  async function conSesion(rol: Rol, empleado_id: number | null = null) {
    // Cada llamada reinicia el TestBed: así se puede pedir "un admin y justo después
    // un secretario" en el mismo test, que es lo que hacen los tests de permisos.
    TestBed.resetTestingModule();
    const clientCon = sesionEn({} as any, rol, empleado_id)['client'];
    TestBed.configureTestingModule({
      providers: [
        { provide: SupabaseService, useValue: crearSupabaseMock({ client: clientCon }) },
        AuthService,
      ],
    });
    const auth = TestBed.inject(AuthService);
    await auth.asegurarSesion();
    return auth;
  }

  describe('que pantallas ve cada rol', () => {
    it('el admin entra a todo', async () => {
      const auth = await conSesion('admin');
      expect(auth.puedeVer('caja')).toBe(true);
      expect(auth.puedeVer('personas')).toBe(true);
      expect(auth.puedeVer('configuracion')).toBe(true);
      expect(auth.puedeVer('turnos')).toBe(true);
    });

    it('el secretario ve caja y personas, pero no configuracion', async () => {
      const auth = await conSesion('secretario');
      expect(auth.puedeVer('caja')).toBe(true);
      expect(auth.puedeVer('personas')).toBe(true);
      // Configuracion tiene horarios de atencion, precios y contrasenas.
      expect(auth.puedeVer('configuracion')).toBe(false);
    });

    it('el empleado solo ve turnos', async () => {
      const auth = await conSesion('empleado', 1);
      expect(auth.puedeVer('turnos')).toBe(true);
      expect(auth.puedeVer('caja')).toBe(false);
      expect(auth.puedeVer('personas')).toBe(false);
      expect(auth.puedeVer('configuracion')).toBe(false);
    });
  });

  describe('escribir en Caja', () => {
    it('solo el admin', async () => {
      expect((await conSesion('admin')).puedeEscribirCaja()).toBe(true);
      expect((await conSesion('secretario')).puedeEscribirCaja()).toBe(false);
      expect((await conSesion('empleado', 1)).puedeEscribirCaja()).toBe(false);
    });

    it('el secretario puede VER caja pero no escribir: son dos preguntas distintas', async () => {
      const auth = await conSesion('secretario');
      expect(auth.puedeVer('caja')).toBe(true);
      expect(auth.puedeEscribirCaja()).toBe(false);
    });
  });

  describe('administrar usuarios', () => {
    it('solo el admin', async () => {
      expect((await conSesion('admin')).puedeAdministrarUsuarios()).toBe(true);
      expect((await conSesion('secretario')).puedeAdministrarUsuarios()).toBe(false);
    });
  });

  describe('que turnos ve', () => {
    it('el admin y el secretario ven todos', async () => {
      expect((await conSesion('admin')).empleadoParaFiltrarTurnos()).toBeNull();
      expect((await conSesion('secretario')).empleadoParaFiltrarTurnos()).toBeNull();
    });

    it('el empleado ve solo los suyos', async () => {
      const auth = await conSesion('empleado', 7);
      expect(auth.empleadoParaFiltrarTurnos()).toBe(7);
      expect(auth.soloSusTurnos()).toBe(true);
    });

    it('un empleado SIN vincular ve todos, no ninguno', async () => {
      // La decisión: una agenda vacía sin explicación parece una app rota. Y como las
      // políticas de RLS ahora sí filtran, "ver todos" es el lado que menos molesta si
      // algo se rompe. La pantalla de Usuarios avisa cuál falta vincular.
      const auth = await conSesion('empleado', null);
      expect(auth.empleadoParaFiltrarTurnos()).toBeNull();
      expect(auth.soloSusTurnos()).toBe(false);
    });
  });

  describe('sesiones raras', () => {
    it('sin sesión, el rol es "empleado" (el lado que menos permite)', async () => {
      // …
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          { provide: SupabaseService, useValue: crearSupabaseMock({
            client: { auth: {
              getSession: () => Promise.resolve({ data: { session: null }, error: null }),
              onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
            } },
          }) },
          AuthService,
        ],
      });
      const auth = TestBed.inject(AuthService);
      await auth.asegurarSesion();
      expect(auth.getRol()).toBe('empleado');
      expect(auth.isLoggedIn()).toBe(false);
    });

    it('logout llama a signOut', async () => {
      let signOutLlamado = 0;
      const clientCon = sesionEn({} as any, 'admin')['client'];
      clientCon.auth.signOut = () => { signOutLlamado++; return Promise.resolve({ error: null }); };
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [{ provide: SupabaseService, useValue: crearSupabaseMock({ client: clientCon }) }, AuthService],
      });
      const auth = TestBed.inject(AuthService);
      await auth.logout();
      expect(signOutLlamado).toBe(1);
    });
  });
});
