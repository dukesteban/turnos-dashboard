/*
 * Deploy a un proyecto de Vercel que NO es el que esta enlazado en `.vercel`.
 *
 * POR QUE ESTO ES UN SCRIPT Y NO UNA LINEA DE NPM
 *
 * La idea obvia seria:
 *
 *   vercel link --yes --project turnos-ryf && vercel --prod --yes ; vercel link ...
 *
 * Y no funciona. En Windows los scripts de npm corren en `cmd.exe`, donde `;` no es
 * separador de comandos sino separador de argumentos: el `cmd.exe` le pasa los
 * cuatro trozos a un solo `vercel link`, que responde
 * `unknown or unexpected option: --project`.
 *
 * Y con `&&` en vez de `;` tampoco se puede: si el deploy falla, el link se queda
 * en el proyecto de ryf, y el siguiente deploy desde `main` publica la app de ryf
 * DENTRO del dominio de test. Dos dominios con la misma base, sin que nadie lo haya
 * pedido, y sin ningun error en ninguna parte.
 *
 * Un `finally` no falla por como este el sistema operativo: el link se restaura
 * haya ido bien o mal.
 *
 * USO
 *
 *   npm run deploy:ryf      publica en turnos-ryf y deja el link en test
 *   npm run deploy:test     publica en test (el link ya esta ahi)
 */

import { execSync } from 'node:child_process';

const PROYECTO = process.argv[2];
const LINK_DE_REPOSO = 'turnos-dashboard';

if (!PROYECTO) {
  console.error('Falta el proyecto. Uso: node scripts/deploy.mjs <proyecto>');
  process.exit(1);
}

const vercel = (args) => execSync(`npx vercel ${args}`, { stdio: 'inherit', shell: true });

if (PROYECTO === LINK_DE_REPOSO) {
  vercel('--prod --yes');
} else {
  try {
    vercel(`link --yes --project ${PROYECTO}`);
    vercel('--prod --yes');
  } finally {
    vercel(`link --yes --project ${LINK_DE_REPOSO}`);
  }
}