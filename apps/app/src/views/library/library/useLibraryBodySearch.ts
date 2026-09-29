import { useEffect, useState } from 'react';
import { product } from '../../../lib/product-client.js';

/** One bounded, debounced product search for both Library views. Results from a
 * previous query or unmounted view never replace the current query's state. */
export function useLibraryBodySearch(query: string) {
  const [hits, setHits] = useState<ReadonlySet<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [warning, setWarning] = useState('');
  useEffect(() => {
    const needle = query.trim();
    setHits(new Set()); setWarning(''); setSearching(Boolean(needle));
    if (!needle) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void product.library.search(needle).then(result => {
        if (cancelled) return;
        setHits(new Set(result.hits.map(hit => hit.docId ?? hit.absPath)));
        setWarning(result.truncated ? 'Showing partial content search results.' : '');
      }, () => {
        if (!cancelled) setWarning('Document content search is unavailable. Try again.');
      }).finally(() => { if (!cancelled) setSearching(false); });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);
  return { hits, searching, warning };
}
