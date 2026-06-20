# Publishing to VS Code Marketplace

## Prerequisites

1. Create a Microsoft account at https://login.microsoftonline.com
2. Go to https://aka.ms/SignupAzureDevOps and create an organization
3. Go to https://marketplace.visualstudio.com/manage and create a Publisher:
   - Publisher ID: gemini-antigravity (must match package.json "publisher")
4. In Azure DevOps → User Settings → Personal Access Tokens:
   - New Token → Scopes: Marketplace → Manage
   - Copy the token

## Steps

### 1. Install vsce
```powershell
npm install -g @vscode/vsce
```

### 2. Login with your publisher
```powershell
vsce login gemini-antigravity
# Paste your Personal Access Token when prompted
```

### 3. Add a 128x128 icon
- Create/add `assets/icon.png` (128x128 px PNG)
- This shows on the marketplace listing

### 4. Package to test locally first
```powershell
cd C:\Users\priya\.gemini\antigravity\scratch\collab-edit
vsce package
# Creates collab-edit-1.0.0.vsix
```

### 5. Install locally to verify
```powershell
code --install-extension collab-edit-1.0.0.vsix
```

### 6. Publish
```powershell
vsce publish
```

### 7. View your listing
https://marketplace.visualstudio.com/items?itemName=gemini-antigravity.collab-edit

---

## Updating later

Bump version in package.json, then:
```powershell
vsce publish patch   # 1.0.0 → 1.0.1
vsce publish minor   # 1.0.0 → 1.1.0
vsce publish major   # 1.0.0 → 2.0.0
```