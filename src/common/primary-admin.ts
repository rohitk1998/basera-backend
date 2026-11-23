/**
 * The one staff account that owns incoming requests. New inquiries are assigned to it automatically and it is the only
 * name offered in the staff pickers. Override with PRIMARY_ADMIN_EMAIL. If no admin has this email the callers fall
 * back to the old behaviour (all admins), so a typo can never leave requests unowned or the picker empty.
 */
export function primaryAdminEmail(): string {
  return (process.env.PRIMARY_ADMIN_EMAIL ?? 'admin@rhenbasera.com').trim().toLowerCase();
}

export function isPrimaryAdmin(email: string | null | undefined): boolean {
  return !!email && email.trim().toLowerCase() === primaryAdminEmail();
}
