@echo off
rem Local Python launcher, not an official Gradle wrapper.
python "%~dp0scripts\run-gradle.py" %*
exit /b %errorlevel%
