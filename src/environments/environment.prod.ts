/*
 * EL BUILD DE TEST (el default: `ng build`, `npm run build`).
 *
 * Este archivo se usa SOLO si `angular.json` tiene el `fileReplacements` de la
 * configuracion `production`. Antes NO lo tenia, y el build de produccion se
 * quedaba con `environment.ts`, o sea que este archivo era un archivo muerto: la
 * app de test salia bien de casualidad, porque los dos archivos dicen lo mismo.
 *
 * CUAL ES CADA BASE:
 *
 *   test-lavadero  ycrhgxwnikksmwyofzmv   la de desarrollo. Datos de prueba.
 *   ryf-lavadero   tvzfsbudhuegsptaokng   la de produccion. Datos reales.
 *
 * La app que se despliega en `turnos-dashboard-mu.vercel.app` es la de TEST.
 * La de RYF va en `turnos-ryf.vercel.app`, desde la rama `ryf`, con
 * `npm run build:ryf`, que usa `environment.ryf.ts`.
 *
 * `sb_publishable_` es una clave PUBLICA a proposito: viaja dentro del bundle
 * y la lee cualquiera que abra la app. Lo que protege los datos es el RLS de
 * cada tabla, no esta clave. La `sb_secret_` de la carpeta del usuario es la que
 * no puede estar en el repo y no esta en ningun archivo de `src`.
 */
export const environment = {
  production: true,
  supabaseUrl: 'https://ycrhgxwnikksmwyofzmv.supabase.co',
  supabaseKey: 'sb_publishable_XKby3gkkk-B_Njm4wSlZXQ_cA03V_8C'
};