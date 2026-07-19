export const ALLOWED_EMAIL_DOMAIN = "glasswing.vc";

export function isAllowedGlasswingEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  return at > 0 && normalized.slice(at + 1) === ALLOWED_EMAIL_DOMAIN;
}
