@echo off
REM Set up lore-web: check and install its dependencies, then install the SDK.
REM Safe to re-run. Works from anywhere (uses the script's own folder).
REM
REM Networking (VPN/tunnel/port forwarding to reach a server) is intentionally
REM out of scope here -- arrange that yourself.
setlocal
cd /d "%~dp0"

echo [lore-web] Checking dependencies...

REM --- Node.js (required) ---
where node >nul 2>nul
if errorlevel 1 goto :no_node
goto :have_node

:no_node
echo [lore-web] Node.js was not found.
where winget >nul 2>nul
if errorlevel 1 (
  echo            Install Node.js 18-24 from https://nodejs.org/ and re-run setup.bat.
  exit /b 1
)
choice /C YN /M "[lore-web] Install Node.js LTS via winget now"
if errorlevel 2 (
  echo            Install Node.js 18-24 from https://nodejs.org/ and re-run setup.bat.
  exit /b 1
)
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
echo.
echo [lore-web] Node.js installed. Close this window, open a new one, and run
echo            setup.bat again so the updated PATH takes effect.
exit /b 0

:have_node
echo [lore-web] Installing npm dependencies ^(npm install^)...
call npm install
if errorlevel 1 (
  echo [lore-web] npm install failed. Check your internet connection and try again.
  exit /b 1
)

REM --- lore CLI (login, plus every feature that talks to a remote server) ---
REM Required version comes from package.json's @lore-vcs/sdk pin -- CLI and SDK
REM ship in lockstep upstream, so that's the single source of truth for both.
where lore >nul 2>nul
if errorlevel 1 goto :no_lore

REM Found -- but presence isn't enough, it might be stale. `lore --version`
REM prints like "lore 0.8.6+373"; take the 2nd token and hand both versions to
REM node for a numeric major.minor.patch compare (batch can't do this reliably:
REM plain string compare would treat "0.9.0" < "0.8.6" as false alphabetically,
REM which is wrong once double-digit parts show up, e.g. "0.10.0" vs "0.9.0").
for /f "tokens=2" %%V in ('lore --version') do set INSTALLED_LORE_VERSION=%%V
node -e "const req=require('./package.json').dependencies['@lore-vcs/sdk'].replace(/^\D*/,'');const cur=process.argv[1].split('+')[0];const p=s=>s.split('.').map(Number);const [a,b]=[p(cur),p(req)];for(let i=0;i<3;i++){if(a[i]>b[i])process.exit(0);if(a[i]<b[i])process.exit(1);}process.exit(0);" "%INSTALLED_LORE_VERSION%"
if not errorlevel 1 goto :done
for /f "delims=" %%V in ('node -e "console.log(require('./package.json').dependencies['@lore-vcs/sdk'].replace(/^\D*/,''))"') do set REQUIRED_LORE_VERSION=%%V
echo [lore-web] The 'lore' CLI is version %INSTALLED_LORE_VERSION%, but this app needs at least %REQUIRED_LORE_VERSION%.
goto :install_lore

:no_lore
echo [lore-web] The 'lore' CLI was not found. lore-web needs it to log in, to
echo            browse or delete repositories on the server, and to mark which
echo            branches are local-only vs remote-only. Local work still works
echo            without it, but those branch badges vanish with no error shown.

:install_lore
choice /C YN /M "[lore-web] Install/upgrade it now via the official Lore installer"
if errorlevel 2 (
  echo            Skipped. Install it later from:
  echo              https://epicgames.github.io/lore/how-to/install-lore-cli/
  echo            then re-run this script.
  goto :done
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/EpicGames/lore/main/scripts/install.ps1 | iex"
echo [lore-web] If 'lore' is still not found, open a new terminal for PATH to update.

:done
echo.
echo [lore-web] Setup complete. Run start.bat ^(or: npm start^) to launch.
echo            Before syncing, make sure this machine can reach your Lore server's host.
endlocal
