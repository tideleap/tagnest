import { clsx, type ClassValue } from 'clsx';

/**
 * Class-name joiner.
 *
 * Deliberately thin: TagNest components expose explicit variant props rather
 * than accepting arbitrary utility soup, so a full tailwind-merge pass is not
 * needed and would only add runtime cost.
 */
export function cx(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
