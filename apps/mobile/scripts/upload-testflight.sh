#!/usr/bin/env bash
set -euo pipefail
umask 077

case "${1:-ios}" in
  ios) platform=iOS ;;
  tvos) platform=tvOS; export EXPO_TV=1 ;;
  *) echo 'Usage: upload-testflight.sh [ios|tvos]' >&2; exit 2 ;;
esac

for variable in \
  APPLE_TEAM_ID \
  APP_STORE_CONNECT_API_ISSUER_ID \
  APP_STORE_CONNECT_API_KEY_ID \
  APP_STORE_CONNECT_API_PRIVATE_KEY \
  IOS_DEVELOPMENT_CERTIFICATE_P12_BASE64 \
  IOS_DEVELOPMENT_CERTIFICATE_PASSWORD \
  SQUIRMY_IOS_VERSION \
  SQUIRMY_IOS_BUILD_NUMBER; do
  if [[ -z "${!variable:-}" ]]; then
    echo "Missing $variable for the TestFlight upload." >&2
    exit 1
  fi
done

signing_dir="$(mktemp -d "${RUNNER_TEMP:?}/squirmy-testflight.XXXXXX")"
key_path="$signing_dir/AuthKey.p8"
certificate_path="$signing_dir/signing.p12"
keychain_path="$signing_dir/signing.keychain-db"
trap 'security delete-keychain "$keychain_path" >/dev/null 2>&1 || true; rm -rf "$signing_dir"' EXIT
keychain_password="$(openssl rand -base64 32)"

printf '%s' "$APP_STORE_CONNECT_API_PRIVATE_KEY" > "$key_path"
printf '%s' "$IOS_DEVELOPMENT_CERTIFICATE_P12_BASE64" | base64 --decode > "$certificate_path"
unset APP_STORE_CONNECT_API_PRIVATE_KEY IOS_DEVELOPMENT_CERTIFICATE_P12_BASE64

# The development identity signs the archive. Automatic export signing uses Apple's
# cloud-managed distribution certificate.
security create-keychain -p "$keychain_password" "$keychain_path"
security set-keychain-settings -lut 3600 "$keychain_path"
security unlock-keychain -p "$keychain_password" "$keychain_path"
security import "$certificate_path" -k "$keychain_path" -P "$IOS_DEVELOPMENT_CERTIFICATE_PASSWORD" -A -t cert -f pkcs12
rm "$certificate_path"
unset IOS_DEVELOPMENT_CERTIFICATE_PASSWORD
if ! security find-identity -v -p codesigning "$keychain_path" | grep -q 'Apple Development'; then
  echo "The PKCS#12 must contain a valid Apple Development certificate and its private key." >&2
  exit 1
fi
security set-key-partition-list -S apple-tool:,apple: -k "$keychain_password" "$keychain_path" >/dev/null
security list-keychains -d user -s "$keychain_path"
security default-keychain -d user -s "$keychain_path"

authentication=(
  -allowProvisioningUpdates
  -authenticationKeyPath "$key_path"
  -authenticationKeyID "$APP_STORE_CONNECT_API_KEY_ID"
  -authenticationKeyIssuerID "$APP_STORE_CONNECT_API_ISSUER_ID"
)
archive_path="$RUNNER_TEMP/Squirmy-$platform.xcarchive"
export_options_path="$signing_dir/ExportOptions.plist"

echo "Archiving Squirmy for $platform $SQUIRMY_IOS_VERSION ($SQUIRMY_IOS_BUILD_NUMBER)."
xcodebuild \
  -workspace ios/Squirmy.xcworkspace \
  -scheme Squirmy \
  -configuration Release \
  -destination "generic/platform=$platform" \
  -archivePath "$archive_path" \
  "${authentication[@]}" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  MARKETING_VERSION="$SQUIRMY_IOS_VERSION" \
  CURRENT_PROJECT_VERSION="$SQUIRMY_IOS_BUILD_NUMBER" \
  archive

/usr/libexec/PlistBuddy -c 'Add :method string app-store-connect' "$export_options_path"
/usr/libexec/PlistBuddy -c 'Add :destination string upload' "$export_options_path"
/usr/libexec/PlistBuddy -c 'Add :signingStyle string automatic' "$export_options_path"
/usr/libexec/PlistBuddy -c "Add :teamID string $APPLE_TEAM_ID" "$export_options_path"
/usr/libexec/PlistBuddy -c 'Add :manageAppVersionAndBuildNumber bool false' "$export_options_path"

xcodebuild \
  -exportArchive \
  -archivePath "$archive_path" \
  -exportOptionsPlist "$export_options_path" \
  "${authentication[@]}"
