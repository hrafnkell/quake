#!/bin/bash
# Keyrir plot.py á 5 mín fresti
cd "$(dirname "$0")"
PYTHON=python3
[ -x .venv/bin/python ] && PYTHON=.venv/bin/python
while true
do
	"$PYTHON" plot.py
	sleep 300
done
