// THE MOBILE FRONT END'S ABSENCE, MADE RESOLVABLE.
//
// `App.tsx` names the mobile chrome by a bare specifier, `@mobileApp`. On `develop` that resolves to
// the real `features-mobile` tree. In the PRODUCTION tree it resolves here, because the production
// rules exclude the mobile front end from what `main` publishes — Sard ships one product, a Windows
// desktop application, and a phone chrome has no business in it.
//
// WHY A STUB RATHER THAN A CONDITIONAL IMPORT. `npm run build` runs `tsc` before Vite, and the
// typechecker cannot resolve an import whose file the production tree legitimately excludes. A
// bundler alias alone is not enough — that is the failure that broke the v1.2.0 release, and the
// diagnostic modules already solve it exactly this way. This is the same mechanism, for the same
// reason, so there is one pattern here and not two.
//
// It is never rendered. `App.tsx` reaches the mobile branch only when `isMobile()` is true, and a
// desktop build is the only thing built from the production tree. If this ever appears on screen,
// something upstream is wrong and the message says so rather than showing a blank page.
export function MobileApp() {
  return null;
}
