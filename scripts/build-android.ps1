# SPDX-License-Identifier: GPL-3.0-or-later
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
python scripts/bootstrap.py --build
if ($LASTEXITCODE -ne 0) { throw 'Android build failed; see the first failing step above.' }
