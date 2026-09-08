// Shared by CI preparation and migration of a saved worker disk from before prepared templates.
export const WORKER_TOOLCHAIN_CHECK_COMMAND =
  "command -v ps && command -v pdftotext && python3 -c 'import openpyxl' && git config --get filter.lfs.process";
export const WORKER_TOOLCHAIN_INSTALL_COMMAND =
  'if [ "$(id -u)" = 0 ]; then apt-get update -qq && apt-get install -y -qq --no-install-recommends git-lfs poppler-utils python3-openpyxl procps; else sudo apt-get update -qq && sudo apt-get install -y -qq --no-install-recommends git-lfs poppler-utils python3-openpyxl procps; fi';
