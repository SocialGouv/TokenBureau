import * as core from '@actions/core';

async function run() {
  try {
    // Get inputs
    const tokenBureauUrl = core.getInput('token-bureau-url', { required: true });
    const audience = core.getInput('audience', { required: true });

    console.log(`Using token-bureau-url: ${tokenBureauUrl}`);
    console.log(`Using audience: ${audience}`);

    // Get OIDC token from GitHub Actions
    const idToken = await core.getIDToken(audience);
    console.log('Successfully obtained OIDC token');
    
    // Extract current repository from environment
    const repository = process.env.GITHUB_REPOSITORY?.split('/')[1];
    if (!repository) {
      throw new Error('GITHUB_REPOSITORY environment variable is not set');
    }
    console.log(`Repository: ${repository}`);

    // Request token from TokenBureau
    console.log('Sending request to TokenBureau');
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

    console.log(`Response status: ${response.status}`);

    if (!response.ok) {
      const error = await response.text();
      core.error(`Error response: ${error}`);
      throw new Error(`Failed to get token: ${error}`);
    }

    const data = await response.json();
    console.log('Successfully received token response');

    // Set outputs
    core.setSecret(data.token);
    core.setOutput('token', data.token);
    core.setOutput('expires_at', data.expires_at);
    core.setOutput('installation_id', data.installation_id);

    console.log('Action completed successfully');
  } catch (error) {
    core.error(`Action failed: ${error.message}`);
    core.setFailed(error.message);
  }
}

run();
