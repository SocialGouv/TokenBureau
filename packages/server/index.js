import express from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { createAppAuth } from '@octokit/auth-app';
import { request } from '@octokit/request';
import pRetry from 'p-retry';
import config from './config.js';

const app = express();
const port = config.port;

// Enable more detailed logging
const DEBUG = process.env.DEBUG === 'true';

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
  if (DEBUG) console.log('Getting signing key for kid:', header.kid);
  
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      console.error('Error getting signing key:', err);
      return callback(err);
    }
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

async function generateToken(owner, repository) {
  // Extract repository name if it includes owner
  const repoName = repository.includes('/') ? repository.split('/')[1] : repository;

  if (DEBUG) {
    console.log('Starting token generation for:', { owner, repository: repoName });
    console.log('App ID:', config.github.appId);
  }

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

    if (DEBUG) {
      console.log('Found installations:', installations.length);
      console.log('Installation accounts:', installations.map(i => i.account.login));
    }

    const installation = installations.find(inst => 
      inst.account.login.toLowerCase() === owner.toLowerCase()
    );

    if (!installation) {
      throw new Error(`No installation found for owner: ${owner}`);
    }

    if (DEBUG) {
      console.log('Found installation:', {
        id: installation.id,
        account: installation.account.login
      });
    }

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

      if (DEBUG) {
        console.log('Found repository:', {
          id: repo.id,
          full_name: repo.full_name
        });
      }

      // Get installation access token using installation auth
      const { token, expiresAt } = await installationAuth({
        type: "installation",
        repositoryIds: [repo.id],
        permissions: {
          contents: "write",
          metadata: "read"
        }
      });

      if (!token) {
        throw new Error('Failed to generate installation token');
      }

      if (DEBUG) {
        console.log('Generated installation token');
        console.log('Token expires at:', expiresAt);
      }

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
    console.error('Error in token generation:', error);
    if (error.response) {
      console.error('GitHub API Error:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data,
        url: error.response.url
      });
    }
    throw error;
  }
}

function extractAndDecodeToken(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }

  let tokenPayload = authHeader.split(' ')[1];

  if (DEBUG) {
    console.log('Raw token payload:', tokenPayload);
  }

  // Try to parse as JSON first
  try {
    const parsed = JSON.parse(tokenPayload);
    if (parsed.value) {
      if (DEBUG) console.log('Found token in JSON value field');
      tokenPayload = parsed.value;
    }
  } catch (e) {
    if (DEBUG) console.log('Token is not in JSON format, using as is');
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
  try {
    if (DEBUG) {
      console.log('Authorization header:', req.headers.authorization);
    }

    const tokenPayload = extractAndDecodeToken(req.headers.authorization);

    if (DEBUG) {
      try {
        const [header, payload] = tokenPayload.split('.').slice(0, 2);
        console.log('Token header:', Buffer.from(header, 'base64').toString());
        console.log('Token payload:', Buffer.from(payload, 'base64').toString());
      } catch (error) {
        console.error('Error decoding token parts:', error);
      }
    }

    // Verify OIDC token
    jwt.verify(tokenPayload, getKey, {
      issuer: 'https://token.actions.githubusercontent.com',
      audience: config.oidc.audience,
      algorithms: ['RS256'],
      clockTolerance: 60 // Allow 1 minute clock skew
    }, async (err, decoded) => {
      if (err) {
        console.error('Token verification failed:', err);
        return res.status(403).json({ 
          error: 'Token verification failed',
          details: err.message
        });
      }

      if (DEBUG) console.log('Decoded token:', decoded);

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
              console.error(
                `Failed to generate token (attempt ${error.attemptNumber}): ${error.message}`
              );
            }
          }
        );

        return res.json(result);
      } catch (error) {
        console.error('Error generating token:', error);
        return res.status(500).json({ 
          error: 'Failed to generate token',
          details: error.message
        });
      }
    });
  } catch (error) {
    console.error('Error processing request:', error);
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
  console.log(`🦉 TokenBureau server running on port ${port}`);
  if (DEBUG) console.log('Debug mode enabled');
});
