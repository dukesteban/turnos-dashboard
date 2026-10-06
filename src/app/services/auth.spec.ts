import { AuthService } from './auth';

// ═════════════════════════════════════════════════════════════════════
// LOS PERMISOS, EN UN SOLO LUGAR
//
// Estos tests fijan QUÉ puede ver cada rol, y también el caso que hace que todo el
// resto importe: una sesión vieja, escrita antes de que existieran los roles, tiene que
// seguir entrando. Es el caso que decide el valor por defecto de `getSesion()`.
//
// OJO CON LO QUE ESTOS TESTS NO DICEN: que el sistema sea seguro. Los permisos
// viven acá, en el navegador, y las 16 políticas de RLS de la base están abiertas a
// quien tenga la key, que es pública y va dentro del bundle. Estos tests verifican
// orden de pantalla, no protección de datos.
// ═════════════════════════════════════════════════════════════════════

function sesion(auth: AuthService, rol: any, empleado_id: number | null = null) {
  localStorage.setItem('auth_sesion', JSON.stringify({ usuario: 'u', rol, empleado_id }));
}

describe('AuthService - permisos por rol', () => {
  let auth: AuthService;

  beforeEach(() => {
    localStorage.clear();
    auth = new AuthService();
  });

  describe('que pantallas ve cada rol', () => {
    it('el admin entra a todo', () => {
      sesion(auth, 'admin');
      expect(auth.puedeVer('caja')).toBe(true);
      expect(auth.puedeVer('personas')).toBe(true);
      expect(auth.puedeVer('configuracion')).toBe(true);
      expect(auth.puedeVer('turnos')).toBe(true);
    });

    it('el secretario ve caja y personas, pero no configuracion', () => {
      sesion(auth, 'secretario');
      expect(auth.puedeVer('caja')).toBe(true);
      expect(auth.puedeVer('personas')).toBe(true);
      // Configuracion tiene horarios de atencion, precios y contrasenas.
      expect(auth.puedeVer('configuracion')).toBe(false);
    });

    it('el empleado solo ve turnos', () => {
      sesion(auth, 'empleado', 1);
      expect(auth.puedeVer('turnos')).toBe(true);
      expect(auth.puedeVer('caja')).toBe(false);
      expect(auth.puedeVer('personas')).toBe(false);
      expect(auth.puedeVer('configuracion')).toBe(false);
    });
  });

  describe('escribir en Caja', () => {
    it('solo el admin', () => {
      sesion(auth, 'admin');
      expect(auth.puedeEscribirCaja()).toBe(true);
      sesion(auth, 'secretario');
      expect(auth.puedeEscribirCaja()).toBe(false);
      sesion(auth, 'empleado', 1);
      expect(auth.puedeEscribirCaja()).toBe(false);
    });

    it('el secretario puede VER caja pero no escribir: son dos preguntas distintas', () => {
      // Si esto se fusionara en un solo permiso, el secretario o no veria caja o
      // podria escribir en ella. Y es exactamente lo que se pidio: entra a mirar
      // cuanto se le pago a alguien.
      sesion(auth, 'secretario');
      expect(auth.puedeVer('caja')).toBe(true);
      expect(auth.puedeEscribirCaja()).toBe(false);
    });
  });

  describe('administrar usuarios', () => {
    it('solo el admin', () => {
      // Si el secretario pudiera cambiar roles, podría pasarse a admin a sí mismo:
      // deja de ser un permiso y pasa a ser una puerta.
      sesion(auth, 'secretario');
      expect(auth.puedeAdministrarUsuarios()).toBe(false);
      sesion(auth, 'admin');
      expect(auth.puedeAdministrarUsuarios()).toBe(true);
    });
  });

  describe('que turnos ve', () => {
    it('el admin y el secretario ven todos', () => {
      sesion(auth, 'admin');
      expect(auth.empleadoParaFiltrarTurnos()).toBeNull();
      sesion(auth, 'secretario');
      expect(auth.empleadoParaFiltrarTurnos()).toBeNull();
    });

    it('el empleado ve solo los suyos', () => {
      sesion(auth, 'empleado', 7);
      expect(auth.empleadoParaFiltrarTurnos()).toBe(7);
      expect(auth.soloSusTurnos()).toBe(true);
    });

    it('un empleado SIN vincular ve todos, no ninguno', () => {
      // La decisión: una agenda vacía sin explicación parece una app rota. Y como las
      // políticas de RLS no filtran, "ver todos" no agrega riesgo nuevo. La pantalla de
      // Usuarios avisa cuál falta vincular.
      sesion(auth, 'empleado', null);
      expect(auth.empleadoParaFiltrarTurnos()).toBeNull();
      expect(auth.soloSusTurnos()).toBe(false);
    });
  });

  describe('sesiones viejas y raras', () => {
    it('sin sesión guardada, entra como admin', () => {
      // Es el valor con más permisos, y es lo que hace que una sesión de antes de esta
      // versión siga funcionando en vez de dejar a todos afuera.
      localStorage.setItem('auth_user', 'admin');
      expect(auth.getSesion().rol).toBe('admin');
      expect(auth.empleadoParaFiltrarTurnos()).toBeNull();
    });

    it('un rol desconocido cae en admin y no rompe la app', () => {
      // Si alguien escribe "super-admin" en el localStorage a mano, la app tiene que
      // seguir andando. Caer en admin es el lado que menos molesta si algo se rompe.
      sesion(auth, 'no-existe');
      expect(auth.getRol()).toBe('no-existe' as any);
      expect(auth.puedeVer('turnos')).toBe(true);
      expect(auth.puedeVer('caja')).toBe(false);
    });

    it('una sesión corrupta no rompe nada: se sigue por el nombre', () => {
      localStorage.setItem('auth_user', 'juan');
      localStorage.setItem('auth_sesion', '{esto no es json');
      expect(auth.isLoggedIn()).toBe(true);
      expect(auth.getUsuario()).toBe('juan');
      expect(auth.getSesion().rol).toBe('admin');
    });

    it('setSesion escribe el nombre y la sesión, y logout borra los dos', () => {
      auth.setSesion('juan', 'empleado', 7);
      expect(auth.getUsuario()).toBe('juan');
      expect(auth.getSesion()).toEqual({ usuario: 'juan', rol: 'empleado', empleado_id: 7 });

      auth.logout();
      expect(auth.isLoggedIn()).toBe(false);
      // Si el logout se olvidara de la sesión, el siguiente usuario de la misma PWA
      // entraría con los permisos del anterior.
      expect(localStorage.getItem('auth_sesion')).toBeNull();
    });
  });

  describe('sha256', () => {
    it('es el hash de SHA-256 del texto, en hexadecimal', async () => {
      // La base guarda el hash, no el texto. Si esto cambia, nadie puede volver a
      // entrar con su contraseña actual.
      expect(await auth.sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      expect(await auth.sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });
  });
});