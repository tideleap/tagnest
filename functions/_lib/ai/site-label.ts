// functions/_lib/ai/site-label.ts
//
// Canonical site-label facade for the AI engine.
//
// `engine.ts` (and any other AI-module code) can import the shared site-label
// resolver straight from the AI module directory:
//
//     import { canonicalSiteLabel, KNOWN_BRANDS, brandFromHost } from './site-label';
//
// The actual implementation lives in `shared/siteLabel.ts` so the same mapping
// is reused by the browser export path — see that file for the full rationale.
// Keeping this a thin re-export means "add a site label" stays a one-file
// change in `shared/`, with no risk of the backend and frontend drifting apart.

export {
  canonicalSiteLabel,
  KNOWN_BRANDS,
  brandFromHost,
  isGenericTitle,
} from '../../../shared/siteLabel';
