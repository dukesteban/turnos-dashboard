// ═══════════════════════════════════════════════════════════════════════════
// admin-usuarios
// ═══════════════════════════════════════════════════════════════════════════
//
// Que hace: crear, cambiar y borrar los usuarios de la app.
//
// Por que existe: desde la migracion 016, la base usa RLS y solo el rol `admin` puede
// tocar la tabla `usuarios`. Y las contrasenas ya no viven en la app: viven en Supabase
// Auth, que se administra con la clave de servicio. Esa clave NO puede ir en el bundle,
// porque esta escrita en el programa y se lee abriendo las DevTools. Con ella, cualquiera
// podria crear un admin en un clic.
//
// La clave de servicio la tiene el servidor de esta funcion y nadie mas. Por eso las
// altas y los resets de clave pasan por aca y no desde el navegador.
//
// QUE NO HACE ESTA
//
// No decide si la persona puede hacer lo que pide: eso lo decide el rol, que esta en el
// JWT de quien llama y se relee aca contra la base. Esta funcion no acepta un rol
// "pidalo vos" del cuerpo de la peticion.
//
// COMO LLAMA LA APP
//
//   supabase.functions.invoke('admin-usuarios', { body: { accion: 'crear', ... } })
//
// Que devuelve: { ok: true, ... } o { ok: false, error: '...' }. Nunca lanza: el error
// va en el cuerpo, para que la pantalla lo muestre tal cual.
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from 'jsr:@supabase/supabase-js@2';

const URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// El cliente de la app, pero con la clave de servicio. Se usa SOLO para leer el rol de
// quien llama y para hablar con auth.users. Cada accion vuelve a chequear el rol.
const admin = createClient(URL, SERVICE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Rol = 'admin' | 'secretario' | 'empleado';

const ROLES: Rol[] = ['admin', 'secretario', 'empleado'];

/**
 * El correo de auth que corresponde a un nombre de usuario.
 *
 * La regla esta en la base, en `public.correo_de_usuario`, y esta funcion la PREGUNTA
 * en vez de repetirla. Antes la tenia escrita aca y la app tambien, y ya se noto el costo:
 * en las pruebas el usuario prueba_fn se creo con el correo prueba-fn (el _ se
 * convierte en guion) y el login fallaba con credenciales invalidas porque buscaba el
 * otro. Con una sola definicion no hay forma de que se desincronicen.
 *
 * OJO: `correoDe` es `async` por esto. Donde antes era una llamada sincronica,
 * ahora hay que esperarla: wait correoDe(...). Olvidarse el wait no da error de
 * tipo (devuelve una Promise, que es truthy) y rompe en silencio.
 */
async function correoDe(usuario: string): Promise<string> {
  const { data } = await admin.rpc('correo_de_usuario', { p_usuario: usuario });
  return (data as string) || 'usuario@carwash.local';
}

/**
 * El rol de quien llama, o `null` si no es admin.
 *
 * NO se lee del cuerpo de la peticion. Se lee del JWT que llega en el `Authorization`,
 * y despues se vuelve a consultar `auth.users` con la clave de servicio para confirmar.
 *
 * La doble lectura es a proposito. El JWT lo valida la plataforma (la firma la verifica
 * Postgres), asi que el `app_metadata` de ahi es de fiar. Pero si el admin le cambia el
 * rol a alguien, el JWT viejo sigue sirviendo hasta que expire. Consultando la base, un
 * cambio de rol se respeta de inmediato: al que le bajan el rol, el proximo clic ya no
 * lo deja.
 */
async function rolDelLlamador(req: Request): Promise<Rol | null> {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (!token) return null;

  // getUser() valida la firma y la expiracion. Si devuelve error, no hay sesion.
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;

  const deLaBase = data.user.app_metadata?.rol;
  return ROLES.includes(deLaBase) ? deLaBase : null;
}

function fallo(mensaje: string, codigo = 400) {
  return new Response(JSON.stringify({ ok: false, error: mensaje }), {
    status: codigo,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  // La app siempre manda POST. Se acepta OPTIONS para que el navegador no lo bloquee.
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } });
  if (req.method !== 'POST') return fallo('Se esperaba POST.', 405);

  const rol = await rolDelLlamador(req);
  if (rol !== 'admin') return fallo('Solo el administrador puede administrar usuarios.', 403);

  let cuerpo: any;
  try {
    cuerpo = await req.json();
  } catch {
    return fallo('No se pudo leer el pedido.');
  }

  const accion = cuerpo?.accion;

  try {
    // ─── CREAR ────────────────────────────────────────────────────────────────
    if (accion === 'crear') {
      const usuario = String(cuerpo.usuario ?? '').trim();
      const clave = String(cuerpo.password ?? '');
      const nuevoRol = cuerpo.rol as Rol;
      const empleado_id = cuerpo.empleado_id ?? null;

      if (!usuario) return fallo('Falta el nombre de usuario.');
      if (!ROLES.includes(nuevoRol)) return fallo('El rol no es valido.');
      if (clave.length < 6) return fallo('La contrasena necesita al menos 6 caracteres.');

      const correo = await correoDe(usuario);

      // El nombre puede repetirse, el correo no. Se chequea en los dos lados para dar
      // un error que diga cual de los dos choca.
      const { data: choque } = await admin
        .from('usuarios')
        .select('id')
        .eq('usuario', usuario)
        .maybeSingle();
      if (choque) return fallo(`Ya existe un usuario llamado "${usuario}".`);

      const { data: correoTomado } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      const existeCorreo = (correoTomado?.users ?? []).some(
        (u) => (u.email ?? '').toLowerCase() === correo,
      );
      if (existeCorreo) {
        return fallo(`El correo interno de "${usuario}" (${correo}) ya lo usa otra persona. Elegi otro nombre.`);
      }

      // Primero auth, despues la fila de la app. Si la fila falla, se borra el usuario
      // de auth: al reves queda un usuario de auth sin fila, que no puede entrar a nada
      // pero tampoco se ve desde la pantalla de Usuarios.
      const { data: nuevo, error: errAuth } = await admin.auth.admin.createUser({
        email: correo,
        password: clave,
        email_confirm: true,
        user_metadata: { usuario },
        app_metadata: { rol: nuevoRol, ...(empleado_id ? { empleado_id: Number(empleado_id) } : {}) },
      });
      if (errAuth) return fallo(errAuth.message, 400);

      const { data: fila, error: errFila } = await admin
        .from('usuarios')
        .insert({
          usuario,
          rol: nuevoRol,
          empleado_id: empleado_id ? Number(empleado_id) : null,
          // El hash queda vacio a proposito: desde la 016 la contrasena la verifica
          // Supabase Auth, no la app. La columna se conserva para no romper el esquema,
          // pero no se escribe. Un SHA-256 sin sal guardado al lado de la de verdad es
          // una puerta de entrada mas, no un respaldo.
          password_hash: '',
        })
        .select()
        .single();

      if (errFila) {
        await admin.auth.admin.deleteUser(nuevo.user.id);
        return fallo('No se pudo guardar el usuario: ' + errFila.message, 400);
      }

      return Response.json({ ok: true, usuario: fila });
    }

    // ─── ACTUALIZAR NOMBRE, ROL O EMPLEADO VINCULADO ─────────────────────────
    if (accion === 'actualizar') {
      const id = Number(cuerpo.id);
      if (!id) return fallo('Falta el id del usuario.');

      // Se trae la fila actual para saber el nombre viejo, que es el que genera el
      // correo de auth. Sin esto, un renombre no se puede mapear al usuario de auth.
      const { data: filaVieja, error: errVieja } = await admin
        .from('usuarios')
        .select('usuario, rol, empleado_id')
        .eq('id', id)
        .single();
      if (errVieja || !filaVieja) return fallo('Ese usuario no existe.', 404);

      const cambios: Record<string, any> = {};
      if (cuerpo.usuario !== undefined) {
        const nombre = String(cuerpo.usuario).trim();
        if (nombre.length < 3) return fallo('El usuario necesita al menos 3 caracteres.');
        cambios.usuario = nombre;
      }
      if (cuerpo.rol !== undefined) {
        if (!ROLES.includes(cuerpo.rol)) return fallo('El rol no es valido.');
        cambios.rol = cuerpo.rol;
      }
      if (cuerpo.empleado_id !== undefined) {
        cambios.empleado_id = cuerpo.empleado_id ? Number(cuerpo.empleado_id) : null;
      }
      if (Object.keys(cambios).length === 0) return fallo('No mando ningun cambio.');

      const { data: fila, error: errFila } = await admin
        .from('usuarios')
        .update(cambios)
        .eq('id', id)
        .select()
        .single();
      if (errFila) return fallo(errFila.message, 400);

      // El rol tiene que cambiar TAMBIEN en auth, porque de ahi lo lee el JWT. Si solo se
      // cambiara en la tabla, la base y la pantalla dirian una cosa y los permisos otra,
      // y el que dirige es el JWT. Y con un renombre, el correo de auth: si no, al
      // renombrar "juan" por "juanito", el correo queda `juan@...` pero la app
      // busca `juanito@...` y no entra nadie.
      const { data: lista } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      const correoViejo = (await correoDe(filaVieja.usuario)).toLowerCase();
      const authUser = (lista?.users ?? []).find(
        (u) => (u.email ?? '').toLowerCase() === correoViejo,
      );
      if (authUser) {
        const cambiosAuth: Record<string, any> = {
          app_metadata: {
            rol: cambios.rol ?? authUser.app_metadata?.rol,
            ...(cambios.empleado_id !== undefined
              ? { empleado_id: cambios.empleado_id ?? '' }
              : {}),
          },
        };
        if (cambios.usuario && cambios.usuario !== filaVieja.usuario) {
          cambiosAuth.email = await correoDe(cambios.usuario);
          cambiosAuth.user_metadata = { usuario: cambios.usuario };
        }
        await admin.auth.admin.updateUserById(authUser.id, cambiosAuth);
      }

      return Response.json({ ok: true, usuario: fila });
    }

    // ─── RESETEAR LA CLAVE DE OTRO ────────────────────────────────────────────
    if (accion === 'resetear_clave') {
      const id = Number(cuerpo.id);
      const clave = String(cuerpo.password ?? '');
      if (!id) return fallo('Falta el id del usuario.');
      if (clave.length < 6) return fallo('La contrasena necesita al menos 6 caracteres.');

      const { data: fila, error: errFila } = await admin
        .from('usuarios')
        .select('usuario')
        .eq('id', id)
        .single();
      if (errFila || !fila) return fallo('Ese usuario no existe.', 404);

      const { data: lista } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      const correoFila = (await correoDe(fila.usuario)).toLowerCase();
        const authUser = (lista?.users ?? []).find(
        (u) => (u.email ?? '').toLowerCase() === correoFila,
      );
      if (!authUser) {
        return fallo(`"${fila.usuario}" todavia no tiene cuenta de acceso. Creala primero.`, 409);
      }

      const { error: errAuth } = await admin.auth.admin.updateUserById(authUser.id, { password: clave });
      if (errAuth) return fallo(errAuth.message, 400);

      return Response.json({ ok: true });
    }

    // ─── BORRAR ───────────────────────────────────────────────────────────────
    if (accion === 'eliminar') {
      const id = Number(cuerpo.id);
      if (!id) return fallo('Falta el id del usuario.');

      const { data: fila, error: errFila } = await admin
        .from('usuarios')
        .select('usuario')
        .eq('id', id)
        .single();
      if (errFila || !fila) return fallo('Ese usuario no existe.', 404);

      const { data: lista } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      const correoFila = (await correoDe(fila.usuario)).toLowerCase();
        const authUser = (lista?.users ?? []).find(
        (u) => (u.email ?? '').toLowerCase() === correoFila,
      );
      if (authUser) await admin.auth.admin.deleteUser(authUser.id);

      const { error: errDel } = await admin.from('usuarios').delete().eq('id', id);
      if (errDel) return fallo(errDel.message, 400);

      return Response.json({ ok: true });
    }

    return fallo('No se que pedir: la accion "' + String(accion) + '" no existe.');
  } catch (e: any) {
    // Un error sin manejar acá devuelve un 500 con la pila, que la app no sabe mostrar.
    return fallo('Error del servidor: ' + (e?.message ?? 'desconocido'), 500);
  }
});