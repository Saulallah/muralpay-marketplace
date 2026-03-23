import dotenv from 'dotenv';
dotenv.config();

/** Returns the value of a required env var, or throws at startup if it's missing. */
function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

/** Returns the value of an optional env var, falling back to defaultValue if unset. */
function optional(name: string, defaultValue = ''): string {
  return process.env[name] ?? defaultValue;
}

export const config = {
  port: parseInt(optional('PORT', '3000'), 10),
  appUrl: optional('APP_URL', ''),
  apiSecret: optional('API_SECRET', ''),

  database: {
    url: required('DATABASE_URL'),
  },

  mural: {
    apiKey: required('MURAL_API_KEY'),
    transferApiKey: required('MURAL_TRANSFER_API_KEY'),
    baseUrl: optional('MURAL_API_BASE_URL', 'https://api-staging.muralpay.com'),
  },

  merchant: {
    firstName: optional('MERCHANT_FIRST_NAME', 'Juan'),
    lastName: optional('MERCHANT_LAST_NAME', 'Garcia'),
    email: optional('MERCHANT_EMAIL', 'merchant@muralpay-marketplace.com'),
    bankId: optional('MERCHANT_BANK_ID', 'bank_cop_bancolombia'),
    bankAccountNumber: optional('MERCHANT_BANK_ACCOUNT_NUMBER', '1234567890'),
    accountType: optional('MERCHANT_ACCOUNT_TYPE', 'CHECKING') as 'CHECKING' | 'SAVINGS',
    documentType: optional('MERCHANT_DOCUMENT_TYPE', 'NATIONAL_ID') as 'NATIONAL_ID' | 'PASSPORT' | 'RESIDENT_ID' | 'RUC_NIT',
    documentNumber: optional('MERCHANT_DOCUMENT_NUMBER', '1234567890'),
    phoneNumber: optional('MERCHANT_PHONE_NUMBER', '+573001234567'),
    address: optional('MERCHANT_ADDRESS', 'Calle 123 # 45-67'),
    city: optional('MERCHANT_CITY', 'Bogota'),
    state: optional('MERCHANT_STATE', 'DC'),
    country: optional('MERCHANT_COUNTRY', 'CO'),
    zip: optional('MERCHANT_ZIP', '110111'),
  },
};
