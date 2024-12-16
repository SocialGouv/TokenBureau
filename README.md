# 🦉 TokenBureau

TokenBureau is a secure service for generating GitHub App tokens using OIDC verification. It includes both a server implementation and a GitHub Action for easy integration.

## GitHub Action Usage

Add the TokenBureau action to your workflow:

```yaml
permissions:
  id-token: write  # Required for OIDC token generation

steps:
  - name: Get GitHub App Token
    id: token
    uses: SocialGouv/token-bureau@v1
    with:
      token-bureau-url: https://your-token-bureau-service.com
      audience: your-audience-value

  # Use the token in subsequent steps
  - name: Use Token
    env:
      GITHUB_TOKEN: ${{ steps.token.outputs.token }}
    run: |
      # Your commands using the token
```

### Action Outputs

- `token`: The generated GitHub App token
- `expires_at`: Token expiration timestamp
- `installation_id`: GitHub App installation ID

## Server Setup

### Using Docker

```bash
# Build the image
docker build -t token-bureau .

# Run the container
docker run -p 3000:3000 \
  -e GITHUB_APP_ID=your_app_id \
  -e GITHUB_PRIVATE_KEY="$(cat path/to/private-key.pem)" \
  -e OIDC_AUDIENCE=your_audience \
  token-bureau
```

### Manual Setup

1. Clone the repository:
```bash
git clone https://github.com/SocialGouv/token-bureau.git
cd token-bureau
```

2. Copy the environment template:
```bash
cp .env.example .env
```

3. Configure environment variables in `.env`:
```env
# Server Configuration
PORT=3000

# GitHub App Configuration
GITHUB_APP_ID=your_github_app_id
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
your_private_key_here
-----END RSA PRIVATE KEY-----"

# OIDC Configuration
OIDC_AUDIENCE=your_external_service_audience
```

4. Install dependencies and start the server:
```bash
yarn install
yarn start
```

## GitHub App Setup

1. Create a GitHub App:
   - Navigate to **Settings** > **Developer settings** > **GitHub Apps** > **New GitHub App**
   - Set required permissions:
     - **Contents**: **Read & Write**
     - **Metadata**: **Read**

2. Install the GitHub App:
   - Go to the **Install App** tab
   - Select your organization/account
   - Choose repositories that need token generation

3. Configure the app:
   - Generate and download the private key
   - Note the App ID
   - Add these to your environment configuration

## Security Features

- OIDC token verification using GitHub's JWKS endpoint
- Automatic token scoping to the requesting repository
- Environment variable validation
- Request retry logic with proper error handling
- Runs as non-root user in Docker

## Development

To run the server in development mode with auto-reload:

```bash
yarn dev
```

## License

MIT
