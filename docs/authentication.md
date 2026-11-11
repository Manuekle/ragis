# Autenticación

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/auth-dark.svg">
  <img alt="Inicio de sesión dentro de la app: navegador, web, Cognito y API" src="diagrams/auth.svg">
</picture>

El inicio de sesión **ocurre dentro de la app** (`/login`), con el estilo de Ragsis. Cognito solo guarda las cuentas y
valida la clave; el navegador nunca sale del sitio ni ve la página de Cognito.

## Modos

| `AUTH_MODE` | Cuándo | Cómo entra la gente |
|---|---|---|
| `dev` | Desarrollo local | Cualquier correo, sin clave. Se emite un token de desarrollo HS256 firmado con `JWT_DEV_SECRET`. |
| `oidc` con emisor de Cognito | **Piloto y producción en AWS** | Formulario propio: correo y clave. Ver más abajo. |
| `oidc` con otro IdP | SSO corporativo | Botón «Continue with SSO»: Authorization Code + PKCE hacia el IdP (ADR-015). |

La web decide el segundo o el tercero mirando `OIDC_ISSUER`: si el host empieza por `cognito-idp.`, muestra el
formulario propio. El resto de proveedores OIDC siguen usando la redirección.

## Formulario propio con Cognito

Implementado en `apps/web/app/login/PasswordLoginForm.tsx`, `apps/web/app/api/auth/password/route.ts` y
`apps/web/lib/cognito.ts`. Usa la API pública de Cognito para clientes sin secreto, desde el **servidor** de la web
(no hace falta ninguna credencial de AWS).

Pasos del formulario (cada uno es una petición `POST /api/auth/password` con JSON y un campo `step`):

| `step` | Qué hace | Operación de Cognito |
|---|---|---|
| `signin` | Correo y clave | `InitiateAuth` con `USER_PASSWORD_AUTH` |
| `new_password` | Fija la clave definitiva de una cuenta invitada | `RespondToAuthChallenge` (`NEW_PASSWORD_REQUIRED`) |
| `forgot` | Pide el código de recuperación | `ForgotPassword` |
| `reset` | Código del correo y clave nueva | `ConfirmForgotPassword` |

Qué ocurre al iniciar sesión:

1. El navegador envía correo y clave a `/api/auth/password`. La ruta exige `Content-Type: application/json`, de modo que
   un formulario de otro sitio no puede disparar un inicio de sesión.
2. La web llama a Cognito. Si la cuenta tiene clave temporal, Cognito devuelve el reto `NEW_PASSWORD_REQUIRED`; la web
   guarda el token del reto en una cookie `httpOnly` de 170 segundos (Cognito lo invalida a los tres minutos) y el
   formulario pide la clave nueva.
3. Con el `id_token` en mano, la web verifica firma, emisor, audiencia y expiración con el JWKS de Cognito.
4. Guarda el `id_token` en la cookie `ragsis_session` (`httpOnly`, `SameSite=Lax`; `Secure` según
   `SESSION_COOKIE_SECURE`, activo por defecto). Su vigencia es la del propio token.
5. En cada llamada, la web reenvía el token a la API como `Authorization: Bearer`. La API lo revalida (emisor, audiencia,
   `token_use=id`) y exige `email_verified`.

Los mensajes de error están pensados para personas y no revelan si una cuenta existe: clave o correo incorrectos dan el
mismo texto. Cognito responde igual para cuentas inexistentes porque el cliente tiene `prevent_user_existence_errors`.

### Cuentas

Las cuentas son **solo por invitación** (`allow_admin_create_user_only`). Para invitar a alguien:

```bash
env -u AWS_ENDPOINT_URL aws cognito-idp admin-create-user \
  --profile ragsis-pilot --region us-east-2 \
  --user-pool-id <pool-id> --username persona@empresa.com \
  --user-attributes Name=email,Value=persona@empresa.com Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
```

- `email_verified=true` es necesario: la API rechaza correos no verificados.
- Cognito envía la clave temporal por correo. En el primer ingreso la persona elige la suya.
- La política de claves es la predeterminada de Cognito (mínimo 8 caracteres, mayúsculas, minúsculas, número y símbolo).
- El rol dentro de cada organización se asigna después, en *Gobierno*; invitar a Cognito no da acceso a ningún tenant.

### Cliente de Cognito

Definido en `infra/terraform/envs/pilot/main.tf`: cliente público (sin secreto) con `ALLOW_USER_PASSWORD_AUTH` y
`ALLOW_REFRESH_TOKEN_AUTH`. Los parámetros de OAuth (código + PKCE, URLs de retorno) se conservan para poder usar el
flujo por redirección con un IdP federado más adelante.

## Sesión y cierre

- La sesión dura lo que el `id_token` (una hora por defecto en Cognito). No hay refresh tokens todavía; al vencer, la
  persona vuelve a iniciar sesión. Es el pendiente «refresh tokens de sesión» del [README](../README.md#estado-frente-al-plan-maestro).
- **Cerrar sesión** (`/api/auth/logout`) borra la cookie y vuelve a `/login`. Con Cognito no hay sesión alojada que
  cerrar. Con otros IdP se hace el cierre RP-initiated si el IdP publica `end_session_endpoint`.

## Probar sin AWS

- **Desarrollo:** `AUTH_MODE=dev` (por defecto en `make up`).
- **Redirección OIDC:** `make mock-oidc` levanta un IdP simulado en <http://localhost:9000> (`client_id` `ragsis-web`).
- **Formulario contra Cognito:** arranca la web con `AUTH_MODE=oidc`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
  `SESSION_COOKIE_SECURE=false` y `PUBLIC_BASE_URL=http://localhost:<puerto>`. Una prueba con credenciales falsas
  devuelve «Wrong email or password.», señal de que el flujo está habilitado en el cliente.

## Relación con otros documentos

- Decisión original del login con redirección: [ADR-015](adr/README.md#adr-015--login-web-oidc-en-el-bff-authorization-code--pkce).
- Revisión para Cognito: [ADR-026](adr/README.md#adr-026--login-dentro-de-la-app-con-cognito-user_password_auth).
- Modelo de amenazas y controles: [security.md](security.md).
