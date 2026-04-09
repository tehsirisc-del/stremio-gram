@echo off
echo [Build] Generating config.js from .env...
node scripts\generate-config.js
if %ERRORLEVEL% NEQ 0 (
    echo [Build] ERROR: Failed to generate config.js. Check your .env file.
    pause
    exit /b 1
)

set "JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-21.0.10.7-hotspot"
echo [Build] Syncing Capacitor assets...
npx cap sync android
cd android
echo [Build] Cleaning previous build...
call gradlew.bat clean
echo [Build] Compiling APK...
call gradlew.bat assembleDebug
echo [Build] Done! APK is at: android\app\build\outputs\apk\debug\app-debug.apk
