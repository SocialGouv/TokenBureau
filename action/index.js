import * as core from '@actions/core';

async function run() {
  try {
    // Get inputs
    const tokenBureauUrl = core.getInput('token-bureau-url', { required: true });
    const audience = core.getInput('audience', { required: true });

    // Get OIDC token from GitHub Actions
    const idToken = await core.getIDToken(audience);
    
    // Extract current repository from environment
    const repository = process.env.GITHUB_REPOSITORY?.split('/')[1];
    if (!repository) {
      throw new Error('GITHUB_REPOSITORY environment variable is not set');
    }

    // Request token from TokenBureau
    const response = await fetch(`${tokenBureauUrl}/generate-token`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        repositories: [repository]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get token: ${error}`);
    }

    const data = await response.json();

    // Set outputs
    core.setSecret(data.token);
    core.setOutput('token', data.token);
    core.setOutput('expires_at', data.expires_at);
    core.setOutput('installation_id', data.installation_id);

  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
