import * as core from '@actions/core';

async function run() {
  try {
    // Get inputs
    const tokenBureauUrl = core.getInput('token-bureau-url', { required: true });
    const audience = core.getInput('audience', { required: true });

    core.debug(`Using token-bureau-url: ${tokenBureauUrl}`);
    core.debug(`Using audience: ${audience}`);

    // Get OIDC token from GitHub Actions
    const idToken = await core.getIDToken(audience);
    core.debug('Successfully obtained OIDC token');
    
    // Extract current repository from environment
    const repository = process.env.GITHUB_REPOSITORY?.split('/')[1];
    if (!repository) {
      throw new Error('GITHUB_REPOSITORY environment variable is not set');
    }
    core.debug(`Repository: ${repository}`);

    // Request token from TokenBureau
    core.debug('Sending request to TokenBureau');
    const response = await fetch(`${tokenBureauUrl}/generate-token`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${idToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'token-bureau-action'
      },
      body: JSON.stringify({
        repositories: [repository]
      })
    });

    core.debug(`Response status: ${response.status}`);

    if (!response.ok) {
      const error = await response.text();
      core.error(`Error response: ${error}`);
      throw new Error(`Failed to get token: ${error}`);
    }

    const data = await response.json();
    core.debug('Successfully received token response');

    // Set outputs
    core.setSecret(data.token);
    core.setOutput('token', data.token);
    core.setOutput('expires_at', data.expires_at);
    core.setOutput('installation_id', data.installation_id);

    core.debug('Action completed successfully');
  } catch (error) {
    core.error(`Action failed: ${error.message}`);
    core.setFailed(error.message);
  }
}

run();
