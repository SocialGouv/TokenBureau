#!/bin/bash

# Default values
URL=${1:-"http://localhost:3000"}
TOKEN=${2:-${OIDC_TOKEN:-"YOUR_OIDC_TOKEN"}}

# Function to check if string is valid JSON
is_json() {
    echo "$1" | jq -e . >/dev/null 2>&1
}

# Function to decode JWT payload
decode_jwt() {
    local jwt=$1
    if is_json "$jwt"; then
        jwt=$(echo "$jwt" | jq -r .value)
    fi
    local parts=(${jwt//./ })
    echo "=== JWT Structure ==="
    echo "Header:"
    echo ${parts[0]} | base64 -d 2>/dev/null | jq .
    echo "Payload:"
    echo ${parts[1]} | base64 -d 2>/dev/null | jq .
    
    # Extract and show repository information
    echo
    echo "=== Repository Information ==="
    echo "Repository Owner:" $(echo ${parts[1]} | base64 -d 2>/dev/null | jq -r .repository_owner)
    echo "Repository:" $(echo ${parts[1]} | base64 -d 2>/dev/null | jq -r .repository)
    echo "Full Name:" $(echo ${parts[1]} | base64 -d 2>/dev/null | jq -r '.repository_owner + "/" + .repository')
}

# Usage instructions if no token provided
if [ "$TOKEN" = "YOUR_OIDC_TOKEN" ]; then
  echo "Usage:"
  echo "1. Run the debug workflow in GitHub Actions"
  echo "2. Export the token:"
  echo "   export OIDC_TOKEN='token_from_workflow'"
  echo "3. Run: DEBUG=true ./scripts/test-request.sh http://localhost:3000"
  echo
  echo "Or directly:"
  echo "DEBUG=true ./scripts/test-request.sh http://localhost:3000 'token_from_workflow'"
  exit 1
fi

echo "=== Token Analysis ==="
if is_json "$TOKEN"; then
    echo "Token format: JSON"
    echo "Token structure:"
    echo "$TOKEN" | jq .
    echo
    decode_jwt "$TOKEN"
else
    echo "Token format: Raw JWT"
    decode_jwt "$TOKEN"
fi

echo -e "\n=== Making Request ==="
echo "URL: $URL/generate-token"

# Make request to generate token
RESPONSE=$(curl -s -X POST "$URL/generate-token" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json")

echo "Response:"
echo "$RESPONSE" | jq .

# If we got a token, test its scope
if echo "$RESPONSE" | jq -e .token > /dev/null 2>&1; then
    echo -e "\n=== Testing Token Scope ==="
    GITHUB_TOKEN=$(echo "$RESPONSE" | jq -r .token)
    REPO=$(decode_jwt "$TOKEN" | grep "Full Name:" | cut -d' ' -f2-)
    
    echo "Testing token scope for repository: $REPO"
    ./scripts/test-token-scope.sh "$GITHUB_TOKEN" "$REPO"
fi

echo -e "\nDone."
