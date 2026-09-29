export function initialVeaQuantity(quantity: string) {
  const text = quantity.trim(); const n = Number(text);
  return /^\d+$/.test(text) && Number.isInteger(n) && n >= 1 && n <= 99 ? { qty: n, assumed: false } : { qty: 1, assumed: true };
}
