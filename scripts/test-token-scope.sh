#!/bin/bash

# Default values
TOKEN=${1:-${GITHUB_TOKEN:-"YOUR_TOKEN"}}
REPO=${2:-${GITHUB_REPOSITORY:-"owner/repo"}}

if [ "$TOKEN" = "YOUR_TOKEN" ]; then
  echo "Usage:"
  echo "1. Get token from TokenBureau"
  echo "2. Test token scope:"
  echo "   ./scripts/test-token-scope.sh 'YOUR_TOKEN' 'owner/repo'"
  echo
  echo "Or using environment variables:"
  echo "   export GITHUB_TOKEN='YOUR_TOKEN'"
  echo "   export GITHUB_REPOSITORY='owner/repo'"
  echo "   ./scripts/test-token-scope.sh"
  exit 1
fi

# Extract owner and repo
OWNER=$(echo $REPO | cut -d'/' -f1)
REPO_NAME=$(echo $REPO | cut -d'/' -f2)

echo "=== Testing Token Scope ==="
echo "Repository: $REPO"

echo -e "\n1. Repository Information:"
REPO_RESPONSE=$(curl -s -H "Authorization: token $TOKEN" \
     -H "Accept: application/vnd.github.v3+json" \
     "https://api.github.com/repos/$REPO")

echo "Note: This is a GitHub App installation token. The permissions shown below are for reference only."
echo "Actual capabilities are determined by the GitHub App's permissions and the installation scope."
echo "$REPO_RESPONSE" | jq '{name, permissions, private}'

echo -e "\n2. Testing Actual Repository Access:"

echo "a) Reading contents:"
CONTENTS_RESPONSE=$(curl -s -H "Authorization: token $TOKEN" \
     -H "Accept: application/vnd.github.v3+json" \
     "https://api.github.com/repos/$REPO/contents")
if echo "$CONTENTS_RESPONSE" | jq -e 'type == "array"' > /dev/null; then
    echo "✓ Can read repository contents"
else
    echo "✗ Cannot read contents: $(echo "$CONTENTS_RESPONSE" | jq -r '.message')"
fi

echo -e "\nb) Writing to main branch:"
# Get the latest commit SHA from main
MAIN_SHA=$(curl -s -H "Authorization: token $TOKEN" \
     -H "Accept: application/vnd.github.v3+json" \
     "https://api.github.com/repos/$REPO/git/refs/heads/main" | jq -r '.object.sha')

if [ "$MAIN_SHA" != "null" ]; then
    # Get the current tree
    TREE_SHA=$(curl -s -H "Authorization: token $TOKEN" \
         -H "Accept: application/vnd.github.v3+json" \
         "https://api.github.com/repos/$REPO/git/commits/$MAIN_SHA" | jq -r '.tree.sha')

    # Create a new blob with test content
    BLOB_RESPONSE=$(curl -s -X POST -H "Authorization: token $TOKEN" \
         -H "Accept: application/vnd.github.v3+json" \
         -H "Content-Type: application/json" \
         -d "{\"content\":\"Test content from token scope test at $(date)\n\",\"encoding\":\"utf-8\"}" \
         "https://api.github.com/repos/$REPO/git/blobs")
    
    BLOB_SHA=$(echo "$BLOB_RESPONSE" | jq -r '.sha')

    # Create a new tree with the test file
    TREE_RESPONSE=$(curl -s -X POST -H "Authorization: token $TOKEN" \
         -H "Accept: application/vnd.github.v3+json" \
         -H "Content-Type: application/json" \
         -d "{\"base_tree\":\"$TREE_SHA\",\"tree\":[{\"path\":\"test-token-scope.txt\",\"mode\":\"100644\",\"type\":\"blob\",\"sha\":\"$BLOB_SHA\"}]}" \
         "https://api.github.com/repos/$REPO/git/trees")
    
    NEW_TREE_SHA=$(echo "$TREE_RESPONSE" | jq -r '.sha')

    # Create a new commit
    COMMIT_RESPONSE=$(curl -s -X POST -H "Authorization: token $TOKEN" \
         -H "Accept: application/vnd.github.v3+json" \
         -H "Content-Type: application/json" \
         -d "{\"message\":\"test: verify token scope and permissions\",\"parents\":[\"$MAIN_SHA\"],\"tree\":\"$NEW_TREE_SHA\"}" \
         "https://api.github.com/repos/$REPO/git/commits")
    
    NEW_COMMIT_SHA=$(echo "$COMMIT_RESPONSE" | jq -r '.sha')

    # Update main branch reference
    UPDATE_REF_RESPONSE=$(curl -s -X PATCH -H "Authorization: token $TOKEN" \
         -H "Accept: application/vnd.github.v3+json" \
         -H "Content-Type: application/json" \
         -d "{\"sha\":\"$NEW_COMMIT_SHA\",\"force\":false}" \
         "https://api.github.com/repos/$REPO/git/refs/heads/main")

    if echo "$UPDATE_REF_RESPONSE" | jq -e '.object.sha' > /dev/null; then
        echo "✓ Can write to main branch (created commit $(echo "$UPDATE_REF_RESPONSE" | jq -r '.object.sha' | cut -c1-7))"
    else
        echo "✗ Cannot write to main branch: $(echo "$UPDATE_REF_RESPONSE" | jq -r '.message')"
    fi
else
    echo "✗ Cannot get main branch SHA"
fi

echo -e "\n3. Testing Out-of-Scope Repository Access:"
TEST_REPO="$OWNER/token-bureau-test-outscope"
echo "Trying to access: $TEST_REPO"

# First check if we can read the repository
OUT_REPO_RESPONSE=$(curl -s -H "Authorization: token $TOKEN" \
     -H "Accept: application/vnd.github.v3+json" \
     "https://api.github.com/repos/$TEST_REPO")

if echo "$OUT_REPO_RESPONSE" | jq -e '.id' > /dev/null; then
    echo "Can read repository metadata (public repository access)"
    
    # Try to create content in the out-of-scope repository
    OUT_BLOB_RESPONSE=$(curl -s -X POST -H "Authorization: token $TOKEN" \
         -H "Accept: application/vnd.github.v3+json" \
         -H "Content-Type: application/json" \
         -d "{\"content\":\"Test content from token scope test\n\",\"encoding\":\"utf-8\"}" \
         "https://api.github.com/repos/$TEST_REPO/git/blobs")
    
    if echo "$OUT_BLOB_RESPONSE" | jq -e '.sha' > /dev/null; then
        echo "✗ WARNING: Can create content in out-of-scope repository!"
    else
        echo "✓ Properly scoped: Cannot create content ($(echo "$OUT_BLOB_RESPONSE" | jq -r '.message'))"
    fi
else
    echo "✓ Properly scoped: Cannot access repository ($(echo "$OUT_REPO_RESPONSE" | jq -r '.message'))"
fi

echo -e "\n4. Installation Scope:"
INSTALLATION_RESPONSE=$(curl -s -H "Authorization: token $TOKEN" \
     -H "Accept: application/vnd.github.v3+json" \
     "https://api.github.com/installation/repositories")

echo "Accessible Repositories:"
echo "$INSTALLATION_RESPONSE" | jq '{
    total_count,
    repositories: [.repositories[] | {
        name: .full_name,
        private,
        permissions: {
            admin: .permissions.admin,
            push: .permissions.push,
            pull: .permissions.pull
        }
    }]
}'

echo -e "\nDone."
