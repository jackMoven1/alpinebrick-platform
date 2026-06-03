@echo off
setlocal
echo [ImagiBricks] Deploy starting...

echo Installing repo dependencies...
npm install
if errorlevel 1 (
  echo npm install failed.
  exit /b 1
)

echo Running repo tests...
npm test
if errorlevel 1 (
  echo Tests failed. Deployment aborted.
  exit /b 1
)

echo Stopping existing containers...
docker compose down --remove-orphans
if errorlevel 1 (
  echo docker compose down failed.
  exit /b 1
)

echo Building and starting services...
docker compose up --build -d
if errorlevel 1 (
  echo docker compose up failed.
  exit /b 1
)

echo Deployment complete.
echo Storefront: http://localhost:3000
echo Admin: http://localhost:3001
echo Catalog service: http://localhost:4001
echo Order service: http://localhost:4002
echo Inventory service: http://localhost:4003
echo Affiliate service: http://localhost:4004

endlocal
