/*
 * EL BUILD DE RYF: `--configuration ryf`, o `npm run build:ryf`.
 *
 * Esta es la app que mira los DATOS REALES del lavadero. Sale del proyecto de
 * Vercel `turnos-ryf`, que se despliega cuando se mergea a la rama `ryf` del
 * repo. No se despliega desde `main`.
 *
 * OJO ANTES DE TOCAR ALGO ACA
 *
 * Esta base tiene datos que no se recuperan: turnos atendidos, pagos de
 * empleados, deudas con proveedores. Las migraciones del repo se aplicaron a
 * ryf el 6 de octubre de 2026 (ver `migrations/README.md`), pero despues de eso
 * las dos bases siguen caminando por separado.
 *
 * O sea: si se toca una migracion y se aplica en test, ACA NO ESTA. Cada base
 * necesita su propia pasada, y con esto ya se perdio una vez la 008 entera por
 * una linea que referenciaba una tabla que en ryf no existe.
 */
export const environment = {
  production: true,
  supabaseUrl: 'https://tvzfsbudhuegsptaokng.supabase.co',
  supabaseKey: 'sb_publishable_GBc8KcZ0odk4W81ll3xD6Q_lYvZcpG3'
};