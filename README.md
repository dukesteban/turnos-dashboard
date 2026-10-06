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

## LO QUE HAY QUE HACER UNA VEZ EN VERCEL (pendiente)

El proyecto `turnos-ryf` **no** esta conectado al repo de GitHub, a proposito: si lo
estuviera con la rama de produccion en `main`, cada merge a `main` publicaria la app
de test dentro del dominio de ryf. Por eso el deploy de ryf es el comando de arriba.

Para que ryf se despliegue solo al mergear:

1. Vercel > proyecto `turnos-ryf` > Settings > Git
2. Conectar el repo `dukesteban/turnos-dashboard`
3. **Production Branch: `ryf`** (este paso es el importante, la API no lo deja cambiar)

Despues se puede borrar `deploy:ryf` y confiar en Vercel.

El proyecto `turnos-dashboard` (test) ya esta conectado con Production Branch `main`,
y se despliega solo. Ademas tiene un deploy hook viejo llamado `RyF` que apunta a la
rama `ryf` y despliega al proyecto de TEST; hoy es inocuo porque el build de esa rama
da test, pero es redundante y conviene borrarlo.