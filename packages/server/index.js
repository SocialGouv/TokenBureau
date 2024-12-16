import express from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { createAppAuth } from '@octokit/auth-app';
import { request } from '@octokit/request';
import pRetry from 'p-retry';
import pino from 'pino';
import pinoHttp from 'pino-http';
import config from './config.js';

// Initialize logger
const logger = pino(config.logger);

const app = express();
const port = config.port;

// Add request logging middleware
app.use(pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) => req.url === '/health' || req.url === '/'
  },
  customLogLevel: function (res, err) {
    if (res.statusCode >= 400 && res.statusCode < 500) return 'warn'
    if (res.statusCode >= 500 || err) return 'error'
    return 'info'
  },
  customSuccessMessage: function (res) {
    return `request completed with status ${res.statusCode}`
  },
  customErrorMessage: function (error, res) {
    return `request failed with status ${res.statusCode}: ${error.message}`
  }
}));

// Middleware
app.use(express.json());

// Setup JWKS Client for GitHub Actions OIDC
const client = jwksClient({
  jwksUri: 'https://token.actions.githubusercontent.com/.well-known/jwks',
  cache: true,
  rateLimit: true
});

// Function to get signing key
function getKey(header, callback) {
  logger.debug({ kid: header.kid }, 'Getting signing key');
  
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      logger.error({ err }, 'Error getting signing key');
      return callback(err);
    }
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

async function generateToken(owner, repository) {
  // Extract repository name if it includes owner
  const repoName = repository.includes('/') ? repository.split('/')[1] : repository;

  logger.debug({ owner, repository: repoName }, 'Starting token generation');

  try {
    // Create app-level auth instance
    const appAuth = createAppAuth({
      appId: config.github.appId,
      privateKey: config.github.privateKey,
    });

    // Create app-level request with auth hook
    const appRequest = request.defaults({
      request: {
        hook: appAuth.hook
      },
      headers: {
        accept: 'application/vnd.github.v3+json'
      }
    });

    // Get installations using app-level auth
    const { data: installations } = await appRequest('GET /app/installations');

    logger.debug({ 
      count: installations.length,
      accounts: installations.map(i => i.account.login)
    }, 'Found installations');

    const installation = installations.find(inst => 
      inst.account.login.toLowerCase() === owner.toLowerCase()
    );

    if (!installation) {
      throw new Error(`No installation found for owner: ${owner}`);
    }

    logger.debug({
      id: installation.id,
      account: installation.account.login
    }, 'Found installation');

    // Create installation-level auth instance
    const installationAuth = createAppAuth({
      appId: config.github.appId,
      privateKey: config.github.privateKey,
      installationId: installation.id
    });

    // Create installation-level request with auth hook
    const installationRequest = request.defaults({
      request: {
        hook: installationAuth.hook
      },
      headers: {
        accept: 'application/vnd.github.v3+json'
      }
    });

    // Get repository details using installation auth
    try {
      const { data: repo } = await installationRequest('GET /repos/{owner}/{repo}', {
        owner,
        repo: repoName
      });

      logger.debug({
        id: repo.id,
        full_name: repo.full_name
      }, 'Found repository');

      // Get installation access token using installation auth
      const { token, expiresAt } = await installationAuth({
        type: "installation",
        repositoryIds: [repo.id],
        permissions: {
          contents: "write",
          metadata: "read",
          // issues: "write"  // Added issues permission
        }
      });

      if (!token) {
        throw new Error('Failed to generate installation token');
      }

      logger.debug({ expiresAt }, 'Generated installation token');

      return {
        token,
        expires_at: expiresAt,
        installation_id: installation.id
      };
    } catch (error) {
      if (error.status === 404) {
        throw new Error(`Repository not found: ${owner}/${repoName}`);
      }
      throw error;
    }
  } catch (error) {
    logger.error({ 
      error: error.message,
      response: error.response ? {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data,
        url: error.response.url
      } : undefined
    }, 'Error in token generation');
    throw error;
  }
}

function extractAndDecodeToken(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }

  let tokenPayload = authHeader.split(' ')[1];

  logger.debug({ tokenPayload }, 'Raw token payload received');

  // Try to parse as JSON first
  try {
    const parsed = JSON.parse(tokenPayload);
    if (parsed.value) {
      logger.debug('Found token in JSON value field');
      tokenPayload = parsed.value;
    }
  } catch (e) {
    logger.debug('Token is not in JSON format, using as is');
  }

  // Remove any whitespace or quotes
  tokenPayload = tokenPayload.trim().replace(/^["']|["']$/g, '');

  // Basic JWT structure validation
  const parts = tokenPayload.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format - token must have three parts');
  }

  return tokenPayload;
}

// Route to generate GitHub App token
app.post('/generate-token', async (req, res) => {
  const reqLog = req.log;
  
  try {
    reqLog.debug({ auth: req.headers.authorization }, 'Processing token generation request');

    const tokenPayload = extractAndDecodeToken(req.headers.authorization);

    try {
      const [header, payload] = tokenPayload.split('.').slice(0, 2);
      reqLog.debug({
        header: JSON.parse(Buffer.from(header, 'base64').toString()),
        payload: JSON.parse(Buffer.from(payload, 'base64').toString())
      }, 'Decoded token parts');
    } catch (error) {
      reqLog.error({ error }, 'Error decoding token parts');
    }

    // Verify OIDC token
    jwt.verify(tokenPayload, getKey, {
      issuer: 'https://token.actions.githubusercontent.com',
      audience: config.oidc.audience,
      algorithms: ['RS256'],
      clockTolerance: 60 // Allow 1 minute clock skew
    }, async (err, decoded) => {
      if (err) {
        reqLog.error({ err }, 'Token verification failed');
        return res.status(403).json({ 
          error: 'Token verification failed',
          details: err.message
        });
      }

      reqLog.debug({ decoded }, 'Token verified successfully');

      // Extract repository information from the token
      const repo = decoded.repository;
      const repoOwner = decoded.repository_owner;

      if (!repo || !repoOwner) {
        return res.status(400).json({ 
          error: 'Missing repository information in token',
          claims: decoded
        });
      }

      try {
        // Generate token with retry logic
        const result = await pRetry(
          () => generateToken(repoOwner, repo),
          {
            retries: 0,
            onFailedAttempt: error => {
              reqLog.error({ 
                attempt: error.attemptNumber,
                error: error.message 
              }, 'Failed to generate token');
            }
          }
        );

        reqLog.info('Token generated successfully');
        return res.json(result);
      } catch (error) {
        reqLog.error({ error }, 'Error generating token');
        return res.status(500).json({ 
          error: 'Failed to generate token',
          details: error.message
        });
      }
    });
  } catch (error) {
    reqLog.error({ error }, 'Error processing request');
    return res.status(400).json({ 
      error: 'Failed to decode token',
      details: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(port, () => {
  logger.info({ port }, '🦉 TokenBureau server running');
});
