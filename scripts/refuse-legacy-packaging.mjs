process.stderr.write(
  "Legacy v1 packaging is disabled; dist, dist:mac, dist:win, and Linux/AppImage cannot produce a GA artifact during the v2 expand phase.\n",
);
process.exitCode = 1;
