$repo = "C:\apps\azure-devops-dashboard"
Set-Location $repo
git pull
npm ci
npm ci --prefix web
npm run build
Restart-Service azure-dashboard
