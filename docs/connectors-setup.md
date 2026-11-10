# Conectores: cómo crear las apps de Google, Slack y ClickUp

Guía para activar los conectores de CON-01 (ADR-025). Sin estas credenciales la página **Connected apps** muestra cada
app como "Not available yet". Para probar sin cuentas reales usa `CONNECTORS_DEMO=1` (solo desarrollo).

Las tres apps usan la **misma URL de vuelta** (redirect URI):

```
<PUBLIC_BASE_URL>/connect/callback
```

En local: `http://localhost:3000/connect/callback`. En producción, la URL HTTPS pública de la web
(p. ej. `https://app.tudominio.com/connect/callback`).

## 1. Clave de cifrado de tokens

Los tokens se guardan cifrados. En producción la clave es obligatoria y debe vivir en Secrets Manager:

```bash
openssl rand -base64 32
```

Guárdala como `CONNECTOR_ENCRYPTION_KEY`. Si la cambias, las conexiones existentes tendrán que reconectarse.

## 2. Google (Gmail)

1. Entra en [Google Cloud Console](https://console.cloud.google.com/) y crea (o elige) un proyecto.
2. **APIs y servicios → Biblioteca**: busca **Gmail API** y pulsa **Habilitar**.
3. **APIs y servicios → Pantalla de consentimiento de OAuth**:
   - Si todos los usuarios están en tu Google Workspace, elige **Interno**: no requiere verificación.
   - Si no, elige **Externo**. En modo *Testing* solo pueden conectar los usuarios de prueba que añadas (máx. 100).
     Para abrirlo a todo el mundo, Google exige verificar la app y, por usar un scope restringido, una evaluación de
     seguridad (CASA). Cuenta con semanas de trámite.
   - Scope: `https://www.googleapis.com/auth/gmail.readonly` (solo lectura).
4. **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth**:
   - Tipo: **Aplicación web**.
   - **URI de redireccionamiento autorizados**: la URL de vuelta de arriba.
5. Copia el ID y el secreto:

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
```

## 3. Slack

1. Entra en [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From scratch**. Elige el workspace
   de Slack de tu empresa.
2. **OAuth & Permissions**:
   - **Redirect URLs**: añade la URL de vuelta.
   - **Bot Token Scopes**: `channels:read`, `channels:history`, `channels:join`, `groups:read`, `groups:history`,
     `users:read`, `team:read`.
3. **Basic Information → App Credentials**: copia Client ID y Client Secret:

```
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
```

4. Los canales privados solo se pueden leer si invitas a la app en Slack (`/invite @nombre-de-la-app`).

> **Importante.** Desde mayo de 2025, Slack limita a 1 petición por minuto la lectura de mensajes en apps distribuidas
> comercialmente fuera del Slack Marketplace. Una app **interna** (instalada solo en el workspace de tu empresa)
> mantiene los límites normales. Si vas a ofrecer el conector a varios clientes desde una sola app, revisa con legal
> los términos de la API de Slack antes de activarlo y valora publicar la app en el Marketplace.

## 4. ClickUp

1. En ClickUp: **avatar → Settings → Apps → Create new app** (requiere ser admin u owner del workspace).
2. **Redirect URL(s)**: el dominio de la web (en local `localhost:3000`).
3. Copia Client ID y Client Secret:

```
CLICKUP_CLIENT_ID=...
CLICKUP_CLIENT_SECRET=...
```

4. ClickUp no tiene scopes: el conector ve lo mismo que la persona que autoriza. Recomendado: conectar con una cuenta
   de servicio que solo tenga acceso a los espacios que deban compartirse.

## 5. Activar

Añade las variables a `.env` (local) o a Secrets Manager (AWS) y reinicia la API:

```bash
docker compose -f infra/docker/compose.yml --env-file .env up -d --no-deps api
```

Comprueba en **Connected apps** que cada app aparece con su botón **Connect**. Gmail lo conecta cada persona; Slack y
ClickUp, un administrador (elige el workspace donde se podrán buscar).

## Variables

| Variable | Para qué |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | App OAuth de Google (Gmail) |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | App de Slack |
| `CLICKUP_CLIENT_ID` / `CLICKUP_CLIENT_SECRET` | App de ClickUp |
| `CONNECTOR_ENCRYPTION_KEY` | Clave AES-256 (base64, 32 bytes) de los tokens; obligatoria en producción |
| `CONNECTOR_SYNC_INTERVAL_MINUTES` | Cada cuánto se actualiza cada conexión (por defecto 30) |
| `CONNECTOR_SYNC_ENABLED` | `false` en réplicas que no deban sincronizar |
| `CONNECTORS_DEMO` | `1` = datos simulados sin cuentas reales (prohibido en producción) |
