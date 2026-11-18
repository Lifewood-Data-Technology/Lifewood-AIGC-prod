type DirectoryAccount = Record<string, unknown>;

/** A presentation boundary only; never changes stored accounts or authorization. */
export function employeeDirectory<T extends DirectoryAccount>(accounts: T[]) {
  return accounts.filter((account) => account.group !== "system");
}

export function filterEmployeeDirectory<T extends DirectoryAccount>(
  accounts: T[], query = "", role = "", status = "",
) {
  const search = query.trim().toLowerCase();
  return employeeDirectory(accounts).filter((account) =>
    `${String(account.name ?? "")} ${String(account.email ?? "")}`.toLowerCase().includes(search) &&
    (!role || account.group === role) &&
    (!status || account.status === status),
  );
}
