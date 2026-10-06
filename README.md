# README

Turnos y caja de un lavadero. Angular 21 standalone, Supabase, PWA.

## LAS DOS BASES, Y COMO NO CONFUNDIRLAS

Hay dos apps y cada una lee una base. La base se elige con el **build**, no con una
variable de entorno: Angular escribe el valor dentro del bundle.

| | app | base de datos | rama | build |
|---|---|---|---|---|
| TEST | `carwash-dashboard-mu.vercel.app` | `test-lavadero` (`ycrhgxwnikksmwyofzmv`) | `main` | `npm run build` |
| RYF | `turnos-ryf.vercel.app` | `ryf-lavadero` (`tvzfsbudhuegsptaokng`) | `ryf` | `npm run build` |

Los archivos:

```
src/environments/environment.ts       ng serve       TEST   (desarrollo local)
src/environments/environment.prod.ts  --configuration production   TEST
src/environments/environment.ryf.ts   --configuration ryf         RYF
```

En la rama `ryf`, el script `build` es `ng build --configuration ryf`. En `main` es
`ng build`. O sea: **deployar a mano desde la rama equivocada no puede sacar la app
del otro conjunto de datos.** Es una diferencia deliberada entre las dos ramas.

Las dos bases tienen **migraciones propias**. Lo que se aplico en cada una esta en
`migrations/README.md`, y las dos NO estan sincronizadas: si se toca una migracion,
cada base necesita su pasada. Una vez se perdio la 008 entera por una linea que
referenciaba una tabla que en ryf no existe.

## DAILY

```bash
npm install
npm start           # http://localhost:4200, contra TEST
npm start:ryf       # el mismo dev server, contra RYF (datos reales)
npm test
npm run typecheck
```

## DEPLOY

```bash
# en la rama main, publica en carwash-dashboard-mu (TEST)
npm run deploy:test

# en la rama ryf, publica en turnos-ryf (RYF)
npm run deploy:ryf
```

`deploy:ryf` cambia el link local de Vercel al proyecto de ryf, despliega, y **vuelve
a dejarlo en el de test**. El `;` y no `&&` al final es a proposito: si el deploy
falla, el link se restaura igual. Sin eso, un deploy caido deja el repo apuntando a
ryf y el siguiente `deploy:test` publica la app de ryf en el dominio de test.

## LOS DEPLOYES SON AUTOMATICOS

Los dos proyectos estan conectados al repo y se despliegan solos al mergear:

| proyecto | production branch | buildCommand |
|---|---|---|
| `turnos-dashboard` (test) | `main` | default de Angular |
| `turnos-ryf` | `ryf` | `npm run build:ryf` |

O sea: `git push origin main` publica en `carwash-dashboard-mu`, y `git push origin
ryf` publica en `turnos-ryf`. No hay que hacer nada mas.

`npm run deploy:ryf` queda igual por si hay que republicar sin mergear nada (por
ejemplo si el build de Vercel falla y hay que reintentarlo).

## LA PRODUCTION BRANCH NO SE CAMBIA DESDE EL DASHBOARD

Vercel la guarda en un ajuste del proyecto que no esta en la pantalla de Settings > Git
que se ve al conectar el repo: en esa pantalla solo aparece el repo conectado y los
toggles de comentarios. La API tampoco la toma en `POST /v9/projects/{id}/link`
(probado con tres nombres de parametro, siempre queda en `main`).

El endpoint que SI la cambia es:

```
PATCH https://api.vercel.com/v9/projects/{projectId}/branch
{ "branch": "ryf" }
```

Si alguna vez hay que cambiarla, es ese. Un `PATCH /v9/projects/{id}` con `{ "name":
... }` renombra el proyecto, que es otra cosa y no hay que mezclar.

## EL DEPLOY HOOK VIEJO

`turnos-dashboard` (test) tiene un deploy hook llamado `RyF` que apunta a la rama `ryf`
y publica en el proyecto de TEST. Se creo antes de que existiera `turnos-ryf` y hoy es
redundante: la rama `ryf` ya publica en el proyecto correcto. Conviene borrarlo desde
Settings > Git > Deploy Hooks del proyecto `turnos-dashboard`.