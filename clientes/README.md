# Alta de un cliente

1. Copiá `ejemplo.json` con el nombre del cliente (`clientes/<slug>.json`). Ese archivo tiene datos y claves: **no se commitea** (está en `.gitignore`).
2. Completá:
   - `slug`: nombre corto, sin espacios (es el nombre del proyecto en Supabase).
   - `nombre_negocio`, `direccion`, `telefono_emergencia`, `descripcion`, `tono`.
   - `horarios`: un array de rangos por día. Un día puede tener mañana y tarde.
   - `servicios`: nombre, precio y duración en minutos.
   - `empleados`: nombre, teléfono, comisión y, si no trabaja todo el horario, su `jornada` (mismo formato que `horarios`).
   - `admin`: usuario y clave del panel.
   - `meta`: token permanente, phone number ID y verify token del cliente.
3. Exportá las claves (una sola vez por terminal):

   ```powershell
   $env:SUPABASE_ACCESS_TOKEN = 'sbp_...'   # token con permiso de organización
   $env:SUPABASE_ORG_ID = 'duxrzkqvgdlmhoehvyog'
   $env:ANTHROPIC_API_KEY = 'sk-ant-...'
   $env:GROQ_API_KEY = 'gsk_...'
   ```

4. Corré:

   ```powershell
   npm run nuevo-cliente -- clientes/ana.json
   ```

   Primero probá con `--dry-run`: no crea nada, solo muestra los pasos.

5. Al final imprime la URL del webhook y el verify token. Eso va en Meta → WhatsApp → Configuración → Webhook.
6. El panel queda para subir a mano con los dos comandos que imprime.

## Si el proyecto ya existe

```powershell
npm run nuevo-cliente -- clientes/ana.json --existing <ref> --db-password <password-de-la-base>
```

Sirve para reconfigurar un cliente sin crear otro proyecto (por ejemplo, si lo creaste desde el dashboard).
