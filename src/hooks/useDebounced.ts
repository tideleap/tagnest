import { useEffect, useState } from 'react';

/**
 * Trailing-edge debounce.
 *
 * Used for search-as-you-type: without it a 12-character query fires twelve
 * round trips, and the results flicker through states the user never asked for.
 */
export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
