export type BacUnit = 'percent' | 'mg_l' | 'permille' | 'g_l' | 'mg_100ml';

export const BAC_UNITS: { value: BacUnit; label: string; description: string }[] = [
  { value: 'percent', label: '% BAC', description: 'Grams per 100 mL of blood' },
  { value: 'mg_l', label: 'mg/L', description: 'Milligrams per liter of breath (estimated)' },
  { value: 'permille', label: '‰', description: 'Grams per liter of blood' },
  { value: 'g_l', label: 'g/L', description: 'Grams per liter of blood' },
  { value: 'mg_100ml', label: 'mg/100mL', description: 'Milligrams per 100 mL of blood' },
];

export function isBacUnit(value: string | null): value is BacUnit {
  return BAC_UNITS.some((unit) => unit.value === value);
}

export function formatBac(percent: number, unit: BacUnit): string {
  switch (unit) {
    case 'percent': return `${percent.toFixed(3)} % BAC`;
    case 'mg_l': return `${(percent * 1000 / 210).toFixed(2)} mg/L`;
    case 'permille': return `${(percent * 10).toFixed(2)} ‰`;
    case 'g_l': return `${(percent * 10).toFixed(2)} g/L`;
    case 'mg_100ml': return `${(percent * 1000).toFixed(1)} mg/100mL`;
  }
}
