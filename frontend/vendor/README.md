# Vendor Libraries

This folder contains all external JavaScript and CSS dependencies for the ExoDeck frontend. 
ExoDeck enforces a strict "no CDN references" policy to ensure offline functionality, so all dependencies must be locally provided and served from this directory.

## Current Libraries

- `marked.min.js`: Markdown parsing engine (`marked.js`).
- `highlight.min.js`: Syntax highlighting core library (`highlight.js`).
- `mermaid.min.js`: Diagram rendering library (`mermaid.js`).
- `highlight-github-dark.css`: Syntax highlighting stylesheet (Github Dark theme).

## How to Update

To update these libraries to their newest versions, you can download the latest pre-compiled minified browser bundles directly from public CDNs like `cdnjs` or `jsdelivr` and replace the existing files.

### Update Script (PowerShell)

You can run the following PowerShell commands from the repository root to download and overwrite the files with the latest versions from CDNs. Ensure you update the version numbers in the URLs to the desired latest versions before running:

```powershell
# 1. Update marked.js (replace 18.0.5 with the latest version)
# marked v18 provides a UMD build under lib/marked.umd.js
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/marked@18.0.5/lib/marked.umd.js" -OutFile "frontend\vendor\marked.min.js"

# 2. Update highlight.js (replace 11.11.1 with the latest version)
Invoke-WebRequest -Uri "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js" -OutFile "frontend\vendor\highlight.min.js"

# 3. Update highlight.js CSS theme (replace 11.11.1 with the latest version)
Invoke-WebRequest -Uri "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css" -OutFile "frontend\vendor\highlight-github-dark.css"

# 4. Update mermaid.js (replace 11.16.0 with the latest version)
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js" -OutFile "frontend\vendor\mermaid.min.js"
```

### Alternatively (Using npm / bash)
If you have `npm` installed, you can create a temporary directory, fetch the files, and move the minified bundles:
```bash
# Create a temporary environment
mkdir /tmp/startgrd-deps && cd /tmp/startgrd-deps
npm init -y

# Install latest packages
npm install marked mermaid

# Copy over the minified production builds
# node_modules/marked/lib/marked.umd.js             -> frontend/vendor/marked.min.js
# node_modules/mermaid/dist/mermaid.min.js          -> frontend/vendor/mermaid.min.js

# Note: For highlight.js, the official npm package mainly ships ESM & CommonJS modules. 
# Providing a pre-built browser bundle is easiest via CDNs as demonstrated in the PowerShell script above.
```
