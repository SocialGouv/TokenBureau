import express from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { createAppAuth } from '@octokit/auth-app';
import { request } from '@octokit/request';
import pRetry from 'p-retry';
import pino from 'pino';
import config from './config.js';

// Initialize logger
const logger = pino(config.logger);

const app = express();
const port = config.port;

// Custom request logging middleware
app.use((req, res, next) => {
  // Skip logging for health checks
  if (req.url === '/health' || req.url === '/') {
    return next();
  }

  const startTime = Date.now();
  const requestId = Math.random().toString(36).substring(2, 15);

  // Log request
  logger.info({
    requestId,
    method: req.method,
    url: req.url,
  }, 'Incoming request');

  // Log response
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    
    logger[level]({
      requestId,
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`
    }, 'Request completed');
  });

  next();
});

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
          issues: "write",
          pull_requests: "write",
          deployments: "write",
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
      status: error.status,
      statusText: error.response?.statusText
    }, 'Error in token generation');
    throw error;
  }
}

function extractAndDecodeToken(authHeader) {
  logger.debug({ authHeader }, 'Processing authorization header'); // Add debug log

  if (!authHeader?.startsWith('Bearer ')) {
    logger.error({ authHeader }, 'Authorization header missing or invalid format');
    throw new Error('Missing or invalid Authorization header');
  }

  let tokenPayload = authHeader.split(' ')[1];

  logger.debug({ tokenPayload: tokenPayload.substring(0, 20) + '...' }, 'Token payload received');

  // Remove JSON parsing attempt as it's not needed
  // The token should always be a plain JWT string
  
  // Remove any whitespace or quotes
  tokenPayload = tokenPayload.trim().replace(/^["']|["']$/g, '');

  logger.debug({ tokenLength: tokenPayload.length }, 'Processed token length');

  // Basic JWT structure validation
  const parts = tokenPayload.split('.');
  if (parts.length !== 3) {
    logger.error({ parts: parts.length }, 'Invalid JWT structure');
    throw new Error('Invalid JWT format - token must have three parts');
  }

  return tokenPayload;
}

// Route to generate GitHub App token
app.post('/generate-token', async (req, res) => {
  try {
    logger.debug({
      headers: req.headers,
      body: req.body
    }, 'Processing token generation request');

    const tokenPayload = extractAndDecodeToken(req.headers.authorization);

    // Verify OIDC token
    jwt.verify(tokenPayload, getKey, {
      issuer: 'https://token.actions.githubusercontent.com',
      audience: config.oidc.audience,
      algorithms: ['RS256'],
      clockTolerance: 60 // Allow 1 minute clock skew
    }, async (err, decoded) => {
      if (err) {
        logger.error({ error: err.message }, 'Token verification failed');
        return res.status(403).json({ 
          error: 'Token verification failed',
          details: err.message
        });
      }

      logger.debug({ decoded }, 'Token verified successfully');

      // Extract repository information from the token
      const repo = decoded.repository;
      const repoOwner = decoded.repository_owner;

      if (!repo || !repoOwner) {
        return res.status(400).json({ 
          error: 'Missing repository information in token'
        });
      }

      try {
        // Generate token with retry logic
        const result = await pRetry(
          () => generateToken(repoOwner, repo),
          {
            retries: 0,
            onFailedAttempt: error => {
              logger.error({ 
                attempt: error.attemptNumber,
                error: error.message 
              }, 'Failed to generate token');
            }
          }
        );

        logger.info('Token generated successfully');
        return res.json(result);
      } catch (error) {
        logger.error({ error: error.message }, 'Error generating token');
        return res.status(500).json({ 
          error: 'Failed to generate token',
          details: error.message
        });
      }
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Error processing request');
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
