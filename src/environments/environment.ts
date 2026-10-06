/*
 * A DONDE VA CADA BASE
 *
 * Hay TRES archivos y no uno, porque hay dos apps y cada una lee una base
 * distinta. Angular no lee variables de entorno en el build: el valor queda
 * escrito dentro del bundle. As��� que la base se elige CONFIGURANDO EL BUILD,
 * no con una variable.
 *
 *   este archivo (sin replace)   ng serve           desarrollo local   TEST
 *   environment.prod.ts          --configuration production   TEST
 *   environment.ryf.ts           --configuration ryf         RYF
 *
 * Los dos deploys de Vercel:
 *
 *   proyecto `turnos-dashboard`  rama `main`  build `npm run build`      -> TEST
 *   proyecto `turnos-ryf`        rama `ryf`   build `npm run build:ryf`  -> RYF
 *
 * OJO: en desarrollo se usa TEST a proposito. Probar contra la base de
 * produccion significaria poder borrar un turno real mientras se prueba una
 * pantalla. Para mirar ryf hay que correr `npm run start:ryf`.
 */
export const environment = {
  production: true,
  supabaseUrl: 'https://tvzfsbudhuegsptaokng.supabase.co',
  supabaseKey: 'sb_publishable_GBc8KcZ0odk4W81ll3xD6Q_lYvZcpG3'
};