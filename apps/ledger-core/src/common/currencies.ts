export const SUPPORTED_CURRENCIES = [
  'USD', // american dollar 
  'INR', // indian rupee 
  'EUR', // euro 
  'GBP', // british pound 
  'CAD', // canadian dollar 
  'AUD', // australian dollar 
  'SGD', // singapore dollar 
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

const SUPPORTED_CURRENCY_SET = new Set<string>(SUPPORTED_CURRENCIES);
export function isSupportedCurrency(currency: string): currency is SupportedCurrency {
  return SUPPORTED_CURRENCY_SET.has(currency.toUpperCase());
}
