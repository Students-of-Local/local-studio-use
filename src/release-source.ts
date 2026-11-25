/** Where releases are published. The helper (cli/src) and the extension both read it from here. */

export const RELEASE_REPO = "baney75/local-studio";

/** A release is the tag browser-v<x.y.z>: the repository's other releases are the app's. */
export const RELEASE_TAG_PREFIX = "browser-v";

export const SOURCE_URL = `https://github.com/${RELEASE_REPO}/tree/main/browser`;

/** Where a person gets the Local Studio app, which brings the helper. */
export const APP_DOWNLOAD_URL = `https://github.com/${RELEASE_REPO}/releases`;

/** Every release of ours, newest first. GitHub's "latest release" is the app's. */
export const RELEASES_URL = `https://github.com/${RELEASE_REPO}/releases?q=${RELEASE_TAG_PREFIX}`;
