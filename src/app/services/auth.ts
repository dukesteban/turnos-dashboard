import { Injectable } from '@angular/core';

/**
 * Los tres roles de la app.
 *
 * Un `string` y no una unión de literales porque viene de la base y a lo largo del
 * código se compara con `===` contra valores que TypeScript no puede verificar. Con la
 * unión, el type checker obliga a que cada comparación esté completa, y eso obliga a
 * agregar el caso nuevo en todas partes, que es lo que hay que hacer igual.
 *
 * LOS PERMISOS, EN UN SOLO LUGAR
 *
 * Cada "¿puede ver?" y "¿puede tocar?" se responde con un método de acá, no con un
 * `*ngIf` que compara el rol contra un string suelto. La razón es que el permiso
 * "el secretario ve Caja pero no escribe" no es un rol: es una combinación de ver y
 * escribir. Si eso vive en el template, el mismo `*ngIf` queda en ocho lugares y
 * cualquier cambio se aplica a a algunos y no a otros.
 */
export type Rol = 'admin' | 'secretario' | 'empleado';

export const ROLES: { clave: Rol; nombre: string; quePuede: string }[] = [
  { clave: 'admin', nombre: 'Administrador', quePuede: 'Ve y modifica todo, y administra los usuarios.' },
  { clave: 'secretario', nombre: 'Secretario', quePuede: 'Ve todo, pero no escribe ni borra nada de Caja.' },
  { clave: 'empleado', nombre: 'Empleado', quePuede: 'Solo Turnos y Agenda, y unicamente sus propios turnos.' },
];

/** La sesión guardada en el navegador. */
export interface Sesion {
  usuario: string;
  rol: Rol;
  empleado_id: number | null;
}

@Injectable({ providedIn: 'root' })
export class AuthService {

  private readonly KEY = 'auth_user';
  /**
   * La sesión completa, en una clave aparte del nombre.
   *
   * En vez de meter el rol adentro de `auth_user` (que hoy es un string pelado) para no
   * romper `getUsuario()`, que lo usan el login, el cambio de contraseña y el logout.
   * Migrar los dos juntos se puede, pero entonces hay que tocar esos tres lugares y
   * el cambio de contraseña se rompe si alguno se queda atrás.
   *
   * Y el nombre queda como estaba para que una sesión vieja (de antes de esta versión)
   * siga siendo válida en vez de dejar a todos afuera con la app abierta.
   */
  private readonly KEY_SESION = 'auth_sesion';

