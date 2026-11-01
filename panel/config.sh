#!/bin/sh
echo "window.RELEVO_API = \"${RELEVO_API:-http://localhost:3000}\";" > /usr/share/nginx/html/config.js
