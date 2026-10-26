/** Role gate for the Supplier Audit area: account owner, or office staff with billing access (mirrors sa_can_manage()). */
export function canManageSupplierAudit(isOwner: boolean, permissions: { can_view_billing?: boolean } | null | undefined): boolean {
  return Boolean(isOwner || permissions?.can_view_billing);
}
