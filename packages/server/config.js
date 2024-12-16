import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env file
dotenv.config({ path: join(__dirname, '..', '.env') });

// Required environment variables
const requiredEnvVars = [
  'GITHUB_APP_ID',
  'GITHUB_PRIVATE_KEY',
  'OIDC_AUDIENCE'
];

// Validate required environment variables
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

// Format private key by ensuring proper line breaks
function formatPrivateKey(key) {
  // Handle keys that use \n
  if (key.includes('\\n')) {
    return key.split('\\n').join('\n');
  }

  // Handle keys that are already properly formatted
  if (key.includes('\n')) {
    return key;
  }

  // Handle single-line keys
  const header = '-----BEGIN RSA PRIVATE KEY-----';
  const footer = '-----END RSA PRIVATE KEY-----';
  
  // Remove any existing headers/footers and whitespace
  let pemContent = key
    .replace(header, '')
    .replace(footer, '')
    .replace(/\s/g, '');
  
  // Add newlines every 64 characters
  const pemLines = pemContent.match(/.{1,64}/g) || [];
  
  return [
    header,
    ...pemLines,
    footer
  ].join('\n');
}

const privateKey = formatPrivateKey(process.env.GITHUB_PRIVATE_KEY);

// Configure logger options
const loggerConfig = {
  development: {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        levelFirst: true,
        ignore: 'pid,hostname,time'
      }
    },
    level: process.env.DEBUG === 'true' ? 'debug' : 'info',
    formatters: {
      level: (label) => {
        return {
          level: label
        }
      }
    },
    timestamp: false,
    hostname: false
  },
  production: {
    level: 'info',
    formatters: {
      level: (label) => {
        return {
          level: label
        }
      }
    },
    timestamp: false,
    hostname: false
  }
};

// Export configuration with defaults
export default {
  port: process.env.PORT || 3000,
  github: {
    appId: process.env.GITHUB_APP_ID,
    privateKey: privateKey
  },
  oidc: {
    audience: process.env.OIDC_AUDIENCE,
    issuer: 'https://token.actions.githubusercontent.com'
  },
  logger: loggerConfig[process.env.NODE_ENV === 'production' ? 'production' : 'development']
};
