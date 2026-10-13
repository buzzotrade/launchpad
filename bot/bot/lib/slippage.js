export const DEFAULT_SLIPPAGE = 10;

export function resolveSlippage(user, mode = 'swap') {
  const value = user?.[`${mode}_slippage`] ?? user?.slippage;
  const number = Number(value);
  // Zero is the existing Auto setting, which also uses 10%.
  return value == null || !Number.isFinite(number) || number <= 0 ? DEFAULT_SLIPPAGE : number;
}
