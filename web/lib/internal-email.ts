const INTERNAL_EMAIL_DOMAINS = ["karboncard.com", "korefi.ai"] as const;

export function isInternalEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  let raw = email.trim().toLowerCase();
  if (raw.includes("<") && raw.includes(">")) {
    raw = raw.slice(raw.lastIndexOf("<") + 1, raw.lastIndexOf(">")).trim();
  }
  if (!raw.includes("@")) return false;
  const domain = raw.slice(raw.lastIndexOf("@") + 1);
  return INTERNAL_EMAIL_DOMAINS.some(
    (item) => domain === item || domain.endsWith(`.${item}`),
  );
}
