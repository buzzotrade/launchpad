// Stable codes survive wallet deletion/reordering; custom names are never cropped.
export function walletCode(wallet) {
  return `W${Number(wallet.sort_order) || Number(wallet.id) || 1}`;
}
export function walletLabel(wallet) {
  const code = walletCode(wallet);
  const name = String(wallet.name || '').trim();
  return !name || /^Wallet\s+\d+$/i.test(name) ? code : `${code} · ${name}`;
}
