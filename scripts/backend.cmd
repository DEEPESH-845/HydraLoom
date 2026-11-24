@echo off
rem Double-click or run from any folder: starts the GANTRYLAB backend. Extra arguments pass through (e.g. -Port 8010 -Reload).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0backend.ps1" %*
