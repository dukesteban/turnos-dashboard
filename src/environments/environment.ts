/*
 * A DONDE VA CADA BASE
 *
 * Hay TRES archivos y no uno, porque hay dos apps y cada una lee una base
 * distinta. Angular no lee variables de entorno en el build: el valor queda
 * escrito dentro del bundle. Así que la base se elige CONFIGURANDO EL BUILD,
 * no con una variable.
 *
 *   este archivo (sin replace)   ng serve           desarrollo local   TEST
 *   environment.prod.ts          --configuration production   TEST
 *   environment.ryf.ts           --configuration ryf         RYF
 *
 * Los dos deploys de Vercel:
 *
 *   proyecto `turnos-dashboard`  rama `main`  -> TEST
 *   proyecto `turnos-ryf`        rama `ryf`   -> RYF
 *
 * OJO, ESTA RAMA ES LA DE RYF Y ESTE ARCHIVO TIENE LA URL DE TEST.
 *
 * Antes de que existiera `environment.ryf.ts`, la URL de ryf estaba puesta acá a
 * mano, y como este archivo es el que usa `ng serve`, developar en esta rama
 *SIGNIFICABA TOCAR LA BASE DE PRODUCCION sin avisar: un `DELETE` de prueba y se
 * perdía un turno real.
 *
 * Ahora el archivo que decide esta en la rama `ryf` es `environment.ryf.ts`, que
 * lo elige la configuracion `ryf` del build. Este queda como development, que es
 * donde va `ng start`.
 *
 * OJO: en desarrollo se usa TEST a proposito. Probar contra la base de
 * produccion significaria poder borrar un turno real mientras se prueba una
 * pantalla. Para mirar ryf hay que correr `npm run start:ryf`.
 */
export const environment = {
  production: false,
  supabaseUrl: 'https://ycrhgxwnikksmwyofzmv.supabase.co',
  supabaseKey: 'sb_publishable_XKby3gkkk-B_Njm4wSlZXQ_cA03V_8C'
};