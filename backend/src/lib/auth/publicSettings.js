/**
 * Client-safe settings projection.
 *
 * Secrets must never leave the server. `oidcConfigured` and
 * `antigravityOAuthConfigured` let the UI show "configured" state without
 * exposing the stored secret values.
 */
export function redactSettingsForClient(settings = {}) {
  const {
    password,
    oidcClientSecret,
    antigravityOAuthClientSecret,
    ...safe
  } = settings;

  safe.oidcConfigured = !!(
    safe.oidcIssuerUrl &&
    safe.oidcClientId &&
    oidcClientSecret
  );
  safe.antigravityOAuthConfigured = !!(
    safe.antigravityOAuthClientId &&
    antigravityOAuthClientSecret
  );
  return safe;
}
