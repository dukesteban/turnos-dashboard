import { Injectable, inject } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import type { Session } from '@supabase/supabase-js';
import { SupabaseService } from './supabase';

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
  private supabase = inject(SupabaseService);

  /**
   * La sesión actual, como observable. `null` si no hay.
   *
   * Antes de que existiera esto, la sesión se guardaba en `localStorage` bajo `auth_user`
   * y la app la leía sin más. Eso servía para la pantalla, pero NO para la base: el JWT que
   * se manda a Postgres no tiene rol, así que las políticas RLS no pueden distinguir al
   * admin del empleado. Desde la migración 016, la sesión viene del JWT de Supabase Auth.
   */
  private sesionSubject = new BehaviorSubject<Sesion | null>(null);
  sesion$ = this.sesionSubject.asObservable();

  /**
   * Promesa de sesión resuelta. Las guards la esperan antes de decidir, para no botar a
   * la persona al login durante el primer refresco de la app.
   *
   * Se resuelve una sola vez: supabase-js lee el localStorage en el constructor y la
   * sesión queda disponible de inmediato. La promesa solo hace falta para no leer
   * `sesionSubject` antes de que `getSession()` termine de resolverse.
   */
  private readonly lista: Promise<Sesion | null>;

  constructor() {
    this.lista = this.supabase.client.auth.getSession().then(({ data }) => {
      const s = data.session ? this.armarSesion(data.session) : null;
      this.sesionSubject.next(s);
      return s;
    });

    // Cada cambio de estado de auth (login, logout, refresh, cambio de tab) actualiza la
    // sesión. Esto incluye cuando se RENUEVA el token: sin esto el rol viejo del JWT
    // puede seguir vivo si el admin lo bajó desde otra pestaña.
    this.supabase.client.auth.onAuthStateChange((_evt, session) => {
      this.sesionSubject.next(session ? this.armarSesion(session) : null);
    });
  }

  /**
   * La sesión como un objeto plano, o `null`. Sincrónica: lee el último valor emitido.
   *
   * Las guards NO la usan sin antes `await asegurarSesion()`, que garantiza que el
   * primer `getSession()` ya terminó. Fuera de una guard, quien llama ya está dentro de
   * una pantalla, y ahí la sesión ya se resolvió.
   */
  getSesion(): Sesion {
    const s = this.sesionSubject.value;
    if (s) return s;
    // Sin sesión, no hay rol. Antes devolvía un admin por defecto, con lo que una sesión
    // vieja o un localStorage editado a mano entraba como el rol con más permisos. Eso
    // ya es historia: ahora, sin JWT no hay datos, y esto solo alimenta la pantalla.
    return { usuario: '', rol: 'empleado', empleado_id: null };
  }

  /**
   * Asegura que el primer `getSession()` ya terminó. Las guards la esperan antes de
   * preguntar si hay sesión o qué rol tiene.
   */
  asegurarSesion(): Promise<Sesion | null> {
    return this.lista;
  }

  private armarSesion(session: Session): Sesion {
    const u = session.user;
    return {
      usuario: String(u.user_metadata?.['usuario'] ?? session.user.email ?? ''),
      rol: (u.app_metadata?.['rol'] as Rol) ?? 'admin',
      // El rol tiene que venir de app_metadata porque acá está el candado de la base:
      // un usuario no puede tocarse el app_metadata a sí mismo, pero sí
      // `user_metadata`. Si el rol viniera de `user_metadata`, un empleado podría
      // hacer `supabase.auth.update({ data: { rol: 'admin' } })` y la pantalla lo
      // vería como admin. La base no, porque las políticas leen `app_metadata`.
      empleado_id: u.app_metadata?.['empleado_id']
        ? Number(u.app_metadata['empleado_id'])
        : null,
    };
  }

  getUsuario(): string {
    return this.sesionSubject.value?.usuario ?? '';
  }

  getRol(): Rol {
    // Sin sesión, el rol es el que MENOS permite ('empleado'), no admin. Antes este
    // método devolvía 'admin' por defecto, con lo que un localStorage editado a mano
    // (o una sesión vieja) entraba como el rol más poderoso. La base lo ignora: sin JWT
    // no hay datos. Pero la pantalla no tiene que mentir.
    return this.sesionSubject.value?.rol ?? 'empleado';
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
    const v = this.sesionSubject.value?.empleado_id;
    return typeof v === 'number' ? v : null;
  }

  isLoggedIn(): boolean {
    return this.sesionSubject.value !== null;
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

  /** Cierra la sesión de verdad: le avisa al servidor y borra el token local. */
  async logout() {
    await this.supabase.client.auth.signOut();
  }
}
