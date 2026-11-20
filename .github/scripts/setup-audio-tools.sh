#!/usr/bin/env bash
# Installs ffmpeg and fpcalc on a GitHub runner.
#
# The runner's default apt mirror is often slow enough to add minutes to a job. Fetch
# from the Ubuntu archive directly with a bounded download time, and fall back to the
# runner's own sources if that fails.
set -euo pipefail

packages=(ffmpeg libchromaprint-tools)
runner_apt_options=(-o APT::Update::Error-Mode=any)

download() {
  # Bound the total fetch time even if the mirror keeps transferring slowly.
  # Finish downloading before letting apt start dpkg.
  sudo timeout --kill-after=5s 30s apt-get "${apt_options[@]}" update &&
    sudo timeout --kill-after=5s 60s apt-get "${apt_options[@]}" \
      --yes --no-install-recommends --download-only install "${packages[@]}"
}

archive_sources=$(mktemp)
trap 'rm -f "$archive_sources"' EXIT
cat > "$archive_sources" <<'SOURCES'
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu/ noble main restricted universe multiverse
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu/ noble-updates main restricted universe multiverse
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://security.ubuntu.com/ubuntu/ noble-security main restricted universe multiverse
SOURCES
apt_options=("${runner_apt_options[@]}" -o "Dir::Etc::sourcelist=$archive_sources" -o Dir::Etc::sourceparts=-)

if download; then
  echo 'Downloaded the audio tools from the Ubuntu archive.'
else
  echo '::warning::Downloads from the Ubuntu archive failed or timed out. Retrying with the runner apt sources.'
  apt_options=("${runner_apt_options[@]}")
  download
  echo 'Downloaded the audio tools from the runner apt sources.'
fi

sudo apt-get "${apt_options[@]}" --yes --no-install-recommends --no-download install "${packages[@]}"
ffmpeg -version | head -1
fpcalc -version
