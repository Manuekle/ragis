import Link from "next/link";
import DevLoginForm from "./DevLoginForm";
import PasswordLoginForm from "./PasswordLoginForm";
import { AuthShell, GateChecks } from "./AuthShell";
import { IconAlert } from "@/components/icons";
import { cognitoPasswordLogin } from "@/lib/cognito";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  idp_error: "The identity provider rejected the sign-in.",
  flow_expired: "The sign-in session expired. Try again.",
  state_mismatch: "Invalid sign-in request. Try again.",
  token_exchange_failed: "Couldn't complete sign-in with the provider.",
  invalid_id_token: "The identity token is not valid.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  if (process.env.AUTH_MODE !== "oidc") return <DevLoginForm />;
  // Cognito: el formulario vive en la app. Otros IdP OIDC siguen redirigiendo a su propia página (SSO).
  if (cognitoPasswordLogin()) return <PasswordLoginForm />;
  return (
    <AuthShell title="Sign in to Ragis." lead="Use your company account." linkBrandToHome>
      <div className="gate-form">
        <p className="gate-note">You&apos;ll go to your identity provider, then come back here.</p>
        {error && (
          <div className="alert">
            <IconAlert size={16} />
            {ERRORS[error] ?? "Couldn't sign in."}
          </div>
        )}
        <a href="/api/auth/login" className="gate-cta">
          Continue with SSO
        </a>
      </div>
      <GateChecks items={["Cited answers", "Permission-aware", "PII redacted"]} />
      <p className="gate-legal">
        By continuing you agree to the <Link href="/terms">Terms</Link> and <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </AuthShell>
  );
}