  async sha256(text: string): Promise<string> {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  isLoggedIn(): boolean {
    return !!localStorage.getItem(this.KEY);
  }

  getUsuario(): string {
    return localStorage.getItem(this.KEY) || '';
  }

  /**
   * La sesión, o `null` si no hay.
   *
   * `JSON.parse` puede tirar si alguien edited el localStorage a mano o si quedó una
   * escritura a medias, así que va en un try. Una sesión corrupta tiene que ser lo
   * mismo que no tener sesión, no una pantalla en blanco.
   *
   * `admin` como valor por defecto cuando no hay sesión guardada: es el valor con más
   * permisos, y es lo que hace que una sesión vieja (creada antes de que existiera el
   * rol) siga funcionando. El costo es que un localStorage borrado a mano abre la app
   * como admin en vez de cerrar; el login real está en la base, esto es lo que hay
   * arriba de eso.
   */
  getSesion(): Sesion {
    try {
      const crudo = localStorage.getItem(this.KEY_SESION);
      if (crudo) {
        const s = JSON.parse(crudo);
        if (s && s.usuario) {
          return { usuario: String(s.usuario), rol: (s.rol || 'admin') as Rol, empleado_id: s.empleado_id ?? null };
        }
      }
    } catch (e) {
      // Sesion ilegible: se sigue por el nombre, que es lo unico que se puede saber.
    }
    return { usuario: this.getUsuario(), rol: 'admin', empleado_id: null };
  }

  getRol(): Rol {
    return this.getSesion().rol;
  }

  /**
   * El `empleado_id` del usuario, o `null`.
   *
   * El nombre de la persona NO sirve para filtrar turnos: el usuario escribe "juan" y
   * el turno tiene un `empleado_id` numérico. Si el usuario no está vinculado a un
   * empleado, esto devuelve `null` y el filtro deja pasar todo, que es el mismo
   * comportamiento que tuvo siempre la app. En la pantalla de Usuarios se ve cuál
   * falta.
   */
  getEmpleadoId(): number | null {
    const v = this.getSesion().empleado_id;
    return typeof v === 'number' ? v : null;
  }

  esAdmin(): boolean { return this.getRol() === 'admin'; }
  esSecretario(): boolean { return this.getRol() === 'secretario'; }
  esEmpleado(): boolean { return this.getRol() === 'empleado'; }

  /**
   * ¿Puede abrir esta pantalla?
   *
   * `caja` y `personas` son `admin | secretario`: el secretario entra a Caja a mirarla.
   * `configuracion` solo para admin, porque ahí se cambian los horarios de atención, los
   * precios y las contraseñas, y nada de eso es del secretario.
   */
  puedeVer(pantalla: 'caja' | 'personas' | 'configuracion' | 'turnos'): boolean {
    const rol = this.getRol();
    switch (pantalla) {
      case 'turnos': return true;                       // todos entran a Turnos y Agenda
      case 'caja': return rol === 'admin' || rol === 'secretario';
      case 'personas': return rol === 'admin' || rol === 'secretario';
      case 'configuracion': return rol === 'admin';
    }
  }

  /**
   * ¿Puede ESCRIBIR en Caja?
   *
   * La única diferencia entre admin y secretario: el secretario puede abrir Caja y ver
   * los tres cuadros, pero no registra pagos ni deudas.
   */
  puedeEscribirCaja(): boolean {
    return this.getRol() === 'admin';
  }

  /**
   * ¿Puede administrar los usuarios?
   *
   * Solo el admin. Si el secretario pudiera cambiar roles, podría pasarse a admin a sí
   * mismo, que deja de ser un permiso y pasa a ser una puerta.
   */
  puedeAdministrarUsuarios(): boolean {
    return this.getRol() === 'admin';
  }

  /**
   * ¿Este usuario tiene que ver solamente sus turnos?
   *
   * Solo el rol empleado. Y solo si además está vinculado a un empleado: un usuario
   * empleado sin `empleado_id` no puede filtrar por nada, así que se trata como
   * "ve todo" y no como una pantalla vacía que lo confunde. La pantalla de Usuarios
   * avisa cuál es.
   */
  soloSusTurnos(): boolean {
    return this.getRol() === 'empleado' && this.getEmpleadoId() !== null;
  }

  /**
   * El `empleado_id` con el que hay que filtrar los turnos, o `null` si tiene que ver
   * todos.
   *
   * Es la forma de que los tres componentes que muestran turnos (Dashboard, Agenda y
   * el filtro de Agenda) usen el MISMO criterio sin repetir la condición de rol en
   * cada uno. Si mañana se agrega un cuarto rol, se cambia acá y no en tres getters.
   *
   * Con `null` devuelto, `soloLosTurnosDe` deja la lista como está: el admin y el
   * secretario no filtran, y el empleado sin `empleado_id` tampoco.
   */
  empleadoParaFiltrarTurnos(): number | null {
    return this.soloSusTurnos() ? this.getEmpleadoId() : null;
  }

  login(usuario: string) {
    localStorage.setItem(this.KEY, usuario);
  }

  /**
   * Guardar la sesión al entrar.
   *
   * Se escribe DESPUÉS del nombre, no antes: si la app se cierra entre las dos
   * escrituras, el nombre queda y la sesión no, que es el estado de una sesión vieja y
   * la app sigue entrando como admin. Al revés, quedaría el nombre sin sesión, que es
   * el mismo resultado pero del lado que menos información tiene.
   */
  setSesion(usuario: string, rol: Rol, empleado_id: number | null) {
    localStorage.setItem(this.KEY, usuario);
    localStorage.setItem(this.KEY_SESION, JSON.stringify({ usuario, rol, empleado_id }));
  }

  logout() {
    localStorage.removeItem(this.KEY);
    localStorage.removeItem(this.KEY_SESION);
  }
}