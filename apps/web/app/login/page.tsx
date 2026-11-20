import { LocaleLink as Link } from "@/components/LocaleProvider";
import DevLoginForm from "./DevLoginForm";
import PasswordLoginForm from "./PasswordLoginForm";
import { AuthShell, GateChecks } from "./AuthShell";
import { IconAlert } from "@/components/icons";
import { cognitoPasswordLogin } from "@/lib/cognito";
import { getLocale } from "@/lib/locale";
import { LOGIN } from "./copy";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const t = LOGIN[await getLocale()];
  if (process.env.AUTH_MODE !== "oidc") return <DevLoginForm />;
  // Cognito: el formulario vive en la app. Otros IdP OIDC siguen redirigiendo a su propia página (SSO).
  if (cognitoPasswordLogin()) return <PasswordLoginForm />;
  return (
    <AuthShell title={t.ssoTitle} lead={t.ssoLead} home={t.home} linkBrandToHome>
      <div className="gate-form">
        <p className="gate-note">{t.ssoNote}</p>
        {error && (
          <div className="alert">
            <IconAlert size={16} />
            {t.ssoErrors[error] ?? t.ssoFallback}
          </div>
        )}
        <a href="/api/auth/login" className="gate-cta">
          {t.sso}
        </a>
      </div>
      <GateChecks items={t.checks} />
      <p className="gate-legal">
        {t.legalA}<Link href="/terms">{t.terms}</Link>{t.legalB}<Link href="/privacy">{t.privacy}</Link>.
      </p>
    </AuthShell>
  );
}
