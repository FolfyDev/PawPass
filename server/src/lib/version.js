/// This build's version, in the same form as the GitHub release tags
/// (year.major.minor.patch) so lib/updates.js can compare the two.
///
/// Bump it as part of cutting a release, to the tag about to be published.
/// Between releases, keep it one step past the last tag: the settings page
/// then shows the build as a development build that's ahead of the release.
/// (Not package.json's "version": npm only accepts three-part semver there.)
export const APP_VERSION = '2026.1.1.0';
