/**
 * MENSAJE SUELTO AL CLIENTE (cancelación / reprogramación)
 *
 * Lo llama el panel cuando el negocio cancela o reprograma un turno y quiere
 * avisarle al cliente por WhatsApp. Antes esto pegaba a un webhook de n8n en
 * Railway que ya no existe, y como nadie miraba la respuesta, el mensaje no
 * salía y la pantalla decía que sí.
 *
 * POR QUE NO SE MANDA DESDE EL PANEL
 *
 * El token de Meta no puede vivir en el navegador: cualquiera lo lee en el
 * bundle y manda mensajes con el número del negocio. La función lo guarda como
 * secreto de Supabase, igual que el bot.
 *
 * EL LÍMITE DE LAS 24 HORAS
 *
 * Meta deja mandar texto libre solo si el cliente escribió en las últimas 24 h.
 * Fuera de eso hay que usar una plantilla aprobada. Cuando falta la plantilla,
 * esto devuelve `fuera_de_ventana` y el panel ofrece abrir WhatsApp con el
 * mensaje ya escrito, en vez de mostrar un "enviado" que no pasó.
 *
 * Pide sesión: el `apikey` público también es un JWT válido, así que con
 * `verify_jwt` solo alcanzaría para que cualquiera con el bundle mande mensajes.
 * Por eso se valida el usuario, no solo la firma.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const WA_TOKEN = Deno.env.get('WHATSAPP_TOKEN') ?? '';
const WA_PHONE_ID = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(cuerpo: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** Los últimos 10 dígitos: es lo que se guarda en `telefonos` (sin país). */
function ultimosDigitos(t: string): string {
  return (t ?? '').replace(/\D/g, '').slice(-10);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, codigo: 'metodo' }, 405);

  // ─── Solo gente logueada en el panel ───
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ ok: false, codigo: 'sin_sesion' }, 401);

  const sb = createClient(SB_URL, SB_ANON, { auth: { persistSession: false } });
  const { data: quien } = await sb.auth.getUser(token);
  if (!quien?.user) return json({ ok: false, codigo: 'sin_sesion' }, 401);

  if (!WA_TOKEN || !WA_PHONE_ID) {
    return json({ ok: false, codigo: 'sin_configuracion', error: 'Falta el token de WhatsApp.' });
  }

  let cuerpo: { telefono?: string; texto?: string };
  try {
    cuerpo = await req.json();
  } catch {
    return json({ ok: false, codigo: 'cuerpo' }, 400);
  }

  const texto = (cuerpo.texto ?? '').trim();
  const digitos = ultimosDigitos(cuerpo.telefono ?? '');
  if (digitos.length < 10) return json({ ok: false, codigo: 'sin_telefono' });
  if (!texto) return json({ ok: false, codigo: 'sin_texto' });

  // Meta acepta el número sin el 9 y el webhook lo manda con el 9: se prueban
  // las dos formas, igual que en los recordatorios.
  const formas = [`549${digitos}`, `54${digitos}`];
  let ultimoError = '';
  let codigoMeta: number | null = null;

  for (const to of formas) {
    const r = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: texto },
      }),
    });

    if (r.ok) return json({ ok: true });

    const data = await r.json().catch(() => ({}));
    ultimoError = data?.error?.message ?? 'Meta rechazó el mensaje.';
    codigoMeta = data?.error?.code ?? null;

    // 131030 = "no autorizado / no está en la lista": con la otra forma suele andar.
    if (codigoMeta !== 131030) break;
  }

  // 131047 y 131026: el cliente no escribió en las últimas 24 h (o no aceptó
  // mensajes). No es un error nuestro: hace falta una plantilla aprobada.
  const fueraDeVentana = codigoMeta === 131047 || codigoMeta === 131026;

  return json({
    ok: false,
    codigo: fueraDeVentana ? 'fuera_de_ventana' : 'error',
    error: ultimoError.slice(0, 300),
  });
});
