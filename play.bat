@echo off
cd /d "%~dp0"
echo ブラウザが開きます。遊ぶのをやめるときは、この黒い窓を閉じてください。
echo スマホで遊ぶ場合は、同じ Wi-Fi で表示された Network の URL を開いてください。
echo.
npm.cmd run play
pause
